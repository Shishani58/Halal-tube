import { assert, test } from './harness';
import { ClipBudget, clipMode, CLIP_START_LOOKS } from '../src/core/clip-budget';
import { THUMB_H, THUMB_W, type Thumb } from '../src/core/shots';

const flat = (luma: number): Thumb => ({ y: new Uint8Array(THUMB_W * THUMB_H).fill(luma), hist: Float32Array.from({ length: 64 }, (_, i) => (i === (luma >> 2) ? 1 : 0)) });
const A = flat(40);
const B = flat(200);

/** Looks the budget grants over frames every 0.25 s of a still shot. */
function looks(b: ClipBudget, from: number, to: number, th: Thumb, score: number, cut = false): number[] {
  const out: number[] = [];
  for (let t = from; t < to - 1e-9; t += 0.25) {
    if (b.want(t, th, cut && t === from, false)) {
      out.push(t);
      b.result(score);
    }
  }
  return out;
}

test('clip budget: a shot starts with two looks, then sparse ones', () => {
  const b = new ClipBudget();
  const got = looks(b, 0, 12, A, 0, true);
  assert(got.slice(0, CLIP_START_LOOKS).join() === '0,0.5', `start looks ${got}`);
  assert(got.length >= 4 && got.length <= 6, `a clear 12 s shot gets ${got.length} looks, not 48`);
  assert(got.slice(2).every((t, i, a) => i === 0 || t - a[i - 1] >= 3), 'clear shot: ≥ 3 s apart');
});

test('clip budget: a shot with women keeps ≥ 2 looks in every 8 s window', () => {
  const b = new ClipBudget();
  const got = looks(b, 0, 40, A, 0.9, true);
  for (let t = 0; t + 8 <= 40; t += 1) assert(got.filter((x) => x >= t && x < t + 8).length >= 2, `two looks within ${t}–${t + 8}`);
  assert(got.length < 14, `${got.length} looks for 40 s`);
});

test('clip budget: a cut, a big change and a jump back restart the two looks', () => {
  const b = new ClipBudget();
  looks(b, 0, 6, A, 0, true);
  assert(looks(b, 6, 7.5, A, 0, true).length === 2, 'cut: two looks');
  const c = new ClipBudget();
  looks(c, 0, 6, A, 0, true);
  assert(looks(c, 6, 7.5, B, 0).length === 2, 'changed picture: two looks');
  const d = new ClipBudget();
  looks(d, 20, 26, A, 0, true);
  assert(looks(d, 5, 6.5, A, 0).length === 2, 'back in time: two looks');
});

test('clip budget: decided frames and mode off get none; economy thins out', () => {
  const b = new ClipBudget();
  assert(!b.want(0, A, true, true), 'nudity / located woman: no look');
  b.mode = 'off';
  assert(!b.want(1, A, false, false), 'off');
  const full = looks(new ClipBudget(), 0, 60, A, 0, true).length;
  const eco = new ClipBudget();
  eco.mode = 'economy';
  assert(looks(eco, 0, 60, A, 0, true).length < full, 'economy has fewer looks');
});

test('clip mode governor: off while behind, back via economy, no flapping', () => {
  assert(clipMode('full', Infinity, 0) === 'full', 'unknown speed');
  assert(clipMode('full', 3, 1) === 'off', 'slow and nothing ahead');
  assert(clipMode('off', 10, 8) === 'off', 'stays off until a stretch is checked');
  assert(clipMode('off', 25, 8) === 'economy', 'recovers to economy');
  assert(clipMode('full', 30, 2) === 'economy', 'slow: economy');
  assert(clipMode('economy', 30, 3.5) === 'economy', 'hysteresis');
  assert(clipMode('economy', 30, 5) === 'full', 'fast again');
});
