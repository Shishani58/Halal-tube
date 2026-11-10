/**
 * «Показывать превью при наведении»: a thumbnail the blur has hidden (a verdict `hide` or `region`
 * from thumbs.ts, which sets `data-mr-thumb` on the picture and `data-mr-box` on the boxes it lays
 * over it) is revealed once the pointer has rested on it for HOVER_DELAY_MS, and hidden again the
 * moment the pointer leaves. The delay keeps a pointer passing over a scrolling feed from flashing
 * pictures. A picture that isn't checked yet (strict mode) has no verdict and is never revealed.
 *
 * It only tags elements with `data-mr-open`; thumbs.ts's decisions are not touched. The CSS lets a
 * tagged picture through (and thumb-cover.ts's dark cover steps aside for it).
 */
export const HOVER_DELAY_MS = 600;

/** Specificity above thumbs.ts's `html[data-mr-thumbs=…] :is(…):not():not()` (the repeated attribute only adds weight). */
export const HOVER_CSS = `
html[data-mr-hover] [data-mr-thumb][data-mr-open][data-mr-open][data-mr-open][data-mr-open] { filter: none !important; }
html[data-mr-hover] [data-mr-box][data-mr-open] { visibility: hidden !important; }
`;

const HIDDEN = '[data-mr-thumb="hide"], [data-mr-thumb="region"]';

export class ThumbHover {
  private style: HTMLStyleElement | null = null;
  private on = false;
  private pic: Element | null = null;
  private timer = 0;
  private tagged: Element[] = [];

  /** Follow the setting (call whenever settings change; cheap when nothing did). */
  apply(enabled: boolean): void {
    if (enabled === this.on && (!enabled || this.style?.isConnected)) return;
    const root = document.documentElement;
    if (!root) return;
    if (enabled !== this.on) {
      this.on = enabled;
      const fn = enabled ? 'addEventListener' : 'removeEventListener';
      document[fn]('pointerover', this.over, true);
      document[fn]('pointerout', this.out, true);
    }
    if (!enabled) {
      this.close();
      root.removeAttribute('data-mr-hover');
      this.style?.remove();
      return;
    }
    if (!this.style) {
      this.style = document.createElement('style');
      this.style.textContent = HOVER_CSS;
    }
    if (!this.style.isConnected) (document.head ?? root).appendChild(this.style);
    root.setAttribute('data-mr-hover', '');
  }

  private over = (e: Event): void => {
    const pic = (e.target as Element | null)?.closest?.(HIDDEN) ?? null;
    if (pic === this.pic) return;
    this.close();
    if (!pic) return;
    this.pic = pic;
    this.timer = window.setTimeout(() => this.open(pic), HOVER_DELAY_MS);
  };

  private out = (e: Event): void => {
    const to = (e as PointerEvent).relatedTarget as Node | null;
    if (this.pic && !(to && this.pic.contains(to))) this.close();
  };

  /** Reveal `pic` and the boxes laid over it (children of the picture's container, up to three levels up). */
  private open(pic: Element): void {
    if (this.pic !== pic || !pic.isConnected) return;
    pic.setAttribute('data-mr-open', '');
    this.tagged.push(pic);
    let host = pic.parentElement;
    for (let i = 0; i < 3 && host; i++, host = host.parentElement) {
      const boxes = host.querySelectorAll(':scope > [data-mr-box]');
      if (boxes.length) {
        for (const b of Array.from(boxes)) {
          b.setAttribute('data-mr-open', '');
          this.tagged.push(b);
        }
        break;
      }
    }
  }

  private close(): void {
    clearTimeout(this.timer);
    for (const el of this.tagged) el.removeAttribute('data-mr-open');
    this.tagged = [];
    this.pic = null;
  }
}
