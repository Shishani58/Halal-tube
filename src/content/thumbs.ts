/**
 * MAIN world: video thumbnails (home feed, recommendations next to the player, search, end screen,
 * the player's poster). Each picture is classified once by the vision worker (which fetches it
 * itself: i.ytimg.com allows any origin) and blurred whole when it shows nudity or, with that
 * option, a woman. In strict mode a thumbnail stays blurred until it has been checked.
 *
 * The blur is a stylesheet keyed on attributes, not inline styles: a thumbnail element YouTube
 * reuses for another video loses its verdict in a MutationObserver callback, i.e. before the next
 * paint, so a new picture is never shown with the previous one's "clear".
 */
import type { Settings } from '../shared/messages';
import type { FromVision, ToVision } from '../shared/vision-messages';
import { THRESHOLDS } from '../core/vision-timeline';

const HOST = String.raw`(?:https?:)?\/\/i\d*\.ytimg\.com\/(?:vi|vi_webp|an_webp)\/`;
const IMG_RE = new RegExp(`^${HOST}`);
const BG_RE = new RegExp(String.raw`url\(\s*["']?(${HOST}[^"')]+)`);
/** Elements showing a video thumbnail: <img> (feed, sidebar) or a background image (end screen, poster). */
const SEL = ':is(img[src*="ytimg.com/vi"], img[src*="ytimg.com/an_webp"], [style*="ytimg.com/vi"], [style*="ytimg.com/an_webp"])';
const BLUR = 'filter: blur(18px) saturate(.6) !important;';
const CSS = `html[data-mr-thumbs="strict"] ${SEL}:not([data-mr-thumb="ok"]), html[data-mr-thumbs] [data-mr-thumb="hide"] { ${BLUR} }`;

/** Rescan the page this often (ms) for new thumbnails. */
const SCAN_MS = 400;
/** Ask again for a picture with no answer after this long (ms): the worker may have restarted. */
const RESEND_MS = 20_000;
/** Pictures asked for at once (the rest wait for the next scans). */
const MAX_INFLIGHT = 48;
const MAX_KNOWN = 4000;

interface Scores {
  nude: number;
  skin: number;
  female: number;
}

/** The picture an element shows, if it is a video thumbnail. */
export function thumbUrl(el: Element): string | null {
  if (el instanceof HTMLImageElement) return IMG_RE.test(el.src) ? el.src : null;
  const m = BG_RE.exec((el as HTMLElement).style?.backgroundImage ?? '');
  if (!m) return null;
  return m[1].startsWith('//') ? `https:${m[1]}` : m[1];
}

const ID_RE = /\/(?:vi|vi_webp|an_webp)\/([^/?#]+)\//;

/**
 * Pictures of one video share a verdict: YouTube shows the same thumbnail in several sizes (and an
 * animated preview), and a woman found in one of them is in all of them.
 */
export function thumbKey(url: string): string {
  return ID_RE.exec(url)?.[1] ?? url.split('?')[0].replace(/^https?:/, '');
}

export class ThumbBlur {
  /** Verdict inputs per picture (null: couldn't be checked, shown as is). */
  private known = new Map<string, Scores | null>();
  private pending = new Map<string, number>();
  private failures = new Map<string, number>();
  private mode: false | 'strict' | 'lenient' = false;
  private women = true;
  private style: HTMLStyleElement | null = null;
  private observer: MutationObserver | null = null;
  private lastScan = 0;
  private dirty = false;

  constructor(private readonly send: (m: ToVision) => void) {}

  tick(s: Settings): void {
    const mode = s.enabled && s.blur && s.blurThumbs ? (s.blurStrict ? 'strict' : 'lenient') : false;
    if (mode !== this.mode || s.blurWomen !== this.women) {
      this.mode = mode;
      this.women = s.blurWomen;
      this.dirty = true;
      this.setup();
    }
    if (!this.mode || document.hidden) return;
    const now = performance.now();
    if (this.dirty || now - this.lastScan > SCAN_MS) {
      this.lastScan = now;
      this.dirty = false;
      this.scan(now);
    }
  }

  onResult(msg: Extract<FromVision, { type: 'image' }>): void {
    const key = thumbKey(msg.url);
    this.pending.delete(key);
    if (msg.frame) {
      const was = this.known.get(key);
      const f = msg.frame;
      this.remember(key, was ? { nude: Math.max(was.nude, f.nude), skin: Math.max(was.skin, f.skin), female: Math.max(was.female, f.female) } : { nude: f.nude, skin: f.skin, female: f.female });
      this.failures.delete(key);
    } else {
      // twice unreadable (removed video, network): leave it as it is rather than blurred forever
      const n = (this.failures.get(key) ?? 0) + 1;
      if (n >= 2) {
        this.remember(key, null);
        this.failures.delete(key);
      } else this.failures.set(key, n);
    }
    this.dirty = true;
  }

  /** The worker restarted: what was asked is lost. */
  onRestart(): void {
    this.pending.clear();
    this.dirty = true;
  }

  private remember(key: string, v: Scores | null): void {
    this.known.delete(key);
    this.known.set(key, v);
    if (this.known.size > MAX_KNOWN) this.known.delete(this.known.keys().next().value!);
  }

  private hides(f: Scores): boolean {
    return f.nude >= THRESHOLDS.nude || f.skin >= THRESHOLDS.skin || (this.women && f.female >= THRESHOLDS.thumbFemale);
  }

  private setup(): void {
    const root = document.documentElement;
    if (!root) return;
    if (!this.mode) {
      root.removeAttribute('data-mr-thumbs');
      this.observer?.disconnect();
      this.observer = null;
      return;
    }
    root.setAttribute('data-mr-thumbs', this.mode);
    if (!this.style) {
      this.style = document.createElement('style');
      this.style.textContent = CSS;
    }
    if (!this.style.isConnected) (document.head ?? root).appendChild(this.style);
    if (!this.observer) {
      this.observer = new MutationObserver((recs) => {
        const now = performance.now();
        for (const r of recs) {
          const el = r.target as Element;
          if (el.hasAttribute('data-mr-key')) this.mark(el, now);
        }
      });
      this.observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['src', 'style'] });
    }
  }

  private scan(now: number): void {
    if (this.style && !this.style.isConnected) (document.head ?? document.documentElement).appendChild(this.style);
    for (const [k, at] of this.pending) if (now - at > RESEND_MS) this.pending.delete(k);
    for (const el of Array.from(document.querySelectorAll(SEL))) this.mark(el, now);
  }

  /** Set el's verdict for the picture it shows now (none yet: ask for it). */
  private mark(el: Element, now: number): void {
    const url = thumbUrl(el);
    if (!url) {
      if (el.hasAttribute('data-mr-key')) {
        el.removeAttribute('data-mr-key');
        el.removeAttribute('data-mr-thumb');
      }
      return;
    }
    const key = thumbKey(url);
    const f = this.known.get(key);
    let want: 'ok' | 'hide' | null = null;
    if (f === undefined) this.request(url, key, now);
    else want = f && this.hides(f) ? 'hide' : 'ok';
    if (el.getAttribute('data-mr-key') !== key) el.setAttribute('data-mr-key', key);
    if (want === null) el.removeAttribute('data-mr-thumb');
    else if (el.getAttribute('data-mr-thumb') !== want) el.setAttribute('data-mr-thumb', want);
  }

  private request(url: string, key: string, now: number): void {
    if (this.pending.has(key) || this.pending.size >= MAX_INFLIGHT) return;
    this.pending.set(key, now);
    this.send({ type: 'image', url });
  }
}
