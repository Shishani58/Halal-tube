import { VOICE_STEP, voicePitch, voiceSex } from '../src/core/voice';
import { VisionTimeline } from '../src/core/vision-timeline';
import { assert, test } from './harness';

/** A synthetic voice: harmonics of f0 (with vibrato), in syllables, with a little noise. */
function speech(f0: number, seconds: number, rate = 44100): Float32Array {
  const n = Math.round(seconds * rate);
  const x = new Float32Array(n);
  let ph = 0;
  let seed = 1;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    ph += (2 * Math.PI * f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 3 * t))) / rate;
    let s = 0;
    for (let h = 1; h <= 12; h++) s += Math.sin(h * ph) / h;
    seed = (seed * 16807) % 2147483647;
    x[i] = 0.15 * s * Math.sqrt(Math.sin(Math.PI * ((t * 2.5) % 1))) + 0.003 * (seed / 2147483647 - 0.5);
  }
  return x;
}

test('Voice pitch: a man, a woman, silence', () => {
  for (const [f0, sex] of [[110, 'm'], [125, 'm'], [210, 'f'], [240, 'f']] as const) {
    const x = speech(f0, 5.75);
    const p = voicePitch(x, x, 44100);
    assert(p.length >= 11, `windows: ${p.length}`);
    const full = p.slice(0, 11);
    assert(full.every((v) => Math.abs(v - f0) < 0.06 * f0), `${f0} Hz: ${p.join(' ')}`);
    assert(full.every((v) => voiceSex(v) === sex), `${f0} Hz is ${sex}`);
  }
  const z = new Float32Array(44100 * 3);
  assert(voicePitch(z, z, 44100).every((v) => v === 0), 'silence: no voice');
  assert(voiceSex(158) === null && voiceSex(0) === null, 'between the ranges: unknown');
});

test('VisionTimeline: a woman’s voice lets an unsure face count', () => {
  const tl = new VisionTimeline();
  // one shot, a face the classifier is unsure about (0.12) on the left
  const frames = [];
  for (let t = 0; t < 10; t += 0.5) frames.push({ t, nude: 0, skin: 0, female: 0.12, women: [0.1, 0.2, 0.2, 0.6, 0.12] });
  tl.add({ from: 0, to: 10, frames, cuts: [], cutRange: [0, 10], edges: [] });
  const all = { women: true };
  assert(tl.decide(3, all, 10).verdict === 'clear', 'unsure face alone: not blurred');
  // a man speaks: nothing changes
  tl.addVoice(0, Array(12).fill(115));
  assert(tl.decide(3, all, 10).verdict === 'clear', 'a man’s voice: not blurred');
  // the same tile again, now a woman speaks (replaces what was known there)
  tl.addVoice(0, [0, 0, 220, 215, 0, 230, 210, 0, 205, 0, 225, 0]);
  const d = tl.decide(3, all, 10);
  assert(d.verdict === 'region' && d.rects.length === 1, `a woman’s voice: blurred ${JSON.stringify(d)}`);
  // mostly a man, a little of a woman: not enough
  tl.addVoice(0, [115, 120, 220, 118, 117, 116, 119, 121, 118, 0, 0, 0]);
  assert(tl.decide(3, all, 10).verdict === 'clear', 'mostly a man’s voice: not blurred');
  assert(VOICE_STEP === 0.5, 'step');
});
