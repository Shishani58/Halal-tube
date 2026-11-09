/**
 * Silencing or beeping spans of audio (profanity filter), plus the audio prep for speech
 * recognition. Works on one tile at a time; all times are absolute media seconds, so spans
 * that cross a tile boundary are handled piecewise by both tiles and the beep stays phase-
 * continuous across the seam.
 */

export interface Span {
  start: number;
  end: number;
}

export type CensorMode = 'mute' | 'beep';

export interface CensorOptions {
  mode: CensorMode;
  /** Extra time masked after (and, unless padBefore is given, before) each word (s). */
  pad?: number;
  /** Extra time masked before each word (s). */
  padBefore?: number;
  /** Raised-cosine ramp length at each edge (s), inside the padded span. */
  fade?: number;
  /** Beep frequency (Hz). */
  beepHz?: number;
}

/**
 * After the timing calibration in asr.ts, recognized word edges are within about ±60–100 ms of
 * the true ones (tests/e2e/asr-bench.mjs, profanity.mjs), starts more often late than early,
 * so the pad is a bit wider than 60 ms, and wider before the word than after it.
 */
export const CENSOR_PAD = 0.08;
export const CENSOR_PAD_BEFORE = 0.1;
export const CENSOR_FADE = 0.01;
export const BEEP_HZ = 1000;
/** Beep level bounds (peak amplitude) in case the measured speech level is silent or clipped. */
const BEEP_MIN = 0.03;
const BEEP_MAX = 0.6;

/** Pad every span and merge the ones that touch or overlap. Sorted output. */
export function padAndMerge(spans: Span[], pad: number, padBefore = pad): Span[] {
  const s = spans
    .filter((x) => x.end > x.start - 1e-9)
    .map((x) => ({ start: x.start - padBefore, end: x.end + pad }))
    .sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

/**
 * Masking weight w(t) ∈ [0, 1] for one padded span: 0 outside, 1 inside, raised-cosine ramps of
 * `fade` seconds just inside both edges.
 */
export function spanWeight(t: number, span: Span, fade: number): number {
  if (t <= span.start || t >= span.end) return 0;
  const f = Math.min(fade, (span.end - span.start) / 2);
  if (f <= 0) return 1;
  const a = t - span.start;
  const b = span.end - t;
  const x = Math.min(a, b);
  if (x >= f) return 1;
  return 0.5 - 0.5 * Math.cos((Math.PI * x) / f);
}

function rms(ch: Float32Array[], i0: number, i1: number): number {
  let s = 0;
  let n = 0;
  for (const c of ch) {
    for (let i = Math.max(0, i0); i < Math.min(c.length, i1); i++) {
      s += c[i] * c[i];
      n++;
    }
  }
  return n ? Math.sqrt(s / n) : 0;
}

/**
 * Silence or beep the given word spans in place.
 *  - channels: the tile's output audio (stereo), first sample at media time `t0`.
 *  - words: raw word spans (unpadded) in media seconds; they may extend outside the tile.
 *  - levelRef: optional audio (same timing as `channels`) whose loudness sets the beep level;
 *    defaults to `channels` (measured before masking).
 * Returns the padded/merged spans that intersect the tile.
 */
export function applyCensor(
  channels: Float32Array[],
  sampleRate: number,
  t0: number,
  words: Span[],
  opts: CensorOptions,
  levelRef: Float32Array[] = channels,
): Span[] {
  const pad = opts.pad ?? CENSOR_PAD;
  const padBefore = opts.padBefore ?? (opts.pad !== undefined ? opts.pad : CENSOR_PAD_BEFORE);
  const fade = opts.fade ?? CENSOR_FADE;
  const hz = opts.beepHz ?? BEEP_HZ;
  const n = channels[0]?.length ?? 0;
  const t1 = t0 + n / sampleRate;
  const spans = padAndMerge(words, pad, padBefore).filter((s) => s.end > t0 && s.start < t1);
  // Beep level: match the RMS of the speech under each (unpadded) word, so the beep is as loud
  // as the word it replaces. A sine with peak A has RMS A/√2.
  const levels = spans.map((sp) => {
    const inner = words.filter((w) => w.end > sp.start && w.start < sp.end);
    let s = 0;
    let d = 0;
    for (const w of inner) {
      const i0 = Math.floor((Math.max(w.start, t0) - t0) * sampleRate);
      const i1 = Math.ceil((Math.min(w.end, t1) - t0) * sampleRate);
      if (i1 <= i0) continue;
      const r = rms(levelRef, i0, i1);
      s += r * r * (i1 - i0);
      d += i1 - i0;
    }
    const r = d ? Math.sqrt(s / d) : 0;
    return Math.min(BEEP_MAX, Math.max(BEEP_MIN, r * Math.SQRT2));
  });
  spans.forEach((sp, j) => {
    const i0 = Math.max(0, Math.floor((sp.start - t0) * sampleRate));
    const i1 = Math.min(n, Math.ceil((sp.end - t0) * sampleRate));
    const amp = levels[j];
    for (let i = i0; i < i1; i++) {
      const t = t0 + i / sampleRate;
      const w = spanWeight(t, sp, fade);
      if (w <= 0) continue;
      const beep = opts.mode === 'beep' ? amp * Math.sin(2 * Math.PI * hz * t) : 0;
      for (const c of channels) c[i] = c[i] * (1 - w) + beep * w;
    }
  });
  return spans;
}

/**
 * Downmix stereo to mono and resample to `dstRate` with an anti-aliasing low-pass
 * (windowed sinc), for speech recognition (Whisper wants 16 kHz mono).
 */
export function toMono16k(
  left: Float32Array,
  right: Float32Array | null,
  srcRate: number,
  dstRate = 16000,
): Float32Array {
  const n = left.length;
  const mono = new Float32Array(n);
  if (right) for (let i = 0; i < n; i++) mono[i] = 0.5 * (left[i] + right[i]);
  else mono.set(left);
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(n / ratio);
  const out = new Float32Array(outLen);
  // cutoff a bit below the new Nyquist
  const fc = (0.45 * dstRate) / srcRate; // cycles per source sample
  const half = Math.ceil(8 * ratio);
  const taps = new Float32Array(2 * half + 1);
  let sum = 0;
  for (let k = -half; k <= half; k++) {
    const x = 2 * fc * k;
    const sinc = k === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const win = 0.42 + 0.5 * Math.cos((Math.PI * k) / half) + 0.08 * Math.cos((2 * Math.PI * k) / half); // Blackman
    taps[k + half] = sinc * win;
    sum += taps[k + half];
  }
  for (let k = 0; k < taps.length; k++) taps[k] /= sum;
  for (let j = 0; j < outLen; j++) {
    const pos = j * ratio;
    const c = Math.round(pos);
    let acc = 0;
    for (let k = -half; k <= half; k++) {
      const i = c + k;
      if (i >= 0 && i < n) acc += mono[i] * taps[k + half];
    }
    out[j] = acc;
  }
  return out;
}

/**
 * Seconds of speech-like energy in `audio` that no recognized word (±0.3 s) accounts for.
 * Meant for a separated voice track, where everything loud is voice.
 */
export function uncoveredSpeech(audio: Float32Array, rate: number, words: Span[]): number {
  const hop = Math.round(0.02 * rate);
  const frames = Math.floor(audio.length / hop);
  if (!frames) return 0;
  const e = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += audio[i] * audio[i];
    e[f] = Math.sqrt(s / hop);
  }
  const sorted = Float32Array.from(e).sort();
  const loud = sorted[Math.floor(0.95 * (frames - 1))];
  const thr = Math.max(0.01, 0.15 * loud);
  let n = 0;
  for (let f = 0; f < frames; f++) {
    if (e[f] < thr) continue;
    const t = (f + 0.5) * (hop / rate);
    if (!words.some((w) => t >= w.start - 0.3 && t <= w.end + 0.3)) n++;
  }
  return (n * hop) / rate;
}
