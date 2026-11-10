import { SELFTEST_MAX_ERR, compareSamples, sampleOutput, testInput } from '../src/core/selftest';
import { assert, test } from './harness';

test('selftest: the input is deterministic, in range, and differs by seed', () => {
  const a = testInput([2, 3, 4], 7, [-1, 1]), b = testInput([2, 3, 4], 7, [-1, 1]), c = testInput([2, 3, 4], 8, [-1, 1]);
  assert(a.length === 24 && a.every((x, i) => x === b[i]), 'same seed, same input');
  assert(a.some((x, i) => x !== c[i]), 'other seed, other input');
  assert(a.every((x) => x >= -1 && x < 1), 'range');
  // a fixed value: the reference files depend on this generator never changing
  assert(Math.abs(testInput([1], 20240601, [0, 1])[0] - 0.8744056) < 1e-6, `first value ${testInput([1], 20240601, [0, 1])[0]}`);
});

test('selftest: sampleOutput takes evenly spaced values, first and last included', () => {
  const s = sampleOutput(Float32Array.from({ length: 101 }, (_, i) => i), 11);
  assert(JSON.stringify(s) === JSON.stringify([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), JSON.stringify(s));
  assert(sampleOutput([5, 6], 1024).length === 2, 'short output');
});

test('selftest: fp16-sized noise passes, broken output does not', () => {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const ref = Array.from({ length: 1024 }, () => 5 * rnd());
  const fp16 = ref.map((x) => x * (1 + 0.004 * rnd()));
  assert(compareSamples(fp16, ref).ok, 'half-precision noise');
  const garbage = ref.map(() => 5 * rnd());
  assert(!compareSamples(garbage, ref).ok, 'unrelated numbers');
  assert(!compareSamples(ref.map(() => 0), ref).ok, 'all zeros');
  assert(!compareSamples(ref.map((x, i) => (i === 500 ? NaN : x)), ref).ok, 'one NaN');
  assert(!compareSamples(ref.map((x) => x * 0.7), ref).ok && compareSamples(ref.map((x) => x * 0.97), ref).ok, 'a wrong scale is caught, a small one is not');
  assert(!compareSamples(ref.slice(1), ref).ok, 'length mismatch');
  assert(!compareSamples([0, 0], [0, 0]).ok, 'a reference of zeros proves nothing');
  assert(SELFTEST_MAX_ERR > 0.02 && SELFTEST_MAX_ERR < 0.5, 'threshold between fp16 noise and garbage');
});

test('selftest: the audio test signal is deterministic, finite and quiet enough, with a voice and a chord in it', async () => {
  const { testAudio } = await import('../src/core/selftest');
  const [a, b] = testAudio(44100, 44100, 5), [c] = testAudio(44100, 44100, 5), [d] = testAudio(44100, 44100, 6);
  assert(a.every((x, i) => x === c[i]), 'same seed, same signal');
  assert(a.some((x, i) => x !== d[i]), 'the seed changes the noise');
  assert(a.every((x) => Number.isFinite(x) && Math.abs(x) < 1), 'finite, below full scale');
  assert(a.some((x, i) => x !== b[i]), 'the channels differ a little');
  const rms = Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  assert(rms > 0.02 && rms < 0.5, `level ${rms.toFixed(3)}`);
});
