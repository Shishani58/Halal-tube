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
