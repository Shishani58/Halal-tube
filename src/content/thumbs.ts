/**
 * MAIN world: video thumbnails (home feed, recommendations next to the player, search, end screen,
 * the player's poster). Each picture is classified once by the vision worker (which fetches it
 * itself: i.ytimg.com allows any origin). Nudity blurs the whole picture; a woman (with that
 * option) only the boxes around her, laid over the picture like the boxes on video — the rest of
 * the picture, men included, stays clear. In strict mode a thumbnail stays blurred whole until it
 * has been checked.
 *
 * The blur is a stylesheet keyed on attributes, not inline styles: a thumbnail element YouTube
 * reuses for another video loses its verdict in a MutationObserver callback, i.e. before the next
 * paint, so a new picture is never shown with the previous one's "clear".
 */
import type { Settings } from '../shared/messages';
import type { FromVision, ToVision } from '../shared/vision-messages';
import { tuningFor, type BlurLevel, type Tuning } from '../core/vision-timeline';

const HOST = String.raw`(?:https?:)?\/\/i\d*\.ytimg\.com\/(?:vi|vi_webp|an_webp)\/`;
const IMG_RE = new RegExp(`^${HOST}`);
const BG_RE = new RegExp(String.raw`url\(\s*["']?(${HOST}[^"')]+)`);
/** Elements showing a video thumbnail: <img> (feed, sidebar) or a background image (end screen, poster). */
const SEL = ':is(img[src*="ytimg.com/vi"], img[src*="ytimg.com/an_webp"], [style*="ytimg.com/vi"], [style*="ytimg.com/an_webp"])';
const BLUR = 'filter: blur(18px) saturate(.6) !important;';
const CSS = `html[data-mr-thumbs="strict"] ${SEL}:not([data-mr-thumb="ok"]):not([data-mr-thumb="region"]), html[data-mr-thumbs] [data-mr-thumb="hide"] { ${BLUR} }`;
/** More of the picture than this is covered by a woman's box (a close-up): blur it whole. */
const MAX_REGION_AREA = 0.85;

/** Rescan the page this often (ms) for new thumbnails. */
const SCAN_MS = 400;
/** Ask again for a picture with no answer after this long (ms): the worker may have restarted. */
const RESEND_MS = 20_000;
/** Pictures asked for at once (the rest wait for the next scans). */
const MAX_INFLIGHT = 48;
const MAX_KNOWN = 4000;
/**
 * Verdicts are kept between page loads (localStorage of the page): the same recommendations come
 * back again and again, and a known thumbnail needs no ~0.7 s check. Bump the version when the
 * classification changes; old entries expire after a week.
 */
const STORE_KEY = 'mr-thumbs-v6';
const STORE_TTL_MS = 7 * 24 * 3600 * 1000;
const SAVE_DELAY_MS = 3000;

interface Scores {
  nude: number;
  skin: number;
  female: number;
  /** Boxes around the women, [x, y, w, h] in the picture's own coordinates (0–1). */
  rects: number[][];
}

interface Placed {
  host: HTMLElement;
  boxes: HTMLElement[];
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

/**
 * One verdict per picture (the sizes of a video's thumbnail differ in crop and bars, so the women's
 * boxes of one don't fit another).
 */
export function pictureKey(url: string): string {
  return url.split('?')[0].replace(/^https?:/, '');
}

/** Where the picture is drawn inside an <img> of box w×h: size and offset (object-fit / -position). */
export function contentBox(nw: number, nh: number, w: number, h: number, fit: string, position: string): { x: number; y: number; w: number; h: number } {
  const k = fit === 'cover' ? Math.max(w / nw, h / nh) : fit === 'contain' ? Math.min(w / nw, h / nh) : fit === 'scale-down' ? Math.min(1, w / nw, h / nh) : fit === 'none' ? 1 : 0;
  if (!k) return { x: 0, y: 0, w, h };
  const [px, py] = position.split(/\s+/).map((t) => (t.endsWith('%') ? parseFloat(t) / 100 : 0.5));
  const cw = nw * k, ch = nh * k;
  return { x: (w - cw) * (px ?? 0.5), y: (h - ch) * (py ?? 0.5), w: cw, h: ch };
}

export class ThumbBlur {
  /** Verdict inputs per picture (null: couldn't be checked, shown as is). */
  private known = new Map<string, Scores | null>();
  private pending = new Map<string, number>();
  private failures = new Map<string, number>();
  /** Boxes laid over thumbnails (<img>s) whose women are blurred in parts. */
  private placed = new Map<Element, Placed>();
  private mode: false | 'strict' | 'lenient' = false;
  private women = true;
  private tune: Tuning = tuningFor('normal');
  private level: BlurLevel = 'normal';
  private hover = false;
  private style: HTMLStyleElement | null = null;
  private observer: MutationObserver | null = null;
  private lastScan = 0;
  private dirty = false;
  private saveTimer = 0;
  /** When each verdict was made (ms since epoch), for the stored copy. */
  private madeAt = new Map<string, number>();

  constructor(private readonly send: (m: ToVision) => void) {
    this.load();
  }

  private load(): void {
    try {
      const rows = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as [string, number, number, number[][], number][];
      const now = Date.now();
      for (const [key, nude, female, rects, at] of rows) {
        if (typeof key !== 'string' || now - at > STORE_TTL_MS) continue;
        this.known.set(key, { nude, skin: 0, female, rects });
        this.madeAt.set(key, at);
      }
    } catch {
      /* no storage, or damaged: start empty */
    }
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      try {
        const rows: [string, number, number, number[][], number][] = [];
        for (const [key, v] of this.known) if (v) rows.push([key, v.nude, v.female, v.rects, this.madeAt.get(key) ?? Date.now()]);
        localStorage.setItem(STORE_KEY, JSON.stringify(rows.slice(-3000)));
      } catch {
        /* storage full or blocked: verdicts just aren't kept */
      }
    }, SAVE_DELAY_MS);
  }

  tick(s: Settings): void {
    const mode = s.enabled && s.blur && s.blurThumbs ? (s.blurStrict ? 'strict' : 'lenient') : false;
    if (mode !== this.mode || s.blurWomen !== this.women || s.blurLevel !== this.level || !!s.blurHover !== this.hover) {
      this.mode = mode;
      this.women = s.blurWomen;
      this.level = s.blurLevel;
      this.tune = tuningFor(s.blurLevel);
      this.hover = !!s.blurHover;
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
    const key = pictureKey(msg.url);
    this.pending.delete(key);
    if (msg.frame) {
      const f = msg.frame;
      const rects: number[][] = [];
      for (let i = 0; i + 4 < f.women.length; i += 5) rects.push(f.women.slice(i, i + 4));
      this.remember(key, { nude: f.nude, skin: f.skin, female: f.female, rects });
      this.failures.delete(key);
      this.madeAt.set(key, Date.now());
      this.save();
    } else {
      // twice unreadable (removed video, network): leave it as it is rather than blurred forever
      const n = (this.failures.get(key) ?? 0) + 1;
      if (n >= 2) {
        this.remember(key, null);
        this.failures.delete(key);
      } else this.failures.set(key, n);
    }
    // every thumbnail showing this picture gets its verdict now, not at the next scan
    const now = performance.now();
    for (const el of Array.from(document.querySelectorAll(`[data-mr-key="${globalThis.CSS.escape(key)}"]`))) this.mark(el, now);
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

  /**
   * Explicit nudity blurs the whole thumbnail; a woman (the worker judges who is one from all looks
   * at her) only her boxes. Bare torso / belly (`skin`) alone blurs nothing: it fires on shirtless
   * men, and only women are to be blurred; a woman showing skin is found as a woman anyway.
   */
  private isNude(f: Scores): boolean {
    return f.nude >= this.tune.nude;
  }

  private hasWoman(f: Scores): boolean {
    return this.women && f.female >= this.tune.thumbFemale;
  }

  private setup(): void {
    const root = document.documentElement;
    if (!root) return;
    if (!this.mode) {
      root.removeAttribute('data-mr-thumbs');
      for (const el of Array.from(this.placed.keys())) this.unplace(el);
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
      // new thumbnails are found at once (not by the next scan): in a batch the page adds, each
      // waits for its check, and every ms of it is a ms the picture shows unblurred in lenient mode
      this.observer = new MutationObserver((recs) => {
        const now = performance.now();
        for (const r of recs) {
          if (r.type === 'attributes') {
            const el = r.target as Element;
            if (el.hasAttribute('data-mr-key') || el.matches(SEL)) this.mark(el, now);
          } else {
            for (const n of Array.from(r.addedNodes)) {
              if (!(n instanceof Element)) continue;
              if (n.matches(SEL)) this.mark(n, now);
              for (const e of Array.from(n.querySelectorAll(SEL))) this.mark(e, now);
            }
          }
        }
      });
      this.observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style'] });
    }
  }

  private scan(now: number): void {
    if (this.style && !this.style.isConnected) (document.head ?? document.documentElement).appendChild(this.style);
    for (const [k, at] of this.pending) if (now - at > RESEND_MS) this.pending.delete(k);
    for (const el of Array.from(document.querySelectorAll(SEL))) this.mark(el, now);
    for (const [el, p] of Array.from(this.placed)) if (!el.isConnected || !p.host.contains(el)) this.unplace(el);
  }

  /** Set el's verdict for the picture it shows now (none yet: ask for it). */
  private mark(el: Element, now: number): void {
    const url = thumbUrl(el);
    if (!url) {
      if (el.hasAttribute('data-mr-key')) {
        el.removeAttribute('data-mr-key');
        el.removeAttribute('data-mr-thumb');
      }
      this.unplace(el);
      return;
    }
    const key = pictureKey(url);
    const f = this.known.get(key);
    let want: 'ok' | 'hide' | 'region' | null = null;
    if (f === undefined) this.request(url, key, now);
    else if (!f) want = 'ok';
    else if (this.isNude(f)) want = 'hide';
    else if (this.hasWoman(f)) want = this.place(el, f.rects) ? 'region' : 'hide';
    else want = 'ok';
    if (want !== 'region') this.unplace(el);
    if (el.getAttribute('data-mr-key') !== key) el.setAttribute('data-mr-key', key);
    if (want === null) el.removeAttribute('data-mr-thumb');
    else if (el.getAttribute('data-mr-thumb') !== want) el.setAttribute('data-mr-thumb', want);
  }

  /**
   * Lay blur boxes over the women's `rects` of the picture an <img> shows. They are children of the
   * image's container, placed in percent of it, so they follow it when the page scrolls or resizes
   * (and are put right again by the next scan). False: this thumbnail can't be done in parts (not
   * an <img>, not laid out yet, women cover most of it): blur it whole.
   */
  private place(el: Element, rects: number[][]): boolean {
    if (!(el instanceof HTMLImageElement) || !rects.length || !el.naturalWidth) return false;
    if (rects.reduce((a, r) => a + r[2] * r[3], 0) > MAX_REGION_AREA) return false;
    let host: HTMLElement | null = el.parentElement;
    for (let i = 0; i < 3 && host && !host.clientWidth; i++) host = host.parentElement;
    const ir = el.getBoundingClientRect();
    if (!host || !host.clientWidth || !host.clientHeight || !ir.width || !ir.height) return false;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const hr = host.getBoundingClientRect();
    const sx = host.clientWidth / hr.width, sy = host.clientHeight / hr.height;
    const cs = getComputedStyle(el);
    const c = contentBox(el.naturalWidth, el.naturalHeight, ir.width, ir.height, cs.objectFit, cs.objectPosition);
    // the image's box and the picture's inside the host's padding box, in screen pixels × scale
    const ox = (ir.left - hr.left) * sx - host.clientLeft, oy = (ir.top - hr.top) * sy - host.clientTop;
    let p = this.placed.get(el);
    if (p && p.host !== host) {
      this.unplace(el);
      p = undefined;
    }
    if (!p) this.placed.set(el, (p = { host, boxes: [] }));
    while (p.boxes.length < rects.length) {
      const b = document.createElement('div');
      b.setAttribute('data-mr-box', '');
      b.style.cssText = 'position:absolute;pointer-events:none;border-radius:6px;background:rgba(120,120,120,.25);margin:0;padding:0;border:0';
      host.appendChild(b);
      p.boxes.push(b);
    }
    for (const b of p.boxes.splice(rects.length)) b.remove();
    let shown = 0;
    p.boxes.forEach((b, i) => {
      const r = rects[i];
      // clipped to the image (object-fit: cover crops the picture)
      const x0 = Math.max(0, (c.x + r[0] * c.w) * sx), y0 = Math.max(0, (c.y + r[1] * c.h) * sy);
      const x1 = Math.min(ir.width * sx, (c.x + (r[0] + r[2]) * c.w) * sx), y1 = Math.min(ir.height * sy, (c.y + (r[1] + r[3]) * c.h) * sy);
      if (x1 <= x0 || y1 <= y0) {
        b.style.display = 'none';
        return;
      }
      shown++;
      b.style.display = 'block';
      b.style.left = `${(((ox + x0) / host!.clientWidth) * 100).toFixed(3)}%`;
      b.style.top = `${(((oy + y0) / host!.clientHeight) * 100).toFixed(3)}%`;
      b.style.width = `${(((x1 - x0) / host!.clientWidth) * 100).toFixed(3)}%`;
      b.style.height = `${(((y1 - y0) / host!.clientHeight) * 100).toFixed(3)}%`;
      const f = `blur(${Math.max(10, Math.round(Math.min(x1 - x0, y1 - y0) / 4))}px)`;
      if (b.style.getPropertyValue('backdrop-filter') !== f) {
        b.style.setProperty('backdrop-filter', f);
        b.style.setProperty('-webkit-backdrop-filter', f);
      }
    });
    if (!shown) {
      this.unplace(el);
      return false;
    }
    return true;
  }

  private unplace(el: Element): void {
    const p = this.placed.get(el);
    if (!p) return;
    for (const b of p.boxes) b.remove();
    this.placed.delete(el);
  }

  private request(url: string, key: string, now: number): void {
    if (this.pending.has(key) || this.pending.size >= MAX_INFLIGHT) return;
    this.pending.set(key, now);
    this.send({ type: 'image', url });
  }
}
