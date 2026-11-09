/**
 * Speech-recognition benchmark page (tests/e2e/asr-bench.mjs drives it): loads a Whisper model
 * the way the worker does and transcribes tile-sized windows of a test recording.
 */
import { findProfanity, type Word } from '../core/profanity';
import { loadAsr, type Asr } from '../processor/asr';

const out = document.getElementById('out')!;
const log = (s: string) => (out.textContent += s + '\n');
const base = new URL('../', location.href).href;

const TILE = 253440 / 44100;
const CONTEXT = 1;

let asr: Asr | null = null;

async function load(name: string) {
  if (asr) await asr.release();
  asr = null;
  const t0 = performance.now();
  asr = await loadAsr(base, name);
  const loadMs = performance.now() - t0;
  log(`[${name}] loaded in ${(loadMs / 1000).toFixed(1)} s`);
  return { loadMs };
}

/** Transcribe every tile window [k·T − C, (k+1)·T + C] of 16 kHz mono audio. */
async function run(audioB64: string, label: string, voiceOnly = false) {
  if (!asr) throw new Error('no model');
  const bin = atob(audioB64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const audio = new Float32Array(u.buffer);
  const R = 16000;
  const tiles = Math.ceil(audio.length / R / TILE);
  const res: { k: number; lang: string; langProb: number; passes: number; text: string; detectMs: number; transcribeMs: number; words: Word[]; hits: Word[] }[] = [];
  for (let k = 0; k < tiles; k++) {
    const a = k * TILE - CONTEXT;
    const b = (k + 1) * TILE + CONTEXT;
    const win = new Float32Array(Math.round((b - a) * R));
    const off = Math.round(a * R);
    for (let i = 0; i < win.length; i++) win[i] = audio[off + i] ?? 0;
    const r = await asr.transcribe(win, voiceOnly ? { voiceSpan: [0, win.length / R] } : {});
    const words = r.words.map((w) => ({ ...w, start: w.start + a, end: w.end + a }));
    const hits = findProfanity(words).filter((w) => w.end > k * TILE && w.start < (k + 1) * TILE);
    res.push({ k, lang: r.lang, langProb: r.langProb, passes: r.passes, text: r.text, detectMs: r.ms.detect, transcribeMs: r.ms.transcribe, words, hits });
    log(`[${asr.name}/${label}] tile ${k} ${r.lang} p=${r.langProb.toFixed(2)} ×${r.passes} ${(r.ms.detect + r.ms.transcribe).toFixed(0)} ms: ${r.text}`);
  }
  return res;
}

Object.assign(window, { __asr: { load, run } });
log('ready');
