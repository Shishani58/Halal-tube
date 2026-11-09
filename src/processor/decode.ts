import type { Packet } from '../core/demux';

export interface DecodedAudio {
  /** Media time of sample 0. */
  start: number;
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

/** Decode a run of compressed packets with WebCodecs into a contiguous stereo buffer. */
export async function decodePackets(packets: Packet[]): Promise<DecodedAudio | null> {
  if (!packets.length) return null;
  const cfg = packets[0].config;
  const same = packets.filter((p) => p.config.key === cfg.key);
  const outputs: { ts: number; rate: number; planes: Float32Array[] }[] = [];
  let failure: unknown = null;
  const decoder = new AudioDecoder({
    output: (ad) => {
      try {
        const n = ad.numberOfFrames;
        const planes: Float32Array[] = [];
        for (let c = 0; c < Math.min(2, ad.numberOfChannels); c++) {
          const buf = new Float32Array(n);
          ad.copyTo(buf, { planeIndex: c, format: 'f32-planar' });
          planes.push(buf);
        }
        outputs.push({ ts: ad.timestamp / 1e6, rate: ad.sampleRate, planes });
      } finally {
        ad.close();
      }
    },
    error: (e) => {
      failure = e;
    },
  });
  decoder.configure({
    codec: cfg.codec,
    sampleRate: cfg.sampleRate,
    numberOfChannels: cfg.channels,
    description: cfg.description,
  });
  for (const p of same) {
    decoder.decode(
      new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round(p.ts * 1e6),
        duration: Math.round(p.dur * 1e6),
        data: p.data,
      }),
    );
  }
  try {
    await decoder.flush();
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (failure) throw failure;
  if (!outputs.length) return null;

  const rate = outputs[0].rate;
  const start = same[0].ts;
  const last = outputs[outputs.length - 1];
  const total = Math.ceil((last.ts - start) * rate) + last.planes[0].length + 1;
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (const o of outputs) {
    const off = Math.round((o.ts - start) * rate);
    const l = o.planes[0];
    const r = o.planes[1] ?? o.planes[0];
    const from = Math.max(0, -off);
    const n = Math.min(l.length, total - off);
    if (n <= from) continue;
    left.set(l.subarray(from, n), off + from);
    right.set(r.subarray(from, n), off + from);
  }
  return { start, sampleRate: rate, left, right };
}
