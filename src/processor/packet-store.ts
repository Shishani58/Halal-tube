import type { Packet } from '../core/demux';

/** Sorted, de-duplicated store of compressed audio packets for one media session. */
export class PacketStore {
  private packets: Packet[] = [];

  get size(): number {
    return this.packets.length;
  }

  add(p: Packet): void {
    const arr = this.packets;
    // fast path: append at end
    if (!arr.length || p.ts > arr[arr.length - 1].ts + 1e-4) {
      arr.push(p);
      return;
    }
    const i = this.lowerBound(p.ts - 1e-4);
    if (i < arr.length && Math.abs(arr[i].ts - p.ts) < 1e-4) {
      arr[i] = p; // replace (re-appended after seek / quality switch)
    } else {
      arr.splice(i, 0, p);
    }
  }

  /** Packets overlapping [start, end). */
  range(start: number, end: number): Packet[] {
    const arr = this.packets;
    let i = this.lowerBound(start - 0.2);
    const out: Packet[] = [];
    for (; i < arr.length && arr[i].ts < end; i++) {
      if (arr[i].ts + arr[i].dur > start) out.push(arr[i]);
    }
    return out;
  }

  /**
   * True if [start, end) is covered by packets with no gap larger than `maxGap`.
   * `end` is clamped by `streamEnd` (media duration) when known.
   */
  covers(start: number, end: number, streamEnd: number, maxGap = 0.03): boolean {
    const s = Math.max(0, start);
    const e = Number.isFinite(streamEnd) && streamEnd > 0 ? Math.min(end, streamEnd - 0.05) : end;
    if (e <= s) return true;
    const ps = this.range(s, e);
    if (!ps.length) return false;
    if (ps[0].ts > s + maxGap) return false;
    let reach = ps[0].ts + ps[0].dur;
    for (let i = 1; i < ps.length; i++) {
      if (ps[i].ts > reach + maxGap) return false;
      reach = Math.max(reach, ps[i].ts + ps[i].dur);
    }
    return reach >= e - maxGap;
  }

  /** End of the contiguous run of packets that contains `t` (or t itself if none). */
  contiguousEnd(t: number, maxGap = 0.05): number {
    const arr = this.packets;
    let i = this.lowerBound(t - 0.5);
    while (i < arr.length && arr[i].ts + arr[i].dur < t) i++;
    if (i >= arr.length || arr[i].ts > t + maxGap) return t;
    let reach = arr[i].ts + arr[i].dur;
    for (i++; i < arr.length; i++) {
      if (arr[i].ts > reach + maxGap) break;
      reach = Math.max(reach, arr[i].ts + arr[i].dur);
    }
    return reach;
  }

  /** Drop packets entirely before `t`. */
  evictBefore(t: number): void {
    const i = this.lowerBound(t);
    if (i > 0) this.packets.splice(0, i);
  }

  private lowerBound(ts: number): number {
    const arr = this.packets;
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
