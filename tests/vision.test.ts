import { IntervalSet } from '../src/core/intervals';
import { NUDENET_LABELS, ZOOM_PER_FRAME, detectFaces, faceCrop, femaleProb, femaleScore, letterbox, personFromBody, personFromFace, rgbaToChw, scoreFrames, shareZooms, zoomCrops, zoomFaces } from '../src/core/nudenet';
import { ShotTracker, THUMB_H, THUMB_W, isCut, makeThumb, thumbDiff } from '../src/core/shots';
import { VisionTimeline, isWoman, pictureWomen } from '../src/core/vision-timeline';
import { StableBoxes } from '../src/core/stable-boxes';
import { contentBox, pictureKey, thumbKey } from '../src/content/thumbs';
import { clipTiles, tileBox } from '../src/core/clip';
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
  // the crop is wider than the box and higher (NudeNet's face box sits low)
  const c = faceCrop(faces[0], { scale: 1.4, dy: -0.1 });
  assert(Math.abs(c.side - 70) < 1e-6 && Math.abs(c.x - 65) < 1e-6 && Math.abs(c.y - 60) < 1e-6, JSON.stringify(c));
  assert(Math.abs(femaleProb(new Float32Array([2, 0, 0.3]), 0) - 0.8808) < 1e-3, 'softmax');
  assert(Math.abs(femaleProb(new Float32Array([3, 0, 0.3, 0, 1, 0.3]), 0, 2) - 0.7311) < 1e-3, 'mean logit over crops');
  assert(femaleScore([0.2, 0.9], 0) === 0.9 && femaleScore([], 0.5) === 0 && Math.abs(femaleScore([0.1], 0.7) - 0.56) < 1e-9, 'female score (a body class counts 0.8×)');
});

test('Zoom: a face the detector half-saw is looked at again, larger; neighbours share the crop', () => {
  const rows = 4 + NUDENET_LABELS.length;
  const A = 6;
  const tensor = (faces: [number, number, number, number][]) => {
    const out = new Float32Array(rows * A);
    faces.forEach(([cx, cy, size, s], a) => {
      out[0 * A + a] = cx; out[1 * A + a] = cy; out[2 * A + a] = size; out[3 * A + a] = size;
      out[(4 + NUDENET_LABELS.indexOf('FACE_FEMALE')) * A + a] = s;
    });
    return out;
  };
  // wide shot, 320×180 in a 320×192 input: a sure face (no zoom), a 20 px one at 0.19, noise at 0.08
  const out = tensor([[250, 40, 40, 0.8], [55, 45, 20, 0.19], [150, 150, 10, 0.08]]);
  const crops = zoomCrops(out, 1, 0, 10, 320, 180, 320, 192);
  assert(crops.length === 1, JSON.stringify(crops));
  const c = crops[0];
  // 2× (40 px / 20 px): half the frame each way, the input's aspect, inside the frame, the face in it
  assert(Math.abs(c.w - 0.5) < 1e-6 && Math.abs((c.w * 320) / (c.h * 180) - 320 / 192) < 1e-6, JSON.stringify(c));
  assert(c.x >= 0 && c.y >= 0 && c.x + c.w <= 1 + 1e-9 && c.y + c.h <= 1 + 1e-9 && 55 / 320 > c.x && 45 / 180 > c.y && 45 / 180 < c.y + c.h, JSON.stringify(c));
  // a face found in the crop's input maps back into the frame where it is
  const inCrop = tensor([[(55 / 320 - c.x) * 2 * 320, (45 / 180 - c.y) * 180 * 2, 40, 0.7]]);
  const back = zoomFaces(inCrop, 1, 0, c, 320, 180, 320);
  assert(back.length === 1 && Math.abs(back[0].x + back[0].w / 2 - 55) < 0.5 && Math.abs(back[0].y + back[0].h / 2 - 45) < 0.5 && Math.abs(back[0].w - 20) < 1e-6, JSON.stringify(back));
  // frames 1 s around one that asked for a crop get it too; 2.5 s away and duplicates don't
  const plan = shareZooms([9, 10, 11, 13.5], [[], [c], [{ ...c, t: 11, x: c.x + 0.01 }], []]);
  assert(plan[0].length === 1 && plan[1].length === 1 && plan[2].length === 1 && plan[3].length === 0, JSON.stringify(plan.map((p) => p.length)));
  assert(plan[0][0].t === 9, 'a shared crop is for the frame it is given to');
  const many = Array.from({ length: 6 }, (_, i) => ({ ...c, x: i * 0.15, w: 0.1, h: 0.1, score: 0.2 }));
  assert(shareZooms([10], [many])[0].length === ZOOM_PER_FRAME, 'capped per frame');
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

test('VisionTimeline: flickering weak "skin" on clothes is not nudity; steady skin is', () => {
  // real scores of two men in dark jackets (youtube yKUPd7BW4P4, 157.8–164.8 s) that blurred 7 s of frame
  const clothed = [0.464, 0.141, 0.179, 0.087, 0.203, 0.27, 0.451, 0.574, 0.197, 0.024, 0.197, 0.235, 0.299, 0.266, 0.341, 0.072, 0.058, 0.14, 0.427, 0.323, 0.299, 0.296, 0.374, 0.411, 0.514, 0.332, 0.289, 0.544, 0.389, 0.446, 0.467, 0.255, 0.349];
  const tl = new VisionTimeline();
  tl.add({ from: 0, to: 12, frames: clothed.map((s, i) => fr(i * 0.2, { skin: s })), cuts: [], cutRange: [0, 12], edges: [] });
  for (const t of [0.1, 3, 6.4]) assert(tl.decide(t, { women: false }, 12).verdict === 'clear', `clothes at ${t}`);
  // a bare torso: high on every look, or one very sure look
  const bare = new VisionTimeline();
  bare.add({ from: 0, to: 6, frames: [0, 1, 2, 3, 4, 5].map((t) => fr(t, { skin: t >= 2 && t < 5 ? 0.55 : 0 })).concat([fr(0.5), fr(1.5)]), cuts: [], cutRange: [0, 6], edges: [] });
  assert(bare.decide(2.5, { women: false }, 6).verdict === 'clear', 'one look at 0.55 per second: not repeated enough');
  const steady = new VisionTimeline();
  steady.add({ from: 0, to: 6, frames: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((t) => fr(t, { skin: t >= 1 && t <= 1.5 ? 0.55 : 0 })), cuts: [], cutRange: [0, 6], edges: [] });
  assert(steady.decide(1.2, { women: false }, 6).verdict === 'full', 'three looks at 0.55 within 0.75 s');
  const sure = new VisionTimeline();
  sure.add({ from: 0, to: 6, frames: [fr(0), fr(1, { skin: 0.7 }), fr(2), fr(3)], cuts: [], cutRange: [0, 6], edges: [] });
  assert(sure.decide(2.5, { women: false }, 6).verdict === 'full', 'one look at 0.7');
});

test('VisionTimeline: a woman who stays put gets one still box; one who walks is followed', () => {
  const tl = new VisionTimeline();
  // shot [0,10): she sits on the left (her box jitters a little from look to look)
  // shot [10,20): she walks left → right · shot [20,40): seen at the start, then gone
  const frames: F[] = [];
  for (let t = 0; t < 10; t += 0.5) frames.push(woman(t, 0.1 + (Math.round(t * 2) % 3) * 0.01));
  for (let t = 10; t < 20; t += 0.5) frames.push(woman(t, 0.04 * (t - 10)));
  for (let t = 20; t < 40; t += 0.5) frames.push(t < 21 ? woman(t, 0.3) : fr(t));
  tl.add({ from: 0, to: 40, frames, cuts: [10, 20], cutRange: [0, 40], edges: [] });
  const all = { women: true };
  const seat = [0.3, 2.1, 5.7, 9.9].map((t) => JSON.stringify(tl.decide(t, all).rects));
  assert(seat.every((x) => x === seat[0]), `still box: ${seat.join(' ')}`);
  const box = tl.decide(5, all).rects[0];
  assert(box.length === 5 && box[4] === 0 && box[0] < 0.1 - 0.02 && box[0] + box[2] > 0.32 + 0.02, `margin for arms and legs: ${box}`);
  const walk = tl.decide(15, all);
  assert(walk.verdict === 'region' && inside(walk.rects, 0.3, 0.5) && !inside(walk.rects, 0.05, 0.5) && !inside(walk.rects, 0.75, 0.5), `followed: ${JSON.stringify(walk.rects)}`);
  assert(walk.shot === 10, 'reports its shot');
  assert(tl.decide(25, all).verdict === 'region', 'not seen now: still blurred where she was');
  assert(tl.decide(35, all).verdict === 'clear', 'a long take: no further than SHOT_REACH');
});

test('StableBoxes: grow at once, shrink late, start over at a cut', () => {
  const sb = new StableBoxes();
  const her = [0.4, 0.2, 0.2, 0.6];
  const [b0] = sb.update([her], 'shot1', 0);
  assert(b0[0] < 0.4 && b0[0] + b0[2] > 0.6, 'padded');
  // small moves and duplicate looks: the box doesn't move
  const same = sb.update([[0.405, 0.21, 0.2, 0.59], [0.398, 0.2, 0.2, 0.6]], 'shot1', 100);
  assert(same.length === 1 && JSON.stringify(same[0]) === JSON.stringify(b0), `still: ${JSON.stringify(same)}`);
  // she leans out: covered right away
  const [b1] = sb.update([[0.45, 0.2, 0.2, 0.6]], 'shot1', 200);
  assert(b1[0] + b1[2] >= 0.65 && b1[0] <= b0[0] + 1e-9, `grows: ${b1}`);
  // much smaller need: shrinks only after a while
  const small = [0.45, 0.3, 0.06, 0.1];
  assert(JSON.stringify(sb.update([small], 'shot1', 1000)[0]) === JSON.stringify(b1), 'not yet');
  sb.update([small], 'shot1', 2000);
  const [b2] = sb.update([small], 'shot1', 3100);
  assert(b2[2] < 0.2 && b2[0] <= 0.45 && b2[0] + b2[2] >= 0.51, `shrinks to fit: ${b2}`);
  // a new shot: boxes start over
  const [b3] = sb.update([[0.0, 0.0, 0.1, 0.1]], 'shot2', 3200);
  assert(b3[0] === 0 && b3[2] < 0.2, `new shot: ${b3}`);
  assert(sb.update([], 'shot2', 3300).length === 1 && sb.update([], 'shot2', 3600).length === 0, 'held briefly, then gone');
});

test('Thumbnails: one verdict per video, whatever the size', () => {
  const k = thumbKey('https://i.ytimg.com/vi/abc_-1/hqdefault.jpg?sqp=x&rs=y');
  assert(k === 'abc_-1' && thumbKey('https://i9.ytimg.com/vi_webp/abc_-1/mqdefault.webp') === k && thumbKey('https://i.ytimg.com/an_webp/abc_-1/mqdefault_6s.webp?du=3000') === k, k);
});

test('Person regions from a face and body parts', () => {
  const face = { x: 0.45, y: 0.1, w: 0.1, h: 0.15 };
  const [head, r] = personFromFace(face, [{ x: 0.3, y: 0.5, w: 0.15, h: 0.1 }, { x: 0.9, y: 0.5, w: 0.05, h: 0.05 }]);
  assert(head.y <= 0.01 && head.x <= 0.43 && head.x + head.w >= 0.57 && head.x > 0.35 && head.x + head.w < 0.65, `head with the hair, no wider: ${JSON.stringify(head)}`);
  assert(r.y <= head.y + head.h && r.y >= 0.15, `body from the shoulders, touching the head: ${JSON.stringify(r)}`);
  assert(r.x <= 0.3 && r.x + r.w >= 0.62 && r.y + r.h === 1, `shoulders, arms, body to the frame edge: ${JSON.stringify(r)}`);
  assert(r.x + r.w < 0.9, 'parts far to the side are someone else');
  const b = personFromBody({ x: 0.4, y: 0.5, w: 0.1, h: 0.1 });
  assert(b.y <= 0.25 && b.x <= 0.32 && b.x + b.w >= 0.58, `head above the chest: ${JSON.stringify(b)}`);
  // a close-up (face a fifth of the frame wide, right of centre): the body box must not reach
  // over to a slide on the left half of the frame
  const [, close] = personFromFace({ x: 0.663, y: 0.238, w: 0.209, h: 0.374 }, []);
  assert(close.x >= 0.45 && close.x + close.w <= 1, `close-up body stays on her: ${JSON.stringify(close)}`);
  const [, wide] = personFromFace(face, [{ x: 0.1, y: 0.5, w: 0.8, h: 0.2 }]);
  assert(wide.x >= 0.5 - 2.5 * face.w - 1e-9 && wide.x + wide.w <= 0.5 + 2.5 * face.w + 1e-9, `a wide stray part can't stretch the body over the frame: ${JSON.stringify(wide)}`);
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

test('Heads and bodies are tracked apart but shown as one blur', () => {
  const tl = new VisionTimeline();
  // a close-up: she leans down and back up; the head of one look overlaps the body of another
  const frames = [];
  for (let t = 0; t < 6; t += 0.5) {
    const dy = (Math.round(t * 2) % 4) * 0.06;
    frames.push({ t, nude: 0, skin: 0, female: 0.9, women: [0.35, 0.02 + dy, 0.3, 0.55, 0.9, 0.05, 0.5 + dy, 0.9, 0.5, 0.9], parts: [1, 2] });
  }
  tl.add({ from: 0, to: 6, frames, cuts: [], cutRange: [0, 6], edges: [] });
  const d = tl.decide(3, { women: true }, 6);
  assert(d.verdict === 'region' && d.rects.length === 2, `two boxes: ${JSON.stringify(d.rects)}`);
  const head = d.rects.find((r) => r[4] === 1)!;
  assert(head[0] > 0.2 && head[0] + head[2] < 0.8, `head box leaves the sides open: ${head}`);
  const sb = new StableBoxes();
  const shown = sb.update(d.rects, 's', 0);
  assert(shown.length === 1, `head and body are shown as one blur: ${JSON.stringify(shown)}`);
  const far = sb.update([[0.02, 0.02, 0.1, 0.1, 1], [0.7, 0.6, 0.25, 0.35, 2]], 'far', 0);
  assert(far.length === 2, `boxes far apart stay separate: ${JSON.stringify(far)}`);
});

/** A person seen by her face: head and body rects, both at probability p; `at` is the head's left edge. */
const person = (t: number, p: number, at: number): F & { parts: number[] } => ({
  t, nude: 0, skin: 0, female: p, women: [at, 0.1, 0.12, 0.2, p, at - 0.05, 0.3, 0.22, 0.6, p], parts: [1, 2],
});
const some = (tl: VisionTimeline, t: number, women = true) => tl.decide(t, { women }, 20);

test('VisionTimeline: one stray "woman" look does not make a man a woman', () => {
  // a man on the left (looks at 0.02–0.1, one at 0.55), a woman on the right (0.6–0.95, one at 0.1)
  const man = [0.05, 0.1, 0.02, 0.55, 0.04, 0.08, 0.03, 0.06, 0.1, 0.02];
  const her = [0.9, 0.85, 0.1, 0.95, 0.6, 0.8, 0.9, 0.7, 0.88, 0.92];
  const tl = new VisionTimeline();
  const frames = man.map((p, i) => {
    const a = person(i * 0.5, p, 0.1), b = person(i * 0.5, her[i], 0.7);
    return { ...a, female: Math.max(p, her[i]), women: [...a.women, ...b.women], parts: [1, 2, 1, 2] };
  });
  tl.add({ from: 0, to: 6, frames, cuts: [], cutRange: [0, 6], edges: [] });
  const d = some(tl, 2.5);
  assert(d.verdict === 'region' && d.rects.length === 2, `only her (head and body): ${JSON.stringify(d.rects)}`);
  assert(d.rects.every((r) => r[0] > 0.55), `not him: ${JSON.stringify(d.rects)}`);
});

test('VisionTimeline: a woman the classifier is unsure of is still found; one look needs to be sure', () => {
  const tl = new VisionTimeline();
  tl.add({ from: 0, to: 6, frames: [0.9, 0.2, 0.6, 0.15, 0.7, 0.5].map((p, i) => person(i, p, 0.4)), cuts: [], cutRange: [0, 6], edges: [] });
  assert(some(tl, 2).verdict === 'region', 'mean 0.5, three looks vote woman');
  const one = new VisionTimeline();
  one.add({ from: 0, to: 3, frames: [person(0, 0.4, 0.4), person(1, 0.4, 0.4)].slice(0, 1), cuts: [], cutRange: [0, 3], edges: [] });
  assert(some(one, 0.5).verdict === 'clear', 'a single look at 0.4 is not enough');
  const sure = new VisionTimeline();
  sure.add({ from: 0, to: 3, frames: [person(0, 0.8, 0.4)], cuts: [], cutRange: [0, 3], edges: [] });
  assert(some(sure, 0.5).verdict === 'region', 'a single look at 0.8 is');
  assert(isWoman({ n: 4, votes: 1, mean: 0.5, max: 0.9 }, 1) === false, 'one voting look of four is not a majority');
});

test('VisionTimeline: a woman\'s voice lifts only the most woman-like face', () => {
  const tl = new VisionTimeline();
  const frames = [0, 1, 2, 3, 4, 5].map((t) => {
    const a = person(t, 0.22, 0.1), b = person(t, 0.08, 0.6); // two faces the classifier doubts, her more
    return { ...a, women: [...a.women, ...b.women], parts: [1, 2, 1, 2] };
  });
  tl.add({ from: 0, to: 6, frames, cuts: [], cutRange: [0, 6], edges: [] });
  assert(some(tl, 2).verdict === 'clear', 'nobody is a woman by the picture');
  tl.addVoice(0, [220, 230, 210, 225, 240, 0, 215, 220, 235, 228, 0, 0]);
  const d = some(tl, 2);
  assert(d.verdict === 'region' && d.rects.length === 2 && d.rects.every((r) => r[0] < 0.4), `the likelier face only: ${JSON.stringify(d.rects)}`);
  const men = new VisionTimeline();
  men.add({ from: 0, to: 6, frames: [0, 1, 2, 3, 4, 5].map((t) => person(t, 0.05, 0.1)), cuts: [], cutRange: [0, 6], edges: [] });
  men.addVoice(0, [220, 230, 210, 225, 240, 0, 215, 220, 235, 228, 0, 0]);
  assert(some(men, 2).verdict === 'clear', 'a face the classifier calls a man (0.05) stays a man');
});

test('VisionTimeline: a woman seen by her body alone needs two looks; men stay out of the scene-model blur', () => {
  const body = (t: number, p: number): F => ({ t, nude: 0, skin: 0, female: p, women: [0.3, 0.2, 0.2, 0.6, p] });
  const one = new VisionTimeline();
  one.add({ from: 0, to: 5, frames: [fr(0), body(1, 0.7), fr(2), fr(3)], cuts: [], cutRange: [0, 5], edges: [] });
  assert(some(one, 1).verdict === 'clear', 'one revealing-clothes look at 0.7: a man in a printed T-shirt');
  const two = new VisionTimeline();
  two.add({ from: 0, to: 5, frames: [fr(0), body(1, 0.7), body(1.5, 0.65), fr(3)], cuts: [], cutRange: [0, 5], edges: [] });
  assert(some(two, 1).verdict === 'region', 'two looks');
  // the scene model says "women" on every look; nobody located
  const clip = (men: boolean) => {
    const tl = new VisionTimeline();
    const frames = [0, 1, 2, 3, 4].map((t) => ({ ...(men ? person(t, 0.03, 0.4) : fr(t)), scene: t === 4 ? 0.1 : 0.8 }));
    tl.add({ from: 0, to: 6, frames, cuts: [], cutRange: [0, 6], edges: [] });
    return some(tl, 1.5).verdict;
  };
  assert(clip(false) === 'full', 'nobody found, 4 of 5 looks say women: whole frame');
  assert(clip(true) === 'full', '…and a man in the picture still needs only 80%: 4 of 5');
  const tl = new VisionTimeline();
  tl.add({ from: 0, to: 6, frames: [0, 1, 2, 3, 4].map((t) => ({ ...person(t, 0.03, 0.4), scene: t < 3 ? 0.9 : 0.2 })), cuts: [], cutRange: [0, 6], edges: [] });
  assert(some(tl, 1.5).verdict === 'clear', 'men found, 3 of 5 looks say women: the scene model is probably wrong');
});

test('Thumbnail: a woman is judged by all looks at her; a man outvotes a stray crop', () => {
  const look = (p: number, x = 0.2): { t: number; nude: number; skin: number; female: number; women: number[] } => ({ t: 0, nude: 0, skin: 0, female: p, women: [x, 0.2, 0.1, 0.15, p] });
  // seen whole and in a part, both sure: a woman
  assert(pictureWomen([look(0.9), look(0.8)]).female === 0.9, 'woman');
  // one crop says 0.7, the whole picture says "man": mean 0.375 → not a woman
  assert(pictureWomen([look(0.05), look(0.7)]).female === 0, 'man outvotes a stray crop');
  // a single look needs THRESHOLDS.thumbFemale
  assert(pictureWomen([look(0.55)]).female === 0 && pictureWomen([look(0.65)]).female === 0.65, 'single look');
  // a man elsewhere in the picture doesn't hide the woman, and isn't one
  const both = { t: 0, nude: 0, skin: 0, female: 0, women: [0.2, 0.2, 0.1, 0.15, 0.9, 0.7, 0.2, 0.1, 0.15, 0.03] };
  assert(pictureWomen([both]).female === 0.9, 'woman and man');
  const men = { t: 0, nude: 0, skin: 0, female: 0, women: [0.7, 0.2, 0.1, 0.15, 0.03] };
  assert(pictureWomen([men, men]).female === 0, 'men only');
  // an unsure face (0.35) counts only in soft mode, i.e. when the scene model backs it up; a man's (0.05) never
  assert(pictureWomen([look(0.35)]).female === 0 && pictureWomen([look(0.35)], 'unsure').female === 0.6, 'unsure face');
  assert(pictureWomen([look(0.05)], 'unsure').female === 0, 'a man is no woman even when softened');
  const men2 = { t: 0, nude: 0, skin: 0, female: 0, women: [0.1, 0.2, 0.1, 0.15, 0.03, 0.7, 0.2, 0.1, 0.15, 0.03] };
  // the picture's only person is taken whatever the classifier said; with two people, no guessing which
  assert(pictureWomen([look(0.05), look(0.06)], 'lone').rects.length === 1, 'lone person');
  assert(pictureWomen([men2], 'lone').rects.length === 0, 'two people: not lone');
  // only the woman gets a box, the man beside her none
  const w = pictureWomen([both]);
  assert(w.rects.length === 1 && w.rects[0][0] <= 0.2 && w.rects[0][0] + w.rects[0][2] < 0.5, JSON.stringify(w.rects));
});

test('Thumbnail: object-fit maps the picture into the <img> box; keys are per picture', () => {
  // 4:3 picture in a 16:9 box, cover: scaled to the width, cropped top and bottom
  const c = contentBox(480, 360, 320, 180, 'cover', '50% 50%');
  assert(Math.abs(c.w - 320) < 1e-6 && Math.abs(c.h - 240) < 1e-6 && Math.abs(c.y + 30) < 1e-6, JSON.stringify(c));
  const f = contentBox(480, 360, 320, 180, 'fill', '50% 50%');
  assert(f.x === 0 && f.w === 320 && f.h === 180, 'fill');
  const n = contentBox(480, 360, 320, 180, 'contain', '50% 50%');
  assert(Math.abs(n.w - 240) < 1e-6 && Math.abs(n.x - 40) < 1e-6, JSON.stringify(n));
  assert(pictureKey('https://i.ytimg.com/vi/a/hqdefault.jpg?sqp=x') === '//i.ytimg.com/vi/a/hqdefault.jpg' && pictureKey('https://i.ytimg.com/vi/a/mqdefault.jpg') !== pictureKey('https://i.ytimg.com/vi/a/hqdefault.jpg'), 'key');
});

test('Thumbnail strips: the scene model locates women without a face', () => {
  const tiles = clipTiles(320, 180);
  assert(tiles.length === 5 && tiles[0][0] === 0 && tiles[4][0] + tiles[4][2] === 320 && clipTiles(100, 200).length === 0, JSON.stringify(tiles));
  // the real scores of a woman (left) beside a man on a 320×180 thumbnail
  const box = tileBox([0.873, 0.905, 0.237, 0.1, 0.04], tiles, 320)!;
  assert(box[0] === 0 && box[3] === 1 && box[2] > 0.3 && box[2] < 0.7, JSON.stringify(box));
  assert(tileBox([0.2, 0.1, 0.5, 0.3, 0.02], tiles, 320) === null, 'no strip says "woman"');
});
