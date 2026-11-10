import { CLIP_WOMEN } from './clip';
import { IntervalSet } from './intervals';
import { VOICE_STEP, voiceSex } from './voice';
import type { VisionFrame } from '../shared/vision-messages';

/**
 * Thresholds: nudity groups are NudeNet confidences (it reports detections from 0.2–0.25);
 * `female` is the gender classifier's probability that a visible face is a woman; `femaleVoice`
 * replaces it where mostly a woman's voice is heard (see VOICE_FEMALE_SHARE). On 231 labelled
 * portraits: 0.3 finds 97.4% of women and takes 2.6% of men for women; 0.05 finds 98.3% / 7%.
 */
export const THRESHOLDS = { nude: 0.3, skin: 0.65, skinWeak: 0.5, female: 0.3, femaleVoice: 0.05 };
/**
 * `skin` (bare torso / belly) is a weak signal: NudeNet takes a dark jacket over a printed T-shirt,
 * or a sun-lit forearm, for it at 0.3–0.57 for seconds at a time (a clothed man in a car review
 * blurred the whole frame for 7 s). One frame counts only at THRESHOLDS.skin; between skinWeak and
 * that it takes SKIN_MIN_LOOKS looks within ±SKIN_WINDOW seconds — a bare torso scores high on
 * every look, clothes flicker.
 */
export const SKIN_MIN_LOOKS = 3;
export const SKIN_WINDOW = 0.75;
/**
 * A part of a shot sounds like a woman when at least this share of the windows with a voice in it
 * are a woman's (by pitch), over at least VOICE_MIN_WINDOWS of them. A man's voice changes
 * nothing: he may be asking a woman on screen.
 */
export const VOICE_FEMALE_SHARE = 0.7;
export const VOICE_MIN_WINDOWS = 2;
/**
 * Women nobody located (MobileCLIP sees them, no face or body was found): the whole frame is
 * blurred when at least CLIP_MIN_FRAMES looks in this part of the shot, and CLIP_MIN_SHARE of
 * them, score CLIP_WOMEN — one stray frame of a group of men doesn't blur their scene.
 */
export const CLIP_MIN_FRAMES = 2;
export const CLIP_MIN_SHARE = 0.3;
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
 * Margin around a person's rect, as a share of its width (sides, top) and height (bottom), at least
 * MIN_MARGIN of the frame: a seated woman's crossed legs or an arm reach out of the face-based
 * estimate. The top goes by the width: a body rect is tall, and a margin by its height would
 * reach up over the head beside it (the two would merge into one box covering the background).
 */
export const PERSON_MARGIN = { x: 0.12, top: 0.03, bottom: 0.1 };
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
  /** …with someone who may be a woman (at the lowest threshold)… */
  women: number[];
  /** …and with a scene score: all of them, and those showing women. */
  scene: number[];
  sceneWomen: number[];
}

/**
 * What the classifier found for one media session: analysed intervals, shot cuts and classified
 * frames. Lives in the page; filled from the vision worker's results.
 */
export class VisionTimeline {
  readonly checked = new IntervalSet();
  private frames: VisionFrame[] = [];
  private cuts: number[] = [];
  /** Voice pitch windows (start time, Hz; 0: no voice), ascending. */
  private voice: { t: number; f0: number }[] = [];
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

  /** Voice pitch of an audio tile: `f0s` every VOICE_STEP seconds from `start` (replaces what was known there). */
  addVoice(start: number, f0s: number[]): void {
    const end = start + f0s.length * VOICE_STEP;
    const k = this.lowerBound(this.voice, start - 1e-3);
    let e = k;
    while (e < this.voice.length && this.voice[e].t < end - 1e-3) e++;
    this.voice.splice(k, e - k, ...f0s.map((f0, i) => ({ t: start + i * VOICE_STEP, f0 })));
    this.version++;
  }

  /** Mostly a woman's voice heard in [lo, hi). */
  womanHeard(lo: number, hi: number): boolean {
    let f = 0, m = 0;
    for (let i = this.lowerBound(this.voice, lo - VOICE_STEP / 2); i < this.voice.length && this.voice[i].t < hi; i++) {
      const s = voiceSex(this.voice[i].f0);
      if (s === 'f') f++;
      else if (s === 'm') m++;
    }
    return f >= VOICE_MIN_WINDOWS && f >= VOICE_FEMALE_SHARE * (f + m);
  }

  private addCut(t: number): void {
    const k = this.lowerBound(this.cuts, t - 0.02);
    if (k < this.cuts.length && Math.abs(this.cuts[k] - t) <= 0.02) return;
    this.cuts.splice(k, 0, t);
  }

  /** Debug: [t, nude, skin, female, scene (-1: none)] rows. */
  dump(): number[][] {
    return this.frames.map((f) => [f.t, f.nude, f.skin, f.female, f.scene ?? -1]);
  }

  /** Debug: [t, Hz] voice pitch windows. */
  voiceDump(): number[][] {
    return this.voice.map((v) => [Math.round(v.t * 100) / 100, v.f0]);
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
    if (!p.women) return { verdict: 'clear', rects: [] };

    // every look at a woman in this part of the shot, grouped into people; faces the classifier
    // isn't sure about count when a woman's voice is heard
    const th = this.womanHeard(lo, hi) ? THRESHOLDS.femaleVoice : THRESHOLDS.female;
    const looks: Look[] = [];
    for (const i of s.women) {
      const f = this.frames[i];
      if (f.t < lo || f.t >= hi) continue;
      for (const r of womenOf(f, th)) looks.push({ t: f.t, r });
    }
    const rects: number[][] = [];
    for (const person of people(looks)) rects.push(this.whereIs(person, t));
    if (rects.length) return { verdict: 'region', rects, shot: a };
    // women seen in the picture, but not where they are: all of it
    const inRange = (idx: number[]) => idx.filter((i) => this.frames[i].t >= lo && this.frames[i].t < hi).length;
    const k = inRange(s.sceneWomen);
    if (k >= CLIP_MIN_FRAMES && k >= CLIP_MIN_SHARE * inRange(s.scene)) return { verdict: 'full', rects: [], shot: a };
    return { verdict: 'clear', rects: [], shot: a };
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
    const scene: number[] = [];
    const sceneWomen: number[] = [];
    const weakSkin: number[] = [];
    for (let i = this.lowerBound(this.frames, a - 1e-4); i < this.frames.length && this.frames[i].t < b - 1e-4; i++) {
      const f = this.frames[i];
      if (f.skin >= THRESHOLDS.skinWeak && f.skin < THRESHOLDS.skin) weakSkin.push(i);
      if (f.nude >= THRESHOLDS.nude || f.skin >= THRESHOLDS.skin) nude.push(i);
      if (womenOf(f, Math.min(THRESHOLDS.female, THRESHOLDS.femaleVoice)).length) women.push(i);
      if (f.scene !== undefined) {
        scene.push(i);
        if (f.scene >= CLIP_WOMEN) sceneWomen.push(i);
      }
    }
    // weak skin looks that repeat (this one included) count; keep `nude` ascending
    const repeated = weakSkin.filter((i) => weakSkin.filter((j) => Math.abs(this.frames[j].t - this.frames[i].t) <= SKIN_WINDOW).length >= SKIN_MIN_LOOKS);
    if (repeated.length) nude.push(...repeated.filter((i) => !nude.includes(i))), nude.sort((p, q) => p - q);
    this.shot = { key, nude, women, scene, sceneWomen };
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
  const y0 = Math.max(0, r[1] - Math.max(MIN_MARGIN, PERSON_MARGIN.top * r[2]));
  const y1 = Math.min(1, r[1] + r[3] + Math.max(MIN_MARGIN, PERSON_MARGIN.bottom * r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/** The women in a frame (score at least th), [x, y, w, h] each. */
function womenOf(f: VisionFrame, th: number): number[][] {
  const out: number[][] = [];
  for (let j = 0; j + 4 < f.women.length; j += 5) {
    if (f.women[j + 4] >= th) out.push([f.women[j], f.women[j + 1], f.women[j + 2], f.women[j + 3]]);
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
