/**
 * Who is speaking, by the pitch of the voice: a hint for blurring where the picture alone is hard
 * to judge (a face seen small, in profile, half hidden). Runs on the separated vocals of each audio
 * tile (music would throw the pitch off), so it is only there while music removal is on.
 *
 * YIN fundamental frequency every 20 ms on a ~11 kHz mono copy, then the median over each
 * VOICE_STEP window of the frames that are clearly voiced. Adult speaking voices: men mostly
 * 85–155 Hz, women 165–255 Hz.
 */

/** Seconds per reported window. */
export const VOICE_STEP = 0.5;
/** Windows at or above this F0 (Hz) sound like a woman (or a child)… */
export const VOICE_FEMALE_F0 = 165;
/** …at or below this, like a man; in between: can't tell. */
export const VOICE_MALE_F0 = 150;

const F0_MIN = 70;
const F0_MAX = 420;
/** Analysis frame length and hop (seconds). */
const FRAME = 0.03;
const HOP = 0.02;
/** YIN: first dip of the normalised difference below this is the period. */
const YIN_THRESHOLD = 0.15;
/** A frame is speech only above this RMS (≈ −40 dBFS)… */
const MIN_RMS = 0.01;
/** …and above this share of the loudest frame of the tile (vocal-stem bleed, breaths). */
const REL_RMS = 0.06;
/** A window has a pitch when at least this share of its frames are voiced. */
const MIN_VOICED = 0.3;

/**
 * Median F0 (Hz) of each VOICE_STEP window of a stereo clip that starts at its first sample;
 * 0 where nobody speaks (or what sounds isn't a voice).
 */
export function voicePitch(left: Float32Array, right: Float32Array, rate: number): number[] {
  const d = Math.max(1, Math.round(rate / 11025));
  const sr = rate / d;
  const n = Math.floor(Math.min(left.length, right.length) / d);
  const x = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < d; k++, j++) s += left[j] + right[j];
    x[i] = s / (2 * d);
  }
  const W = Math.round(FRAME * sr), H = Math.round(HOP * sr);
  const tMin = Math.floor(sr / F0_MAX), tMax = Math.ceil(sr / F0_MIN);
  const frames = n >= W + tMax ? Math.floor((n - W - tMax) / H) + 1 : 0;
  const rms = new Float32Array(frames);
  let loudest = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * H, end = i + W; i < end; i++) e += x[i] * x[i];
    rms[f] = Math.sqrt(e / W);
    loudest = Math.max(loudest, rms[f]);
  }
  const f0 = new Float32Array(frames);
  const diff = new Float32Array(tMax + 2);
  for (let f = 0; f < frames; f++) {
    if (rms[f] < MIN_RMS || rms[f] < REL_RMS * loudest) continue;
    const o = f * H;
    for (let tau = 1; tau <= tMax + 1; tau++) {
      let s = 0;
      for (let i = o, end = o + W; i < end; i++) {
        const v = x[i] - x[i + tau];
        s += v * v;
      }
      diff[tau] = s;
    }
    // cumulative mean normalised difference
    let sum = 0;
    let best = -1;
    for (let tau = 1; tau <= tMax + 1; tau++) {
      sum += diff[tau];
      diff[tau] = sum > 0 ? (diff[tau] * tau) / sum : 1;
    }
    for (let tau = tMin; tau <= tMax; tau++) {
      if (diff[tau] < YIN_THRESHOLD) {
        while (tau + 1 <= tMax && diff[tau + 1] < diff[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) continue;
    // parabolic interpolation around the dip
    const a = diff[best - 1], b = diff[best], c = diff[best + 1];
    const den = a - 2 * b + c;
    const t = den > 0 ? best + (0.5 * (a - c)) / den : best;
    f0[f] = sr / t;
  }
  const per = Math.max(1, Math.round(VOICE_STEP / HOP));
  const windows = Math.max(0, Math.round(n / sr / VOICE_STEP));
  const out: number[] = [];
  for (let w = 0; w < windows; w++) {
    const v: number[] = [];
    const end = Math.min(frames, (w + 1) * per);
    for (let f = w * per; f < end; f++) if (f0[f] > 0) v.push(f0[f]);
    // the last window may be short (frames need a period's worth of samples after them)
    if (end - w * per < per / 2 || v.length < MIN_VOICED * (end - w * per)) {
      out.push(0);
      continue;
    }
    v.sort((p, q) => p - q);
    out.push(Math.round(v[v.length >> 1]));
  }
  return out;
}

/** 'f': sounds like a woman · 'm': like a man · null: no voice, or can't tell. */
export function voiceSex(f0: number): 'f' | 'm' | null {
  if (!(f0 > 0)) return null;
  if (f0 >= VOICE_FEMALE_F0) return 'f';
  if (f0 <= VOICE_MALE_F0) return 'm';
  return null;
}
