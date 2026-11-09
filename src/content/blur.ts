/**
 * MAIN world: blurring. Forwards the video track (as the player buffers it, i.e. ahead of
 * playback) to the frame classifier and blurs <video> elements whenever the frame on screen
 * is flagged — or, in strict mode, not checked yet. The blur is a CSS filter on the element:
 * composited on the GPU, no pixel work in the page.
 */
import { MSG_NS, type Settings } from '../shared/messages';
import { isInitSegment, type FromVision, type PageVision, type ToVision, type VisionStatus } from '../shared/vision-messages';
import { VisionTimeline } from '../core/vision-timeline';

interface VideoSb {
  id: number;
  session: number;
  mime: string;
  /** Latest init segment (needed to start mid-stream when blurring gets enabled). */
  init: ArrayBuffer | null;
  tsOffset: number;
  announced: boolean;
}

const MAX_SBS = 8;
const MAX_TIMELINES = 8;

function copyOf(data: BufferSource): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data.slice(0);
  const v = data as ArrayBufferView;
  return (v.buffer as ArrayBuffer).slice(v.byteOffset, v.byteOffset + v.byteLength);
}

function headOf(data: BufferSource): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data, 0, Math.min(8, data.byteLength));
  const v = data as ArrayBufferView;
  return new Uint8Array(v.buffer, v.byteOffset, Math.min(8, v.byteLength));
}

export class VisionController {
  private sbs = new Map<number, VideoSb>();
  private timelines = new Map<number, VisionTimeline>();
  private active = false;
  private lastPos = 0;
  private blurred = new Set<HTMLVideoElement>();
  private ambientHidden = false;
  status: VisionStatus | null = null;
  state: PageVision['state'] = 'off';

  constructor(
    private readonly getSettings: () => Settings,
    private readonly sessionOf: (v: HTMLVideoElement) => number,
  ) {}

  private send(msg: ToVision): void {
    window.postMessage({ ns: MSG_NS, from: 'main', kind: 'to-vision', msg }, '*');
  }

  // ───────── MSE hooks (called for video SourceBuffers) ─────────
  isVideo(sb: number): boolean {
    return this.sbs.has(sb);
  }

  onSourceBuffer(id: number, session: number, mime: string): void {
    const prev = this.sbs.get(id);
    if (prev && prev.mime === mime) return;
    this.sbs.set(id, { id, session, mime, init: prev?.init ?? null, tsOffset: 0, announced: false });
    if (this.sbs.size > MAX_SBS) this.sbs.delete(this.sbs.keys().next().value!);
    if (this.active) this.announce(this.sbs.get(id)!);
  }

  onAppend(id: number, data: BufferSource, tsOffset: number): void {
    const sb = this.sbs.get(id);
    if (!sb) return;
    const init = isInitSegment(headOf(data));
    if (!init && !this.active) return; // no copies at all while blurring is off
    const copy = copyOf(data);
    if (init) {
      sb.init = copy;
      sb.tsOffset = tsOffset;
    }
    if (!this.active) return;
    if (!sb.announced) this.announce(sb, init);
    this.send({ type: 'append', session: sb.session, sb: sb.id, data: copy, tsOffset });
  }

  onAbort(id: number): void {
    const sb = this.sbs.get(id);
    if (sb && this.active) this.send({ type: 'abort', session: sb.session, sb: sb.id });
  }

  private announce(sb: VideoSb, skipInit = false): void {
    sb.announced = true;
    this.send({ type: 'sb-init', session: sb.session, sb: sb.id, mime: sb.mime });
    if (sb.init && !skipInit) this.send({ type: 'append', session: sb.session, sb: sb.id, data: sb.init.slice(0), tsOffset: sb.tsOffset });
  }

  // ───────── results ─────────
  onMessage(msg: FromVision): void {
    if (msg.type === 'status') this.status = msg.status;
    else if (msg.type === 'result') {
      let tl = this.timelines.get(msg.session);
      if (!tl) {
        tl = new VisionTimeline();
        this.timelines.set(msg.session, tl);
        if (this.timelines.size > MAX_TIMELINES) this.timelines.delete(this.timelines.keys().next().value!);
      }
      tl.add(msg.from, msg.to, msg.samples);
    } else if (msg.type === 'ready') this.lastPos = 0;
  }

  timeline(session: number): VisionTimeline | undefined {
    return this.timelines.get(session);
  }

  // ───────── per-frame decision ─────────
  tick(activeVideo: HTMLVideoElement | null): void {
    const s = this.getSettings();
    const on = s.blur;
    if (on !== this.active) {
      this.active = on;
      for (const sb of this.sbs.values()) sb.announced = false;
      if (on) for (const sb of this.sbs.values()) this.announce(sb);
    }
    let activeBlurred = false;
    const seen = new Set<HTMLVideoElement>();
    if (on) {
      for (const v of Array.from(document.querySelectorAll('video'))) {
        seen.add(v);
        const verdict = this.verdict(v, s);
        const blur = verdict === 'unsafe' || (verdict === 'unknown' && s.blurStrict);
        this.apply(v, blur);
        if (v === activeVideo) {
          activeBlurred = blur;
          this.state = verdict === 'unsafe' ? 'hidden' : verdict === 'unknown' ? 'checking' : 'clear';
        }
      }
      if (!activeVideo) this.state = 'no-video';
    } else this.state = 'off';
    for (const v of this.blurred) if (!seen.has(v)) this.apply(v, false);
    this.hideAmbient(activeBlurred);

    const now = performance.now();
    if (activeVideo && now - this.lastPos > 250) {
      const session = this.sessionOf(activeVideo);
      // while off, a single 'disabled' position lets the worker go idle (and free the model later)
      if (session && (on || this.lastPos)) {
        this.lastPos = on ? now : 0;
        const d = activeVideo.duration;
        this.send({ type: 'position', session, time: activeVideo.currentTime, duration: Number.isFinite(d) ? d : Infinity, enabled: on });
      }
    }
  }

  private verdict(v: HTMLVideoElement, s: Settings): 'unsafe' | 'safe' | 'unknown' {
    const sid = this.sessionOf(v);
    const tl = sid ? this.timelines.get(sid) : undefined;
    return tl ? tl.decide(v.currentTime, { women: s.blurWomen }) : 'unknown';
  }

  private apply(v: HTMLVideoElement, blur: boolean): void {
    if (blur) {
      const r = v.getBoundingClientRect();
      const px = Math.max(24, Math.round(Math.min(r.width, r.height) / 8));
      const want = `blur(${px}px)`;
      if (v.style.getPropertyValue('filter') !== want) v.style.setProperty('filter', want, 'important');
      this.blurred.add(v);
    } else if (this.blurred.has(v)) {
      v.style.removeProperty('filter');
      this.blurred.delete(v);
    }
  }

  /** YouTube's ambient mode paints the current frame around the player: hide it while blurred. */
  private hideAmbient(hide: boolean): void {
    if (hide === this.ambientHidden) return;
    this.ambientHidden = hide;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('#cinematics, #cinematics-container'))) {
      if (hide) el.style.setProperty('visibility', 'hidden', 'important');
      else el.style.removeProperty('visibility');
    }
  }

  pageState(): PageVision {
    return { status: this.status, state: this.state };
  }

  /** Short note for the on-video badge ('' = nothing to say). */
  badgeText(): string {
    const s = this.getSettings();
    if (!s.blur) return '';
    if (this.status?.model === 'error') return '⚠ Размытие: ошибка модели';
    if (this.state === 'checking' && s.blurStrict) return '⏳ Проверяю кадры…';
    if (this.state === 'hidden') return '🙈 Скрыто';
    return '';
  }
}
