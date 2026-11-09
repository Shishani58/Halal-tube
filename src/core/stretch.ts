/**
 * WSOLA time-scale modification: changes tempo by `rate` without changing pitch.
 * Output length is exactly round(input.length / rate) so stretched tiles stay seamless.
 */
export function timeStretch(L: Float32Array, R: Float32Array, rate: number): [Float32Array, Float32Array] {
  const N = L.length;
  const outLen = Math.round(N / rate);
  const win = 1536; // ~35 ms at 44.1 kHz
  const hs = win / 2; // synthesis hop
  const ha = hs * rate; // analysis hop
  const delta = 384; // search tolerance
  const w = new Float32Array(win);
  for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);

  const outL = new Float32Array(outLen + win);
  const outR = new Float32Array(outLen + win);
  const wsum = new Float32Array(outLen + win);
  const maxPos = Math.max(0, N - win);
  const mono = (i: number) => L[i] + R[i];

  let prev = 0;
  for (let k = 0; k * hs < outLen; k++) {
    const outPos = k * hs;
    const nominal = Math.min(maxPos, Math.round(k * ha));
    let best = nominal;
    if (k > 0) {
      // natural continuation of the previous frame (may run past the end: compare what exists)
      const target = prev + hs;
      const span = Math.min(win, N - target);
      let bestScore = -Infinity;
      const lo = Math.max(0, nominal - delta);
      const hi = Math.min(maxPos, nominal + delta);
      for (let p = lo; p <= hi; p += 2) {
        let c = 0;
        for (let i = 0; i < span; i += 4) c += mono(p + i) * mono(target + i);
        if (c > bestScore) {
          bestScore = c;
          best = p;
        }
      }
    }
    for (let i = 0; i < win; i++) {
      // first frame has a flat leading half so the tile doesn't fade in
      const g = k === 0 && i < hs ? 1 : w[i];
      outL[outPos + i] += L[best + i] * g;
      outR[outPos + i] += R[best + i] * g;
      wsum[outPos + i] += g;
    }
    prev = best;
  }
  const rl = new Float32Array(outLen);
  const rr = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = wsum[i] > 1e-3 ? 1 / wsum[i] : 0;
    rl[i] = outL[i] * s;
    rr[i] = outR[i] * s;
  }
  return [rl, rr];
}
