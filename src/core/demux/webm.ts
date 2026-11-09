import { ByteQueue, configKey, type Demuxer, type Packet, type TrackConfig } from './types';

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
} as const;

/** Level-1 children of Segment: seeing one closes any open (unknown-size) Cluster. */
const LEVEL1 = new Set<number>([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments]);

interface Container { id: number; end: number } // end = absolute offset or Infinity

/** Streaming WebM (Matroska) audio demuxer tolerant to arbitrary chunk boundaries. */
export class WebmDemuxer implements Demuxer {
  private q = new ByteQueue();
  private stack: Container[] = [];
  private skip = 0;
  private timecodeScale = 1_000_000; // ns
  private clusterTime = 0;
  private audioTrack = -1;
  private config: TrackConfig | null = null;
  private codecDelay = 0;
  private nextTs: number | null = null;

  resetParser(): void {
    this.q.clear();
    this.stack = [];
    this.skip = 0;
    this.nextTs = null;
  }

  push(bytes: Uint8Array, timestampOffset: number): Packet[] {
    const out: Packet[] = [];
    this.q.push(bytes);
    for (;;) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, this.q.length);
        this.q.consume(n);
        this.skip -= n;
        if (this.skip > 0) break;
      }
      const abs = this.q.offset;
      while (this.stack.length) {
        const top = this.stack[this.stack.length - 1];
        if (top.end !== Infinity && abs >= top.end) this.stack.pop();
        else break;
      }
      const v = this.q.view();
      const idv = readId(v, 0);
      if (!idv) break;
      const szv = readSize(v, idv.len);
      if (!szv) break;
      const id = idv.value;
      const hdr = idv.len + szv.len;
      const size = szv.value; // -1 = unknown

      if (id === ID.EBML) {
        this.stack = [];
        if (size < 0 || v.length < hdr + size) {
          if (size < 0) { this.q.consume(hdr); continue; }
          break;
        }
        this.q.consume(hdr + size);
        continue;
      }
      if (id === ID.Segment) {
        this.stack = [{ id, end: size < 0 ? Infinity : abs + hdr + size }];
        this.q.consume(hdr);
        continue;
      }
      if (LEVEL1.has(id)) {
        while (this.stack.length && this.stack[this.stack.length - 1].id !== ID.Segment) this.stack.pop();
      }
      if (id === ID.Cluster) {
        this.stack.push({ id, end: size < 0 ? Infinity : abs + hdr + size });
        this.q.consume(hdr);
        continue;
      }
      if (size < 0) {
        // Unknown-size element we don't descend into: step over its header and keep parsing.
        this.q.consume(hdr);
        continue;
      }
      const wanted =
        id === ID.Info || id === ID.Tracks || id === ID.Timecode || id === ID.SimpleBlock || id === ID.BlockGroup;
      if (!wanted) {
        const n = Math.min(hdr + size, this.q.length);
        this.q.consume(n);
        this.skip = hdr + size - n;
        continue;
      }
      if (v.length < hdr + size) break; // wait for the whole element
      const body = v.subarray(hdr, hdr + size);
      switch (id) {
        case ID.Info:
          this.parseInfo(body);
          break;
        case ID.Tracks:
          this.parseTracks(body);
          break;
        case ID.Timecode:
          this.clusterTime = readUint(body);
          break;
        case ID.SimpleBlock:
          this.parseBlock(body, out, timestampOffset);
          break;
        case ID.BlockGroup: {
          for (const [cid, cbody] of children(body)) if (cid === ID.Block) this.parseBlock(cbody, out, timestampOffset);
          break;
        }
      }
      this.q.consume(hdr + size);
    }
    return out;
  }

  private parseInfo(body: Uint8Array): void {
    for (const [id, b] of children(body)) if (id === ID.TimecodeScale) this.timecodeScale = readUint(b);
  }

  private parseTracks(body: Uint8Array): void {
    for (const [id, entry] of children(body)) {
      if (id !== ID.TrackEntry) continue;
      let num = -1, type = -1, codecId = '', priv: Uint8Array | undefined, rate = 48000, ch = 2, delay = 0;
      for (const [cid, b] of children(entry)) {
        if (cid === ID.TrackNumber) num = readUint(b);
        else if (cid === ID.TrackType) type = readUint(b);
        else if (cid === ID.CodecID) codecId = new TextDecoder().decode(b);
        else if (cid === ID.CodecPrivate) priv = b.slice();
        else if (cid === ID.CodecDelay) delay = readUint(b);
        else if (cid === ID.Audio) {
          for (const [aid, ab] of children(b)) {
            if (aid === ID.SamplingFrequency) rate = readFloat(ab);
            else if (aid === ID.Channels) ch = readUint(ab);
          }
        }
      }
      if (type !== 2 && !codecId.startsWith('A_')) continue;
      let codec: string;
      if (codecId === 'A_OPUS') codec = 'opus';
      else if (codecId === 'A_VORBIS') codec = 'vorbis';
      else if (codecId.startsWith('A_AAC')) codec = 'mp4a.40.2';
      else continue;
      if (codec === 'opus') rate = 48000;
      this.audioTrack = num;
      this.codecDelay = delay / 1e9;
      this.config = { codec, sampleRate: rate, channels: ch, description: priv, key: configKey(codec, rate, ch, priv) };
      return;
    }
  }

  private parseBlock(b: Uint8Array, out: Packet[], tsOffset: number): void {
    if (!this.config) return;
    const tn = readVint(b, 0);
    if (!tn || tn.value !== this.audioTrack) return;
    let p = tn.len;
    const rel = (b[p] << 24) >> 16 | b[p + 1]; // signed int16
    p += 2;
    const flags = b[p++];
    const lacing = (flags >> 1) & 3;
    const ts = ((this.clusterTime + rel) * this.timecodeScale) / 1e9 + tsOffset;
    const frames: Uint8Array[] = [];
    if (lacing === 0) {
      frames.push(b.slice(p));
    } else if (lacing === 2) {
      const count = b[p++] + 1;
      const each = (b.length - p) / count;
      for (let i = 0; i < count; i++) frames.push(b.slice(p + i * each, p + (i + 1) * each));
    } else {
      // Xiph (1) / EBML (3) lacing: not used by YouTube; ignore block.
      return;
    }
    let t = ts;
    // Block timestamps are rounded to the timecode scale (1 ms), while audio frames are
    // sample-exact. Keep a continuous timeline when a block lands within 2 ms of where the
    // previous one ended, exactly like a decoder fed the stream in order would.
    if (this.nextTs !== null && Math.abs(t - this.nextTs) < 0.002) t = this.nextTs;
    for (const f of frames) {
      const dur = this.config.codec === 'opus' ? opusPacketDuration(f) : 1024 / this.config.sampleRate;
      out.push({ ts: t, dur, data: f, config: this.config });
      t += dur;
    }
    this.nextTs = t;
  }
}

/** Duration of an Opus packet in seconds, from its TOC byte (RFC 6716 §3.1). */
export function opusPacketDuration(p: Uint8Array): number {
  if (p.length === 0) return 0;
  const toc = p[0];
  const cfg = toc >> 3;
  let frameMs: number;
  if (cfg < 12) frameMs = [10, 20, 40, 60][cfg & 3];
  else if (cfg < 16) frameMs = [10, 20][cfg & 1];
  else frameMs = [2.5, 5, 10, 20][cfg & 3];
  const c = toc & 3;
  const count = c === 0 ? 1 : c === 3 ? (p.length > 1 ? p[1] & 0x3f : 1) : 2;
  return (frameMs * count) / 1000;
}

function readId(b: Uint8Array, p: number): { value: number; len: number } | null {
  if (p >= b.length) return null;
  const first = b[p];
  let len = 1;
  if (first & 0x80) len = 1;
  else if (first & 0x40) len = 2;
  else if (first & 0x20) len = 3;
  else if (first & 0x10) len = 4;
  else return { value: -1, len: 1 }; // invalid; caller will skip 1 byte via size read
  if (p + len > b.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
  return { value: v, len };
}

function readSize(b: Uint8Array, p: number): { value: number; len: number } | null {
  const r = readVint(b, p);
  if (!r) return null;
  // all value bits set ⇒ unknown size
  const allOnes = Math.pow(2, 7 * r.len) - 1;
  return { value: r.value === allOnes ? -1 : r.value, len: r.len };
}

function readVint(b: Uint8Array, p: number): { value: number; len: number } | null {
  if (p >= b.length) return null;
  const first = b[p];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) return { value: 0, len: 1 };
  if (p + len > b.length) return null;
  let v = first & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + b[p + i];
  return { value: v, len };
}

function* children(b: Uint8Array): Generator<[number, Uint8Array]> {
  let p = 0;
  while (p < b.length) {
    const id = readId(b, p);
    if (!id) return;
    const sz = readSize(b, p + id.len);
    if (!sz) return;
    const start = p + id.len + sz.len;
    const end = sz.value < 0 ? b.length : Math.min(b.length, start + sz.value);
    yield [id.value, b.subarray(start, end)];
    p = end;
  }
}

function readUint(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

function readFloat(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
}
