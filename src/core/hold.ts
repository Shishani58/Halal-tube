/**
 * "Pause until ready": while the sound without music or the frame check (blur) hasn't caught up
 * with the playhead, the video is kept paused instead of playing silence / a blurred frame, and
 * resumed once there's a little reserve. Pure decision logic; the DOM side is content/hold.ts.
 */

/** Resume only with this many seconds ready ahead (so it doesn't stall again at once). */
export const HOLD_RESUME_AHEAD = 3;
/** Held this long without progress → give up and let the video play as the other settings say. */
export const HOLD_GIVE_UP_MS = 60_000;
/** A playhead move beyond this (seconds) is a seek: the give-up timer starts over. */
const SEEK_JUMP = 1.5;

export type HoldKind = 'audio' | 'blur';

/** One thing the video waits for. */
export interface HoldPart {
  kind: HoldKind;
  /** What is under the playhead (the clean sound, a checked frame) is ready. */
  now: boolean;
  /** Seconds ready ahead of the playhead. */
  ahead: number;
}

export interface HoldInput {
  /** performance.now() */
  now: number;
  /** The setting is on and the extension is enabled. */
  enabled: boolean;
  paused: boolean;
  ended: boolean;
  /** Media time, seconds. */
  time: number;
  /** Seconds to the end of the video (Infinity: live / unknown). */
  remaining: number;
  /** What the video depends on right now (empty: nothing to wait for, e.g. an ad or an error). */
  parts: HoldPart[];
}

export type HoldAction = 'none' | 'pause' | 'resume';

export class HoldGate {
  held = false;
  /** Gave up on this stretch: don't hold again until everything has been ready once. */
  gaveUp = false;
  /** What the video is waiting for while held. */
  waiting: HoldKind[] = [];
  private since = 0;
  private lastTime = 0;

  reset(): void {
    this.held = false;
    this.gaveUp = false;
    this.waiting = [];
  }

  update(i: HoldInput): HoldAction {
    const parts = i.enabled ? i.parts : [];
    if (!parts.length) {
      const was = this.held;
      this.reset();
      return was ? 'resume' : 'none';
    }
    const need = Math.min(HOLD_RESUME_AHEAD, Math.max(i.remaining, 0.25));
    const caughtUp = parts.every((p) => p.now);
    const reserve = caughtUp && parts.every((p) => p.ahead >= need);
    const jumped = Math.abs(i.time - this.lastTime) > SEEK_JUMP;
    this.lastTime = i.time;

    if (!this.held) {
      if (caughtUp) this.gaveUp = false;
      if (this.gaveUp || i.paused || i.ended || caughtUp) return 'none';
      this.held = true;
      this.since = i.now;
      this.waiting = parts.filter((p) => !p.now).map((p) => p.kind);
      return 'pause';
    }

    if (reserve) {
      this.reset();
      return 'resume';
    }
    if (jumped) this.since = i.now;
    if (i.now - this.since > HOLD_GIVE_UP_MS) {
      this.reset();
      this.gaveUp = true;
      return 'resume';
    }
    this.waiting = parts.filter((p) => !p.now || p.ahead < need).map((p) => p.kind);
    // someone pressed play meanwhile: the hold stays
    return i.paused ? 'none' : 'pause';
  }
}
