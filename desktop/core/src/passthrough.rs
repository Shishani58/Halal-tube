//! Plain speech is better left as it was. Port of `src/core/passthrough.ts` of the extension.
//!
//! The separation always alters a little (the voice's top end, breaths, room), and on a stretch of
//! plain speech there is no music to win that back. So windows in which what the model removed
//! (original − voice) is far below the original are replaced by the original itself, with a short
//! crossfade at the edges.

/// Window length (s).
pub const WINDOW_S: f64 = 0.5;
/// A window passes when the removed part is at most this far below the original (dB, power).
pub const BELOW_DB: f64 = -30.0;
/// Crossfade into / out of a passed window (s).
pub const FADE_S: f64 = 0.03;
/// Windows with less power per sample than this are silence: left as separated.
const SILENCE: f64 = 1e-9;

/// Replaces, in place, the stretches of `clean_*` where the removed part is negligible by the
/// original. Both pairs cover the same span at `rate`. Returns the share of the span that came
/// from the original (0–1).
pub fn keep_original_where_clean(clean_l: &mut [f32], clean_r: &mut [f32], orig_l: &[f32], orig_r: &[f32], rate: u32, below_db: f64) -> f64 {
    let n = clean_l.len().min(clean_r.len()).min(orig_l.len()).min(orig_r.len());
    if n == 0 {
        return 0.0;
    }
    let win = ((WINDOW_S * rate as f64).round() as usize).max(1);
    let fade = ((FADE_S * rate as f64).round() as usize).max(1);
    let ratio = 10f64.powf(below_db / 10.0);
    let count = n.div_ceil(win);
    let keep: Vec<bool> = (0..count)
        .map(|w| {
            let (a, b) = (w * win, ((w + 1) * win).min(n));
            let (mut eo, mut er) = (0f64, 0f64);
            for i in a..b {
                let (l, r) = (orig_l[i] as f64, orig_r[i] as f64);
                let (dl, dr) = (l - clean_l[i] as f64, r - clean_r[i] as f64);
                eo += l * l + r * r;
                er += dl * dl + dr * dr;
            }
            eo / (2.0 * (b - a) as f64) > SILENCE && er <= ratio * eo
        })
        .collect();
    let mut kept = 0usize;
    for w in 0..count {
        if !keep[w] {
            continue;
        }
        let (a, b) = (w * win, ((w + 1) * win).min(n));
        kept += b - a;
        let ramp_in = w > 0 && !keep[w - 1];
        let ramp_out = w + 1 < count && !keep[w + 1];
        for i in a..b {
            let mut g = 1f64;
            if ramp_in {
                g = g.min((i - a + 1) as f64 / fade as f64);
            }
            if ramp_out {
                g = g.min((b - i) as f64 / fade as f64);
            }
            if g >= 1.0 {
                clean_l[i] = orig_l[i];
                clean_r[i] = orig_r[i];
            } else {
                clean_l[i] += (g as f32) * (orig_l[i] - clean_l[i]);
                clean_r[i] += (g as f32) * (orig_r[i] - clean_r[i]);
            }
        }
    }
    kept as f64 / n as f64
}

/// `out = share · clean + (1 − share) · orig`, in place on `clean` (the "strength" slider).
pub fn mix_original(clean_l: &mut [f32], clean_r: &mut [f32], orig_l: &[f32], orig_r: &[f32], share: f32) {
    if share >= 1.0 {
        return;
    }
    let share = share.max(0.0);
    for (c, o) in clean_l.iter_mut().zip(orig_l) {
        *c = share * *c + (1.0 - share) * *o;
    }
    for (c, o) in clean_r.iter_mut().zip(orig_r) {
        *c = share * *c + (1.0 - share) * *o;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const RATE: u32 = 8000;

    fn noise(n: usize, amp: f32, mut seed: u32) -> Vec<f32> {
        (0..n)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                amp * ((seed as f32 / u32::MAX as f32) * 2.0 - 1.0)
            })
            .collect()
    }

    #[test]
    fn plain_speech_comes_back_as_the_original() {
        let speech = noise(4 * RATE as usize, 0.2, 1);
        let (mut l, mut r) = (speech.iter().map(|x| x * 0.97).collect::<Vec<_>>(), speech.iter().map(|x| x * 0.97).collect::<Vec<_>>());
        let kept = keep_original_where_clean(&mut l, &mut r, &speech, &speech, RATE, BELOW_DB);
        assert_eq!(kept, 1.0);
        assert!(l.iter().zip(&speech).all(|(a, b)| a == b));
    }

    #[test]
    fn windows_with_music_stay_separated() {
        let n = 6 * RATE as usize;
        let speech = noise(n, 0.2, 2);
        let mut orig = speech.clone();
        for i in (2 * RATE as usize)..(4 * RATE as usize) {
            orig[i] += 0.2 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / RATE as f32).sin();
        }
        let (mut l, mut r) = (speech.clone(), speech.clone()); // a perfect separation
        let kept = keep_original_where_clean(&mut l, &mut r, &orig, &orig, RATE, BELOW_DB);
        let (a, b) = ((2.2 * RATE as f32) as usize, (3.8 * RATE as f32) as usize);
        assert!(l[a..b].iter().zip(&speech[a..b]).all(|(x, y)| x == y), "music span keeps the separated voice");
        assert!(l[..(1.4 * RATE as f32) as usize].iter().zip(&orig).all(|(x, y)| x == y), "clean span plays the original");
        assert!(kept > 0.5 && kept < 0.75, "kept {kept}");
    }

    #[test]
    fn silence_and_empty_are_left_alone() {
        let z = vec![0f32; RATE as usize];
        let (mut l, mut r) = (z.clone(), z.clone());
        assert_eq!(keep_original_where_clean(&mut l, &mut r, &z, &z, RATE, BELOW_DB), 0.0);
        assert_eq!(keep_original_where_clean(&mut [], &mut [], &[], &[], RATE, BELOW_DB), 0.0);
    }

    #[test]
    fn strength_mixes_the_original_in() {
        let (mut l, mut r) = (vec![1.0f32; 4], vec![1.0f32; 4]);
        mix_original(&mut l, &mut r, &[0.0; 4], &[0.0; 4], 0.25);
        assert!(l.iter().all(|x| (x - 0.25).abs() < 1e-6) && r.iter().all(|x| (x - 0.25).abs() < 1e-6));
        let (mut l, mut r) = (vec![1.0f32; 2], vec![1.0f32; 2]);
        mix_original(&mut l, &mut r, &[0.0; 2], &[0.0; 2], 1.0);
        assert_eq!(l, vec![1.0, 1.0]); // 100 %: untouched
        mix_original(&mut l, &mut r, &[0.5; 2], &[0.5; 2], 0.0);
        assert_eq!(l, vec![0.5, 0.5]); // 0 %: the original
    }
}
