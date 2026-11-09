export interface TrackConfig {
  /** WebCodecs codec string, e.g. "opus" or "mp4a.40.2". */
  codec: string;
  sampleRate: number;
  channels: number;
  /** Codec-specific setup (OpusHead / AudioSpecificConfig). */
  description?: Uint8Array;
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
  private buf = new Uint8Array(0);
  private start = 0; // read index into buf
  /** Absolute stream offset of the first unread byte. */
  offset = 0;

  push(bytes: Uint8Array): void {
    const avail = this.buf.length - this.start;
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
