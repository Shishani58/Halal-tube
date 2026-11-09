/**
 * Shot (scene cut) detection on tiny thumbnails of every decoded frame, and the frame-sampling
 * policy built on it. A shot is the run of frames between two hard cuts: blurring decisions are
 * made per shot, and frames are classified where the picture actually changes (at a cut, after
 * enough motion) instead of at a fixed rate.
 */

export const THUMB_W = 32;
export const THUMB_H = 18;
const N = THUMB_W * THUMB_H;
/** RGB histogram: 4 levels per channel. */
const BINS = 64;

export interface Thumb {
  /** Luma per pixel (THUMB_W × THUMB_H). */
  y: Uint8Array;
  /** Normalised RGB histogram (sums to 1). */
  hist: Float32Array;
}

/** RGBA bytes of a THUMB_W × THUMB_H image → thumbnail features. */
export function makeThumb(rgba: Uint8ClampedArray | Uint8Array): Thumb {
  const y = new Uint8Array(N);
  const hist = new Float32Array(BINS);
  const k = 1 / N;
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    y[i] = (r * 77 + g * 150 + b * 29) >> 8;
    hist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)] += k;
  }
  return { y, hist };
}

export interface ThumbDiff {
  /** Mean absolute luma difference, 0–255. */
  pix: number;
  /** The same, at the best of small shifts of one image against the other (camera motion removed). */
  moved: number;
  /** Histogram distance (half L1), 0–1. */
  hist: number;
}

/** Mean |a − b| over the overlap with b shifted by (dx, dy) pixels. */
function shiftedDiff(a: Uint8Array, b: Uint8Array, dx: number, dy: number): number {
  let s = 0, n = 0;
  for (let y = Math.max(0, -dy); y < THUMB_H - Math.max(0, dy); y++) {
    const ra = y * THUMB_W, rb = (y + dy) * THUMB_W + dx;
    for (let x = Math.max(0, -dx); x < THUMB_W - Math.max(0, dx); x++) s += Math.abs(a[ra + x] - b[rb + x]);
    n += THUMB_W - Math.abs(dx);
  }
  return s / n;
}

/** Cut at a GOP boundary: last frame of one GOP vs the first of the next, with each side's motion. */
export function isEdgeCut(a: Thumb, aRecent: number, b: Thumb, bRecent: number): boolean {
  const calm = Number.isFinite(aRecent) && Number.isFinite(bRecent);
  return isCut(thumbDiff(a, b), calm ? Math.max(aRecent, bRecent) : 0, calm);
}

export function thumbDiff(a: Thumb, b: Thumb): ThumbDiff {
  const pix = shiftedDiff(a.y, b.y, 0, 0);
  let moved = pix;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) if (dx || dy) moved = Math.min(moved, shiftedDiff(a.y, b.y, dx, dy));
  let h = 0;
  for (let i = 0; i < BINS; i++) h += Math.abs(a.hist[i] - b.hist[i]);
  return { pix, moved, hist: h / 2 };
}

/**
 * Hard cut between two consecutive frames. Both the layout (pixels) and the colours
 * (histogram) must change: a pan or a flash changes one of them, a new shot changes both.
 * `recentPix`: typical frame-to-frame pixel change in the preceding frames, so fast motion
 * (which changes everything a bit every frame) doesn't read as a chain of cuts.
 */
export function isCut(d: ThumbDiff, recentPix = 0, calm = false): boolean {
  if (d.pix < 14) return false;
  // a calm shot (steady picture for a while) that suddenly jumps: a cut even between similar-looking shots
  if (calm && d.pix >= 20 && d.hist >= 0.08 && d.pix >= 4 * recentPix + 8) return true;
  if (d.pix < 2.5 * recentPix + 6) return false;
  return d.hist >= 0.3 || (d.pix >= 40 && d.hist >= 0.15);
}

/** Sampling policy: seconds between classified frames inside a shot. */
export const SAMPLE_MIN = 0.2;
export const SAMPLE_MAX = 0.5;
/** Picture change (mean |Δluma| vs the last classified frame) that warrants a new look early. */
export const MOTION_RESAMPLE = 10;

/**
 * Follows the decoded frames of one GOP in order: finds cuts and decides which frames to classify.
 * Deterministic, so a re-run over a longer copy of a still-growing GOP repeats earlier decisions.
 */
export class ShotTracker {
  private prev: Thumb | null = null;
  private lastSampled: Thumb | null = null;
  private lastSampleT = -Infinity;
  private recent: number[] = [];
  /** Last cut and the frame before it: a flash returns to that picture within a few frames. */
  private flash: { before: Thumb; frames: number; recent: number } | null = null;
  /** Times of the frames that start a new shot (cuts inside the GOP). */
  readonly cuts: number[] = [];
  /** Thumbnails of the first and the last frame seen (to check cuts across GOP boundaries). */
  first: Thumb | null = null;
  last: Thumb | null = null;
  firstT = NaN;
  lastT = NaN;
  /** Typical frame-to-frame change over the first / last 8 frames (NaN: fewer frames, or a cut there). */
  startRecent = NaN;
  get endRecent(): number {
    return this.recent.length >= 8 ? median(this.recent) : NaN;
  }

  /** → whether the frame starts a new shot, and whether to classify it. */
  push(t: number, th: Thumb): { cut: boolean; sample: boolean } {
    let cut = false;
    let sample: boolean;
    if (!this.prev) {
      this.first = th;
      this.firstT = t;
      sample = true; // nothing known before the GOP's first frame
    } else {
      const d = thumbDiff(this.prev, th);
      const recent = this.recent.length ? median(this.recent) : 0;
      // "calm" needs a full window of frames from this shot (not right after a cut or the GOP start)
      cut = isCut(d, recent, this.recent.length >= 8);
      if (this.flash && ++this.flash.frames <= FLASH_FRAMES) {
        const back = thumbDiff(this.flash.before, th);
        // (as close to it as frames in that shot were to each other, allowing for the frames missed)
        if (back.pix < Math.max(10, (this.flash.frames + 1) * this.flash.recent + 4) && back.hist < 0.15) {
          // a flash or a single odd frame, not a new shot: take the cut back
          this.cuts.pop();
          this.flash = null;
          cut = false;
        }
      }
      this.recent.push(d.pix);
      if (this.recent.length > 8) this.recent.shift();
      if (this.recent.length === 8 && !this.cuts.length && Number.isNaN(this.startRecent)) this.startRecent = median(this.recent);
      if (cut) {
        this.cuts.push(t);
        this.flash = { before: this.prev, frames: 0, recent };
        this.recent.length = 0;
        sample = true;
      } else {
        const dt = t - this.lastSampleT;
        sample = dt >= SAMPLE_MAX - 0.02 || (dt >= SAMPLE_MIN - 0.02 && thumbDiff(this.lastSampled!, th).pix >= MOTION_RESAMPLE);
      }
    }
    if (sample) {
      this.lastSampled = th;
      this.lastSampleT = t;
    }
    this.prev = th;
    this.last = th;
    this.lastT = t;
    return { cut, sample };
  }
}

/** A cut followed by a return to the previous picture within this many frames is a flash. */
const FLASH_FRAMES = 4;

function median(a: number[]): number {
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}
