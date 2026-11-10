import { VisionTimeline } from '../src/core/vision-timeline';
import { videoKey } from '../src/processor/vision-store';
import type { VisionFrame } from '../src/shared/vision-messages';
import { assert, test } from './harness';

const fr = (t: number, p = 0): VisionFrame => ({ t, nude: 0, skin: 0, female: p, women: p ? [0.3, 0.2, 0.2, 0.3, p] : [], ...(p ? { parts: [1] } : {}) });
const result = (from: number, to: number, frames: VisionFrame[], cuts: number[] = []) => ({ from, to, frames, cuts, cutRange: [from, to] as [number, number], edges: [] as [number, number][] });

test('vision cache: videoKey is the id and the length in whole seconds', () => {
  assert(videoKey('abc', 61.4) === 'abc|61' && videoKey('abc', 61.6) === 'abc|62', 'rounded');
  assert(videoKey('abc', 30) !== videoKey('abc', 3600), 'an ad or another cut does not share it');
});

test('vision cache: a kept timeline gives the same verdicts without any analysis', () => {
  const a = new VisionTimeline();
  const frames = Array.from({ length: 20 }, (_, i) => fr(i * 0.5, 0.9));
  a.add(result(0, 10, frames, [5]));
  const kept = JSON.parse(JSON.stringify(a.toCache())); // what IndexedDB hands back
  const b = new VisionTimeline();
  assert(b.decide(1, { women: true }, 10).verdict === 'unknown', 'nothing known yet');
  b.load(kept);
  assert(b.checked.covers(0, 10), 'spans are checked');
  assert(JSON.stringify(b.cutTimes) === '[5]', 'cuts');
  for (const t of [0.5, 2, 4.9, 5.2, 8]) assert(b.decide(t, { women: true, strict: true }, 10).verdict === a.decide(t, { women: true, strict: true }, 10).verdict, `same verdict at ${t}`);
  assert(b.decide(2, { women: true }, 10).verdict === 'region', 'the woman is covered from the first frame');
});

test('vision cache: what is already known wins over the record; the record fills the rest', () => {
  const b = new VisionTimeline();
  b.add(result(4, 6, [fr(4, 0.05), fr(5, 0.05)])); // fresh analysis: a man
  const old = new VisionTimeline();
  old.add(result(0, 6, [fr(0, 0.9), fr(1, 0.9), fr(4, 0.9), fr(5, 0.9)])); // an older record says "woman"
  b.load(old.toCache());
  assert(b.sampleCount === 4, `frames merged: ${b.sampleCount}`);
  const rows = b.dump();
  assert(rows.find((r) => r[0] === 4)![3] === 0.05, 'fresh frame kept');
  assert(rows.find((r) => r[0] === 0)![3] === 0.9, 'old frame filled in');
  assert(b.checked.covers(0.1, 5.9), 'spans joined');
});

test('vision cache: loading twice changes nothing', () => {
  const a = new VisionTimeline();
  a.add(result(0, 4, [fr(0, 0.9), fr(2, 0.9)], [2]));
  const k = a.toCache();
  const b = new VisionTimeline();
  b.load(k);
  b.load(k);
  assert(b.sampleCount === 2 && b.cutTimes.length === 1 && b.checked.spans.length === 1, 'idempotent');
});
