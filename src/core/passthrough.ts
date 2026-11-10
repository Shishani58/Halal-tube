/**
 * Where nothing was taken out, the original sound is better than the model's estimate of it: the
 * separation always alters a little (a few dB of the voice's top end, breaths, room), and on a
 * stretch of plain speech there is no music to win that back. So after separation, windows in which
 * what the model removed (original − voice) is far below the original are played from the original
 * itself. A window with real music has a removed part near its own level and stays as separated.
 */

/** Window length (s). */
export const PASS_WINDOW_S = 0.5;
/** A window passes when the removed part is at most this far below the original (dB, power). */
export const PASS_BELOW_DB = -30;
/** Crossfade into / out of a passed window (s). */
export const PASS_FADE_S = 0.03;
/** Windows with less power per sample than this are silence: left as separated. */
const SILENCE = 1e-9;

export interface PassStats {
  /** Share of the span played from the original (0–1). */
  kept: number;
}

/**
 * Replace, in place, the stretches of `cleanL`/`cleanR` where the removed part is negligible by the
 * original. Both pairs cover the same span at `rate`. Neighbouring tiles need no crossfade between
 * them: a passed window differs from the separated one by at most PASS_BELOW_DB.
 */
export function keepOriginalWhereClean(
  cleanL: Float32Array,
  cleanR: Float32Array,
  origL: Float32Array,
  origR: Float32Array,
  rate: number,
  belowDb = PASS_BELOW_DB,
): PassStats {
  const n = Math.min(cleanL.length, cleanR.length, origL.length, origR.length);
  if (n === 0) return { kept: 0 };
  const win = Math.max(1, Math.round(PASS_WINDOW_S * rate));
  const fade = Math.max(1, Math.round(PASS_FADE_S * rate));
  const ratio = Math.pow(10, belowDb / 10);
  const count = Math.ceil(n / win);
  const keep: boolean[] = [];
  for (let w = 0; w < count; w++) {
    const a = w * win, b = Math.min(n, a + win);
    let eo = 0, er = 0;
    for (let i = a; i < b; i++) {
      const l = origL[i], r = origR[i];
      const dl = l - cleanL[i], dr = r - cleanR[i];
      eo += l * l + r * r;
      er += dl * dl + dr * dr;
    }
    keep.push(eo / (2 * (b - a)) > SILENCE && er <= ratio * eo);
  }
  let keptSamples = 0;
  for (let w = 0; w < count; w++) {
    if (!keep[w]) continue;
    const a = w * win, b = Math.min(n, a + win);
    keptSamples += b - a;
    const rampIn = w > 0 && !keep[w - 1];
    const rampOut = w < count - 1 && !keep[w + 1];
    for (let i = a; i < b; i++) {
      let g = 1;
      if (rampIn) g = Math.min(g, (i - a + 1) / fade);
      if (rampOut) g = Math.min(g, (b - i) / fade);
      if (g >= 1) {
        cleanL[i] = origL[i];
        cleanR[i] = origR[i];
      } else {
        cleanL[i] += g * (origL[i] - cleanL[i]);
        cleanR[i] += g * (origR[i] - cleanR[i]);
      }
    }
  }
  return { kept: keptSamples / n };
}
