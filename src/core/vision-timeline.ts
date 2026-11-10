import { CLIP_WOMEN } from './clip';
import { area, grow, overlap, union } from './rects';
import { platesBetween, platesOf } from './plates';

export { area, grow, overlap, union };
import { IntervalSet } from './intervals';
import { VOICE_STEP, voiceSex } from './voice';
import type { VisionFrame } from '../shared/vision-messages';

/**
 * Thresholds: nudity groups are NudeNet confidences (it reports detections from 0.2–0.25);
 * `female` is the gender classifier's probability that a visible face is a woman, for ONE look
 * (on 231 labelled portraits 0.3 finds 97.4% of women and takes 2.6% of men for women). A single
 * look is that unreliable on video — small, turned, blurred faces — so a person is called a woman
 * only by several looks together (PERSON). `thumbFemale`: a thumbnail is one picture, often a
 * stylised one with several faces, and gets no second look: it needs a surer one.
 */
export const THRESHOLDS = { nude: 0.5, nudeWeak: 0.3, skin: 0.65, skinWeak: 0.5, female: 0.3, thumbFemale: 0.6 };
/**
 * When a person (the looks of her face over a shot, clustered by position) is a woman. A look at
 * `look` or more votes "woman"; she is one when the mean probability over all her looks
 * (the looks that said "man" included) reaches `mean` and at least min(looks, 2) voted. Her only
 * look needs `single`. A woman found by her body alone (no face; revealing-clothes classes fire on
 * clothed men too) needs `bodyLooks` looks of `bodyMean` on average, or one of `bodySure`. Where a woman's voice is heard
 * the most woman-like face of the shot (within `voiceBest` of the best mean) is enough from `voiceMean`.
 */
export const PERSON = { look: 0.3, mean: 0.4, single: 0.5, bodyLooks: 2, bodyMean: 0.5, bodySure: 0.85, voiceMean: 0.2, voiceBest: 0.85 };
/** A face this surely a man over at least MAN_LOOKS looks: a scene model's "women" doubts then need more votes. */
export const MAN_MEAN = 0.12;
export const MAN_LOOKS = 2;
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
 * Explicit-nudity classes work the same way. A bald head filling the frame (no face found: dark
 * glasses, head down) scored BUTTOCKS_EXPOSED 0.48 and MALE_GENITALIA_EXPOSED 0.32 in a talk show
 * and blurred the shot; real nudity scores 0.5–0.75 on every look (bare chests: 0.45–0.75). One
 * look counts only at THRESHOLDS.nude; between nudeWeak and that it takes NUDE_MIN_LOOKS looks
 * within ±SKIN_WINDOW seconds.
 */
export const NUDE_MIN_LOOKS = 3;
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
 * them, score CLIP_WOMEN — one stray frame of a group of men doesn't blur their scene. When faces
 * were found and all of them are men's, the scene model is probably confusing a group of men with
 * women (it does that for about 1 in 10 such pictures): then CLIP_MIN_SHARE_MEN of the looks.
 */
export const CLIP_MIN_FRAMES = 2;
export const CLIP_MIN_SHARE_MEN = 0.8;
/** What a woman's rect covers (VisionFrame.parts): heads and bodies are kept as separate boxes. */
export const PART = { whole: 0, head: 1, body: 2 } as const;
export const CLIP_MIN_SHARE = 0.5;
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
export const STILL_GROWTH = 1.4;
export const MOVE_WINDOW = 1.0;
/** …grown by MOTION_MARGIN per second to the nearest look when she was only seen on one side of t. */
export const MOTION_MARGIN = 0.25;
/**
 * Margin around a person's rect, as a share of its width (sides, top) and height (bottom), at least
 * MIN_MARGIN of the frame: a seated woman's crossed legs or an arm reach out of the face-based
 * estimate. The top goes by the width: a body rect is tall, and a margin by its height would
 * reach up over the head beside it (the two would merge into one box covering the background).
 */
export const PERSON_MARGIN = { x: 0.06, top: 0.03, bottom: 0.06 };
export const MIN_MARGIN = 0.025;
/** Plates are taken from the looks within this many seconds before and after the moment. */
export const PLATE_REACH = 0.8;

/**
 * How readily frames are blurred (the popup's «Чувствительность»). Every threshold above is the
 * 'normal' level; 'soft' wants more evidence (fewer false blurs, a woman far from the camera may
 * slip through), 'strict' blurs when in doubt. Nudity is blurred at every level, only its score
 * thresholds move.
 */
export type BlurLevel = 'soft' | 'normal' | 'strict';
export type PersonTuning = typeof PERSON;
export interface Tuning {
  /** Explicit nudity: one look at this or more counts… */
  nude: number;
  /** …between nudeWeak and nude it takes nudeLooks looks close together. */
  nudeWeak: number;
  nudeLooks: number;
  skin: number;
  skinWeak: number;
  skinLooks: number;
  person: PersonTuning;
  /** MobileCLIP "women in the picture" score, and the share of looks that must reach it (the second: when faces found are all men's). */
  clipWomen: number;
  clipShare: number;
  clipShareMen: number;
  /** A thumbnail's woman: best look, and mean over her looks. */
  thumbFemale: number;
  thumbMean: number;
}

const TUNINGS: Record<BlurLevel, Tuning> = {
  normal: {
    nude: THRESHOLDS.nude, nudeWeak: THRESHOLDS.nudeWeak, nudeLooks: NUDE_MIN_LOOKS, skin: THRESHOLDS.skin, skinWeak: THRESHOLDS.skinWeak, skinLooks: SKIN_MIN_LOOKS, person: PERSON,
    clipWomen: CLIP_WOMEN, clipShare: CLIP_MIN_SHARE, clipShareMen: CLIP_MIN_SHARE_MEN, thumbFemale: THRESHOLDS.thumbFemale, thumbMean: 0.5,
  },
  soft: {
    nude: 0.6, nudeWeak: 0.4, nudeLooks: 4, skin: 0.75, skinWeak: 0.6, skinLooks: 4,
    person: { look: 0.35, mean: 0.5, single: 0.6, bodyLooks: 3, bodyMean: 0.6, bodySure: 0.92, voiceMean: 0.3, voiceBest: 0.9 },
    clipWomen: CLIP_WOMEN + 0.1, clipShare: 0.65, clipShareMen: 0.9, thumbFemale: 0.7, thumbMean: 0.55,
  },
  strict: {
    nude: 0.4, nudeWeak: 0.25, nudeLooks: 2, skin: 0.55, skinWeak: 0.4, skinLooks: 2,
    person: { look: 0.25, mean: 0.3, single: 0.4, bodyLooks: 1, bodyMean: 0.4, bodySure: 0.75, voiceMean: 0.12, voiceBest: 0.75 },
    clipWomen: CLIP_WOMEN - 0.1, clipShare: 0.35, clipShareMen: 0.65, thumbFemale: THRESHOLDS.thumbFemale, thumbMean: 0.5,
  },
};

export function tuningFor(level: BlurLevel | undefined): Tuning {
  return TUNINGS[level ?? 'normal'] ?? TUNINGS.normal;
}

/** A timeline's findings, as kept between viewings of a video. */
export interface CacheData {
  frames: VisionFrame[];
  cuts: number[];
  spans: [number, number][];
}

export interface BlurPolicy {
  /** Blur women (besides nudity, which is always blurred). */
  women: boolean;
  /**
   * Strict mode blurs whatever isn't certain yet: a shot not checked far enough ahead is 'unknown'
   * whatever was found in it. Otherwise what was found so far is acted on at once.
   */
  strict?: boolean;
  /** Sensitivity (default 'normal'). */
  level?: BlurLevel;
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
  /** Overlay plates in the picture at t (frame-relative [x, y, w, h]): not part of anyone, never blurred. */
  plates?: number[][];
}

interface ShotInfo {
  key: string;
  /** Indices (into frames, ascending) of frames with nudity… */
  nude: number[];
  /** …with a person found (a face or body; whether a woman is decided over all of them)… */
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

  /**
   * What was found so far (frames, cuts, analysed spans), for keeping between viewings of a video
   * (vision-store). The voice pitch isn't included: it is measured again with the audio.
   */
  toCache(): CacheData {
    return { frames: this.frames, cuts: this.cuts.slice(), spans: this.checked.spans.map((s) => [s[0], s[1]]) };
  }

  /**
   * Merge a kept record in. What this timeline already knows wins at the same moment (it is newer);
   * the record fills in the rest, and its spans count as analysed.
   */
  load(d: CacheData): void {
    for (const f of d.frames) {
      const k = this.lowerBound(this.frames, f.t - 1e-3);
      if (k < this.frames.length && Math.abs(this.frames[k].t - f.t) < 1e-3) continue;
      this.frames.splice(k, 0, f);
    }
    for (const c of d.cuts) this.addCut(c);
    for (const [a, b] of d.spans) this.checked.add(a, b);
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

  /** Debug: [t, x, y, w, h] of every overlay plate found. */
  platesDump(): number[][] {
    return this.frames.flatMap((f) => platesOf(f.plates).map((r) => [f.t, ...r]));
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
    // The shot isn't checked far enough ahead. What is found so far still counts (a woman already
    // seen, nudity), so the blur doesn't drop out whenever the checking is close behind the playhead;
    // only a clear verdict can't be given yet.
    const ahead = until <= t || this.checked.covers(t, until);
    if (!ahead && p.strict) return none;

    const tune = tuningFor(p.level);
    const s = this.shotInfo(a, b, tune, p.level ?? 'normal');
    const lo = Math.max(a, t - SHOT_REACH), hi = Math.min(b, t + SHOT_REACH);
    const near = (idx: number[]) => {
      const k = this.firstAfter(idx, t);
      return { prev: idx[k - 1], next: idx[k] };
    };
    const n = near(s.nude);
    if ((n.prev !== undefined && this.frames[n.prev].t >= lo) || (n.next !== undefined && this.frames[n.next].t < hi)) return { verdict: 'full', rects: [] };
    if (!p.women) return ahead ? { verdict: 'clear', rects: [] } : none;

    // every look at anyone in this part of the shot (men's too: they vote against), grouped into
    // people; each is judged on all her looks together, not on her most woman-like one
    const looks: Look[] = [];
    for (const i of s.women) {
      const f = this.frames[i];
      if (f.t < lo || f.t >= hi) continue;
      looks.push(...looksOf(f));
    }
    const group = people(looks);
    const stats = group.map((g) => statsOf(g, tune.person.look));
    const heads = stats.filter((_, i) => group[i].part !== PART.whole);
    const best = Math.max(0, ...heads.map((x) => x.mean));
    const voice = this.womanHeard(lo, hi);
    const rects: number[][] = [];
    group.forEach((person, i) => {
      const st = stats[i];
      const byVoice = voice && person.part !== PART.whole && st.mean >= tune.person.voiceMean && st.mean >= tune.person.voiceBest * best;
      if (!isWoman(st, person.part, tune.person) && !byVoice) return;
      rects.push([...this.whereIs(person.anchors, t), person.part]);
      if (person.bodies.length) rects.push([...this.whereIs(person.bodies, t), PART.body]);
    });
    if (rects.length) return { verdict: 'region', rects, shot: a, plates: this.platesAt(t, a, b) };
    if (!ahead) return none;
    // women seen in the picture, but not where they are: all of it
    const inRange = (idx: number[]) => idx.filter((i) => this.frames[i].t >= lo && this.frames[i].t < hi).length;
    const k = inRange(s.sceneWomen);
    const men = heads.some((x) => x.n >= MAN_LOOKS && x.mean <= MAN_MEAN);
    if (k >= CLIP_MIN_FRAMES && k >= (men ? tune.clipShareMen : tune.clipShare) * inRange(s.scene)) return { verdict: 'full', rects: [], shot: a };
    return { verdict: 'clear', rects: [], shot: a };
  }

  /**
   * The overlay plates at t: those of the looks in this shot within PLATE_REACH before and after it
   * (see platesBetween).
   */
  private platesAt(t: number, a: number, b: number): number[][] {
    const k = this.lowerBound(this.frames, t + 1e-4);
    const take = (from: number, step: number, ok: (ft: number) => boolean): number[][][] => {
      const out: number[][][] = [];
      for (let i = from; i >= 0 && i < this.frames.length && ok(this.frames[i].t); i += step) out.push(platesOf(this.frames[i].plates));
      return out;
    };
    const inShot = (ft: number) => ft >= a - 1e-4 && ft < b - 1e-4;
    return platesBetween(
      take(k - 1, -1, (ft) => inShot(ft) && t - ft <= PLATE_REACH),
      take(k, 1, (ft) => inShot(ft) && ft - t <= PLATE_REACH),
    );
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

  private shotInfo(a: number, b: number, tune: Tuning, level: BlurLevel): ShotInfo {
    const key = `${a}|${b}|${this.version}|${level}`;
    if (this.shot?.key === key) return this.shot;
    const nude: number[] = [];
    const women: number[] = [];
    const scene: number[] = [];
    const sceneWomen: number[] = [];
    const weakSkin: number[] = [];
    const weakNude: number[] = [];
    for (let i = this.lowerBound(this.frames, a - 1e-4); i < this.frames.length && this.frames[i].t < b - 1e-4; i++) {
      const f = this.frames[i];
      if (f.skin >= tune.skinWeak && f.skin < tune.skin) weakSkin.push(i);
      if (f.nude >= tune.nudeWeak && f.nude < tune.nude) weakNude.push(i);
      if (f.nude >= tune.nude || f.skin >= tune.skin) nude.push(i);
      if (f.women.length) women.push(i);
      if (f.scene !== undefined) {
        scene.push(i);
        if (f.scene >= tune.clipWomen) sceneWomen.push(i);
      }
    }
    // weak looks (bare torso, nudity) that repeat (this one included) count; keep `nude` ascending
    const repeats = (weak: number[], looks: number) => weak.filter((i) => weak.filter((j) => Math.abs(this.frames[j].t - this.frames[i].t) <= SKIN_WINDOW).length >= looks);
    const repeated = [...repeats(weakSkin, tune.skinLooks), ...repeats(weakNude, tune.nudeLooks)];
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
  /** [x, y, w, h, part] */
  r: number[];
  /** Probability that this person is a woman, by this look. */
  p: number;
  /** A body look: the head look of the same face (they share `p`). */
  of?: Look;
}

/** A person: her head (or whole-person) looks, and the body looks that belong to them. */
interface Person {
  part: number;
  anchors: Look[];
  bodies: Look[];
}

/** Every look in a frame: for each person a head (or whole) rect, and a body rect that follows it. */
function looksOf(f: VisionFrame): Look[] {
  const out: Look[] = [];
  let anchor: Look | undefined;
  for (let j = 0, i = 0; j + 4 < f.women.length; j += 5, i++) {
    const part = f.parts?.[i] ?? PART.whole;
    const look: Look = { t: f.t, r: [f.women[j], f.women[j + 1], f.women[j + 2], f.women[j + 3], part], p: f.women[j + 4] };
    if (part === PART.body && anchor) look.of = anchor;
    else anchor = look;
    out.push(look);
  }
  return out;
}

/**
 * Looks whose boxes overlap (directly or through others) are the same person. Her head (or whole
 * body, when no face was found) decides who is who: heads go with heads, and a body look follows
 * its own head. Bodies clustered among themselves chained neighbours into one person, and a head
 * seen a little lower in one frame overlaps the body of another — one box over the whole frame.
 */
function people(looks: Look[]): Person[] {
  const anchors = looks.filter((l) => !l.of);
  const parent = anchors.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < anchors.length; i++)
    for (let j = i + 1; j < anchors.length; j++)
      if (anchors[i].r[4] === anchors[j].r[4] && overlap(anchors[i].r, anchors[j].r) > 0.3) parent[root(i)] = root(j);
  const groups = new Map<number, Person>();
  const of = new Map<Look, Person>();
  anchors.forEach((l, i) => {
    const k = root(i);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { part: l.r[4], anchors: [], bodies: [] }));
    g.anchors.push(l);
    of.set(l, g);
  });
  for (const l of looks) if (l.of) of.get(l.of)?.bodies.push(l);
  return [...groups.values()];
}

interface Stats {
  n: number;
  /** Looks at THRESHOLDS.female or more. */
  votes: number;
  mean: number;
  max: number;
}

function statsOf(person: Person, look: number = PERSON.look): Stats {
  let votes = 0, sum = 0, max = 0;
  for (const l of person.anchors) {
    if (l.p >= look) votes++;
    sum += l.p;
    max = Math.max(max, l.p);
  }
  const n = person.anchors.length;
  return { n, votes, mean: sum / Math.max(1, n), max };
}

/** Is this person a woman (PERSON)? */
export function isWoman(s: Stats, part: number, t: PersonTuning = PERSON): boolean {
  if (part === PART.whole) return (s.n >= t.bodyLooks && s.mean >= t.bodyMean) || s.max >= t.bodySure;
  if (s.n === 1) return s.max >= t.single;
  return s.mean >= t.mean && s.votes >= 2;
}

/**
 * A thumbnail is one picture, seen whole and in parts (the same faces again, not independent
 * evidence): a person in it is a woman only when her best look reaches THRESHOLDS.thumbFemale
 * AND the mean over all her looks reaches THUMB_MEAN — a man's face that one crop takes for a
 * woman's is outvoted by the looks that said "man".
 */
export const THUMB_MEAN = 0.5;
/** An unsure face (best look, mean of looks): a woman only when the scene model agrees (clip.ts CLIP_THUMB_WOMEN). */
export const THUMB_SOFT = { look: 0.2, mean: 0.2 };

/**
 * The women in a still picture, judged by all looks at them: `female` is the best look of the most
 * woman-like one (0: none), `rects` the boxes to blur ([x, y, w, h] in the whole picture's
 * coordinates, one for each woman: head and body together). `looks`: the whole picture and its
 * parts, their women rects already in the whole picture's coordinates. `soft`, for when the scene
 * model backs the verdict up: 'unsure' also takes the unsure faces (THUMB_SOFT); 'lone' takes the
 * only person of the picture whatever the face classifier said (it can call a woman's face a man's).
 */
export function pictureWomen(looks: VisionFrame[], soft?: 'unsure' | 'lone'): { female: number; rects: number[][] } {
  const [minLook, minMean] = soft === 'unsure' ? [THUMB_SOFT.look, THUMB_SOFT.mean] : soft === 'lone' ? [0, 0] : [THRESHOLDS.thumbFemale, THUMB_MEAN];
  let female = 0;
  const rects: number[][] = [];
  const persons = people(looks.flatMap(looksOf));
  if (soft === 'lone' && persons.length !== 1) return { female, rects };
  for (const person of persons) {
    const s = statsOf(person);
    if (s.max < minLook || s.mean < minMean) continue;
    female = Math.max(female, soft ? Math.max(s.max, THRESHOLDS.thumbFemale) : s.max);
    const hull = (ls: Look[]) => ls.map((l) => l.r).reduce((u, r) => union(u, r));
    // one box per woman: head and body together (two boxes on one person look like two things)
    rects.push(pad(hull([...person.anchors, ...person.bodies])));
  }
  return { female, rects };
}

export function pictureFemale(looks: VisionFrame[]): number {
  return pictureWomen(looks).female;
}

/** A person's box with her margin. */
function pad(r: number[]): number[] {
  const mx = Math.max(MIN_MARGIN, PERSON_MARGIN.x * r[2]);
  const x0 = Math.max(0, r[0] - mx), x1 = Math.min(1, r[0] + r[2] + mx);
  const y0 = Math.max(0, r[1] - Math.max(MIN_MARGIN, PERSON_MARGIN.top * r[2]));
  const y1 = Math.min(1, r[1] + r[3] + Math.max(MIN_MARGIN, PERSON_MARGIN.bottom * r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}
