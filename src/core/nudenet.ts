/**
 * NudeNet v3 detector (YOLOv8n, 320×320): image preprocessing and per-frame scores.
 * Output tensor: [batch, 4 + 18 classes, anchors] (box cx,cy,w,h then class confidences).
 */

export const NUDENET_INPUT = 320;
/** Frames per inference call (fixed shape: WebGPU compiles shaders once). */
export const NUDENET_BATCH = 8;

export const NUDENET_LABELS = [
  'FEMALE_GENITALIA_COVERED',
  'FACE_FEMALE',
  'BUTTOCKS_EXPOSED',
  'FEMALE_BREAST_EXPOSED',
  'FEMALE_GENITALIA_EXPOSED',
  'MALE_BREAST_EXPOSED',
  'ANUS_EXPOSED',
  'FEET_EXPOSED',
  'BELLY_COVERED',
  'FEET_COVERED',
  'ARMPITS_COVERED',
  'ARMPITS_EXPOSED',
  'FACE_MALE',
  'BELLY_EXPOSED',
  'MALE_GENITALIA_EXPOSED',
  'ANUS_COVERED',
  'FEMALE_BREAST_COVERED',
  'BUTTOCKS_COVERED',
] as const;

const idx = (...names: (typeof NUDENET_LABELS)[number][]) => names.map((n) => NUDENET_LABELS.indexOf(n));

/** Class groups the blur policy works with. */
export const GROUPS = {
  /** Explicit nudity (men and women). */
  nude: idx('FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'BUTTOCKS_EXPOSED', 'ANUS_EXPOSED'),
  /** Partial nudity: bare torso / belly. */
  skin: idx('MALE_BREAST_EXPOSED', 'BELLY_EXPOSED'),
  /**
   * Female body regions in revealing clothing (swimwear / lingerie). Not a reliable sign of a
   * woman alone (fires on some clothed men too), so it only counts above FEMALE_BODY_MIN.
   * Note: FACE_FEMALE is not used — this model labels men's faces FACE_FEMALE as well.
   */
  femaleBody: idx('FEMALE_BREAST_COVERED', 'FEMALE_GENITALIA_COVERED'),
};

export const FEMALE_BODY_MIN = 0.6;

export interface FrameScores {
  nude: number;
  skin: number;
  femaleBody: number;
}

/** Scaled size of a w×h frame letterboxed into the top-left of a size×size square (as NudeNet does). */
export function letterbox(w: number, h: number, size = NUDENET_INPUT): { dw: number; dh: number } {
  const s = size / Math.max(w, h, 1);
  return { dw: Math.max(1, Math.round(w * s)), dh: Math.max(1, Math.round(h * s)) };
}

/**
 * RGBA bytes (size×size) → planar **BGR** floats in [0,1] at `out[offset…]`.
 * The model expects BGR: NudeNet's reference preprocessing swaps R/B twice
 * (cvtColor RGBA2BGR on a BGR image, then blobFromImage swapRB), so channels end up in BGR order.
 */
export function rgbaToChw(rgba: Uint8ClampedArray | Uint8Array, size: number, out: Float32Array, offset = 0): void {
  const n = size * size;
  const k = 1 / 255;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[offset + i] = rgba[j + 2] * k;
    out[offset + n + i] = rgba[j + 1] * k;
    out[offset + 2 * n + i] = rgba[j] * k;
  }
}

/**
 * Highest confidence of each class group in each of the first `count` images of a batch.
 * No NMS needed: the policy only asks "is any such region present".
 */
export function scoreFrames(out: Float32Array, batch: number, count = batch): FrameScores[] {
  const rows = 4 + NUDENET_LABELS.length;
  const anchors = out.length / (batch * rows);
  const res: FrameScores[] = [];
  const classMax = new Float32Array(NUDENET_LABELS.length);
  for (let b = 0; b < count; b++) {
    for (let c = 0; c < classMax.length; c++) {
      const base = (b * rows + 4 + c) * anchors;
      let m = 0;
      for (let a = 0; a < anchors; a++) if (out[base + a] > m) m = out[base + a];
      classMax[c] = m;
    }
    const g = (ids: number[]) => ids.reduce((m, i) => Math.max(m, classMax[i]), 0);
    res.push({ nude: g(GROUPS.nude), skin: g(GROUPS.skin), femaleBody: g(GROUPS.femaleBody) });
  }
  return res;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

const FACE_CLASSES = idx('FACE_FEMALE', 'FACE_MALE');

/**
 * Face boxes of image `b` (in the 320×320 letterboxed input space), after NMS.
 * NudeNet finds faces well but can't tell men from women (both come out as FACE_FEMALE),
 * so gender is decided by a separate classifier on these crops.
 */
export function detectFaces(out: Float32Array, batch: number, b: number, minScore = 0.35, maxFaces = 6): Box[] {
  const rows = 4 + NUDENET_LABELS.length;
  const A = out.length / (batch * rows);
  const at = (r: number, a: number) => out[(b * rows + r) * A + a];
  const cand: Box[] = [];
  for (let a = 0; a < A; a++) {
    let s = 0;
    for (const c of FACE_CLASSES) s = Math.max(s, at(4 + c, a));
    if (s < minScore) continue;
    const w = at(2, a), h = at(3, a);
    cand.push({ x: at(0, a) - w / 2, y: at(1, a) - h / 2, w, h, score: s });
  }
  cand.sort((p, q) => q.score - p.score);
  const keep: Box[] = [];
  for (const c of cand) {
    if (keep.every((k) => iou(k, c) < 0.45)) keep.push(c);
    if (keep.length >= maxFaces) break;
  }
  return keep;
}

function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter + 1e-9);
}

/**
 * NudeNet face boxes are looser than InsightFace's own detector, so the crop is 1.2× the longer
 * edge (not InsightFace's 1.5×). Tuned on portraits: 1.2 separates men / women best.
 */
export const FACE_CROP_SCALE = 1.2;

/** Square crop around a face for the gender classifier (centred on the box). */
export function faceCrop(box: Box): { x: number; y: number; side: number } {
  const side = Math.max(box.w, box.h) * FACE_CROP_SCALE;
  return { x: box.x + box.w / 2 - side / 2, y: box.y + box.h / 2 - side / 2, side };
}

export const GENDER_INPUT = 96;

/**
 * InsightFace genderage (input: RGB 0–255, planar, 96×96; it normalises internally).
 * Output [female, male, age/100] → probability the face is a woman.
 */
export function femaleProb(out: Float32Array, i: number): number {
  const f = out[i * 3], m = out[i * 3 + 1];
  const mx = Math.max(f, m);
  const ef = Math.exp(f - mx), em = Math.exp(m - mx);
  return ef / (ef + em);
}

/** RGBA bytes (n×n) → planar RGB 0–255 floats, the gender classifier's input. */
export function rgbaToGenderInput(rgba: Uint8ClampedArray | Uint8Array, n: number, out: Float32Array, offset = 0): void {
  const m = n * n;
  for (let i = 0, j = 0; i < m; i++, j += 4) {
    out[offset + i] = rgba[j];
    out[offset + m + i] = rgba[j + 1];
    out[offset + 2 * m + i] = rgba[j + 2];
  }
}

/** Woman score of a frame: the most confident female face, or revealing female body regions. */
export function femaleScore(faceProbs: number[], femaleBody: number): number {
  let s = femaleBody >= FEMALE_BODY_MIN ? femaleBody : 0;
  for (const p of faceProbs) s = Math.max(s, p);
  return s;
}
