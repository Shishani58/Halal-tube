/**
 * «Как скрывать → Тёмная заливка» for video thumbnails: instead of the blur thumbs.ts applies
 * (a CSS filter on the picture, `backdrop-filter` boxes over the women), the picture is turned
 * black and the boxes are opaque. Pure CSS keyed on one attribute of <html>, laid over thumbs.ts's
 * own rules (higher specificity, `!important`), so thumbs.ts's decisions are not touched.
 */
/**
 * Same elements as thumbs.ts (SEL), at no specificity of their own (`:where`). `:not([data-mr-open])`
 * lets a picture the pointer has revealed (thumb-hover.ts) through; the `[data-mr-cover]` repeated
 * only adds weight over thumbs.ts's own blur rule.
 */
const SEL = ':where(img[src*="ytimg.com/vi"], img[src*="ytimg.com/an_webp"], [style*="ytimg.com/vi"], [style*="ytimg.com/an_webp"])';
export const COVER_CSS = `
html[data-mr-cover="solid"][data-mr-cover][data-mr-thumbs="strict"] ${SEL}:not([data-mr-thumb="ok"]):not([data-mr-thumb="region"]):not([data-mr-open]),
html[data-mr-cover="solid"][data-mr-cover][data-mr-thumbs] [data-mr-thumb="hide"]:not([data-mr-open]) { filter: brightness(0) !important; }
html[data-mr-cover="solid"] [data-mr-box] { background: #0b0b0b !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
`;

export class ThumbCover {
  private style: HTMLStyleElement | null = null;
  private on = false;

  apply(solid: boolean): void {
    if (solid === this.on && (!solid || this.style?.isConnected)) return;
    this.on = solid;
    const root = document.documentElement;
    if (!root) return;
    if (!solid) {
      root.removeAttribute('data-mr-cover');
      this.style?.remove();
      return;
    }
    if (!this.style) {
      this.style = document.createElement('style');
      this.style.textContent = COVER_CSS;
    }
    if (!this.style.isConnected) (document.head ?? root).appendChild(this.style);
    root.setAttribute('data-mr-cover', 'solid');
  }
}
