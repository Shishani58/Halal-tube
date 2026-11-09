import { ByteQueue, configKey, type Demuxer, type Packet, type TrackConfig, type TrackKind } from './types';
import { av1CodecString } from './video-codecs';

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
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  ReferenceBlock: 0xfb,
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

/** Elements that may legitimately appear inside a Cluster. */
const CLUSTER_CHILDREN = new Set<number>([ID.Timecode, ID.SimpleBlock, ID.BlockGroup, 0xec /* Void */, 0xbf /* CRC-32 */, 0xab /* PrevSize */, 0xa7 /* Position */, 0x5854 /* SilentTracks */, 0xaf /* EncryptedBlock */]);
const MAX_SKIP = 32 * 1024 * 1024;

const startsWith = (b: Uint8Array, id: number) =>
  b.length >= 4 && b[0] === id >>> 24 && b[1] === ((id >>> 16) & 0xff) && b[2] === ((id >>> 8) & 0xff) && b[3] === (id & 0xff);

/** Level-1 children of Segment: seeing one closes any open (unknown-size) Cluster. */
const LEVEL1 = new Set<number>([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments]);

interface Container { id: number; end: number } // end = absolute offset or Infinity

/** Streaming WebM (Matroska) demuxer for one audio or video track, tolerant to arbitrary chunk boundaries. */
export class WebmDemuxer implements Demuxer {
  /** @param codecHint the `codecs` parameter of the SourceBuffer MIME type (exact VP9/AV1 profile). */
  constructor(
    private readonly kind: TrackKind = 'audio',
    private readonly codecHint = '',
  ) {}

  private q = new ByteQueue();
  private stack: Container[] = [];
  private skip = 0;
  private timecodeScale = 1_000_000; // ns
  private clusterTime = 0;
  private audioTrack = -1;
  private config: TrackConfig | null = null;
  private codecDelay = 0;
  /** Video frame duration (s) from DefaultDuration, else a 30 fps guess. */
  private frameDur = 1 / 30;
  private nextTs: number | null = null;

  resetParser(): void {
    this.q.clear();
    this.stack = [];
    this.skip = 0;
    this.nextTs = null;
  }

  push(bytes: Uint8Array, timestampOffset: number): Packet[] {
    const out: Packet[] = [];
    // Players (YouTube SABR) append clusters in pieces and may abandon a partially appended
    // cluster on seek / quality switch. An append that begins with a Cluster or EBML header
    // always starts a new element: drop whatever partial element we were waiting on.
    if (startsWith(bytes, ID.Cluster) || startsWith(bytes, ID.EBML)) {
      this.q.clear();
      this.skip = 0;
      this.stack = this.config && !startsWith(bytes, ID.EBML) ? [{ id: ID.Segment, end: Infinity }] : [];
    }
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
      const inCluster = this.stack.length > 0 && this.stack[this.stack.length - 1].id === ID.Cluster;
      const garbage =
        id < 0 ||
        size > MAX_SKIP ||
        (inCluster && !CLUSTER_CHILDREN.has(id) && !LEVEL1.has(id) && id !== ID.EBML && id !== ID.Segment);
      if (garbage) {
        if (!this.resync()) break;
        continue;
      }

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
          let block: Uint8Array | null = null;
          let ref = false;
          for (const [cid, cbody] of children(body)) {
            if (cid === ID.Block) block = cbody;
            else if (cid === ID.ReferenceBlock) ref = true;
          }
          if (block) this.parseBlock(block, out, timestampOffset, !ref);
          break;
        }
      }
      this.q.consume(hdr + size);
    }
    return out;
  }

  /** Lost sync: jump to the next Cluster/EBML header. Returns false if none is buffered yet. */
  private resync(): boolean {
    const v = this.q.view();
    for (let i = 1; i + 4 <= v.length; i++) {
      if (
        (v[i] === 0x1f && v[i + 1] === 0x43 && v[i + 2] === 0xb6 && v[i + 3] === 0x75) ||
        (v[i] === 0x1a && v[i + 1] === 0x45 && v[i + 2] === 0xdf && v[i + 3] === 0xa3)
      ) {
        this.q.consume(i);
        this.stack = this.config ? [{ id: ID.Segment, end: Infinity }] : [];
        return true;
      }
    }
    this.q.consume(Math.max(0, v.length - 3));
    return false;
  }

  private parseInfo(body: Uint8Array): void {
    for (const [id, b] of children(body)) if (id === ID.TimecodeScale) this.timecodeScale = readUint(b);
  }

  private parseTracks(body: Uint8Array): void {
    for (const [id, entry] of children(body)) {
      if (id !== ID.TrackEntry) continue;
      let num = -1, type = -1, codecId = '', priv: Uint8Array | undefined, rate = 48000, ch = 2, delay = 0;
      let defDur = 0, width = 0, height = 0;
      for (const [cid, b] of children(entry)) {
        if (cid === ID.TrackNumber) num = readUint(b);
        else if (cid === ID.TrackType) type = readUint(b);
        else if (cid === ID.CodecID) codecId = new TextDecoder().decode(b);
        else if (cid === ID.CodecPrivate) priv = b.slice();
        else if (cid === ID.CodecDelay) delay = readUint(b);
        else if (cid === ID.DefaultDuration) defDur = readUint(b);
        else if (cid === ID.Audio) {
          for (const [aid, ab] of children(b)) {
            if (aid === ID.SamplingFrequency) rate = readFloat(ab);
            else if (aid === ID.Channels) ch = readUint(ab);
          }
        } else if (cid === ID.Video) {
          for (const [vid, vb] of children(b)) {
            if (vid === ID.PixelWidth) width = readUint(vb);
            else if (vid === ID.PixelHeight) height = readUint(vb);
          }
        }
      }
      if (this.kind === 'video') {
        if (type !== 1 && !codecId.startsWith('V_')) continue;
        const codec = this.videoCodec(codecId, priv);
        if (!codec) continue;
        // VP8/VP9 need no description; for AV1 CodecPrivate is the av1C record.
        const description = codecId === 'V_AV1' && priv && priv.length > 4 ? priv : undefined;
        this.audioTrack = num;
        if (defDur > 0) this.frameDur = defDur / 1e9;
        this.config = { codec, sampleRate: 0, channels: 0, description, kind: 'video', width, height, key: configKey(codec, width, height, description) };
        return;
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
      this.config = { codec, sampleRate: rate, channels: ch, description: priv, kind: 'audio', key: configKey(codec, rate, ch, priv) };
      return;
    }
  }

  /** WebCodecs codec string for a Matroska video CodecID. */
  private videoCodec(codecId: string, priv: Uint8Array | undefined): string | null {
    const hint = this.codecHint.toLowerCase();
    if (codecId === 'V_VP8') return 'vp8';
    if (codecId === 'V_VP9') {
      if (hint.startsWith('vp09.')) return this.codecHint;
      // CodecPrivate (optional): [id, len, value] features — 1 profile, 2 level, 3 bit depth
      let profile = 0, level = 10, depth = 8;
      for (let p = 0; priv && p + 3 <= priv.length && p + 2 + priv[p + 1] <= priv.length; p += 2 + priv[p + 1]) {
        const v = priv[p + 2];
        if (priv[p] === 1) profile = v;
        else if (priv[p] === 2) level = v;
        else if (priv[p] === 3) depth = v;
      }
      const two = (n: number) => String(n).padStart(2, '0');
      return `vp09.${two(profile)}.${two(level)}.${two(depth)}`;
    }
    if (codecId === 'V_AV1') {
      if (hint.startsWith('av01.')) return this.codecHint;
      return (priv && av1CodecString(priv)) || 'av01.0.08M.08';
    }
    return null;
  }

  private parseBlock(b: Uint8Array, out: Packet[], tsOffset: number, groupKey?: boolean): void {
    if (!this.config) return;
    const tn = readVint(b, 0);
    if (!tn || tn.value !== this.audioTrack) return;
    let p = tn.len;
    const rel = (b[p] << 24) >> 16 | b[p + 1]; // signed int16
    p += 2;
    const flags = b[p++];
    const lacing = (flags >> 1) & 3;
    const ts = ((this.clusterTime + rel) * this.timecodeScale) / 1e9 + tsOffset;
    if (this.config.kind === 'video') {
      // SimpleBlock: keyframe flag 0x80; BlockGroup: keyframe when it has no ReferenceBlock.
      const key = groupKey ?? (flags & 0x80) !== 0;
      if (lacing !== 0) return; // video is never laced in practice
      out.push({ ts, dts: ts, dur: this.frameDur, data: b.slice(p), config: this.config, key });
      return;
    }
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
