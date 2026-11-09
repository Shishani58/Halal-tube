/**
 * MAIN world: gets the current YouTube video's captions with per-word timing for the profanity
 * filter, without speech recognition.
 *
 * Caption files can't be downloaded directly (YouTube answers an empty body without the player's
 * proof-of-origin token), so the player is asked to load the track itself and its response is
 * read on the way in. While that happens the caption overlay is hidden; afterwards the viewer's
 * own caption choice is restored. A video's captions come in one response (≈1 MB per hour).
 */
import { parseJson3, type CaptionWord } from '../core/captions';
import type { CaptionState } from '../shared/messages';

interface YtTrack {
  languageCode?: string;
  kind?: string;
  vssId?: string;
}
interface YtPlayer extends HTMLElement {
  getPlayerResponse?: () => {
    videoDetails?: { videoId?: string };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: YtTrack[] } };
  } | null;
  loadModule?: (m: string) => void;
  unloadModule?: (m: string) => void;
  getOption?: (m: string, o: string) => unknown;
  setOption?: (m: string, o: string, v: unknown) => void;
  isSubtitlesOn?: () => boolean;
}

const LANGS = ['ru', 'en'];
/** Give up on a request after this long (then the worker uses speech recognition). */
const REQUEST_TIMEOUT_MS = 8000;
/** No response yet after this long: reload the caption module and ask again (once). */
const RETRY_MS = 3000;
const HIDE_CLASS = 'mr-captions-hidden';

export interface CaptionResult {
  videoId: string;
  state: CaptionState;
  words: CaptionWord[];
  lang?: string;
  kind?: 'asr' | 'uploaded';
}

/** Best track for the filter: word-timed auto captions in RU/EN, then uploaded RU/EN, then any auto. */
export function pickTrack(tracks: YtTrack[]): { languageCode: string; kind?: 'asr' } | null {
  const lang = (t: YtTrack) => (t.languageCode ?? '').toLowerCase().split('-')[0];
  const asr = tracks.filter((t) => t.kind === 'asr');
  const up = tracks.filter((t) => t.kind !== 'asr');
  const t =
    asr.find((x) => LANGS.includes(lang(x))) ?? up.find((x) => LANGS.includes(lang(x))) ?? asr[0] ?? null;
  if (!t?.languageCode) return null;
  return t.kind === 'asr' ? { languageCode: t.languageCode, kind: 'asr' } : { languageCode: t.languageCode };
}

export class Captions {
  result: CaptionResult = { videoId: '', state: 'none', words: [] };
  /** Bumped whenever `result` changes. */
  version = 0;
  private cache = new Map<string, CaptionResult>();
  private want: {
    videoId: string;
    languageCode: string;
    kind?: 'asr';
    at: number;
    retried: boolean;
    /** The viewer's own captions were on (their track is restored afterwards). */
    userTrack: unknown;
  } | null = null;
  private style: HTMLStyleElement | null = null;

  constructor() {
    this.hook();
  }

  /** Call often while the profanity filter is on. */
  update(): void {
    const p = document.getElementById('movie_player') as YtPlayer | null;
    const pr = p?.getPlayerResponse?.();
    const vid = pr?.videoDetails?.videoId;
    if (!p || !vid) return;
    if (vid !== this.result.videoId) {
      this.finishRequest(p);
      const cached = this.cache.get(vid);
      if (cached) return this.set(cached);
      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      const t = pickTrack(tracks);
      if (!t) return this.set({ videoId: vid, state: 'none', words: [] });
      this.set({ videoId: vid, state: 'pending', words: [], lang: t.languageCode, kind: t.kind === 'asr' ? 'asr' : 'uploaded' });
      this.want = { videoId: vid, languageCode: t.languageCode, kind: t.kind, at: 0, retried: false, userTrack: null };
    }
    const w = this.want;
    if (!w || this.result.state !== 'pending') return;
    if (p.classList.contains('ad-showing')) return; // ask once the video itself plays
    const now = performance.now();
    try {
      if (!w.at) {
        w.at = now;
        // 'track' keeps the last track even with captions off: ask whether they are shown
        const on = p.isSubtitlesOn ? p.isSubtitlesOn() : document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true';
        w.userTrack = on ? (p.getOption?.('captions', 'track') ?? null) : null;
        if (!w.userTrack) this.hideOverlay(true);
        this.ask(p, w, false);
      } else if (!w.retried && now - w.at > RETRY_MS) {
        // the player wasn't ready, or it had the track cached and didn't fetch it
        w.retried = true;
        this.ask(p, w, true);
      } else if (now - w.at > REQUEST_TIMEOUT_MS) {
        this.fail(p);
      }
    } catch (e) {
      console.warn('[music-remover] captions request failed', e);
      this.fail(p);
    }
  }

  private ask(p: YtPlayer, w: NonNullable<Captions['want']>, reload: boolean): void {
    if (reload) p.unloadModule?.('captions');
    p.loadModule?.('captions');
    // the module needs a moment before it takes a track
    setTimeout(() => {
      if (this.want === w) p.setOption?.('captions', 'track', w.kind ? { languageCode: w.languageCode, kind: w.kind } : { languageCode: w.languageCode });
    }, 300);
  }

  private set(r: CaptionResult, cache = true): void {
    this.result = r;
    this.version++;
    if (cache && r.state !== 'pending') {
      this.cache.set(r.videoId, r);
      if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
    }
  }

  private fail(p: YtPlayer): void {
    const vid = this.result.videoId;
    this.finishRequest(p);
    this.set({ videoId: vid, state: 'none', words: [] }, false); // try again when the video is opened again
  }

  /** Put the viewer's caption setting back and show the overlay again. */
  private finishRequest(p: YtPlayer): void {
    const w = this.want;
    this.want = null;
    if (!w || !w.at) return;
    try {
      if (w.userTrack) p.setOption?.('captions', 'track', w.userTrack);
      else p.unloadModule?.('captions');
    } catch {
      /* player gone */
    }
    setTimeout(() => this.hideOverlay(false), 400);
  }

  private hideOverlay(on: boolean): void {
    if (!this.style) {
      this.style = document.createElement('style');
      this.style.textContent = `.${HIDE_CLASS} .ytp-caption-window-container{display:none!important}`;
      (document.head ?? document.documentElement).appendChild(this.style);
    }
    document.getElementById('movie_player')?.classList.toggle(HIDE_CLASS, on);
  }

  /** Read caption responses the player receives (XHR and fetch). */
  private hook(): void {
    const onText = (url: string, text: string) => {
      let u: URL;
      try {
        u = new URL(url, location.href);
      } catch {
        return;
      }
      if (!u.pathname.endsWith('/api/timedtext')) return;
      const w = this.want;
      const vid = u.searchParams.get('v');
      if (!w || vid !== w.videoId || this.result.state !== 'pending' || this.result.videoId !== vid) return;
      const lang = u.searchParams.get('lang') ?? '';
      const kind = u.searchParams.get('kind') === 'asr' ? 'asr' : undefined;
      if (lang !== w.languageCode || kind !== w.kind) return; // the viewer's own track, or a translation
      if (u.searchParams.get('tlang')) return;
      let words: CaptionWord[];
      try {
        words = parseJson3(text);
      } catch {
        return; // not json3
      }
      const p = document.getElementById('movie_player') as YtPlayer | null;
      if (p) this.finishRequest(p);
      this.set({ videoId: vid, state: 'ready', words, lang, kind: kind ? 'asr' : 'uploaded' });
    };

    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    const urls = new WeakMap<XMLHttpRequest, string>();
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      urls.set(this, String(args[1]));
      return (XO as (...a: unknown[]) => void).apply(this, args);
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const url = urls.get(this);
      if (url && url.includes('/api/timedtext')) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') onText(url, this.responseText);
          } catch {
            /* ignore */
          }
        });
      }
      return XS.call(this, body as XMLHttpRequestBodyInit | null | undefined);
    };

    const F = window.fetch;
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const p = F.call(this, input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/timedtext')) {
        p.then((r) => r.clone().text()).then((t) => onText(url, t), () => undefined);
      }
      return p;
    } as typeof window.fetch;
  }
}
