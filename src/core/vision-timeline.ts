import { IntervalSet } from './intervals';

/**
 * Thresholds: nudity groups are NudeNet confidences (it reports detections from 0.2–0.25);
 * `female` is the gender classifier's probability that a visible face is a woman.
 */
export const THRESHOLDS = { nude: 0.3, skin: 0.4, female: 0.5 };
/** Blur starts this long before the first flagged frame… */
export const BLUR_BEFORE = 0.6;
/** …and lasts this long after the last one (also smooths frame-to-frame flicker). */
export const BLUR_AFTER = 1.0;

export interface BlurPolicy {
  /** Blur any frame where a woman is visible (besides nudity, which is always blurred). */
  women: boolean;
}

export type Verdict = 'unsafe' | 'safe' | 'unknown';

/**
 * What the classifier found for one media session: analysed intervals and flagged frame times.
 * Lives in the page; filled from the vision worker's results.
 */
export class VisionTimeline {
  readonly checked = new IntervalSet();
  /** Sorted sample times and their [nude, skin, female] scores. */
  private times: number[] = [];
  private scores: number[][] = [];

  /** `samples`: flat [t, nude, skin, female, …] for frames in [from, to]. */
  add(from: number, to: number, samples: number[]): void {
    for (let i = 0; i + 3 < samples.length; i += 4) {
      const t = samples[i];
      const k = this.lowerBound(t);
      const s = [samples[i + 1], samples[i + 2], samples[i + 3]];
      if (k < this.times.length && Math.abs(this.times[k] - t) < 1e-3) this.scores[k] = s;
      else {
        this.times.splice(k, 0, t);
        this.scores.splice(k, 0, s);
      }
    }
    this.checked.add(from, to);
  }

  /** Debug: [t, nude, skin, female] rows. */
  dump(): number[][] {
    return this.times.map((t, i) => [t, ...this.scores[i]]);
  }

  get sampleCount(): number {
    return this.times.length;
  }

  flagged(s: number[], p: BlurPolicy): boolean {
    return s[0] >= THRESHOLDS.nude || s[1] >= THRESHOLDS.skin || (p.women && s[2] >= THRESHOLDS.female);
  }

  /** Verdict for the frame shown at media time t. */
  decide(t: number, p: BlurPolicy): Verdict {
    const from = this.lowerBound(t - BLUR_AFTER);
    for (let k = from; k < this.times.length && this.times[k] <= t + BLUR_BEFORE; k++) {
      if (this.flagged(this.scores[k], p)) return 'unsafe';
    }
    return this.checked.has(t) ? 'safe' : 'unknown';
  }

  private lowerBound(t: number): number {
    let lo = 0, hi = this.times.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.times[m] < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
}
