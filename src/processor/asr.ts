/**
 * Speech recognition with word timestamps (Whisper via transformers.js on WebGPU), for the
 * profanity filter. Model files are bundled with the extension under models/<name>/ and loaded
 * from the extension origin; nothing is fetched from the network.
 */
import { uncoveredSpeech } from '../core/censor';
import type { Word } from '../core/profanity';
import { loadOrt } from './model';

export const ASR_MODEL = 'whisper-base_timestamped';
const DTYPE = { encoder_model: 'fp16', decoder_model_merged: 'q4f16' } as const;
/** Whisper language tokens we choose between (the profanity lists cover these two). */
const LANGS = ['ru', 'en'] as const;
export type AsrLang = (typeof LANGS)[number];
/** Below this detector confidence, transcribe in both languages. */
const BOTH_BELOW = 0.9;
/** Whisper's no-speech probability above which a window is skipped. */
const NOSPEECH_SKIP = 0.6;

/** A hallucination loop ("что, что, что…"): many words, few distinct. */
function repetitive(words: Word[]): boolean {
  if (words.length < 12) return false;
  const distinct = new Set(words.map((w) => w.text.toLowerCase().replace(/[^\p{L}]/gu, ''))).size;
  return distinct / words.length < 0.35;
}
/**
 * Whisper's cross-attention word times come out late by a fairly constant amount; measured on
 * the profanity fixture (tests/e2e/asr-bench.mjs and profanity.mjs, whisper-base): starts
 * ≈ +190 ms, ends ≈ +140 ms on average. Subtracted from the edges.
 */
const START_SHIFT = 0.19;
const END_SHIFT = 0.14;

export interface AsrResult {
  /** Main language (detected or given). */
  lang: AsrLang;
  /** Detector's probability for `lang` among RU/EN (1 when given). */
  langProb: number;
  /** Number of decoding passes (2 when the window looked mixed-language). */
  passes: number;
  text: string;
  /** Times in seconds from the start of the input audio. */
  words: Word[];
  ms: { detect: number; transcribe: number };
}

export interface Asr {
  name: string;
  /**
   * lang: skip detection. voice: a separated voice track (16 kHz, silence between phrases)
   * covering the input from `offset` seconds, where stretches of speech without recognized
   * words reveal a second language.
   */
  transcribe(audio16k: Float32Array, opts?: { lang?: AsrLang; voice?: { audio: Float32Array; offset: number } }): Promise<AsrResult>;
  release(): Promise<void>;
}

/* Minimal typing of what we use from transformers.js. */
interface TfTensor {
  data: Float32Array;
  dims: number[];
}
interface AsrPipeline {
  (audio: Float32Array, opts: Record<string, unknown>): Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  model: ((inputs: Record<string, unknown>) => Promise<{ logits: TfTensor }>) & { generation_config?: { lang_to_id?: Record<string, number>; decoder_start_token_id?: number } };
  dispose(): Promise<void>;
}
interface TfLib {
  pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<AsrPipeline>;
  env: Record<string, unknown> & { backends: { onnx: Record<string, unknown> } };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

let libPromise: Promise<TfLib> | null = null;

async function loadLib(base: string): Promise<TfLib> {
  if (!libPromise) {
    libPromise = (async () => {
      const ort = await loadOrt(base);
      (globalThis as unknown as { __musicRemoverOrt: unknown }).__musicRemoverOrt = ort; // see ort-shim.ts
      const url = `${base}processor/asr-lib.js`;
      const lib = (await import(/* webpackIgnore: true */ url)) as TfLib;
      lib.env.allowRemoteModels = false;
      lib.env.allowLocalModels = true;
      lib.env.localModelPath = `${base}models/`;
      lib.env.useBrowserCache = false;
      lib.env.useWasmCache = false;
      return lib;
    })();
    libPromise.catch(() => (libPromise = null));
  }
  return libPromise;
}

export async function loadAsr(base: string, name = ASR_MODEL): Promise<Asr> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
  if (!adapter) throw new Error('распознаванию речи нужен WebGPU');
  if (!adapter.features.has('shader-f16')) throw new Error('видеокарта без поддержки fp16 (shader-f16)');
  const lib = await loadLib(base);
  const pipe = await lib.pipeline('automatic-speech-recognition', name, { device: 'webgpu', dtype: DTYPE });
  const gc = pipe.model.generation_config ?? {};
  const sot = gc.decoder_start_token_id ?? 50258;
  const langIds = LANGS.map((l) => gc.lang_to_id?.[`<|${l}|>`] ?? -1);

  const noSpeechId = (gc as { no_timestamps_token_id?: number }).no_timestamps_token_id ? (gc as { no_timestamps_token_id: number }).no_timestamps_token_id - 1 : 50362;

  /**
   * Whisper language ID restricted to RU/EN (one encoder pass + one decoder step): P(lang),
   * plus Whisper's own no-speech probability (<|nospeech|> at the first step).
   */
  async function detect(audio: Float32Array): Promise<Record<AsrLang | 'nospeech', number>> {
    const { input_features } = await pipe.processor(audio);
    const ids = new lib.Tensor('int64', BigInt64Array.from([BigInt(sot)]), [1, 1]);
    const { logits } = await pipe.model({ input_features, decoder_input_ids: ids });
    const V = logits.dims[logits.dims.length - 1];
    const row = logits.data.subarray(logits.data.length - V);
    const l = langIds.map((id) => (id >= 0 ? row[id] : -Infinity));
    const m = Math.max(...l);
    const e = l.map((x) => Math.exp(x - m));
    const z = e.reduce((a, b) => a + b, 0);
    const all = Math.max(...row);
    let zAll = 0;
    for (let i = 0; i < row.length; i++) zAll += Math.exp(row[i] - all);
    const nospeech = Math.exp(row[noSpeechId] - all) / zAll;
    return { ...(Object.fromEntries(LANGS.map((lang, i) => [lang, e[i] / z])) as Record<AsrLang, number>), nospeech };
  }

  async function pass(audio: Float32Array, language: AsrLang, tokensPerSecond: number): Promise<{ text: string; words: Word[] }> {
    const seconds = audio.length / 16000;
    const out = await pipe(audio, {
      language,
      task: 'transcribe',
      return_timestamps: 'word',
      // Bounded decode and no 6-token n-gram twice: Whisper's classic hallucination on music is
      // one phrase repeated until the token limit, which also costs seconds of GPU time. A word
      // cut off at the end of the window is still heard by the next tile (its left context).
      max_new_tokens: Math.ceil(seconds * tokensPerSecond) + 10,
      no_repeat_ngram_size: 6,
    });
    const words: Word[] = [];
    for (const c of out.chunks ?? []) {
      const [s, e] = c.timestamp;
      if (s == null || !Number.isFinite(s)) continue;
      const end = e != null && Number.isFinite(e) && e > s ? e : Math.min(seconds, s + 0.5);
      // the last word before a pause sometimes gets the pause too: cap by its length in letters
      const letters = c.text.replace(/[^\p{L}]/gu, '').length;
      const e2 = Math.min(end, s + 0.3 + 0.09 * letters);
      words.push({ text: c.text, start: Math.max(0, s - START_SHIFT), end: Math.max(0, e2 - END_SHIFT) });
    }
    return { text: out.text, words };
  }

  return {
    name,
    async transcribe(audio, opts = {}) {
      const t0 = performance.now();
      let langs: AsrLang[];
      let prob = 1;
      let halvesDisagree = false;
      let nospeech = 0;
      if (opts.lang) langs = [opts.lang];
      else if (opts.voice) {
        const p = await detect(audio);
        const top = p.ru >= p.en ? 'ru' : 'en';
        prob = p[top];
        nospeech = p.nospeech;
        langs = [top];
      } else {
        // On the original mix (music everywhere) speech can't be told from music by level, so
        // a language switch inside the window is found by detecting each half separately.
        const h = audio.length >> 1;
        const [a, b] = [await detect(audio.subarray(0, h)), await detect(audio.subarray(h))];
        const ru = (a.ru + b.ru) / 2;
        const top = ru >= 0.5 ? 'ru' : 'en';
        prob = top === 'ru' ? ru : 1 - ru;
        nospeech = Math.min(a.nospeech, b.nospeech);
        langs = [top];
        halvesDisagree = a.ru >= 0.5 !== b.ru >= 0.5;
      }
      const t1 = performance.now();
      if (nospeech > NOSPEECH_SKIP) {
        // music or silence only: nothing to recognize (and the most hallucination-prone input)
        return { lang: langs[0], langProb: prob, passes: 0, text: '', words: [], ms: { detect: t1 - t0, transcribe: 0 } };
      }
      const passes = [await pass(audio, langs[0], 9)];
      const looped = repetitive(passes[0].words);
      if (looped) {
        // A hallucination loop ("что, что, что…"). Whisper is chaotic here; the same speech
        // without the first second of context usually decodes fine.
        const retry = await pass(audio.subarray(16000), langs[0], 9);
        if (!repetitive(retry.words)) passes[0] = { text: retry.text, words: retry.words.map((w) => ({ ...w, start: w.start + 1, end: w.end + 1 })) };
        else passes[0] = { text: '', words: [] };
      }
      // Whisper forced to one language skips speech in the other. When the window may mix
      // Russian and English — the detector is unsure, or (on a clean voice track) a second or
      // more of speech got no words — transcribe it in the other language too and merge.
      if (!opts.lang) {
        const unsure = prob < BOTH_BELOW || halvesDisagree;
        const v = opts.voice;
        const gap = v ? uncoveredSpeech(v.audio, 16000, passes[0].words.map((w) => ({ start: w.start - v.offset, end: w.end - v.offset }))) : 0;
        // (not after a loop retry: that window already took three decodes' worth of time)
        if ((unsure || gap >= 1) && !looped) {
          langs.push(langs[0] === 'ru' ? 'en' : 'ru');
          passes.push(await pass(audio, langs[1], 6));
        }
      }
      const t2 = performance.now();
      return {
        lang: langs[0],
        langProb: prob,
        passes: langs.length,
        text: passes.map((p) => p.text.trim()).join(' | '),
        words: passes.flatMap((p) => p.words),
        ms: { detect: t1 - t0, transcribe: t2 - t1 },
      };
    },
    release: () => pipe.dispose(),
  };
}
