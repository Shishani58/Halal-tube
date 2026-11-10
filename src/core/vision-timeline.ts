import { IntervalSet } from './intervals';
import type { VisionFrame } from '../shared/vision-messages';

/**
 * Thresholds: nudity groups are NudeNet confidences (it reports detections from 0.2–0.25);
 * `female` is the gender classifier's probability that a visible face is a woman.
 */
export const THRESHOLDS = { nude: 0.3, skin: 0.4, female: 0.5 };
/**
 * Decisions are made per shot (the frames between two cuts): what is found anywhere in a shot holds
 * for all of it, so a woman is hidden from the shot's first frame even if her face only shows later.
 * Before calling a frame clear, the classifier must have seen its shot this far ahead (or to its end).
 */
export const SHOT_AHEAD = 2.0;
/**
 * A finding reaches at most this far within its shot: a long continuous take (a walk through a
 * room, a lecture) changes content without a cut, and one false detection shouldn't blur minutes.
 */
export const SHOT_REACH = 8;
/**
 * A woman who stays in place (her boxes over the shot add up to at most this × her largest box)
 * gets one still box for the whole shot; one who moves is followed, from her looks this close to t…
 */
export const STILL_GROWTH = 1.8;
export const MOVE_WINDOW = 1.0;
/** …grown by MOTION_MARGIN per second to the nearest look when she was only seen on one side of t. */
export const MOTION_MARGIN = 0.25;
/**
 * Margin around a person, as a share of her box (sides, top, bottom), at least MIN_MARGIN of the
 * frame: a seated woman's crossed legs or an arm reach out of the face-based estimate.
 */
export const PERSON_MARGIN = { x: 0.12, top: 0.04, bottom: 0.1 };
export const MIN_MARGIN = 0.025;

export interface BlurPolicy {
  /** Blur women (besides nudity, which is always blurred). */
  women: boolean;
}

/**
 * clear · region: only `rects` (women) are blurred · full: the whole frame (nudity) ·
 * unknown: not analysed yet (whole frame in strict mode).
 */
export type Verdict = 'unknown' | 'full' | 'region' | 'clear';

export interface Decision {
  verdict: Verdict;
  /** Frame-relative [x, y, w, h] rects to blur (region verdict). */
  rects: number[][];
  /** Start of the shot t is in (boxes are kept still within a shot). */
  shot?: number;
}

interface ShotInfo {
  key: string;
  /** Indices (into frames, ascending) of frames with nudity… */
  nude: number[];
  /** …and with a woman. */
  women: number[];
}

/**
 * What the classifier found for one media session: analysed intervals, shot cuts and classified
 * frames. Lives in the page; filled from the vision worker's results.
 */
export class VisionTimeline {
  readonly checked = new IntervalSet();
  private frames: VisionFrame[] = [];
  private cuts: number[] = [];
  private version = 0;
  private shot: ShotInfo | null = null;

  add(r: { from: number; to: number; frames: VisionFrame[]; cuts: number[]; cutRange: [number, number]; edges: [number, number][] }): void {
    for (const f of r.frames) {
      const k = this.lowerBound(this.frames, f.t - 1e-3);
      if (k < this.frames.length && Math.abs(this.frames[k].t - f.t) < 1e-3) this.frames[k] = f;
      else this.frames.splice(k, 0, f);
    }
    const [a, b] = r.cutRange;
    this.cuts = this.cuts.filter((c) => c <= a + 1e-3 || c >= b - 1e-3);
    for (const c of r.cuts) this.addCut(c);
    for (const [t, cut] of r.edges) {
      this.cuts = this.cuts.filter((c) => Math.abs(c - t) > 0.02);
      if (cut) this.addCut(t);
    }
    this.checked.add(r.from, r.to);
    this.version++;
  }

  private addCut(t: number): void {
    const k = this.lowerBound(this.cuts, t - 0.02);
    if (k < this.cuts.length && Math.abs(this.cuts[k] - t) <= 0.02) return;
    this.cuts.splice(k, 0, t);
  }

  /** Debug: [t, nude, skin, female] rows. */
  dump(): number[][] {
    return this.frames.map((f) => [f.t, f.nude, f.skin, f.female]);
  }

  get sampleCount(): number {
    return this.frames.length;
  }

  get cutTimes(): readonly number[] {
    return this.cuts;
  }

  /** The shot around t: [start, end) between cuts (±Infinity when none known). */
  shotAt(t: number): [number, number] {
    const k = this.lowerBound(this.cuts, t + 1e-4); // cuts[k] > t (a cut at t starts this shot)
    return [k > 0 ? this.cuts[k - 1] : -Infinity, k < this.cuts.length ? this.cuts[k] : Infinity];
  }

  /**
   * What to blur in the frame shown at media time t. `end`: media duration (a shot can't be
   * checked past it).
   */
  decide(t: number, p: BlurPolicy, end = Infinity): Decision {
    const none: Decision = { verdict: 'unknown', rects: [] };
    if (!this.checked.has(t)) return none;
    const [a, b] = this.shotAt(t);
    const until = Math.min(b, t + SHOT_AHEAD, end - 0.05);
    if (until > t && !this.checked.covers(t, until)) return none;

    const s = this.shotInfo(a, b);
    const lo = Math.max(a, t - SHOT_REACH), hi = Math.min(b, t + SHOT_REACH);
    const near = (idx: number[]) => {
      const k = this.firstAfter(idx, t);
      return { prev: idx[k - 1], next: idx[k] };
    };
    const n = near(s.nude);
    if ((n.prev !== undefined && this.frames[n.prev].t >= lo) || (n.next !== undefined && this.frames[n.next].t < hi)) return { verdict: 'full', rects: [] };
    if (!p.women || !s.women.length) return { verdict: 'clear', rects: [] };

    // every look at a woman in this part of the shot, grouped into people
    const looks: Look[] = [];
    for (const i of s.women) {
      const f = this.frames[i];
      if (f.t < lo || f.t >= hi) continue;
      for (const r of womenOf(f)) looks.push({ t: f.t, r });
    }
    const rects: number[][] = [];
    for (const person of people(looks)) rects.push(this.whereIs(person, t));
    return rects.length ? { verdict: 'region', rects, shot: a } : { verdict: 'clear', rects: [], shot: a };
  }

  /** Where to blur one person (her looks in this part of the shot) at t. */
  private whereIs(person: Look[], t: number): number[] {
    let hull = person[0].r;
    let largest = 0;
    for (const l of person) {
      hull = union(hull, l.r);
      largest = Math.max(largest, area(l.r));
    }
    // she stays in place: the same box for the whole shot
    if (area(hull) <= STILL_GROWTH * largest) return pad(hull);
    // she moves: where she is around t
    let near: number[] | null = null;
    let before = Infinity, after = Infinity;
    for (const l of person) {
      const dt = l.t - t;
      if (Math.abs(dt) > MOVE_WINDOW) continue;
      near = near ? union(near, l.r) : l.r;
      if (dt <= 0) before = Math.min(before, -dt);
      else after = Math.min(after, dt);
    }
    // not seen near t (face turned away, hidden): everywhere she was in this part of the shot
    if (!near) return pad(hull);
    const gap = Number.isFinite(before) && Number.isFinite(after) ? 0 : Math.min(before, after);
    return grow(pad(near), MOTION_MARGIN * gap);
  }

  /** First k with frames[idx[k]].t > t. */
  private firstAfter(idx: number[], t: number): number {
    let lo = 0, hi = idx.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.frames[idx[m]].t <= t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  private shotInfo(a: number, b: number): ShotInfo {
    const key = `${a}|${b}|${this.version}`;
    if (this.shot?.key === key) return this.shot;
    const nude: number[] = [];
    const women: number[] = [];
    for (let i = this.lowerBound(this.frames, a - 1e-4); i < this.frames.length && this.frames[i].t < b - 1e-4; i++) {
      const f = this.frames[i];
      if (f.nude >= THRESHOLDS.nude || f.skin >= THRESHOLDS.skin) nude.push(i);
      if (f.female >= THRESHOLDS.female && womenOf(f).length) women.push(i);
    }
    this.shot = { key, nude, women };
    return this.shot;
  }

  private lowerBound(arr: readonly ({ t: number } | number)[], t: number): number {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      const v = arr[m];
      if ((typeof v === 'number' ? v : v.t) < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
}

interface Look {
  t: number;
  r: number[];
}

/** Looks whose boxes overlap (directly or through others) are the same person. */
function people(looks: Look[]): Look[][] {
  const parent = looks.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < looks.length; i++)
    for (let j = i + 1; j < looks.length; j++) if (overlap(looks[i].r, looks[j].r) > 0.3) parent[root(i)] = root(j);
  const groups = new Map<number, Look[]>();
  looks.forEach((l, i) => {
    const k = root(i);
    const g = groups.get(k);
    if (g) g.push(l);
    else groups.set(k, [l]);
  });
  return [...groups.values()];
}

/** Intersection over the smaller of the two areas. */
export function overlap(a: number[], b: number[]): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1e-9, Math.min(area(a), area(b)));
}

export function area(r: number[]): number {
  return Math.max(0, r[2]) * Math.max(0, r[3]);
}

/** A person's box with her margin. */
function pad(r: number[]): number[] {
  const mx = Math.max(MIN_MARGIN, PERSON_MARGIN.x * r[2]);
  const x0 = Math.max(0, r[0] - mx), x1 = Math.min(1, r[0] + r[2] + mx);
  const y0 = Math.max(0, r[1] - Math.max(MIN_MARGIN, PERSON_MARGIN.top * r[3]));
  const y1 = Math.min(1, r[1] + r[3] + Math.max(MIN_MARGIN, PERSON_MARGIN.bottom * r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/** The women in a frame, [x, y, w, h] each. */
function womenOf(f: VisionFrame): number[][] {
  const out: number[][] = [];
  for (let j = 0; j + 4 < f.women.length; j += 5) {
    if (f.women[j + 4] >= THRESHOLDS.female) out.push([f.women[j], f.women[j + 1], f.women[j + 2], f.women[j + 3]]);
  }
  return out;
}

export function grow(r: number[], m: number): number[] {
  const x0 = Math.max(0, r[0] - m), y0 = Math.max(0, r[1] - m);
  const x1 = Math.min(1, r[0] + r[2] + m), y1 = Math.min(1, r[1] + r[3] + m);
  return [x0, y0, x1 - x0, y1 - y0];
}

export function union(a: number[], b: number[]): number[] {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  return [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0];
}
