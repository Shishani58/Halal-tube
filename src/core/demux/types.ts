export interface TrackConfig {
  /** WebCodecs codec string, e.g. "opus", "mp4a.40.2", "vp09.00.10.08", "avc1.4d401f". */
  codec: string;
  /** Audio only (0 for video). */
  sampleRate: number;
  /** Audio only (0 for video). */
  channels: number;
  /** Codec-specific setup (OpusHead / AudioSpecificConfig / avcC / av1C). */
  description?: Uint8Array;
  kind?: 'audio' | 'video';
  width?: number;
  height?: number;
  /** Stable identity for grouping packets that share a decoder config. */
  key: string;
}

export interface Packet {
  /** Presentation time in seconds (media timeline). */
  ts: number;
  /** Duration in seconds. */
  dur: number;
  data: Uint8Array;
  config: TrackConfig;
  /** Video: decode timestamp (differs from ts with B-frames). */
  dts?: number;
  /** Video: sync sample (decoding can start here). Audio packets are always decodable. */
  key?: boolean;
}

export type TrackKind = 'audio' | 'video';

/** The `codecs="…"` parameter of a MIME type, if any. */
export function codecParam(mimeType: string): string {
  const m = /codecs\s*=\s*"?([^";]+)"?/i.exec(mimeType);
  return m ? m[1].trim() : '';
}

export interface Demuxer {
  /** Feed the next bytes passed to SourceBuffer.appendBuffer. Returns packets completed so far. */
  push(bytes: Uint8Array, timestampOffset: number): Packet[];
  /** Drop partially parsed media data (SourceBuffer.abort / discontinuity) but keep track config. */
  resetParser(): void;
}

export function configKey(codec: string, sampleRate: number, channels: number, desc?: Uint8Array): string {
  let h = 2166136261;
  if (desc) for (const b of desc) h = Math.imul(h ^ b, 16777619) >>> 0;
  return `${codec}|${sampleRate}|${channels}|${h.toString(16)}`;
}

/** Growable byte queue with an absolute stream offset. */
export class ByteQueue {
  private buf: Uint8Array = new Uint8Array(0);
  private start = 0; // read index into buf
  /** Absolute stream offset of the first unread byte. */
  offset = 0;

  push(bytes: Uint8Array): void {
    const avail = this.buf.length - this.start;
    if (!avail) {
      // common case: the previous chunk was parsed to the end — no copy (callers don't reuse `bytes`)
      this.buf = bytes;
      this.start = 0;
      return;
    }
    const next = new Uint8Array(avail + bytes.length);
    next.set(this.buf.subarray(this.start), 0);
    next.set(bytes, avail);
    this.buf = next;
    this.start = 0;
  }

  get length(): number {
    return this.buf.length - this.start;
  }

  /** View of unread bytes (valid until next push). */
  view(): Uint8Array {
    return this.buf.subarray(this.start);
  }

  consume(n: number): void {
    this.start += n;
    this.offset += n;
  }

  clear(): void {
    this.offset += this.length;
    this.buf = new Uint8Array(0);
    this.start = 0;
  }
}
