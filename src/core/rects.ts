/** Rectangles as [x, y, w, h] in frame-relative units (0–1). */

/** Intersection over the smaller of the two areas. */
export function overlap(a: number[], b: number[]): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1e-9, Math.min(area(a), area(b)));
}

export function area(r: number[]): number {
  return Math.max(0, r[2]) * Math.max(0, r[3]);
}

export function grow(r: number[], m: number): number[] {
  const x0 = Math.max(0, r[0] - m), y0 = Math.max(0, r[1] - m);
  const x1 = Math.min(1, r[0] + r[2] + m), y1 = Math.min(1, r[1] + r[3] + m);
  return [x0, y0, x1 - x0, y1 - y0];
}

export function union(a: number[], b: number[]): number[] {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  return [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0];
}
