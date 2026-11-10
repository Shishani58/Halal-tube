/**
 * How often the scene model (MobileCLIP, the costliest stage: ~30 ms a look, three squares each)
 * has to look. The page needs it only to call a whole shot "women" when nobody was located
 * (vision-timeline: ≥ CLIP_MIN_FRAMES looks showing women within ±SHOT_REACH of the frame, and a
 * share of the looks), and a frame with nudity or a located woman never consults it. So it is
 * spent per shot, not per classified frame:
 *
 *  - a frame already decided without it (nudity, a woman found) gets no look;
 *  - a new shot (a cut, a jump back in time, a long gap) or a picture that changed a lot since the
 *    last look starts with START_LOOKS looks, ≥ START_GAP apart — enough for the page's rule;
 *  - after that one look every GAP_WOMEN seconds when the shot showed women (keeps ≥ 2 looks inside
 *    the page's ±SHOT_REACH window), every GAP_CLEAR seconds when it did not (a woman who walks in
 *    still gets her two looks; the change test catches larger changes at once).
 *
 * Analysis runs well ahead of playback and a finding holds for the whole shot, so sparse looks
 * delay nothing; they only make a finding come a little later in the shot.
 *
 * `clipMode` is the governor for computers that cannot keep up: it thins the looks out (economy)
 * or stops them (off) while the checked part ahead of the playhead is short and analysis is slow.
 */
import { CLIP_WOMEN } from './clip';
import { thumbDiff, type Thumb } from './shots';

export const CLIP_START_LOOKS = 2;
export const CLIP_START_GAP = 0.5;
export const CLIP_GAP_WOMEN = 4;
export const CLIP_GAP_CLEAR = 3;
/** Economy mode stretches the gaps by this much. */
export const CLIP_ECONOMY = 2;
/** A picture this different from the last look (mean luma difference / histogram distance) is new content. */
export const CLIP_CHANGE_PIX = 14;
export const CLIP_CHANGE_HIST = 0.2;
/** A gap this long between two frames it is asked about: not the same shot any more. */
export const CLIP_RESET_GAP = 8;

export type ClipMode = 'full' | 'economy' | 'off';

export class ClipBudget {
  /** Set from `clipMode` before each batch. */
  mode: ClipMode = 'full';
  private seenT = -Infinity;
  private lastT = -Infinity;
  private lastThumb: Thumb | null = null;
  private looks = 0;
  private women = false;

  /**
   * Should the frame at `t` get a look? `cut`: it starts a new shot; `decided`: nudity or a located
   * woman already settles it. Frames come in time order within a run; going back in time starts over.
   */
  want(t: number, th: Thumb | null, cut: boolean, decided: boolean): boolean {
    if (cut || t < this.seenT || t - this.seenT > CLIP_RESET_GAP) this.reset();
    this.seenT = t;
    if (decided || this.mode === 'off') return false;
    if (!th) return true;
    const gap = t - this.lastT;
    if (this.lastThumb && gap >= CLIP_START_GAP) {
      const d = thumbDiff(this.lastThumb, th);
      if (d.pix >= CLIP_CHANGE_PIX || d.hist >= CLIP_CHANGE_HIST) this.reset();
    }
    let run: boolean;
    if (this.looks < CLIP_START_LOOKS) run = this.looks === 0 || t - this.lastT >= CLIP_START_GAP;
    else run = t - this.lastT >= (this.women ? CLIP_GAP_WOMEN : CLIP_GAP_CLEAR) * (this.mode === 'economy' ? CLIP_ECONOMY : 1);
    if (!run) return false;
    this.lastT = t;
    this.lastThumb = th;
    this.looks++;
    return true;
  }

  /** The score of the look just asked for. */
  result(score: number): void {
    if (score >= CLIP_WOMEN) this.women = true;
  }

  private reset(): void {
    this.lastT = -Infinity;
    this.lastThumb = null;
    this.looks = 0;
    this.women = false;
  }
}

/**
 * The look rate for the current load. `ahead`: seconds checked beyond the playhead (Infinity:
 * unknown); `speed`: seconds of video analysed per second of work (0: not known yet). Off while
 * behind (slow and little ahead), back to economy once a good stretch is checked; economy while
 * slow; full otherwise. The thresholds between economy and full leave a gap so it doesn't flap.
 */
export function clipMode(prev: ClipMode, ahead: number, speed: number): ClipMode {
  if (prev === 'off') return ahead >= 20 ? 'economy' : 'off';
  if (speed > 0 && speed < 1.2 && ahead < 8) return 'off';
  if (speed > 0 && speed < 3) return 'economy';
  if (prev === 'economy' && speed > 0 && speed < 4) return 'economy';
  return 'full';
}
