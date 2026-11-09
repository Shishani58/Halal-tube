/**
 * Resample with Catmull-Rom cubic interpolation.
 * `src` holds samples at `srcRate` beginning at absolute time `srcStart` (seconds).
 * Produces `count` samples at `dstRate` beginning at absolute time `dstStart`.
 * Positions outside `src` read as silence.
 */
export function resampleCubic(
  src: Float32Array,
  srcRate: number,
  srcStart: number,
  dstRate: number,
  dstStart: number,
  count: number,
  out: Float32Array = new Float32Array(count),
): Float32Array {
  const len = src.length;
  const ratio = srcRate / dstRate;
  const base = (dstStart - srcStart) * srcRate;
  const at = (i: number) => (i >= 0 && i < len ? src[i] : 0);
  for (let j = 0; j < count; j++) {
    const pos = base + j * ratio;
    const i = Math.floor(pos);
    const f = pos - i;
    if (f < 1e-9) {
      out[j] = at(i);
      continue;
    }
    const y0 = at(i - 1), y1 = at(i), y2 = at(i + 1), y3 = at(i + 2);
    const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    const b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c = -0.5 * y0 + 0.5 * y2;
    out[j] = ((a * f + b) * f + c) * f + y1;
  }
  return out;
}
