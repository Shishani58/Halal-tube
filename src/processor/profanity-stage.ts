/**
 * Profanity filter stage of the worker: per tile, recognize speech with word timestamps and
 * silence or beep the swear words in the tile's output audio before it is sent to the page.
 *
 * Recognition sees the tile plus CONTEXT_S seconds on each side, so a word on a tile boundary is
 * heard whole by both neighbouring tiles and each one masks its own part of it; when only the
 * later tile recognizes it, the earlier one is re-censored and sent again (TilePatch).
 *
 * Input inside the tile: with music removal, VOICE_MIX·voice + (1−VOICE_MIX)·original — music
 * is ~10 dB down, while the original softens separation artifacts that make Whisper mishear
 * some consonants (measured: voice alone 5/7 swear words found, this blend 6/7, original mix
 * 6/7 with more hallucinations; tests/e2e/asr-bench.mjs). Without music removal: the original.
 * Context: the previous tile's input when that tile was the last one computed, else the original.
 */
import { applyCensor, toMono16k, type CensorMode, type Span } from '../core/censor';
import { findProfanity, type Word } from '../core/profanity';
import { resampleCubic } from '../core/resample';
import type { TileProfanityReport } from '../shared/messages';
import { loadAsr, type Asr } from './asr';
import type { DecodedAudio } from './decode';

export const CONTEXT_S = 1.0;
const VOICE_MIX = 0.7;

/** A re-censored copy of the previous tile (a swear word on the seam found only now). */
export interface TilePatch {
  k: number;
  start: number;
  validFrom: number;
  left: Float32Array;
  right: Float32Array;
  profanity: TileProfanityReport;
}

export interface TileFilterResult {
  report?: TileProfanityReport;
  /** Set when this tile's recognition found a word reaching back into the previous tile. */
  patch?: TilePatch;
}

export type FilterState = 'idle' | 'loading' | 'ready' | 'error';

export type WordSource = (session: number, from: number, to: number) => Word[] | null;

/** How a tile's words were obtained (goes into the report). */
export type RecognitionMeta = Pick<TileProfanityReport, 'lang' | 'langProb' | 'passes' | 'asrMs' | 'context' | 'input'>;

export class ProfanityStage {
  state: FilterState = 'idle';
  error?: string;
  private asr: Asr | null = null;
  private prevTail: { session: number; k: number; data: Float32Array } | null = null;
  /** Copy of the last tile sent, so a seam word found by the next tile can still be masked. */
  private prevOut: { session: number; k: number; start: number; validFrom: number; left: Float32Array; right: Float32Array; info: TileProfanityReport } | null = null;
  /** Swear words the last tile found reaching past its end (the next tile masks its part too). */
  private carry: { session: number; k: number; hits: { text: string; start: number; end: number }[] } | null = null;
  private asrSec = 0;
  private asrTiles = 0;

  /** Average recognition time per tile (ms). */
  get avgMs(): number {
    return this.asrTiles ? (this.asrSec / this.asrTiles) * 1000 : 0;
  }

  /**
   * `serial` runs model loads one at a time: creating the first sessions of the separation model
   * and of the recognizer concurrently hangs ONNX Runtime's initialization.
   */
  constructor(
    private base: string,
    private serial: <T>(load: () => Promise<T>) => Promise<T> = (load) => load(),
    /**
     * External word timings (e.g. YouTube captions), media seconds: return the words of
     * `session` in [from, to], or null when this source doesn't cover that range — then speech
     * recognition is used.
     */
    public wordSource: WordSource | null = null,
  ) {}

  /** Start loading the recognizer if needed; `done` runs when it is ready or failed. */
  ensure(done: () => void): void {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    this.serial(() => loadAsr(this.base)).then(
      (a) => {
        this.asr = a;
        this.state = 'ready';
        done();
      },
      (e) => {
        this.state = 'error';
        this.error = e instanceof Error ? e.message : String(e);
        console.error('[music-remover] speech recognition failed to load', e);
        done();
      },
    );
  }

  async release(): Promise<void> {
    const a = this.asr;
    this.asr = null;
    this.prevTail = null;
    this.prevOut = null;
    this.carry = null;
    if (this.state === 'ready') this.state = 'idle';
    if (a) await a.release().catch(() => undefined);
  }

  /**
   * Censor a tile in place (see FilterInput). Never throws: on failure the tile stays as is.
   * Words come from `wordSource` when it has them for the tile ± context (e.g. captions), else
   * from speech recognition (when loaded); either way they go through censorWords().
   */
  async filterTile(o: FilterInput): Promise<TileFilterResult> {
    const from = o.start - CONTEXT_S;
    const to = o.start + o.left.length / o.rate + CONTEXT_S;
    try {
      const external = this.wordSource?.(o.session, from, to);
      if (external) return this.censorWords(o, external, { lang: 'external', langProb: 1, passes: 0, asrMs: 0 });
      if (!this.asr) return {};
      const r = await this.recognize(this.asr, o);
      this.asrSec += r.meta.asrMs / 1000;
      this.asrTiles++;
      return this.censorWords(o, r.words, r.meta);
    } catch (e) {
      console.warn('[music-remover] profanity filter failed for tile', o.k, e);
      return {};
    }
  }

  /** Recognize the words around a tile (Whisper). Times in media seconds. */
  private async recognize(asr: Asr, o: FilterInput): Promise<{ words: Word[]; meta: RecognitionMeta }> {
    const { rate, start } = o;
    const n = o.left.length;
    const c = Math.round(CONTEXT_S * rate);
    const buf = new Float32Array(c + n + c);
    // original mix (mono) for the context on both sides
    const mixAt = (t0: number, count: number, at: number) => {
      const d = o.decoded;
      const l = resampleCubic(d.left, d.sampleRate, d.start, rate, t0, count);
      const r = resampleCubic(d.right, d.sampleRate, d.start, rate, t0, count);
      for (let i = 0; i < count; i++) buf[at + i] = 0.5 * (l[i] + r[i]);
    };
    const prev = this.prevTail;
    if (o.separated && prev && prev.session === o.session && prev.k === o.k - 1 && prev.data.length === c) buf.set(prev.data, 0);
    else mixAt(start - CONTEXT_S, c, 0);
    mixAt(start, n, c);
    let voice: Float32Array | null = null;
    if (o.separated) {
      voice = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        voice[i] = 0.5 * (o.left[i] + o.right[i]);
        buf[c + i] = VOICE_MIX * voice[i] + (1 - VOICE_MIX) * buf[c + i];
      }
    }
    mixAt(start + n / rate, c, c + n);
    this.prevTail = o.separated ? { session: o.session, k: o.k, data: buf.slice(n, n + c) } : null;

    const t0 = performance.now();
    const asrIn = normalizeLevel(toMono16k(buf, null, rate));
    const r = await asr.transcribe(asrIn, voice ? { voice: { audio: toMono16k(voice, null, rate), offset: CONTEXT_S } } : {});
    const asrMs = performance.now() - t0;
    const off = start - CONTEXT_S;
    const words = r.words.map((w) => ({ text: w.text, start: w.start + off, end: w.end + off }));
    // share of silent (missing) audio in the left/right context — debugging aid
    const filled = (a: number, b: number) => {
      let z = 0;
      for (let i = a; i < b; i++) if (buf[i] !== 0) z++;
      return +(z / Math.max(1, b - a)).toFixed(2);
    };
    const meta: RecognitionMeta = { lang: r.lang, langProb: r.langProb, passes: r.passes, asrMs, context: [filled(0, c), filled(c + n, c + n + c)] };
    if (o.debug) meta.input = Array.from(asrIn, (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767));
    return { words, meta };
  }

  /**
   * The one way words enter censoring: match them (findProfanity), add swear words the previous
   * tile found reaching into this one, mute/beep the spans in the tile, and re-censor the previous
   * tile when a word on the seam was found only now.
   */
  censorWords(o: FilterInput, words: Word[], meta: RecognitionMeta): { report: TileProfanityReport; patch?: TilePatch } {
    const { rate, start } = o;
    const n = o.left.length;
    const end = start + n / rate;
    const hits = findProfanity(words)
      .filter((w) => w.end > start - 0.2 && w.start < end + 0.2)
      .map(({ text, start: s, end: e }) => ({ text, start: s, end: e }));
    const cr = this.carry;
    if (cr && cr.session === o.session && cr.k === o.k - 1) {
      for (const h of cr.hits) if (!hits.some((x) => x.start < h.end && x.end > h.start)) hits.push(h);
    }
    this.carry = { session: o.session, k: o.k, hits: hits.filter((h) => h.end > end - 0.1) };
    const spans = hits.length ? applyCensor([o.left, o.right], rate, start, hits, { mode: o.mode }) : [];
    const info: TileProfanityReport = { ...meta, words: words.filter((w) => w.end > start - CONTEXT_S && w.start < end + CONTEXT_S), hits, spans };
    let patch: TilePatch | undefined;

    // The previous tile heard a word on the seam only half (its right context is the original
    // mix, not the voice) and may have missed it; this tile heard it whole. Re-censor the
    // previous tile and send it again — it is normally still far ahead of the playhead.
    const po = this.prevOut;
    if (po && po.session === o.session && po.k === o.k - 1) {
      const back = hits.filter((h) => h.start < start + 0.05);
      const covered = (sp: Span) => po.info.spans.some((q) => q.start <= sp.start + 0.02 && q.end >= sp.end - 0.02);
      const L = po.left.slice();
      const R = po.right.slice();
      const extra = back.length ? applyCensor([L, R], rate, po.start, back, { mode: o.mode }) : [];
      if (extra.some((sp) => !covered(sp))) {
        const pinfo: TileProfanityReport = { ...po.info, hits: [...po.info.hits, ...back], spans: [...po.info.spans, ...extra] };
        patch = { k: po.k, start: po.start, validFrom: po.validFrom, left: L, right: R, profanity: pinfo };
        po.left = L.slice();
        po.right = R.slice();
        po.info = pinfo;
      }
    }
    this.prevOut = { session: o.session, k: o.k, start, validFrom: o.validFrom, left: o.left.slice(), right: o.right.slice(), info };
    return { report: info, patch };
  }
}

/**
 * Whisper's log-mel input is not fully level-invariant; bring windows to a typical speech level
 * (RMS ≈ −16 dBFS), at most ×8, without clipping.
 */
function normalizeLevel(x: Float32Array): Float32Array {
  let s = 0;
  let peak = 0;
  for (const v of x) {
    s += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  const r = Math.sqrt(s / Math.max(1, x.length));
  if (r < 1e-4) return x;
  const g = Math.min(8, 0.16 / r, 0.99 / Math.max(peak, 1e-6));
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/**
 * Tile `k`'s output samples (`left`/`right`, at `rate`, from media time `start`), censored in
 * place; `decoded` is the original mix around it (the tile ± context when available);
 * `separated` tells whether the tile holds the separated voice.
 */
export interface FilterInput {
  session: number;
  k: number;
  start: number;
  validFrom: number;
  rate: number;
  left: Float32Array;
  right: Float32Array;
  decoded: DecodedAudio;
  separated: boolean;
  mode: CensorMode;
  /** Debug: include the recognizer's input in the report. */
  debug?: boolean;
}
