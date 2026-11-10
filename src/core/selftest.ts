/**
 * WebGPU self-test. A GPU stack (driver, ONNX Runtime's shaders, an fp16 or int8 variant of a model)
 * can compute wrong numbers without an error: safe frames then score as unsafe, the separated "voice"
 * is noise. The cure is to compare one run with a trusted one. A model is run on a fixed
 * pseudo-random input and its output is compared with the same model's output on the CPU, made
 * beforehand (scripts/make-selftest.ts → static/selftest.json). The CPU result doesn't depend on
 * the machine, so nothing is computed at run time but the one run the warm-up already does.
 */

export interface SelfTestRef {
  /** Input the reference was made with (the model's usual input shape). */
  shape: number[];
  seed: number;
  /** 'audio': the input is the spectrogram of testAudio (the caller builds it, LoadOptions.selfTestInput); otherwise uniform noise. */
  kind?: 'audio';
  /** The noise input is uniform in [lo, hi). */
  range: [number, number];
  /** Evenly spaced samples of the model's first output on the CPU. */
  ref: number[];
}

/** Share (RMS of the difference over RMS of the reference) above which the GPU result is wrong. fp16 weights differ by ~0.5 %, a broken kernel by 100 %. */
export const SELFTEST_MAX_ERR = 0.1;
export const SELFTEST_SAMPLES = 1024;

const size = (shape: readonly number[]) => shape.reduce((a, b) => a * b, 1);

/** Deterministic input: xorshift32, the same in every JS engine and in the script that made the reference. */
export function testInput(shape: readonly number[], seed: number, range: readonly [number, number]): Float32Array {
  const out = new Float32Array(size(shape));
  let x = seed >>> 0 || 1;
  const [lo, hi] = range;
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = lo + (hi - lo) * (x / 4294967296);
  }
  return out;
}

/**
 * A deterministic stereo test signal that looks like what the separation model gets: a voice (a
 * gliding pitch with harmonics, a formant-like envelope and a syllable rhythm), a chord with
 * tremolo behind it, and a little noise. Random noise is no stand-in: its spectrogram makes the
 * network's activations huge, and fp16 then differs from fp32 by ~12 % where real audio differs by
 * ~0.5 % — a test on noise would reject a perfectly good fp16 model.
 */
export function testAudio(n: number, rate: number, seed: number): [Float32Array, Float32Array] {
  const L = new Float32Array(n), R = new Float32Array(n);
  let x = seed >>> 0 || 1;
  const noise = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 2147483648 - 1;
  };
  const chord = [220, 277.18, 329.63, 440];
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f0 = 130 + 50 * Math.sin(2 * Math.PI * 0.35 * t); // pitch glides 80–180 Hz
    phase += (2 * Math.PI * f0) / rate;
    let voice = 0;
    for (let h = 1; h <= 18; h++) voice += Math.sin(h * phase) * Math.exp(-0.5 * ((h * f0 - 700) / 500) ** 2) / h;
    voice *= Math.max(0, Math.sin(2 * Math.PI * 3.3 * t)) ** 0.5; // syllables
    let music = 0;
    for (const f of chord) music += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * 2 * f * t);
    music *= 0.12 * (0.7 + 0.3 * Math.sin(2 * Math.PI * 2 * t));
    const e = 0.01 * noise();
    L[i] = 0.35 * voice + music + e;
    R[i] = 0.35 * voice + 0.9 * music - e;
  }
  return [L, R];
}

/** `n` evenly spaced values of an output. */
export function sampleOutput(out: ArrayLike<number>, n = SELFTEST_SAMPLES): number[] {
  const len = out.length;
  const m = Math.min(n, len);
  const s: number[] = [];
  for (let i = 0; i < m; i++) s.push(out[m === 1 ? 0 : Math.floor((i * (len - 1)) / (m - 1))]);
  return s;
}

export interface SelfTestResult {
  ok: boolean;
  /** Relative RMS error (Infinity: not comparable). */
  err: number;
  why?: string;
}

/** Is the GPU's output the reference's, within fp16 noise? */
export function compareSamples(got: readonly number[], ref: readonly number[], maxErr = SELFTEST_MAX_ERR): SelfTestResult {
  if (got.length !== ref.length || !ref.length) return { ok: false, err: Infinity, why: 'sample count differs' };
  let d = 0, r = 0;
  for (let i = 0; i < ref.length; i++) {
    if (!Number.isFinite(got[i])) return { ok: false, err: Infinity, why: 'non-finite output' };
    d += (got[i] - ref[i]) ** 2;
    r += ref[i] ** 2;
  }
  if (r < 1e-12) return { ok: false, err: Infinity, why: 'reference is all zeros' };
  const err = Math.sqrt(d / r);
  return { ok: err <= maxErr, err, why: err <= maxErr ? undefined : `error ${(err * 100).toFixed(1)} % of the reference` };
}
