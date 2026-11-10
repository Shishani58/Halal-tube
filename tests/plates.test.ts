import { cutPlates, findPlates, platesBetween } from '../src/core/plates';
import { VisionTimeline } from '../src/core/vision-timeline';
import { assert, test } from './harness';

/** A w×h frame: dark room, bright card over [x0,x1)×[y0,y1) (frame-relative), a warm blob (a person) at the right. */
function frame(w: number, h: number, card: number[] | null, person = true): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      let c = [40 + 20 * u, 70, 55]; // the room, a soft gradient
      if (person && Math.hypot((u - 0.72) / 0.2, (v - 0.5) / 0.45) < 1) c = [150, 90, 80 + 10 * Math.sin(x / 3)];
      if (card && u >= card[0] && u < card[2] && v >= card[1] && v < card[3]) {
        c = [238, 240, 236];
        // text lines
        const line = Math.floor(y / 6);
        // words of varying lengths at varying places, as on a real slide
        if (line % 4 === 0 && (x * 7 + line * 31) % 23 < 11 && u > card[0] + 0.03 && u < card[2] - 0.03 && v > card[1] + 0.05) c = [60, 60, 70];
      }
      const p = (y * w + x) * 4;
      px[p] = c[0];
      px[p + 1] = c[1];
      px[p + 2] = c[2];
      px[p + 3] = 255;
    }
  return px;
}

test('findPlates: a slide laid over the picture is found; a plain picture and a person are not', () => {
  const [w, h] = [320, 180];
  const plates = findPlates(frame(w, h, [0.03, 0.12, 0.55, 0.9]), w, w, h);
  assert(plates.length === 1, `one plate: ${JSON.stringify(plates)}`);
  const [x, y, pw, ph] = plates[0];
  assert(Math.abs(x - 0.03) < 0.03 && Math.abs(x + pw - 0.55) < 0.03 && Math.abs(y - 0.12) < 0.04 && Math.abs(y + ph - 0.9) < 0.04, `where it is: ${plates[0]}`);
  assert(findPlates(frame(w, h, null), w, w, h).length === 0, 'a person in a room is no plate');
  assert(findPlates(frame(w, h, null, false), w, w, h).length === 0, 'an empty room neither');
});

test('cutPlates: the plate is taken out of the blur, the head stays covered', () => {
  // the real case: a close-up, face on the right, a slide over the left half; her body box reaches into it
  const plate = [[0.019, 0.114, 0.519, 0.873]];
  const head = [0.6, 0.15, 0.26, 0.5, 1];
  const box = [0.416, 0, 0.584, 1];
  const [cut] = cutPlates([box], plate, [head]);
  assert(cut[0] >= 0.538 - 1e-9 && cut[0] + cut[2] === 1 && cut[1] === 0 && cut[3] === 1, `cut at the plate's edge: ${cut}`);
  assert(cutPlates([box], [], [head])[0] === box, 'no plates: untouched');
  // a plate that would take the head with it, or only grazes a corner, changes nothing
  assert(JSON.stringify(cutPlates([box], [[0.5, 0.1, 0.45, 0.7]], [head])[0]) === JSON.stringify(box), 'head inside the plate: no cut');
  assert(JSON.stringify(cutPlates([box], [[0.1, 0.05, 0.33, 0.2]], [head])[0]) === JSON.stringify(box), 'corner graze: no cut');
});

test('platesBetween: a plate that just left must not uncover her; one that just came is cut a look later', () => {
  const a = [[0.02, 0.1, 0.52, 0.8]];
  assert(platesBetween(a, []).length === 0, 'gone in the next look');
  assert(platesBetween([], a).length === 0, 'not there before');
  assert(platesBetween(a, [[0.021, 0.1, 0.52, 0.8]]).length === 1, 'in both');
  assert(platesBetween(a, null).length === 1 && platesBetween(null, a).length === 1, 'one side only');
});

test('VisionTimeline: found women stay blurred when the checking is close behind the playhead (not strict)', () => {
  const tl = new VisionTimeline();
  const frames = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ t, nude: 0, skin: 0, female: 0.95, women: [0.4, 0.1, 0.2, 0.3, 0.95, 0.4, 0.4, 0.2, 0.5, 0.95], parts: [1, 2], plates: [0.02, 0.1, 0.3, 0.8] }));
  tl.add({ from: 0, to: 1.2, frames, cuts: [], cutRange: [0, 1.2], edges: [] });
  // video goes on past 1.2 s but isn't checked yet
  const lax = tl.decide(0.9, { women: true });
  assert(lax.verdict === 'region' && lax.rects.length > 0, `region: ${lax.verdict}`);
  assert(lax.plates?.length === 1, `plates reported: ${JSON.stringify(lax.plates)}`);
  assert(tl.decide(0.9, { women: true, strict: true }).verdict === 'unknown', 'strict: not known yet');
  assert(tl.decide(0.9, { women: false }).verdict === 'unknown', 'nothing found: nothing to act on yet');
});
