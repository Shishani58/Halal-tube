/**
 * MAIN world: blurring. Forwards the video track (as the player buffers it, i.e. ahead of
 * playback) to the frame classifier and blurs what the frame on screen must not show:
 *  - women: only where they are — boxes laid over the video with `backdrop-filter: blur()`;
 *  - nudity, and (strict mode) frames not checked yet: the whole frame, a CSS filter on <video>.
 * Both are composited on the GPU, no pixel work in the page. While a video plays, the decision is
 * remade every animation frame and switches exactly at shot cuts; the boxes are kept still within a
 * shot (StableBoxes). Video thumbnails are handled by ThumbBlur.
 */
import { MSG_NS, type Settings } from '../shared/messages';
import { isInitSegment, type FromVision, type PageVision, type ToVision, type VisionStatus } from '../shared/vision-messages';
import { PART, VisionTimeline, type Decision } from '../core/vision-timeline';
import { cutPlates, samePlate } from '../core/plates';
import type { HoldPart } from '../core/hold';
import { StableBoxes } from '../core/stable-boxes';
import { ThumbBlur } from './thumbs';

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
/** A video id must be shown by the player this long (ms) before findings are kept under it. */
const ID_STABLE_MS = 1500;
const MAX_TIMELINES = 8;
/**
 * The frame on screen can be a little ahead of `currentTime` (and the boxes land on the next
 * paint): decisions also look this far ahead (seconds of playback at 1×) and behind.
 */
const LEAD = 0.12;
const LAG = 0.05;

/** Boxes over one video (women's regions). */
interface Overlay {
  root: HTMLDivElement;
  boxes: HTMLDivElement[];
  fit: string;
  fitAt: number;
}

/** Element-space rectangle the picture occupies inside a <video> (object-fit). */
function contentBox(v: HTMLVideoElement, r: DOMRect, fit: string): { x: number; y: number; w: number; h: number } {
  const W = r.width, H = r.height;
  const vw = v.videoWidth || W, vh = v.videoHeight || H;
  if (fit === 'fill' || !vw || !vh) return { x: 0, y: 0, w: W, h: H };
  let k = fit === 'cover' ? Math.max(W / vw, H / vh) : fit === 'none' ? 1 : Math.min(W / vw, H / vh);
  if (fit === 'scale-down') k = Math.min(1, Math.min(W / vw, H / vh));
  const w = vw * k, h = vh * k;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

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
  private overlays = new Map<HTMLVideoElement, Overlay>();
  private ambientHidden = false;
  private activeVideo: HTMLVideoElement | null = null;
  /** Still boxes per video; `t`/`seeks` tell a seek from playback. */
  private steady = new WeakMap<HTMLVideoElement, { boxes: StableBoxes; t: number; seeks: number }>();
  /** Video thumbnails (feed, sidebar, end screen). */
  private readonly thumbs = new ThumbBlur((m) => this.send(m));
  private raf = 0;
  private idSeen: { session: number; id: string; duration: number; since: number } | null = null;
  /** Women boxes on the active video right now. */
  private regions = 0;
  status: VisionStatus | null = null;
  state: PageVision['state'] = 'off';

  constructor(
    private readonly getSettings: () => Settings,
    private readonly sessionOf: (v: HTMLVideoElement) => number,
  ) {}

  /** Appends must carry a buffer of their own: it is transferred, not copied. */
  private send(msg: ToVision): void {
    window.postMessage({ ns: MSG_NS, from: 'main', kind: 'to-vision', msg }, '*', msg.type === 'append' ? [msg.data] : []);
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
    // keep the Map in least-recently-appended order: the cap drops idle buffers, never the playing one
    this.sbs.delete(id);
    this.sbs.set(id, sb);
    const init = isInitSegment(headOf(data));
    if (!init && !this.active) return; // no copies at all while blurring is off
    const copy = copyOf(data);
    if (init) {
      sb.init = copy;
      sb.tsOffset = tsOffset;
    }
    if (!this.active) return;
    if (!sb.announced) this.announce(sb, init);
    this.send({ type: 'append', session: sb.session, sb: sb.id, data: init ? copy.slice(0) : copy, tsOffset });
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
    else if (msg.type === 'image') this.thumbs.onResult(msg);
    else if (msg.type === 'cache') this.timelineFor(msg.session).load(msg.data);
    else if (msg.type === 'result') {
      let tl = this.timelines.get(msg.session);
      if (tl) this.timelines.delete(msg.session); // re-inserted below: least-recently-updated order
      else tl = new VisionTimeline();
      this.timelines.set(msg.session, tl);
      if (this.timelines.size > MAX_TIMELINES) this.timelines.delete(this.timelines.keys().next().value!);
      tl.add(msg);
    } else if (msg.type === 'ready') {
      this.lastPos = 0;
      this.thumbs.onRestart();
    }
  }

  /** Voice pitch of an audio tile of this session (from the audio processor). */
  onVoice(session: number, start: number, f0s: number[]): void {
    let tl = this.timelines.get(session);
    if (!tl) {
      tl = new VisionTimeline();
      this.timelines.set(session, tl);
      if (this.timelines.size > MAX_TIMELINES) this.timelines.delete(this.timelines.keys().next().value!);
    }
    tl.addVoice(start, f0s);
  }

  private timelineFor(session: number): VisionTimeline {
    let tl = this.timelines.get(session);
    if (!tl) {
      tl = new VisionTimeline();
      this.timelines.set(session, tl);
      if (this.timelines.size > MAX_TIMELINES) this.timelines.delete(this.timelines.keys().next().value!);
    }
    return tl;
  }

  /**
   * The YouTube id of the video in this session, when the player has shown the same one for a
   * moment (on a page change the player's data lags behind the new stream) and it is a recorded
   * video, not an ad or a live stream. Undefined: nothing is kept for it.
   */
  private videoId(session: number, duration: number): string | undefined {
    const s = this.getSettings();
    const p = document.getElementById('movie_player') as (HTMLElement & { getPlayerResponse?: () => { videoDetails?: { videoId?: string; isLive?: boolean } } }) | null;
    const details = s.blurCache && Number.isFinite(duration) && !p?.classList.contains('ad-showing') ? p?.getPlayerResponse?.()?.videoDetails : undefined;
    const id = details && !details.isLive ? details.videoId : undefined;
    const now = performance.now();
    if (!id) {
      this.idSeen = null;
      return undefined;
    }
    if (!this.idSeen || this.idSeen.session !== session || this.idSeen.id !== id || this.idSeen.duration !== Math.round(duration)) this.idSeen = { session, id, duration: Math.round(duration), since: now };
    return now - this.idSeen.since >= ID_STABLE_MS ? id : undefined;
  }

  timeline(session: number): VisionTimeline | undefined {
    return this.timelines.get(session);
  }

  // ───────── per-frame decision ─────────
  tick(activeVideo: HTMLVideoElement | null): void {
    const s = this.getSettings();
    const on = s.enabled && s.blur; // the header switch turns everything off
    if (on !== this.active) {
      this.active = on;
      for (const sb of this.sbs.values()) sb.announced = false;
      if (on) for (const sb of this.sbs.values()) this.announce(sb);
    }
    this.activeVideo = activeVideo;
    this.frame();
    this.thumbs.tick(s);

    const now = performance.now();
    if (activeVideo && now - this.lastPos > 250) {
      const session = this.sessionOf(activeVideo);
      // while off, a single 'disabled' position lets the worker go idle (and free the model later)
      if (session && (on || this.lastPos)) {
        this.lastPos = on ? now : 0;
        const d = activeVideo.duration;
        const duration = Number.isFinite(d) ? d : Infinity;
        this.send({ type: 'position', session, time: activeVideo.currentTime, duration, enabled: on, videoId: on ? this.videoId(session, duration) : undefined });
      }
    }
  }

  /** Decide and apply the blur for every video; repeats each animation frame while one plays. */
  private frame(): void {
    const s = this.getSettings();
    const on = this.active;
    let activeBlurred = false;
    let playing = false;
    const seen = new Set<HTMLVideoElement>();
    if (on) {
      for (const v of Array.from(document.getElementsByTagName('video'))) {
        seen.add(v);
        if (!v.paused && !v.ended) playing = true;
        const d = this.decision(v, s);
        let full = d.verdict === 'full' || (d.verdict === 'unknown' && s.blurStrict);
        // boxes are page elements: a <video> shown fullscreen by itself (or in PiP) would leave them behind
        if (d.verdict === 'region' && (document.fullscreenElement === v || document.pictureInPictureElement === v)) full = true;
        this.apply(v, full);
        const rects = !full && d.verdict === 'region' ? this.still(v, d) : [];
        if (!rects.length) this.steady.get(v)?.boxes.reset();
        this.place(v, rects);
        if (v === this.activeVideo) {
          activeBlurred = full || d.verdict === 'region';
          this.regions = rects.length;
          this.state = d.verdict === 'full' || d.verdict === 'region' ? 'hidden' : d.verdict === 'unknown' ? 'checking' : 'clear';
        }
      }
      if (!this.activeVideo) this.state = 'no-video';
    } else this.state = 'off';
    for (const v of this.blurred) if (!seen.has(v)) this.apply(v, false);
    for (const v of this.overlays.keys()) if (!seen.has(v)) this.place(v, []);
    this.hideAmbient(activeBlurred);

    if (on && playing && !document.hidden && !this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        try {
          this.frame();
        } catch (e) {
          console.warn('[music-remover] blur frame error', e);
        }
      });
    }
  }

  /**
   * What to blur on v now: the shown frame and its neighbours within LEAD / LAG, so a cut or a
   * woman coming in is covered from the first frame whatever the paint timing.
   */
  private decision(v: HTMLVideoElement, s: Settings): Decision {
    const sid = this.sessionOf(v);
    const tl = sid ? this.timelines.get(sid) : undefined;
    if (!tl) return { verdict: 'unknown', rects: [] };
    const t = v.currentTime;
    const d = Number.isFinite(v.duration) ? v.duration : Infinity;
    const p = { women: s.blurWomen, strict: s.blurStrict, level: s.blurLevel };
    const lead = v.paused ? 0.04 : LEAD * Math.max(1, v.playbackRate);
    const out: Decision = { verdict: 'clear', rects: [] };
    // Strict: what isn't known yet outranks a found woman (the whole frame is blurred then).
    // Otherwise a woman found at one of the three moments is blurred whatever the others know.
    const rank = s.blurStrict ? ({ clear: 0, region: 1, unknown: 2, full: 3 } as const) : ({ clear: 0, unknown: 1, region: 2, full: 3 } as const);
    const plates: number[][] = [];
    for (const x of [t, Math.max(0, t - LAG), Math.min(t + lead, d - 0.01)]) {
      const r = tl.decide(x, p, d);
      if (x === t) out.shot = r.shot;
      if (rank[r.verdict] > rank[out.verdict]) out.verdict = r.verdict;
      out.rects.push(...r.rects);
      for (const q of r.plates ?? []) if (!plates.some((o) => samePlate(o, q))) plates.push(q);
    }
    out.plates = plates;
    return out;
  }

  /** The boxes to show on v: what d asks to hide, kept still within a shot. */
  private still(v: HTMLVideoElement, d: Decision): number[][] {
    let st = this.steady.get(v);
    if (!st) {
      st = { boxes: new StableBoxes(), t: v.currentTime, seeks: 0 };
      this.steady.set(v, st);
    }
    const t = v.currentTime;
    if (Math.abs(t - st.t) > 1.5) st.seeks++;
    st.t = t;
    const boxes = st.boxes.update(d.rects, `${this.sessionOf(v)}|${d.shot ?? ''}|${st.seeks}`, performance.now());
    // a slide laid over her isn't her: heads stay covered, the rest gives way to the plate
    return cutPlates(boxes, d.plates ?? [], d.rects.filter((r) => r[4] === PART.head));
  }

  private apply(v: HTMLVideoElement, blur: boolean): void {
    if (blur) {
      const r = v.getBoundingClientRect();
      const px = Math.max(24, Math.round(Math.min(r.width, r.height) / 8));
      const want = this.getSettings().blurStyle === 'solid' ? 'brightness(0)' : `blur(${px}px)`;
      if (v.style.getPropertyValue('filter') !== want) v.style.setProperty('filter', want, 'important');
      this.blurred.add(v);
    } else if (this.blurred.has(v)) {
      v.style.removeProperty('filter');
      this.blurred.delete(v);
    }
  }

  /** Lay blur boxes over v at the frame-relative `rects` (none: hide them). */
  private place(v: HTMLVideoElement, rects: number[][]): void {
    let o = this.overlays.get(v);
    if (!rects.length) {
      if (o) for (const b of o.boxes) b.style.display = 'none';
      return;
    }
    if (!o) {
      const root = document.createElement('div');
      root.dataset.mrBlur = '';
      root.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;margin:0;padding:0;border:0';
      o = { root, boxes: [], fit: 'contain', fitAt: 0 };
      this.overlays.set(v, o);
    }
    if (o.root.previousSibling !== v) v.after(o.root);
    const now = performance.now();
    if (now - o.fitAt > 1000) {
      const cs = getComputedStyle(v);
      o.fit = cs.objectFit || 'contain';
      const z = parseInt(cs.zIndex, 10);
      o.root.style.zIndex = Number.isFinite(z) ? String(z + 1) : '';
      o.fitAt = now;
    }
    const vr = v.getBoundingClientRect();
    const origin = o.root.getBoundingClientRect();
    const c = contentBox(v, vr, o.fit);
    const ox = vr.left - origin.left + c.x, oy = vr.top - origin.top + c.y;
    // clipped to the element (object-fit: cover crops the picture)
    const minX = vr.left - origin.left, minY = vr.top - origin.top;
    const maxX = minX + vr.width, maxY = minY + vr.height;
    while (o.boxes.length < rects.length) {
      const b = document.createElement('div');
      b.style.cssText = 'position:absolute;pointer-events:none;border-radius:10px;background:rgba(120,120,120,.25)';
      o.root.appendChild(b);
      o.boxes.push(b);
    }
    o.boxes.forEach((b, i) => {
      const r = rects[i];
      const x0 = r ? Math.max(minX, ox + r[0] * c.w) : 0, y0 = r ? Math.max(minY, oy + r[1] * c.h) : 0;
      const x1 = r ? Math.min(maxX, ox + (r[0] + r[2]) * c.w) : 0, y1 = r ? Math.min(maxY, oy + (r[1] + r[3]) * c.h) : 0;
      if (x1 <= x0 || y1 <= y0) {
        b.style.display = 'none';
        return;
      }
      const w = x1 - x0, h = y1 - y0;
      const solid = this.getSettings().blurStyle === 'solid';
      const f = solid ? 'none' : `blur(${Math.max(16, Math.round(Math.min(w, h) / 5))}px)`;
      b.style.background = solid ? '#0b0b0b' : 'rgba(120,120,120,.25)';
      b.style.display = 'block';
      b.style.left = `${x0}px`;
      b.style.top = `${y0}px`;
      b.style.width = `${w}px`;
      b.style.height = `${h}px`;
      if (b.style.getPropertyValue('backdrop-filter') !== f) {
        b.style.setProperty('backdrop-filter', f);
        b.style.setProperty('-webkit-backdrop-filter', f);
      }
    });
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
    return { status: this.status, state: this.state, regions: this.regions };
  }

  /**
   * What "pause until ready" waits for on the active video: whether its frame is checked, and how
   * far ahead. Null when blurring doesn't apply (off, no video, broken model: don't hold for it).
   */
  holdPart(): HoldPart | null {
    const s = this.getSettings();
    if (!s.enabled || !s.blur || !this.activeVideo || this.status?.model === 'error') return null;
    if (this.state === 'off' || this.state === 'no-video') return null;
    return { kind: 'blur', now: this.state !== 'checking', ahead: this.status?.ahead ?? 0 };
  }

  /** Short note for the on-video badge ('' = nothing to say). */
  badgeText(): string {
    const s = this.getSettings();
    if (!s.enabled || !s.blur) return '';
    if (this.status?.model === 'error') return '⚠ Размытие: ошибка модели';
    if (this.state === 'checking' && s.blurStrict) return '⏳ Проверяю кадры…';
    if (this.state === 'hidden') return '🙈 Скрыто';
    return '';
  }
}
