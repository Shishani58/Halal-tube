import { area, grow, overlap, union } from './vision-timeline';

/** Room added around a box whenever it has to grow, so small movements fit without moving it again. */
export const GROW_PAD = 0.02;
/** A box shrinks back once it has been this many times bigger than needed… */
export const SHRINK_RATIO = 1.8;
/** …for this long (ms). */
export const SHRINK_AFTER = 2000;
/** A box nothing needs any more stays this long (ms), so it doesn't blink. */
export const HOLD = 300;

interface Box {
  r: number[];
  /** Part of a person it covers (rect[4], vision-timeline PART): boxes of different parts never merge. */
  kind: number;
  /** What it must cover now (null: nothing). */
  need: number[] | null;
  tooBigSince: number;
  lastNeeded: number;
}

/**
 * Keeps the blur boxes still. The rects to hide come in each animation frame and shift a little
 * with every new look at the people; shown as they are, the boxes would twitch. A box here only
 * grows when something to hide pokes out of it (immediately: covering comes first), and only shrinks
 * after being far too big for a while. Boxes start over at a new shot and after a seek.
 */
export class StableBoxes {
  private boxes: Box[] = [];
  private key: string | null = null;

  /** Frame-relative boxes to show for the rects `want` ([x, y, w, h, part?]) to hide; `key` names the shot. */
  update(want: number[][], key: string, now: number): number[][] {
    if (key !== this.key) {
      this.boxes = [];
      this.key = key;
    }
    for (const b of this.boxes) b.need = null;
    for (const w of mergeAll(want.map((r) => r.slice()))) {
      const kind = w[4] ?? 0;
      let best: Box | null = null;
      let bestOv = 0;
      for (const b of this.boxes) {
        if (b.kind !== kind) continue;
        const ov = overlap(b.r, w);
        if (ov > bestOv) {
          bestOv = ov;
          best = b;
        }
      }
      if (best && bestOv > 0.2) {
        best.need = best.need ? union(best.need, w) : w;
        if (!contains(best.r, w)) best.r = grow(union(best.r, w), GROW_PAD);
      } else this.boxes.push({ r: grow(w, GROW_PAD), kind, need: w, tooBigSince: 0, lastNeeded: now });
    }
    // boxes that grew into each other become one
    for (let i = 0; i < this.boxes.length; i++)
      for (let j = this.boxes.length - 1; j > i; j--) {
        const a = this.boxes[i], b = this.boxes[j];
        if (a.kind !== b.kind || overlap(a.r, b.r) < 0.3) continue;
        a.r = union(a.r, b.r);
        a.need = a.need && b.need ? union(a.need, b.need) : a.need ?? b.need;
        a.lastNeeded = Math.max(a.lastNeeded, b.lastNeeded);
        this.boxes.splice(j, 1);
      }
    this.boxes = this.boxes.filter((b) => {
      if (b.need) b.lastNeeded = now;
      return now - b.lastNeeded < HOLD;
    });
    for (const b of this.boxes) {
      if (!b.need) continue;
      const tight = grow(b.need, GROW_PAD);
      if (area(b.r) <= SHRINK_RATIO * area(tight)) b.tooBigSince = 0;
      else if (!b.tooBigSince) b.tooBigSince = now;
      else if (now - b.tooBigSince >= SHRINK_AFTER) {
        b.r = tight;
        b.tooBigSince = 0;
      }
    }
    // heads and bodies are tracked apart, but shown as one blur where they touch
    return joinTouching(this.boxes.map((b) => b.r));
  }

  reset(): void {
    this.boxes = [];
    this.key = null;
  }
}

/** Boxes closer than this (share of the frame) to each other are shown as one blur. */
export const JOIN_GAP = 0.02;

/** Boxes that overlap or nearly touch (directly or through others) as one box around them. */
export function joinTouching(boxes: number[][]): number[][] {
  const rs = boxes.map((r) => r.slice(0, 4));
  for (let i = 0; i < rs.length; i++)
    for (let j = rs.length - 1; j > i; j--)
      if (touches(rs[i], rs[j])) {
        rs[i] = union(rs[i], rs[j]);
        rs.splice(j, 1);
        j = rs.length; // the grown box may now touch ones already passed
      }
  return rs;
}

function touches(a: number[], b: number[]): boolean {
  return Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]) > -JOIN_GAP && Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]) > -JOIN_GAP;
}

function contains(outer: number[], r: number[]): boolean {
  const e = 1e-6;
  return r[0] >= outer[0] - e && r[1] >= outer[1] - e && r[0] + r[2] <= outer[0] + outer[2] + e && r[1] + r[3] <= outer[1] + outer[3] + e;
}

/** Rects of the same part that largely overlap (the same person seen at nearby times) as one. */
function mergeAll(rs: number[][]): number[][] {
  for (let i = 0; i < rs.length; i++)
    for (let j = rs.length - 1; j > i; j--)
      if ((rs[i][4] ?? 0) === (rs[j][4] ?? 0) && overlap(rs[i], rs[j]) > 0.25) {
        rs[i] = [...union(rs[i], rs[j]), rs[i][4] ?? 0];
        rs.splice(j, 1);
        j = rs.length; // the grown rect may now overlap ones already passed
      }
  return rs;
}
