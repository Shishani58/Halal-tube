import { VisionTimeline, isWoman, tuningFor, type BlurLevel } from '../src/core/vision-timeline';
import type { VisionFrame } from '../src/shared/vision-messages';
import { HOVER_CSS, HOVER_DELAY_MS } from '../src/content/thumb-hover';
import { assert, test } from './harness';

/** A timeline of one shot, 0–4 s, checked, with `frames` (4 per second). */
function shot(frames: Partial<VisionFrame>[]): VisionTimeline {
  const tl = new VisionTimeline();
  tl.add({
    from: 0,
    to: 12,
    frames: frames.map((f, i) => ({ t: i * 0.25, nude: 0, skin: 0, female: 0, women: [], ...f })),
    cuts: [],
    cutRange: [0, 12],
    edges: [],
  });
  return tl;
}
const verdict = (tl: VisionTimeline, level: BlurLevel) => tl.decide(1, { women: true, level }, 12).verdict;
/** A face looked at `n` times, each look `p` woman. */
const face = (p: number, n: number): Partial<VisionFrame>[] => Array.from({ length: n }, () => ({ women: [0.4, 0.2, 0.15, 0.2, p], parts: [1] }));

test('levels: normal is the original behaviour', () => {
  const t = tuningFor('normal');
  assert(t.nude === 0.5 && t.nudeWeak === 0.3 && t.nudeLooks === 3 && t.skin === 0.65 && t.person.mean === 0.4 && t.thumbFemale === 0.6, 'normal values');
  assert(tuningFor(undefined) === t, 'default is normal');
  assert(isWoman({ n: 3, votes: 3, mean: 0.45, max: 0.5 }, 1) === isWoman({ n: 3, votes: 3, mean: 0.45, max: 0.5 }, 1, t.person), 'same default');
});

test('levels: a weak nudity score is blurred only by stricter levels, and only when it repeats', () => {
  // one look of 0.27 is nothing at any level (strict wants two close together, normal 0.3 and three)
  const lone = shot([{ nude: 0.27 }, {}, {}, {}]);
  for (const l of ['soft', 'normal', 'strict'] as const) assert(verdict(lone, l) === 'clear', `one look 0.27 at ${l}`);
  const twice = shot([{ nude: 0.27 }, { nude: 0.27 }, {}, {}]);
  assert(verdict(twice, 'strict') === 'full', 'strict: 0.27 twice');
  assert(verdict(twice, 'normal') === 'clear' && verdict(twice, 'soft') === 'clear', 'normal and soft: not 0.27');
  // 0.35 three times in a row: normal and strict, not soft (soft wants 0.4)
  const mid = shot([{ nude: 0.35 }, { nude: 0.35 }, { nude: 0.35 }, {}]);
  assert(verdict(mid, 'normal') === 'full' && verdict(mid, 'strict') === 'full', '0.35 x3: normal and strict');
  assert(verdict(mid, 'soft') === 'clear', '0.35 x3: not soft');
  // 0.35 once: a bald head, not a body
  assert(verdict(shot([{ nude: 0.35 }, {}, {}, {}]), 'normal') === 'clear', 'one look at 0.35');
  // one sure look is enough
  const sure = shot([{ nude: 0.8 }, {}, {}, {}]);
  for (const l of ['soft', 'normal', 'strict'] as const) assert(verdict(sure, l) === 'full', `clear nudity blurred at ${l}`);
  assert(verdict(shot([{ nude: 0.5 }, {}, {}, {}]), 'normal') === 'full', 'one look at 0.5');
});

test('levels: a doubtful face — soft passes it, strict blurs it', () => {
  // five looks averaging 0.35 "woman"
  const tl = shot(face(0.35, 5));
  assert(verdict(tl, 'strict') === 'region', 'strict');
  assert(verdict(tl, 'normal') === 'clear', 'normal: mean 0.35 < 0.4');
  assert(verdict(tl, 'soft') === 'clear', 'soft');
  // a fairly sure woman: normal and strict, not soft
  const fair = shot(face(0.45, 5));
  assert(verdict(fair, 'normal') === 'region' && verdict(fair, 'strict') === 'region', 'normal+strict');
  assert(verdict(fair, 'soft') === 'clear', 'soft wants 0.5');
  const sure = shot(face(0.9, 5));
  for (const l of ['soft', 'normal', 'strict'] as const) assert(verdict(sure, l) === 'region', `sure woman at ${l}`);
});

test('levels: a man (p≈0.05) is not blurred at any level', () => {
  const tl = shot(face(0.05, 6));
  for (const l of ['soft', 'normal', 'strict'] as const) assert(verdict(tl, l) === 'clear', `man at ${l}`);
});

test('levels: the shot cache does not leak a verdict between levels', () => {
  const tl = shot(face(0.35, 5));
  const a = verdict(tl, 'strict'), b = verdict(tl, 'normal'), c = verdict(tl, 'strict');
  assert(a === 'region' && b === 'clear' && c === 'region', `${a} ${b} ${c}`);
});

test('levels: a scene-only woman (CLIP) needs more or fewer looks by level', () => {
  // 10 looks, 4 of them (40 %) score 0.7 on "women"
  const frames: Partial<VisionFrame>[] = Array.from({ length: 10 }, (_, i) => ({ scene: i < 4 ? 0.7 : 0.1 }));
  const tl = shot(frames);
  assert(verdict(tl, 'strict') === 'full', 'strict: 35 % is enough');
  assert(verdict(tl, 'normal') === 'clear', 'normal: needs 50 %');
});

test('hover reveal: CSS only lets through pictures tagged open, never unchecked ones', () => {
  assert(/\[data-mr-thumb\]\[data-mr-open\]/.test(HOVER_CSS), 'tagged pictures');
  assert(/\[data-mr-box\]\[data-mr-open\]/.test(HOVER_CSS), 'region boxes of a tagged picture');
  assert(!/data-mr-thumb="ok"|strict/.test(HOVER_CSS), 'unchecked / ok pictures are not in it');
  assert(HOVER_DELAY_MS >= 300, 'delayed');
});
