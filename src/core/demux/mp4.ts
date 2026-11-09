import { ByteQueue, configKey, type Demuxer, type Packet, type TrackConfig } from './types';

interface TrackInfo {
  id: number;
  timescale: number;
  config: TrackConfig;
  defaultDuration: number;
  defaultSize: number;
}

interface PendingSamples {
  trackId: number;
  /** Absolute stream offsets of each sample. */
  offsets: number[];
  sizes: number[];
  times: number[]; // in timescale units
  durations: number[];
}

/** Streaming fragmented-MP4 audio demuxer (AAC). */
export class Mp4Demuxer implements Demuxer {
  private q = new ByteQueue();
  private tracks = new Map<number, TrackInfo>();
  private audioTrackId = -1;
  private pending: PendingSamples | null = null;

  resetParser(): void {
    this.q.clear();
    this.pending = null;
  }

  push(bytes: Uint8Array, timestampOffset: number): Packet[] {
    const out: Packet[] = [];
    this.q.push(bytes);
    for (;;) {
      const v = this.q.view();
      if (v.length < 8) break;
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      let size = dv.getUint32(0);
      const type = fourcc(v, 4);
      let hdr = 8;
      if (size === 1) {
        if (v.length < 16) break;
        size = Number(dv.getBigUint64(8));
        hdr = 16;
      } else if (size === 0) {
        break; // box extends to end of stream – not expected in MSE segments
      }
      if (v.length < size) {
        if (type === 'mdat' && this.pending) {
          // emit whatever samples are already complete inside a partially received mdat
          this.emitSamples(v, this.q.offset, out, timestampOffset, false);
        }
        break;
      }
      const abs = this.q.offset;
      if (type === 'moov') this.parseMoov(v.subarray(hdr, size));
      else if (type === 'moof') this.parseMoof(v.subarray(hdr, size), abs);
      else if (type === 'mdat') this.emitSamples(v.subarray(0, size), abs, out, timestampOffset, true);
      this.q.consume(size);
    }
    return out;
  }

  /** Emit samples that are fully contained in `buf` (which starts at absolute offset `bufAbs`). */
  private emitSamples(buf: Uint8Array, bufAbs: number, out: Packet[], tsOffset: number, final: boolean): void {
    const p = this.pending;
    if (!p) return;
    const tr = this.tracks.get(p.trackId);
    if (!tr) return;
    let i = 0;
    for (; i < p.offsets.length; i++) {
      const rel = p.offsets[i] - bufAbs;
      if (rel < 0 || rel + p.sizes[i] > buf.length) break;
      out.push({
        ts: p.times[i] / tr.timescale + tsOffset,
        dur: p.durations[i] / tr.timescale,
        data: buf.slice(rel, rel + p.sizes[i]),
        config: tr.config,
      });
    }
    p.offsets.splice(0, i);
    p.sizes.splice(0, i);
    p.times.splice(0, i);
    p.durations.splice(0, i);
    if (final || p.offsets.length === 0) this.pending = final ? null : p;
  }

  private parseMoov(b: Uint8Array): void {
    const trex = new Map<number, { dur: number; size: number }>();
    for (const [type, body] of boxes(b)) {
      if (type === 'mvex') {
        for (const [t2, bb] of boxes(body)) {
          if (t2 !== 'trex') continue;
          const dv = view(bb);
          trex.set(dv.getUint32(4), { dur: dv.getUint32(12), size: dv.getUint32(16) });
        }
      }
    }
    for (const [type, trak] of boxes(b)) {
      if (type !== 'trak') continue;
      let id = -1, timescale = 0, handler = '', config: TrackConfig | null = null;
      for (const [t, body] of boxes(trak)) {
        if (t === 'tkhd') {
          const dv = view(body);
          id = body[0] === 1 ? dv.getUint32(20) : dv.getUint32(12);
        } else if (t === 'mdia') {
          for (const [t2, mb] of boxes(body)) {
            if (t2 === 'mdhd') timescale = mb[0] === 1 ? view(mb).getUint32(20) : view(mb).getUint32(12);
            else if (t2 === 'hdlr') handler = fourcc(mb, 8);
            else if (t2 === 'minf') {
              const stsd = findPath(mb, ['stbl', 'stsd']);
              if (stsd) config = parseStsd(stsd);
            }
          }
        }
      }
      if (handler !== 'soun' || !config) continue;
      const d = trex.get(id) ?? { dur: 1024, size: 0 };
      this.tracks.set(id, { id, timescale, config, defaultDuration: d.dur, defaultSize: d.size });
      this.audioTrackId = id;
    }
  }

  private parseMoof(b: Uint8Array, moofAbs: number): void {
    for (const [type, traf] of boxes(b)) {
      if (type !== 'traf') continue;
      let trackId = -1, baseOffset = moofAbs, defDur = 0, defSize = 0, baseTime = 0;
      const samples: PendingSamples = { trackId: -1, offsets: [], sizes: [], times: [], durations: [] };
      for (const [t, body] of boxes(traf)) {
        const dv = view(body);
        if (t === 'tfhd') {
          const flags = dv.getUint32(0) & 0xffffff;
          trackId = dv.getUint32(4);
          const tr = this.tracks.get(trackId);
          defDur = tr?.defaultDuration ?? 1024;
          defSize = tr?.defaultSize ?? 0;
          let p = 8;
          if (flags & 0x01) { baseOffset = Number(dv.getBigUint64(p)); p += 8; }
          if (flags & 0x02) p += 4;
          if (flags & 0x08) { defDur = dv.getUint32(p); p += 4; }
          if (flags & 0x10) { defSize = dv.getUint32(p); p += 4; }
        } else if (t === 'tfdt') {
          baseTime = body[0] === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
        } else if (t === 'trun') {
          const flags = dv.getUint32(0) & 0xffffff;
          const count = dv.getUint32(4);
          let p = 8;
          let dataOffset = 0;
          if (flags & 0x01) { dataOffset = dv.getInt32(p); p += 4; }
          if (flags & 0x04) p += 4;
          let off = baseOffset + dataOffset;
          let time = baseTime + samples.durations.reduce((a, x) => a + x, 0);
          for (let i = 0; i < count; i++) {
            let dur = defDur, size = defSize;
            if (flags & 0x100) { dur = dv.getUint32(p); p += 4; }
            if (flags & 0x200) { size = dv.getUint32(p); p += 4; }
            if (flags & 0x400) p += 4;
            if (flags & 0x800) p += 4;
            samples.offsets.push(off);
            samples.sizes.push(size);
            samples.times.push(time);
            samples.durations.push(dur);
            off += size;
            time += dur;
          }
        }
      }
      if (trackId === this.audioTrackId) {
        samples.trackId = trackId;
        this.pending = samples;
      }
    }
  }
}

function parseStsd(stsd: Uint8Array): TrackConfig | null {
  // full box header (4) + entry_count (4), then sample entries
  for (const [type, entry] of boxes(stsd.subarray(8))) {
    if (type !== 'mp4a') continue;
    const dv = view(entry);
    const channels = dv.getUint16(16);
    let rate = dv.getUint32(24) >>> 16;
    const esds = [...boxes(entry.subarray(28))].find(([t]) => t === 'esds')?.[1];
    if (!esds) continue;
    const asc = findDescriptor(esds.subarray(4), 0x05);
    if (!asc) continue;
    const aot = asc[0] >> 3;
    const freqIdx = ((asc[0] & 7) << 1) | (asc[1] >> 7);
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    if (freqIdx < rates.length) rate = rates[freqIdx];
    const codec = `mp4a.40.${aot}`;
    const description = asc.slice();
    return { codec, sampleRate: rate, channels, description, key: configKey(codec, rate, channels, description) };
  }
  return null;
}

/** Recursively search MPEG-4 descriptors for a tag. */
function findDescriptor(b: Uint8Array, tag: number): Uint8Array | null {
  let p = 0;
  while (p < b.length) {
    const t = b[p++];
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const x = b[p++];
      len = (len << 7) | (x & 0x7f);
      if (!(x & 0x80)) break;
    }
    const body = b.subarray(p, p + len);
    if (t === tag) return body;
    if (t === 0x03) {
      // ES_Descriptor: ES_ID(2) + flags(1) [+ optional fields]
      const flags = body[2];
      let q = 3;
      if (flags & 0x80) q += 2;
      if (flags & 0x40) q += 1 + body[q];
      if (flags & 0x20) q += 2;
      const r = findDescriptor(body.subarray(q), tag);
      if (r) return r;
    } else if (t === 0x04) {
      const r = findDescriptor(body.subarray(13), tag);
      if (r) return r;
    }
    p += len;
  }
  return null;
}

function* boxes(b: Uint8Array): Generator<[string, Uint8Array]> {
  let p = 0;
  while (p + 8 <= b.length) {
    const dv = new DataView(b.buffer, b.byteOffset + p, b.byteLength - p);
    let size = dv.getUint32(0);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; }
    else if (size === 0) size = b.length - p;
    if (size < hdr || p + size > b.length) return;
    yield [fourcc(b, p + 4), b.subarray(p + hdr, p + size)];
    p += size;
  }
}

function findPath(b: Uint8Array, path: string[]): Uint8Array | null {
  let cur: Uint8Array | null = b;
  for (const name of path) {
    if (!cur) return null;
    let next: Uint8Array | null = null;
    for (const [t, body] of boxes(cur)) if (t === name) { next = body; break; }
    cur = next;
  }
  return cur;
}

function fourcc(b: Uint8Array, p: number): string {
  return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}
