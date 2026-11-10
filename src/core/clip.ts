/**
 * MobileCLIP-S0 (image encoder, 256×256): does the picture show a woman or women at all? A
 * fallback for what the face pipeline can't see — small figures on a stage, dancers in dresses,
 * dark or stylised footage where NudeNet finds no face or body. It doesn't say where she is, so
 * the page blurs the whole frame for a shot where only it saw women (vision-timeline).
 *
 * The frame is looked at as three squares along its longer side (a wide video frame would lose
 * its sides to a single centre crop); the score is their mean. Each square's embedding is
 * compared with the prompt embeddings (clip-text.ts) and the probability mass of the
 * woman prompts is its score.
 */
import { CLIP_TEXT_B64, CLIP_TEXT_DIM, CLIP_TEXT_KINDS } from './clip-text';

export const CLIP_INPUT = 256;
/** Squares per frame. */
export const CLIP_VIEWS = 3;
/** Logit scale of the similarities (MobileCLIP's trained one). */
const SCALE = 100;
/**
 * A frame shows women at this score. scripts/clip-prompts.mjs chose 0.5 on labelled pictures (about
 * 1 in 10 groups of young men over it); 0.65 trades a little of the women found for fewer such errors.
 * The page also needs it on several frames of a shot (vision-timeline CLIP_MIN_*).
 */
export const CLIP_WOMEN = 0.65;
/**
 * A thumbnail with a face the gender classifier is unsure about (THUMB_SOFT) counts as a woman's
 * when the scene model says women at this score: a stylised or tired woman's portrait gets
 * 0.2–0.4 from the face classifier but ~0.65 here, and men's portraits seldom pass 0.5 (1%).
 */
export const CLIP_THUMB_WOMEN = 0.5;
/** …and when the face classifier says "man" outright but the picture shows one person only: the scene model alone, this surely. */
export const CLIP_THUMB_LONE = 0.55;

let text: Float32Array | null = null;
function textEmbeds(): Float32Array {
  if (!text) {
    const bin = atob(CLIP_TEXT_B64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    text = new Float32Array(u8.buffer);
  }
  return text;
}

/**
 * Thumbnails whose face the detector can't use (tiny, turned, stylised): the scene model scores the
 * whole picture, and when that reaches CLIP_TILE_GATE it scores vertical strips of it too — a
 * woman's clothes and figure give a strip a high score (0.87–0.99 against 0.00–0.24 for strips of
 * men on a 320×180 thumbnail), which says where she is, roughly.
 */
export const CLIP_TILE_GATE = 0.35;
export const CLIP_TILE_WOMEN = 0.7;
const TILE_W = 0.34;
const TILE_STEP = 0.165;

/** Strips [x, y, w, h] (pixels) of a w×h picture, 5 of them from left to right; none for a tall picture. */
export function clipTiles(w: number, h: number): [number, number, number, number][] {
  if (w < h * 1.2) return [];
  const tw = Math.round(w * TILE_W);
  return [0, 1, 2, 3, 4].map((i) => [Math.min(w - tw, Math.round(w * TILE_STEP * i)), 0, tw, h]);
}

/**
 * The box (normalised [x, y, w, h], full height) over the strips that show women: those scoring at
 * least CLIP_TILE_WOMEN and 90% of the best one. Null when none does.
 */
export function tileBox(scores: number[], tiles: [number, number, number, number][], w: number): number[] | null {
  const best = Math.max(0, ...scores);
  if (best < CLIP_TILE_WOMEN) return null;
  const min = Math.max(CLIP_TILE_WOMEN, best * 0.9);
  let x0 = Infinity, x1 = -Infinity;
  tiles.forEach((t, i) => {
    if (scores[i] < min) return;
    x0 = Math.min(x0, t[0]);
    x1 = Math.max(x1, t[0] + t[2]);
  });
  return [x0 / w, 0, (x1 - x0) / w, 1];
}

/** The CLIP_VIEWS squares [x, y, side] of a w×h picture: start, middle and end of its longer side. */
export function clipViews(w: number, h: number): [number, number, number][] {
  const side = Math.min(w, h);
  const span = Math.max(w, h) - side;
  return [0, 0.5, 1].map((f) => {
    const o = Math.round(span * f);
    return w >= h ? [o, 0, side] : [0, o, side];
  });
}

/** RGBA bytes (n×n) → planar RGB in [0, 1] at `out[offset…]` (MobileCLIP: no mean/std). */
export function rgbaToClip(rgba: Uint8ClampedArray | Uint8Array, n: number, out: Float32Array, offset = 0): void {
  const m = n * n;
  const k = 1 / 255;
  for (let i = 0, j = 0; i < m; i++, j += 4) {
    out[offset + i] = rgba[j] * k;
    out[offset + m + i] = rgba[j + 1] * k;
    out[offset + 2 * m + i] = rgba[j + 2] * k;
  }
}

/** Women score (0–1) of image embedding `i` in `embeds` ([n, CLIP_TEXT_DIM], not normalised). */
export function clipWomen(embeds: Float32Array, i: number): number {
  const D = CLIP_TEXT_DIM;
  const t = textEmbeds();
  const P = CLIP_TEXT_KINDS.length;
  let norm = 0;
  for (let k = 0; k < D; k++) norm += embeds[i * D + k] ** 2;
  norm = Math.sqrt(norm) || 1;
  const logits = new Float64Array(P);
  let max = -Infinity;
  for (let p = 0; p < P; p++) {
    let s = 0;
    for (let k = 0; k < D; k++) s += embeds[i * D + k] * t[p * D + k];
    logits[p] = (SCALE * s) / norm;
    max = Math.max(max, logits[p]);
  }
  let all = 0, women = 0;
  for (let p = 0; p < P; p++) {
    const e = Math.exp(logits[p] - max);
    all += e;
    if (CLIP_TEXT_KINDS[p] === 'W') women += e;
  }
  return women / all;
}

/** Women score of a frame from its `views` consecutive embeddings starting at `i`. */
export function clipFrameWomen(embeds: Float32Array, i: number, views = CLIP_VIEWS): number {
  let s = 0;
  for (let v = 0; v < views; v++) s += clipWomen(embeds, i + v);
  return s / views;
}
