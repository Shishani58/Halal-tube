/**
 * Mixed-radix (2/3/4/5/…) Stockham FFT for arbitrary N whose prime factors are small.
 * MDX models use n_fft = 7680 = 4·4·4·4·2·3·5, which is not a power of two.
 */
export class FFT {
  readonly n: number;
  private readonly factors: number[];
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly tRe: Float64Array;
  private readonly tIm: Float64Array;
  private readonly aRe = new Float64Array(16);
  private readonly aIm = new Float64Array(16);

  constructor(n: number) {
    this.n = n;
    this.factors = factorize(n);
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (-2 * Math.PI * i) / n;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
    this.tRe = new Float64Array(n);
    this.tIm = new Float64Array(n);
  }

  /** In-place forward DFT: X[k] = Σ x[n]·e^{-2πikn/N}. */
  forward(re: Float64Array, im: Float64Array): void {
    const N = this.n;
    let xr = re, xi = im, yr = this.tRe, yi = this.tIm;
    let n = N; // current sub-transform length
    let s = 1; // stride
    const { cos, sin, aRe, aIm } = this;
    for (const r of this.factors) {
      const m = n / r;
      const nStep = N / n; // global twiddle index multiplier for e^{-2πi pk/n}
      const rStep = N / r; // global index multiplier for e^{-2πi jk/r}
      if (r === 4) {
        radix4(xr, xi, yr, yi, m, s, nStep, cos, sin);
      } else if (r === 2) {
        radix2(xr, xi, yr, yi, m, s, nStep, cos, sin);
      } else if (r === 3) {
        radix3(xr, xi, yr, yi, m, s, nStep, cos, sin);
      } else if (r === 5) {
        radix5(xr, xi, yr, yi, m, s, nStep, cos, sin);
      } else for (let p = 0; p < m; p++) {
        for (let q = 0; q < s; q++) {
          // gather
          for (let j = 0; j < r; j++) {
            const idx = q + s * (p + j * m);
            aRe[j] = xr[idx];
            aIm[j] = xi[idx];
          }
          // small DFT of size r, then twiddle by e^{-2πi pk/n}
          for (let k = 0; k < r; k++) {
            let sr = 0, si = 0;
            for (let j = 0; j < r; j++) {
              const t = ((j * k) % r) * rStep;
              const c = cos[t], sn = sin[t];
              sr += aRe[j] * c - aIm[j] * sn;
              si += aRe[j] * sn + aIm[j] * c;
            }
            const tw = ((p * k * nStep) % N);
            const c = cos[tw], sn = sin[tw];
            const out = q + s * (r * p + k);
            yr[out] = sr * c - si * sn;
            yi[out] = sr * sn + si * c;
          }
        }
      }
      // swap
      const tr = xr; xr = yr; yr = tr;
      const ti = xi; xi = yi; yi = ti;
      n = m;
      s *= r;
    }
    if (xr !== re) {
      re.set(xr);
      im.set(xi);
    }
  }

  /** In-place inverse DFT (normalized by 1/N). */
  inverse(re: Float64Array, im: Float64Array): void {
    this.inverseUnscaled(re, im);
    const inv = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      re[i] *= inv;
      im[i] *= inv;
    }
  }

  /**
   * In-place inverse DFT without the 1/N factor (callers that scale anyway fold it in).
   * IDFT(x) = swap(DFT(swap(x))): a forward transform with real and imaginary parts exchanged.
   */
  inverseUnscaled(re: Float64Array, im: Float64Array): void {
    this.forward(im, re);
  }
}

type A = Float64Array;

function radix2(xr: A, xi: A, yr: A, yi: A, m: number, s: number, nStep: number, cos: A, sin: A): void {
  for (let p = 0; p < m; p++) {
    const w1 = p * nStep;
    const c1 = cos[w1], s1 = sin[w1];
    for (let q = 0; q < s; q++) {
      const i0 = q + s * p, i1 = i0 + s * m;
      const ar = xr[i0], ai = xi[i0], br = xr[i1], bi = xi[i1];
      const o = q + s * 2 * p;
      yr[o] = ar + br;
      yi[o] = ai + bi;
      const dr = ar - br, di = ai - bi;
      yr[o + s] = dr * c1 - di * s1;
      yi[o + s] = dr * s1 + di * c1;
    }
  }
}

function radix4(xr: A, xi: A, yr: A, yi: A, m: number, s: number, nStep: number, cos: A, sin: A): void {
  const sm = s * m;
  for (let p = 0; p < m; p++) {
    const w1 = p * nStep, w2 = 2 * w1, w3 = 3 * w1;
    const c1 = cos[w1], s1 = sin[w1], c2 = cos[w2], s2 = sin[w2], c3 = cos[w3], s3 = sin[w3];
    for (let q = 0; q < s; q++) {
      const i0 = q + s * p;
      const a0r = xr[i0], a0i = xi[i0];
      const a1r = xr[i0 + sm], a1i = xi[i0 + sm];
      const a2r = xr[i0 + 2 * sm], a2i = xi[i0 + 2 * sm];
      const a3r = xr[i0 + 3 * sm], a3i = xi[i0 + 3 * sm];
      const t0r = a0r + a2r, t0i = a0i + a2i;
      const t1r = a0r - a2r, t1i = a0i - a2i;
      const t2r = a1r + a3r, t2i = a1i + a3i;
      // (a1 - a3)·(−i)
      const t3r = a1i - a3i, t3i = a3r - a1r;
      const o = q + s * 4 * p;
      yr[o] = t0r + t2r;
      yi[o] = t0i + t2i;
      let ur = t1r + t3r, ui = t1i + t3i;
      yr[o + s] = ur * c1 - ui * s1;
      yi[o + s] = ur * s1 + ui * c1;
      ur = t0r - t2r; ui = t0i - t2i;
      yr[o + 2 * s] = ur * c2 - ui * s2;
      yi[o + 2 * s] = ur * s2 + ui * c2;
      ur = t1r - t3r; ui = t1i - t3i;
      yr[o + 3 * s] = ur * c3 - ui * s3;
      yi[o + 3 * s] = ur * s3 + ui * c3;
    }
  }
}

const SQ3_2 = Math.sqrt(3) / 2;
function radix3(xr: A, xi: A, yr: A, yi: A, m: number, s: number, nStep: number, cos: A, sin: A): void {
  const sm = s * m;
  for (let p = 0; p < m; p++) {
    const w1 = p * nStep, w2 = 2 * w1;
    const c1 = cos[w1], s1 = sin[w1], c2 = cos[w2], s2 = sin[w2];
    for (let q = 0; q < s; q++) {
      const i0 = q + s * p;
      const a0r = xr[i0], a0i = xi[i0];
      const a1r = xr[i0 + sm], a1i = xi[i0 + sm];
      const a2r = xr[i0 + 2 * sm], a2i = xi[i0 + 2 * sm];
      const sr = a1r + a2r, si = a1i + a2i;
      const dr = a1r - a2r, di = a1i - a2i;
      const mr = a0r - 0.5 * sr, mi = a0i - 0.5 * si;
      // ∓i·(√3/2)·d
      const er = SQ3_2 * di, ei = -SQ3_2 * dr;
      const o = q + s * 3 * p;
      yr[o] = a0r + sr;
      yi[o] = a0i + si;
      let ur = mr + er, ui = mi + ei;
      yr[o + s] = ur * c1 - ui * s1;
      yi[o + s] = ur * s1 + ui * c1;
      ur = mr - er; ui = mi - ei;
      yr[o + 2 * s] = ur * c2 - ui * s2;
      yi[o + 2 * s] = ur * s2 + ui * c2;
    }
  }
}

const C5_1 = Math.cos((2 * Math.PI) / 5), C5_2 = Math.cos((4 * Math.PI) / 5);
const S5_1 = Math.sin((2 * Math.PI) / 5), S5_2 = Math.sin((4 * Math.PI) / 5);
function radix5(xr: A, xi: A, yr: A, yi: A, m: number, s: number, nStep: number, cos: A, sin: A): void {
  const sm = s * m;
  for (let p = 0; p < m; p++) {
    const w1 = p * nStep;
    const c1 = cos[w1], s1 = sin[w1], c2 = cos[2 * w1], s2 = sin[2 * w1];
    const c3 = cos[3 * w1], s3 = sin[3 * w1], c4 = cos[4 * w1], s4 = sin[4 * w1];
    for (let q = 0; q < s; q++) {
      const i0 = q + s * p;
      const a0r = xr[i0], a0i = xi[i0];
      const a1r = xr[i0 + sm], a1i = xi[i0 + sm];
      const a2r = xr[i0 + 2 * sm], a2i = xi[i0 + 2 * sm];
      const a3r = xr[i0 + 3 * sm], a3i = xi[i0 + 3 * sm];
      const a4r = xr[i0 + 4 * sm], a4i = xi[i0 + 4 * sm];
      const t1r = a1r + a4r, t1i = a1i + a4i, t2r = a2r + a3r, t2i = a2i + a3i;
      const t3r = a1r - a4r, t3i = a1i - a4i, t4r = a2r - a3r, t4i = a2i - a3i;
      const b1r = a0r + C5_1 * t1r + C5_2 * t2r, b1i = a0i + C5_1 * t1i + C5_2 * t2i;
      const b2r = a0r + C5_2 * t1r + C5_1 * t2r, b2i = a0i + C5_2 * t1i + C5_1 * t2i;
      const d1r = S5_1 * t3r + S5_2 * t4r, d1i = S5_1 * t3i + S5_2 * t4i;
      const d2r = S5_2 * t3r - S5_1 * t4r, d2i = S5_2 * t3i - S5_1 * t4i;
      const o = q + s * 5 * p;
      yr[o] = a0r + t1r + t2r;
      yi[o] = a0i + t1i + t2i;
      // y1 = b1 − i·d1, y4 = b1 + i·d1, y2 = b2 − i·d2, y3 = b2 + i·d2; then twiddle by e^{−2πi·pk/n}
      let ur = b1r + d1i, ui = b1i - d1r;
      yr[o + s] = ur * c1 - ui * s1;
      yi[o + s] = ur * s1 + ui * c1;
      ur = b2r + d2i; ui = b2i - d2r;
      yr[o + 2 * s] = ur * c2 - ui * s2;
      yi[o + 2 * s] = ur * s2 + ui * c2;
      ur = b2r - d2i; ui = b2i + d2r;
      yr[o + 3 * s] = ur * c3 - ui * s3;
      yi[o + 3 * s] = ur * s3 + ui * c3;
      ur = b1r - d1i; ui = b1i + d1r;
      yr[o + 4 * s] = ur * c4 - ui * s4;
      yi[o + 4 * s] = ur * s4 + ui * c4;
    }
  }
}

function factorize(n: number): number[] {
  const out: number[] = [];
  let x = n;
  for (const f of [4, 2, 3, 5, 7, 11, 13]) {
    while (x % f === 0) {
      out.push(f);
      x /= f;
    }
  }
  if (x !== 1) throw new Error(`FFT size ${n} has unsupported prime factor ${x}`);
  return out;
}
