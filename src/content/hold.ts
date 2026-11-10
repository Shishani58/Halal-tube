/**
 * MAIN world: the "pause until ready" setting. Pauses the video while its clean sound or its frame
 * check hasn't caught up (see core/hold.ts) and resumes it afterwards. Only a video that was playing
 * is ever paused, and only the one this class paused is resumed.
 */
import { HoldGate, type HoldKind, type HoldPart } from '../core/hold';

type YtPlayer = HTMLElement & { pauseVideo?: () => void; playVideo?: () => void };

export class PauseHold {
  private readonly gate = new HoldGate();
  private video: HTMLVideoElement | null = null;
  private session = 0;

  /** What the video is being held for (empty: not held). */
  get waiting(): HoldKind[] {
    return this.gate.held ? this.gate.waiting : [];
  }

  /** Short note for the on-video badge. */
  note(): string {
    const w = this.waiting;
    if (!w.length) return '';
    const what = [w.includes('audio') ? 'звук' : '', w.includes('blur') ? 'кадры' : ''].filter(Boolean).join(' и ');
    return `⏸ Пауза: ${what} ещё не готов${w.length > 1 ? 'ы' : w.includes('blur') ? 'ы' : ''}`;
  }

  /**
   * One step (every tick). `v` / `session`: the video the page works on; `enabled`: the setting is
   * on; `parts`: what that video depends on (empty: nothing to wait for).
   */
  tick(v: HTMLVideoElement | null, session: number, enabled: boolean, parts: HoldPart[]): void {
    if (this.video && (v !== this.video || session !== this.session)) {
      // another video (or stream) took over: nothing of ours to resume
      this.gate.reset();
      this.video = null;
    }
    if (!v || !session) return;
    const player = document.getElementById('movie_player') as YtPlayer | null;
    // only the main player: feed hover previews and the like are never held
    const skip = !player?.contains(v) || player.classList.contains('ad-showing');
    const d = v.duration;
    const act = this.gate.update({
      now: performance.now(),
      enabled,
      paused: v.paused,
      ended: v.ended,
      time: v.currentTime,
      remaining: Number.isFinite(d) ? Math.max(0, d - v.currentTime) : Infinity,
      parts: skip ? [] : parts,
    });
    if (act === 'pause') {
      this.video = v;
      this.session = session;
      // the player's own API keeps YouTube's controls in step with the video
      if (player?.pauseVideo) player.pauseVideo();
      if (!v.paused) v.pause();
    } else if (act === 'resume') {
      this.video = null;
      if (!v.paused || v.ended) return;
      if (player?.playVideo) player.playVideo();
      else void v.play().catch(() => undefined);
    }
  }
}
