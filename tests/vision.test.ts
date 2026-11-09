import { IntervalSet } from '../src/core/intervals';
import { NUDENET_LABELS, detectFaces, faceCrop, femaleProb, femaleScore, letterbox, rgbaToChw, scoreFrames } from '../src/core/nudenet';
import { VisionTimeline } from '../src/core/vision-timeline';
import { assert, test } from './harness';

test('IntervalSet merges, answers coverage, trims', () => {
  const s = new IntervalSet();
  s.add(5, 10);
  s.add(0, 2);
  s.add(10.05, 12); // joins (gap < 0.12)
  s.add(1.5, 3);
  assert(JSON.stringify(s.spans) === '[[0,3],[5,12]]', JSON.stringify(s.spans));
  assert(s.has(7) && s.has(0) && !s.has(4) && !s.has(12.2), 'has');
  assert(s.covers(5.5, 11.9) && !s.covers(2, 6), 'covers');
  assert(s.endFrom(6) === 12 && s.endFrom(4) === 4, 'endFrom');
  s.trimBefore(4);
  assert(s.spans.length === 1, 'trim');
});

test('NudeNet preprocessing: letterbox + planar BGR', () => {
  const lb = letterbox(1920, 1080);
  assert(lb.dw === 320 && lb.dh === 180, `letterbox ${lb.dw}x${lb.dh}`);
  const rgba = new Uint8Array(2 * 2 * 4).fill(0);
  rgba.set([255, 0, 51, 255], 4); // pixel 1
  const out = new Float32Array(12);
  rgbaToChw(rgba, 2, out);
  assert(Math.abs(out[1] - 0.2) < 1e-6 && out[4 + 1] === 0 && out[8 + 1] === 1, 'planar BGR');
});

test('NudeNet scores: max per class group, per image', () => {
  const rows = 4 + NUDENET_LABELS.length;
  const A = 10, B = 2;
  const out = new Float32Array(B * rows * A);
  const set = (b: number, label: string, a: number, v: number) => (out[(b * rows + 4 + NUDENET_LABELS.indexOf(label as never)) * A + a] = v);
  set(0, 'FEMALE_BREAST_COVERED', 3, 0.8);
  set(0, 'FACE_MALE', 4, 0.9);
  set(1, 'MALE_GENITALIA_EXPOSED', 7, 0.6);
  set(1, 'BELLY_EXPOSED', 1, 0.45);
  const [a, b] = scoreFrames(out, B);
  assert(Math.abs(a.femaleBody - 0.8) < 1e-6 && a.nude === 0 && a.skin === 0, JSON.stringify(a));
  assert(Math.abs(b.nude - 0.6) < 1e-6 && Math.abs(b.skin - 0.45) < 1e-6 && b.femaleBody === 0, JSON.stringify(b));
  assert(scoreFrames(out, B, 1).length === 1, 'count');
});

test('NudeNet faces: boxes + NMS; gender softmax; woman score', () => {
  const rows = 4 + NUDENET_LABELS.length;
  const A = 6;
  const out = new Float32Array(rows * A);
  const put = (a: number, cx: number, cy: number, w: number, h: number, label: string, s: number) => {
    out[0 * A + a] = cx; out[1 * A + a] = cy; out[2 * A + a] = w; out[3 * A + a] = h;
    out[(4 + NUDENET_LABELS.indexOf(label as never)) * A + a] = s;
  };
  put(0, 100, 100, 40, 50, 'FACE_FEMALE', 0.9);
  put(1, 102, 101, 40, 50, 'FACE_FEMALE', 0.8); // duplicate of 0 → suppressed
  put(2, 250, 80, 20, 20, 'FACE_MALE', 0.5);
  put(3, 30, 30, 10, 10, 'FACE_MALE', 0.2); // below threshold
  const faces = detectFaces(out, 1, 0);
  assert(faces.length === 2 && Math.abs(faces[0].score - 0.9) < 1e-6 && Math.abs(faces[0].x - 80) < 1e-6 && Math.abs(faces[0].y - 75) < 1e-6, JSON.stringify(faces));
  const c = faceCrop(faces[0]);
  assert(Math.abs(c.side - 60) < 1e-6 && Math.abs(c.x - 70) < 1e-6 && Math.abs(c.y - 70) < 1e-6, JSON.stringify(c));
  assert(Math.abs(femaleProb(new Float32Array([2, 0, 0.3]), 0) - 0.8808) < 1e-3, 'softmax');
  assert(femaleScore([0.2, 0.9], 0) === 0.9 && femaleScore([], 0.5) === 0 && femaleScore([0.1], 0.7) === 0.7, 'female score');
});

test('VisionTimeline: verdicts with pre/post margins and policy', () => {
  const tl = new VisionTimeline();
  // checked 0–10 s, a woman at 4.0 s, nudity at 8.0 s
  const samples: number[] = [];
  for (let t = 0; t < 10; t += 0.25) samples.push(t, t === 8 ? 0.7 : 0, 0, t === 4 ? 0.9 : 0.05);
  tl.add(0, 10, samples);
  const men = { women: false }, all = { women: true };
  assert(tl.decide(1, all) === 'safe', 'safe');
  assert(tl.decide(3.5, all) === 'unsafe' && tl.decide(4.9, all) === 'unsafe', 'woman blurred around 4 s');
  assert(tl.decide(3.3, all) === 'safe' && tl.decide(5.1, all) === 'safe', 'margins');
  assert(tl.decide(4, men) === 'safe', 'women policy off');
  assert(tl.decide(7.5, men) === 'unsafe' && tl.decide(8.9, men) === 'unsafe', 'nudity always');
  assert(tl.decide(12, all) === 'unknown', 'unchecked');
  // re-analysis replaces a sample
  tl.add(3.9, 4.1, [4, 0, 0, 0]);
  assert(tl.decide(4, all) === 'safe' && tl.sampleCount === 40, 'replace');
});
