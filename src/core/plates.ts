import { area, overlap } from './rects';

/**
 * Overlay plates: a slide, a card or a banner an editor laid over the picture. A plate is a large
 * rectangle with long straight edges on both sides; the picture beneath it is not what the viewer
 * sees. A woman's body is estimated from her face and reaches under such a plate, so the blur laid
 * over her would also hide the plate. Plates are found on the detector's input (a small copy of the
 * frame) and reported in frame-relative units, [x, y, w, h] each.
 */

/** Luma step across an edge pixel that counts as an edge, in 0–255. */
const EDGE = 26;
/** Gaps (rows / columns) allowed within one edge line: text, shadows and noise break it up a little. */
const GAP = 3;
/** Shortest edge line as a share of the frame side it runs along. */
const MIN_RUN = 0.4;
/** Smallest plate: share of the frame width, of its height, and of both together. */
const MIN_W = 0.15;
const MIN_H = 0.3;
const MIN_AREA = 0.06;
/** A plate this big in both directions is the picture itself, not a plate over it. */
const MAX_SIDE = 0.92;
/** The two sides of a plate differ from what lies outside by at least this much, the same way, in luma. */
const POLARITY = 18;
/** A plate's side is an unbroken edge: this share of its length (rock, foliage and hair are 0.6–0.9). */
const MIN_FILL = 0.9;
/** Plates reported per frame at most. */
const MAX_PLATES = 3;

interface Line {
  /** Position across (x for a vertical line, y for a horizontal one). */
  at: number;
  from: number;
  to: number;
  /** Share of the line's length that is edge (the rest are the gaps GAP allows). */
  fill: number;
}

/**
 * Plates in a frame. `rgba`: the frame's pixels (row length `stride`, top-left `w`×`h` used).
 * Returns frame-relative [x, y, w, h].
 */
export function findPlates(rgba: Uint8ClampedArray | Uint8Array, stride: number, w: number, h: number): number[][] {
  const W = w >> 1, H = h >> 1;
  if (W < 24 || H < 16) return [];
  const y = halfLuma(rgba, stride, W, H);
  const vs = lines(y, W, H, true, MIN_RUN);
  if (vs.length < 2) return [];
  const hs = lines(y, W, H, false, MIN_W);
  // a plate's top or bottom: a horizontal edge across it
  const closed = (x0: number, x1: number, at: number) =>
    hs.some((l) => l.fill >= 0.8 && Math.abs(l.at - at) <= 3 && Math.min(l.to, x1) - Math.max(l.from, x0) >= 0.7 * (x1 - x0));
  const out: { r: number[]; a: number }[] = [];
  for (let i = 0; i < vs.length; i++)
    for (let j = i + 1; j < vs.length; j++) {
      const l = vs[i], r = vs[j];
      if (l.fill < MIN_FILL || r.fill < MIN_FILL || r.at - l.at < MIN_W * W) continue;
      const y0 = Math.max(l.from, r.from), y1 = Math.min(l.to, r.to);
      if (y1 - y0 < MIN_H * H) continue;
      const rect = [l.at / W, y0 / H, (r.at - l.at) / W, (y1 - y0) / H];
      if (area(rect) < MIN_AREA || (rect[2] > MAX_SIDE && rect[3] > MAX_SIDE)) continue;
      // (a card's edge against a dark room can be too faint to see on one of the two)
      // (the frame's border alone proves nothing: it takes a real edge on one side at least)
      if (!closed(l.at, r.at, y0) && !closed(l.at, r.at, y1)) continue;
      if (!sidedAlike(y, W, H, l.at, r.at, y0, y1)) continue;
      out.push({ r: rect, a: area(rect) });
    }
  out.sort((p, q) => q.a - p.a);
  const keep: number[][] = [];
  for (const c of out) {
    if (keep.some((k) => overlap(k, c.r) > 0.8)) continue;
    keep.push(c.r);
    if (keep.length >= MAX_PLATES) break;
  }
  return keep;
}

/** Flat [x, y, w, h, …] → rects. */
export function platesOf(flat: readonly number[] | undefined): number[][] {
  const out: number[][] = [];
  if (flat) for (let i = 0; i + 3 < flat.length; i += 4) out.push(flat.slice(i, i + 4));
  return out;
}

/** A plate seen in two looks is the same one when the rects nearly coincide. */
export function samePlate(a: number[], b: number[]): boolean {
  return overlap(a, b) > 0.85 && Math.min(area(a), area(b)) > 0.8 * Math.max(area(a), area(b));
}

/**
 * The plates a blur box must leave alone at one moment. `before` / `after`: the plates found in
 * each look (newest / oldest first) shortly before and after it. One that a single look misses
 * (a slide mid-animation) still counts; one that is in no look after the moment doesn't — a plate
 * that just left must not uncover a woman — and one that just came is cut away from its first look.
 */
export function platesBetween(before: number[][][], after: number[][][]): number[][] {
  if (!before.length) return after[0] ?? [];
  const out: number[][] = [];
  for (const p of before.flat()) {
    if (out.some((o) => samePlate(o, p))) continue;
    const prev = before.map((l) => l.find((q) => samePlate(q, p))).find((q) => q);
    if (!after.length) {
      if (prev) out.push(prev);
      continue;
    }
    const next = after.map((l) => l.find((q) => samePlate(q, p))).find((q) => q);
    if (prev && next) out.push(inter(prev, next));
  }
  return out;
}

function inter(a: number[], b: number[]): number[] {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  return [x0, y0, Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x0), Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y0)];
}

/**
 * Boxes with the plates taken out. A box is cut at the plate's edge only where that removes
 * (mostly) plate — the strip taken off is at least CUT_SHARE plate (a card is shorter than the box) — and keeps every `keep` rect
 * (heads) it held; of the cuts that qualify the one leaving the most is made. A box a plate only
 * touches at the corner, or one that would lose a head, stays as it is.
 */
export const CUT_SHARE = 0.45;
export function cutPlates(boxes: number[][], plates: number[][], keep: number[][]): number[][] {
  if (!plates.length) return boxes;
  const e = 0.004;
  const out: number[][] = [];
  for (const box of boxes) {
    let b = box.slice(0, 4);
    for (const p of plates) {
      const ov = inter(b, p);
      if (ov[2] * ov[3] < 0.04 * area(b)) continue;
      const [bx, by, bw, bh] = b, bx1 = bx + bw, by1 = by + bh;
      const px1 = p[0] + p[2], py1 = p[1] + p[3];
      // each way to cut: what stays, and the strip that goes
      const cuts: { stay: number[]; strip: number[] }[] = [];
      if (px1 < bx1) cuts.push({ stay: [px1, by, bx1 - px1, bh], strip: [bx, by, px1 - bx, bh] }); // plate on the left
      if (p[0] > bx) cuts.push({ stay: [bx, by, p[0] - bx, bh], strip: [p[0], by, bx1 - p[0], bh] }); // …right
      if (py1 < by1) cuts.push({ stay: [bx, py1, bw, by1 - py1], strip: [bx, by, bw, py1 - by] }); // …above
      if (p[1] > by) cuts.push({ stay: [bx, by, bw, p[1] - by], strip: [bx, p[1], bw, by1 - p[1]] }); // …below
      let best: number[] | null = null;
      for (const { stay, strip } of cuts) {
        if (area(strip) <= 0) continue;
        const s = inter(strip, p);
        if (s[2] * s[3] < CUT_SHARE * area(strip)) continue;
        const holds = (k: number[]) => k[0] >= stay[0] - e && k[1] >= stay[1] - e && k[0] + k[2] <= stay[0] + stay[2] + e && k[1] + k[3] <= stay[1] + stay[3] + e;
        if (keep.some((k) => area(inter(k, b)) > 0 && !holds(k))) continue;
        if (!best || area(stay) > area(best)) best = stay;
      }
      if (best) b = best;
    }
    if (b[2] > 0.02 && b[3] > 0.02) out.push(b);
  }
  return out;
}

/** Luma of the top-left 2W×2H pixels at half size (steadier edges, a quarter of the work). */
export function halfLuma(rgba: Uint8ClampedArray | Uint8Array, stride: number, W: number, H: number): Float32Array {
  const y = new Float32Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      let s = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const p = ((2 * j + dy) * stride + 2 * i + dx) * 4;
          s += rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114;
        }
      y[j * W + i] = s / 4;
    }
  return y;
}

/** Long straight edge lines of an image: vertical ones (columns) or horizontal ones (rows). */
export function lines(y: Float32Array, W: number, H: number, vertical: boolean, minRun: number): Line[] {
  const across = vertical ? W : H;
  const along = vertical ? H : W;
  const need = Math.round(minRun * along);
  const best: Line[] = [];
  for (let a = 2; a < across - 2; a++) {
    let runFrom = -1, last = -1, bFrom = 0, bTo = 0, n = 0, bN = 0;
    const close = () => {
      if (runFrom >= 0 && last - runFrom > bTo - bFrom) {
        bFrom = runFrom;
        bTo = last;
        bN = n;
      }
    };
    for (let b = 0; b < along; b++) {
      const at = (k: number) => (vertical ? y[b * W + k] : y[k * W + b]);
      const d = Math.abs(at(a + 1) - at(a - 1));
      // an edge may sit between pixels: look one over as well
      const e = d >= EDGE || Math.abs(at(a + 2) - at(a)) >= EDGE;
      if (!e) continue;
      if (runFrom >= 0 && b - last <= GAP + 1) {
        last = b;
        n++;
      } else {
        close();
        runFrom = last = b;
        n = 1;
      }
    }
    close();
    if (bTo - bFrom >= need) best.push({ at: a, from: bFrom, to: bTo, fill: bN / (bTo - bFrom + 1) });
  }
  // neighbouring columns are one thick edge: keep the longest
  const out: Line[] = [];
  for (const l of best) {
    const p = out[out.length - 1];
    if (p && l.at - p.at <= 2) {
      if (l.to - l.from > p.to - p.from) out[out.length - 1] = l;
    } else out.push(l);
  }
  return out;
}

/**
 * The inside of the plate differs from the strips just outside its left and right edge in the same
 * direction (an overlay is brighter than what it covers, or darker, on both sides) — a door frame or
 * a monitor has one such edge at best.
 */
function sidedAlike(y: Float32Array, W: number, H: number, xl: number, xr: number, y0: number, y1: number): boolean {
  const strip = (x0: number, x1: number): number => {
    let s = 0, n = 0;
    for (let j = Math.max(0, y0); j < Math.min(H, y1); j++)
      for (let i = Math.max(0, x0); i < Math.min(W, x1); i++) {
        s += y[j * W + i];
        n++;
      }
    return n ? s / n : NaN;
  };
  const m = 4;
  const inL = strip(xl + 2, xl + 2 + m), inR = strip(xr - 2 - m, xr - 2);
  const outL = strip(xl - 2 - m, xl - 2), outR = strip(xr + 2, xr + 2 + m);
  // (a side too close to the frame's edge has a thin or no strip outside: judged by the other one)
  const dl = inL - outL, dr = inR - outR;
  if (Number.isNaN(dl) && Number.isNaN(dr)) return false;
  if (Number.isNaN(dl)) return Math.abs(dr) >= POLARITY;
  if (Number.isNaN(dr)) return Math.abs(dl) >= POLARITY;
  return dl * dr > 0 && Math.min(Math.abs(dl), Math.abs(dr)) >= POLARITY;
}
