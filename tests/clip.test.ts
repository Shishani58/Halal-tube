import { CLIP_VIEWS, CLIP_WOMEN, clipFrameWomen, clipViews, clipWomen } from '../src/core/clip';
import { CLIP_TEXT_B64, CLIP_TEXT_DIM, CLIP_TEXT_KINDS, CLIP_TEXT_PROMPTS } from '../src/core/clip-text';
import { VisionTimeline } from '../src/core/vision-timeline';
import { assert, test } from './harness';

const text = new Float32Array(Uint8Array.from(Buffer.from(CLIP_TEXT_B64, 'base64')).buffer);
/** An image embedding that looks like prompt p (scaled: the image side isn't normalised). */
const like = (p: number, k = 3) => text.slice(p * CLIP_TEXT_DIM, (p + 1) * CLIP_TEXT_DIM).map((v) => v * k);

test('CLIP: prompt embeddings, women score, views', () => {
  assert(text.length === CLIP_TEXT_KINDS.length * CLIP_TEXT_DIM && CLIP_TEXT_PROMPTS.length === CLIP_TEXT_KINDS.length, 'one embedding per prompt');
  const w = CLIP_TEXT_KINDS.indexOf('W'), m = CLIP_TEXT_KINDS.indexOf('M'), n = CLIP_TEXT_KINDS.indexOf('N');
  assert(clipWomen(like(w), 0) > 0.9, `a woman: ${clipWomen(like(w), 0)}`);
  assert(clipWomen(like(m), 0) < 0.1 && clipWomen(like(n), 0) < 0.1, 'a man, no people');
  const three = new Float32Array([...like(w), ...like(w), ...like(n)]);
  const f = clipFrameWomen(three, 0);
  assert(CLIP_VIEWS === 3 && Math.abs(f - (2 * clipWomen(like(w), 0) + clipWomen(like(n), 0)) / 3) < 1e-9, 'mean of the views');
  assert(JSON.stringify(clipViews(960, 540)) === '[[0,0,540],[210,0,540],[420,0,540]]', `wide: ${JSON.stringify(clipViews(960, 540))}`);
  assert(JSON.stringify(clipViews(100, 200)) === '[[0,0,100],[0,50,100],[0,100,100]]', 'tall');
});

test('VisionTimeline: women only CLIP sees blur the whole frame, if seen on enough frames', () => {
  const fr = (t: number, scene: number, women: number[] = []) => ({ t, nude: 0, skin: 0, female: women.length ? women[4] : 0, women, scene });
  const tl = new VisionTimeline();
  // [0,4): dancers nobody located · [4,8): one stray frame · [8,12): she is located · [12,16): no scene scores
  const frames = [];
  for (let t = 0; t < 16; t += 0.5) {
    if (t < 4) frames.push(fr(t, t < 2 ? 0.9 : 0.2));
    else if (t < 8) frames.push(fr(t, t === 5 ? 0.95 : 0.05));
    else if (t < 12) frames.push(fr(t, 0.9, [0.4, 0.1, 0.2, 0.8, 0.9]));
    else frames.push({ t, nude: 0, skin: 0, female: 0, women: [] });
  }
  tl.add({ from: 0, to: 16, frames, cuts: [4, 8, 12], cutRange: [0, 16], edges: [] });
  const all = { women: true };
  assert(tl.decide(1, all, 16).verdict === 'full' && tl.decide(3.5, all, 16).verdict === 'full', 'dancers: the whole shot');
  assert(tl.decide(1, { women: false }, 16).verdict === 'clear', 'women policy off');
  assert(tl.decide(5, all, 16).verdict === 'clear', 'one stray frame: nothing');
  const d = tl.decide(10, all, 16);
  assert(d.verdict === 'region' && d.rects.length === 1, `located: only where she is ${JSON.stringify(d)}`);
  assert(tl.decide(14, all, 16).verdict === 'clear', 'no scene model: clear');
  assert(CLIP_WOMEN === 0.5, 'threshold');
});
