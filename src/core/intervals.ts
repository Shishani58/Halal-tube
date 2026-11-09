/** Sorted set of disjoint [start, end) intervals on the media timeline. */
export class IntervalSet {
  readonly spans: [number, number][] = [];

  /** Add [a, b), merging with neighbours closer than `join` seconds. */
  add(a: number, b: number, join = 0.12): void {
    if (!(b > a)) return;
    const s = this.spans;
    let i = 0;
    while (i < s.length && s[i][1] < a - join) i++;
    let j = i;
    let lo = a, hi = b;
    while (j < s.length && s[j][0] <= b + join) {
      lo = Math.min(lo, s[j][0]);
      hi = Math.max(hi, s[j][1]);
      j++;
    }
    s.splice(i, j - i, [lo, hi]);
  }

  /** True if t lies inside a span (with tolerance). */
  has(t: number, tol = 0.05): boolean {
    const s = this.spans;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (s[m][1] + tol < t) lo = m + 1;
      else hi = m;
    }
    return lo < s.length && s[lo][0] - tol <= t;
  }

  /** True if [a, b] is inside one span (with tolerance). */
  covers(a: number, b: number, tol = 0.05): boolean {
    for (const [x, y] of this.spans) if (x - tol <= a && b <= y + tol) return true;
    return false;
  }

  /** End of the span containing t (t itself if none). */
  endFrom(t: number, tol = 0.05): number {
    for (const [x, y] of this.spans) if (x - tol <= t && t <= y + tol) return y;
    return t;
  }

  /** Drop spans entirely before t. */
  trimBefore(t: number): void {
    let i = 0;
    while (i < this.spans.length && this.spans[i][1] < t) i++;
    if (i) this.spans.splice(0, i);
  }
}
