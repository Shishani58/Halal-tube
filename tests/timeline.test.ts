import type { Packet, TrackConfig } from '../src/core/demux';
import { KIM_VOCAL_2, MdxProcessor } from '../src/core/mdx';
import { Tiling } from '../src/core/tiles';
import { PacketStore } from '../src/processor/packet-store';
import { assert, test } from './harness';

const cfg: TrackConfig = { codec: 'opus', sampleRate: 48000, channels: 2, key: 'x' };
const pk = (ts: number, dur = 0.02): Packet => ({ ts, dur, data: new Uint8Array(1), config: cfg });

test('PacketStore coverage, gaps, out-of-order inserts', () => {
  const s = new PacketStore();
  for (let i = 0; i < 500; i++) s.add(pk(i * 0.02)); // 0 .. 10 s
  assert(s.covers(0, 9.9, Infinity), 'covers 0..9.9');
  assert(!s.covers(0, 11, Infinity), 'does not cover beyond');
  assert(s.covers(-0.1, 5, Infinity), 'negative start clamps to 0');
  assert(s.covers(9, 12, 10.02), 'stream end clamps coverage');
  // seek: later region appended first, then earlier
  for (let i = 1000; i < 1100; i++) s.add(pk(i * 0.02)); // 20..22
  assert(!s.covers(9, 21, Infinity), 'gap detected');
  for (let i = 600; i > 400; i--) s.add(pk(i * 0.02)); // re-append overlapping + reversed
  assert(s.size === 500 + 100 + 101, `dedupe, size=${s.size}`);
  assert(Math.abs(s.contiguousEnd(1) - 12.02) < 1e-6, `contiguous end ${s.contiguousEnd(1)}`);
  s.evictBefore(5);
  assert(!s.covers(4, 6, Infinity) && s.covers(5, 6, Infinity), 'eviction');
});

test('Tiling maps time ↔ tiles and input windows', () => {
  const t = new Tiling(new MdxProcessor(KIM_VOCAL_2));
  assert(t.genSize === 253440 && t.trim === 3840, 'sizes');
  assert(t.tileAt(0) === 0 && t.tileAt(5.74) === 0 && t.tileAt(5.75) === 1, 'tileAt');
  const [a, b] = t.inputRange(1);
  assert(Math.abs(a - (253440 - 3840) / 44100) < 1e-9 && Math.abs(b - a - 261120 / 44100) < 1e-9, 'input range');
});

import { decodeFromWorker, decodeToWorker, encodeFromWorker, encodeToWorker } from '../src/shared/wire';
test('Port wire codec round-trips appends and tiles', () => {
  const data = new Uint8Array(70000).map((_, i) => (i * 31) & 255);
  const back = decodeToWorker(JSON.parse(JSON.stringify(encodeToWorker({ type: 'append', session: 1, sb: 2, data: data.buffer, tsOffset: 0 }))));
  assert(back.type === 'append' && new Uint8Array(back.data).every((x, i) => x === data[i]), 'append bytes');
  const left = new Float32Array(1000).map((_, i) => Math.sin(i / 10) * 0.9);
  const t = decodeFromWorker(JSON.parse(JSON.stringify(encodeFromWorker({ type: 'tile', session: 1, k: 3, start: 1, validFrom: 1, sampleRate: 44100, left, right: left }))));
  assert(t.type === 'tile' && t.left.every((x, i) => Math.abs(x - left[i]) < 1e-4), 'tile pcm16');
});
