import { FFT } from '../src/core/fft';
import { MdxProcessor, KIM_VOCAL_2 } from '../src/core/mdx';
import { resampleCubic } from '../src/core/resample';
import { assert, test } from './harness';

test('FFT and inverse match naive DFT (N=60, 250, 360)', () => {
  for (const N of [60, 250, 360]) {
  const fft = new FFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) { re[i] = Math.sin(i * 0.37) + 0.1 * i; im[i] = Math.cos(i * 1.3); }
  const r0 = re.slice(), i0 = im.slice();
  fft.forward(re, im);
  for (let k = 0; k < N; k++) {
    let sr = 0, si = 0;
    for (let n = 0; n < N; n++) {
      const a = (-2 * Math.PI * k * n) / N;
      sr += r0[n] * Math.cos(a) - i0[n] * Math.sin(a);
      si += r0[n] * Math.sin(a) + i0[n] * Math.cos(a);
    }
    assert(Math.abs(sr - re[k]) < 1e-9 && Math.abs(si - im[k]) < 1e-9, `N=${N} bin ${k}`);
  }
  fft.inverse(re, im);
  for (let i = 0; i < N; i++) assert(Math.abs(re[i] - r0[i]) < 1e-9 && Math.abs(im[i] - i0[i]) < 1e-9, `inverse ${N}`);
  }
});

test('FFT N=7680 spot check + speed', () => {
  const N = 7680;
  const fft = new FFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = Math.random() - 0.5;
  const r0 = re.slice();
  fft.forward(re, im);
  for (const k of [0, 1, 7, 333, 3840, 7679]) {
    let sr = 0, si = 0;
    for (let n = 0; n < N; n++) {
      const a = (-2 * Math.PI * k * n) / N;
      sr += r0[n] * Math.cos(a);
      si += r0[n] * Math.sin(a);
    }
    assert(Math.abs(sr - re[k]) < 1e-7 && Math.abs(si - im[k]) < 1e-7, `bin ${k}`);
  }
  const t = performance.now();
  for (let i = 0; i < 512; i++) fft.forward(re, im);
  console.log(`    512 FFTs of 7680: ${(performance.now() - t).toFixed(0)} ms`);
});

test('MDX stft → istft round-trip reconstructs band-limited audio', () => {
  const mdx = new MdxProcessor(KIM_VOCAL_2);
  const L = mdx.chunkSize, sr = 44100;
  const left = new Float32Array(L), right = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    const t = i / sr;
    left[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 3100 * t);
    right[i] = 0.25 * Math.sin(2 * Math.PI * 440 * t + 1) + 0.1 * Math.sin(2 * Math.PI * 9000 * t);
  }
  const t0 = performance.now();
  const spec = mdx.stft(left, right);
  const t1 = performance.now();
  const [ol, or] = mdx.istftTrimmed(spec);
  const t2 = performance.now();
  console.log(`    stft ${(t1 - t0).toFixed(0)} ms, istft ${(t2 - t1).toFixed(0)} ms`);
  assert(ol.length === mdx.genSize, 'length');
  let maxErr = 0;
  const c = KIM_VOCAL_2.compensate;
  for (let j = 0; j < mdx.genSize; j++) {
    maxErr = Math.max(maxErr, Math.abs(ol[j] / c - left[j + mdx.trim]), Math.abs(or[j] / c - right[j + mdx.trim]));
  }
  console.log(`    max reconstruction error ${maxErr.toExponential(2)}`);
  assert(maxErr < 2e-3, `reconstruction error too large: ${maxErr}`);
});

test('resampleCubic 48k → 44.1k preserves a sine', () => {
  const src = new Float32Array(48000);
  for (let i = 0; i < src.length; i++) src[i] = Math.sin((2 * Math.PI * 1000 * i) / 48000);
  const out = resampleCubic(src, 48000, 0, 44100, 0.1, 30000);
  let maxErr = 0;
  for (let j = 0; j < out.length; j++) {
    const t = 0.1 + j / 44100;
    maxErr = Math.max(maxErr, Math.abs(out[j] - Math.sin(2 * Math.PI * 1000 * t)));
  }
  assert(maxErr < 2e-3, `resample error ${maxErr}`);
});

import { timeStretch } from '../src/core/stretch';
test('WSOLA time stretch keeps pitch, exact length, no level dips', () => {
  const n = 253440;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / 44100); R[i] = L[i]; }
  for (const rate of [1.25, 1.5, 2, 0.75]) {
    const t = performance.now();
    const [ol] = timeStretch(L, R, rate);
    const ms = performance.now() - t;
    assert(ol.length === Math.round(n / rate), `length @${rate}`);
    // pitch: count zero crossings in the middle second
    let zc = 0;
    const s = Math.floor(ol.length / 2) - 22050;
    for (let i = s + 1; i < s + 44100; i++) if ((ol[i - 1] < 0) !== (ol[i] < 0)) zc++;
    assert(Math.abs(zc / 2 - 300) < 6, `pitch @${rate}: ${zc / 2} Hz`);
    // envelope: RMS in 10 ms windows stays near 0.35 everywhere (no dips at tile edges)
    let minRms = 1;
    for (let w = 0; w + 441 <= ol.length; w += 441) {
      let e = 0;
      for (let i = w; i < w + 441; i++) e += ol[i] * ol[i];
      minRms = Math.min(minRms, Math.sqrt(e / 441));
    }
    assert(minRms > 0.3, `level dip @${rate}: ${minRms.toFixed(3)}`);
    console.log(`    rate ${rate}: ${ms.toFixed(0)} ms, min rms ${minRms.toFixed(3)}`);
  }
});
