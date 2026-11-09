import { IntervalSet } from '../src/core/intervals';
import { NUDENET_LABELS, detectFaces, faceCrop, femaleProb, femaleScore, letterbox, personFromBody, personFromFace, rgbaToChw, scoreFrames } from '../src/core/nudenet';
import { ShotTracker, THUMB_H, THUMB_W, isCut, makeThumb, thumbDiff } from '../src/core/shots';
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

type F = { t: number; nude: number; skin: number; female: number; women: number[] };
const fr = (t: number, o: Partial<F> = {}): F => ({ t, nude: 0, skin: 0, female: 0, women: [], ...o });
const woman = (t: number, x: number, y = 0.2, w = 0.2, h = 0.6, p = 0.9): F => fr(t, { female: p, women: [x, y, w, h, p] });
const inside = (rs: number[][], x: number, y: number) => rs.some((r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]);

test('VisionTimeline: a woman is blurred where she is, for her whole shot', () => {
  const tl = new VisionTimeline();
  // shots: [0,4) empty room · [4,9) a woman on the left, face only found from 6 s · [9,12) a man
  const frames: F[] = [];
  for (let t = 0; t < 12; t += 0.5) {
    if (t >= 6 && t < 9) frames.push(woman(t, 0.1));
    else frames.push(fr(t, { female: t >= 4 && t < 9 ? 0.1 : 0 }));
  }
  tl.add({ from: 0, to: 12, frames, cuts: [4, 9], cutRange: [0, 12], edges: [] });
  const all = { women: true };
  assert(tl.decide(2, all).verdict === 'clear', 'empty room clear');
  const at4 = tl.decide(4.0, all);
  assert(at4.verdict === 'region' && inside(at4.rects, 0.2, 0.5) && !inside(at4.rects, 0.7, 0.5), `from the cut, before her face shows: ${JSON.stringify(at4)}`);
  const at7 = tl.decide(7.2, all);
  assert(at7.verdict === 'region' && inside(at7.rects, 0.2, 0.5) && !inside(at7.rects, 0.8, 0.5), 'where she is');
  assert(tl.decide(3.99, all).verdict === 'clear' && tl.decide(9.0, all).verdict === 'clear', 'switches exactly at the cuts');
  assert(tl.decide(7, { women: false }).verdict === 'clear', 'women policy off');
  assert(tl.decide(13, all).verdict === 'unknown', 'unchecked');
});

test('VisionTimeline: needs the shot checked ahead; nudity blurs the whole frame', () => {
  const tl = new VisionTimeline();
  tl.add({ from: 0, to: 3, frames: [fr(0), fr(1), fr(2)], cuts: [], cutRange: [0, 3], edges: [] });
  assert(tl.decide(0.5, { women: true }).verdict === 'clear', 'checked 2 s ahead');
  assert(tl.decide(1.5, { women: true }).verdict === 'unknown', 'shot continues into unchecked video');
  assert(tl.decide(1.5, { women: true }, 3).verdict === 'clear', 'unless the video ends');
  // the next GOP: a cut at 3.5, then nudity in that shot
  tl.add({ from: 3, to: 6, frames: [fr(3), fr(3.5), fr(4, { nude: 0.8 }), fr(5)], cuts: [3.5], cutRange: [3, 6], edges: [[3, 0]] });
  assert(tl.decide(1.5, { women: true }, 99).verdict === 'clear', 'shot ends at the cut');
  assert(tl.decide(3.6, { women: false }).verdict === 'full' && tl.decide(5.5, { women: false }, 6).verdict === 'full', 'nudity: the whole shot');
  assert(tl.decide(3.4, { women: false }).verdict === 'clear', 'previous shot not');
  // re-analysis replaces the cut list inside its range
  tl.add({ from: 3, to: 6, frames: [fr(4)], cuts: [], cutRange: [3, 6], edges: [] });
  assert(tl.cutTimes.length === 0 && tl.decide(3.4, { women: false }, 6).verdict === 'clear', 'cut taken back, nudity gone');
});

test('VisionTimeline: between looks; turned away; reach limit', () => {
  const tl = new VisionTimeline();
  const frames: F[] = [woman(0, 0.1), woman(0.5, 0.3), fr(1), fr(1.5), fr(2), fr(2.5), fr(3)];
  for (let t = 3.5; t < 30; t += 0.5) frames.push(fr(t));
  tl.add({ from: 0, to: 30, frames, cuts: [], cutRange: [0, 30], edges: [] });
  const mid = tl.decide(0.25, { women: true });
  assert(mid.verdict === 'region' && inside(mid.rects, 0.2, 0.5) && inside(mid.rects, 0.4, 0.5), 'covers both looks around t');
  const away = tl.decide(2.0, { women: true });
  assert(away.verdict === 'region' && away.rects.length === 1 && inside(away.rects, 0.15, 0.5) && inside(away.rects, 0.45, 0.5), 'not seen now: everywhere she was');
  assert(tl.decide(12, { women: true }).verdict === 'clear', 'a long take: no further than SHOT_REACH');
});

test('Person regions from a face and body parts', () => {
  const face = { x: 0.45, y: 0.1, w: 0.1, h: 0.15 };
  const r = personFromFace(face, [{ x: 0.3, y: 0.5, w: 0.15, h: 0.1 }, { x: 0.9, y: 0.5, w: 0.05, h: 0.05 }]);
  assert(r.x <= 0.3 && r.x + r.w >= 0.62 && r.y <= 0.05 && r.y + r.h === 1, `hair, shoulders, body to the frame edge: ${JSON.stringify(r)}`);
  assert(r.x + r.w < 0.9, 'parts far to the side are someone else');
  const b = personFromBody({ x: 0.4, y: 0.5, w: 0.1, h: 0.1 });
  assert(b.y <= 0.25 && b.x <= 0.32 && b.x + b.w >= 0.58, `head above the chest: ${JSON.stringify(b)}`);
});

/** Synthetic THUMB_W×THUMB_H RGBA "scene": a gradient with an offset and a colour. */
function scene(shift: number, rgb: [number, number, number], noise = 2): Uint8Array {
  const a = new Uint8Array(THUMB_W * THUMB_H * 4);
  for (let y = 0; y < THUMB_H; y++)
    for (let x = 0; x < THUMB_W; x++) {
      const i = (y * THUMB_W + x) * 4;
      const g = (((x + shift) * 7 + y * 5) % 160) + Math.random() * noise;
      a[i] = Math.min(255, rgb[0] * 0.4 + g);
      a[i + 1] = Math.min(255, rgb[1] * 0.4 + g);
      a[i + 2] = Math.min(255, rgb[2] * 0.4 + g);
      a[i + 3] = 255;
    }
  return a;
}

test('Shot cuts: hard cut yes; noise, pan, flash no', () => {
  const A = makeThumb(scene(0, [200, 40, 40])), A2 = makeThumb(scene(0, [200, 40, 40]));
  const B = makeThumb(scene(9, [30, 60, 220]));
  assert(!isCut(thumbDiff(A, A2)), 'noise');
  assert(isCut(thumbDiff(A, B)), 'new shot');
  const st = new ShotTracker();
  const res: string[] = [];
  let t = 0;
  const push = (rgba: Uint8Array) => {
    const r = st.push(+(t += 0.04).toFixed(2), makeThumb(rgba));
    res.push(`${r.cut ? 'C' : '.'}${r.sample ? 's' : ''}`);
  };
  for (let i = 0; i < 30; i++) push(scene(i, [200, 40, 40])); // slow pan: no cuts
  push(scene(0, [250, 250, 250], 0)); // flash for one frame…
  for (let i = 30; i < 34; i++) push(scene(i, [200, 40, 40])); // …and back
  for (let i = 0; i < 20; i++) push(scene(0, [30, 60, 220])); // cut to a still shot
  assert(st.cuts.length === 1 && Math.abs(st.cuts[0] - 1.44) < 1e-6, `one cut at 1.44 s, flash taken back: ${st.cuts} ${res.join(' ')}`);
  const sampled = res.filter((x) => x.includes('s')).length;
  assert(res[0] === '.s' && res[35] === 'Cs', `first frame and the cut frame are classified: ${res.join(' ')}`);
  assert(sampled <= 12, `few looks at a still shot: ${sampled}`);
});
