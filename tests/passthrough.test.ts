import { assert, test } from './harness';
import { PASS_WINDOW_S, keepOriginalWhereClean } from '../src/core/passthrough';
import { DEFAULT_SETTINGS, cleanShare } from '../src/shared/messages';

const RATE = 8000;

/** Speech-like noise; "music" a tone added in [m0, m1) seconds. */
function make(seconds: number, m0: number, m1: number) {
  const n = seconds * RATE;
  let seed = 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const speech = new Float32Array(n).map(() => 0.2 * rnd());
  const orig = speech.slice();
  for (let i = Math.floor(m0 * RATE); i < Math.min(n, m1 * RATE); i++) orig[i] += 0.2 * Math.sin((2 * Math.PI * 440 * i) / RATE);
  return { speech, orig };
}

test('passthrough: plain speech (tiny difference) comes back as the original', () => {
  const { speech, orig } = make(4, 99, 99);
  const clean = speech.map((x) => x * 0.97); // the model's estimate is slightly off
  const origCopy = speech.slice();
  const cl = clean.slice(), cr = clean.slice();
  const r = keepOriginalWhereClean(cl, cr, origCopy, origCopy, RATE);
  assert(r.kept === 1, `kept ${r.kept}`);
  assert(cl.every((x, i) => x === orig[i]), 'equals the original everywhere');
});

test('passthrough: windows with music stay as separated, with a short crossfade at the edges', () => {
  const { speech, orig } = make(6, 2, 4); // music 2–4 s
  const cl = speech.slice(), cr = speech.slice(); // perfect separation
  const r = keepOriginalWhereClean(cl, cr, orig, orig, RATE);
  const w = PASS_WINDOW_S * RATE;
  // deep inside the music: untouched
  for (let i = 2.2 * RATE; i < 3.8 * RATE; i++) assert(cl[i] === speech[i], 'music span keeps the separated voice');
  // far from the music: the original (here equal to the speech)
  for (let i = 0; i < 1.4 * RATE; i++) assert(cl[i] === orig[i], 'clean span plays the original');
  assert(r.kept > 0.5 && r.kept < 0.75, `kept ${r.kept}`);
  assert(w === 4000, 'window size');
});

test('passthrough: silence and mismatched lengths are left alone', () => {
  const z = new Float32Array(RATE);
  assert(keepOriginalWhereClean(z, z, z, z, RATE).kept === 0, 'silence is not "kept"');
  assert(keepOriginalWhereClean(new Float32Array(0), new Float32Array(0), new Float32Array(0), new Float32Array(0), RATE).kept === 0, 'empty');
});

test('settings: cleanShare — strength only matters without the profanity filter', () => {
  const s = { ...DEFAULT_SETTINGS };
  assert(cleanShare(s) === 1, 'default 100%');
  assert(cleanShare({ ...s, musicStrength: 40 }) === 0.4, '40%');
  assert(cleanShare({ ...s, musicStrength: 40, profanity: 'mute' }) === 1, 'profanity filter forces full removal');
  assert(cleanShare({ ...s, musicStrength: 40, musicRemoval: false }) === 1, 'no music removal: nothing to mix');
  assert(cleanShare({ ...s, musicStrength: 250 }) === 1 && cleanShare({ ...s, musicStrength: -5 }) === 0, 'clamped');
  assert(cleanShare({ ...s, musicStrength: NaN as unknown as number }) === 1, 'garbage → full removal');
});
