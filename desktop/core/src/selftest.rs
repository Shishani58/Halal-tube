//! GPU self-test helpers. Port of `src/core/selftest.ts` of the extension.
//!
//! CoreML or DirectML can compute wrong numbers without an error (a driver bug, a half-precision
//! path that loses a model). The model is run on a fixed realistic signal on the GPU and on the CPU
//! and the two outputs are compared; a mismatch means the CPU is used instead.

/// Share (RMS of the difference over RMS of the CPU output) above which the GPU result is wrong.
/// Half precision differs by ~1.5 %, a broken kernel by ~100 %.
pub const MAX_ERR: f64 = 0.1;
pub const SAMPLES: usize = 1024;

/// `n` evenly spaced values of an output.
pub fn sample_output(out: &[f32], n: usize) -> Vec<f32> {
    let len = out.len();
    let m = n.min(len);
    (0..m).map(|i| out[if m == 1 { 0 } else { i * (len - 1) / (m - 1) }]).collect()
}

/// Relative RMS error of `got` against `reference`; `Err` says why they can't be compared or are wrong.
pub fn compare_samples(got: &[f32], reference: &[f32], max_err: f64) -> Result<f64, String> {
    if got.len() != reference.len() || reference.is_empty() {
        return Err("sample count differs".into());
    }
    let (mut d, mut r) = (0f64, 0f64);
    for (g, c) in got.iter().zip(reference) {
        if !g.is_finite() {
            return Err("non-finite output".into());
        }
        d += ((*g - *c) as f64).powi(2);
        r += (*c as f64).powi(2);
    }
    if r < 1e-12 {
        return Err("reference is all zeros".into());
    }
    let err = (d / r).sqrt();
    if err <= max_err {
        Ok(err)
    } else {
        Err(format!("error {:.1} % of the reference", err * 100.0))
    }
}

/// A deterministic stereo signal that looks like what the model gets: a voice (gliding pitch,
/// harmonics, formant-like envelope, syllables), a chord with tremolo, a little noise. (Random noise
/// is no stand-in: fp16 differs from fp32 by ~12 % on it, by ~1.5 % on real audio.)
pub fn test_audio(n: usize, rate: u32, seed: u32) -> (Vec<f32>, Vec<f32>) {
    let mut x = if seed == 0 { 1 } else { seed };
    let mut noise = move || {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        x as f64 / 2147483648.0 - 1.0
    };
    let tau = std::f64::consts::TAU;
    let chord = [220.0, 277.18, 329.63, 440.0];
    let (mut l, mut r) = (vec![0f32; n], vec![0f32; n]);
    let mut phase = 0f64;
    for i in 0..n {
        let t = i as f64 / rate as f64;
        let f0 = 130.0 + 50.0 * (tau * 0.35 * t).sin();
        phase += tau * f0 / rate as f64;
        let mut voice = 0.0;
        for h in 1..=18 {
            let hf = h as f64;
            voice += (hf * phase).sin() * (-0.5 * ((hf * f0 - 700.0) / 500.0).powi(2)).exp() / hf;
        }
        voice *= (tau * 3.3 * t).sin().max(0.0).powf(0.5);
        let mut music = 0.0;
        for f in chord {
            music += (tau * f * t).sin() + 0.3 * (tau * 2.0 * f * t).sin();
        }
        music *= 0.12 * (0.7 + 0.3 * (tau * 2.0 * t).sin());
        let e = 0.01 * noise();
        l[i] = (0.35 * voice + music + e) as f32;
        r[i] = (0.35 * voice + 0.9 * music - e) as f32;
    }
    (l, r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampling_includes_first_and_last() {
        let v: Vec<f32> = (0..=100).map(|i| i as f32).collect();
        assert_eq!(sample_output(&v, 11), (0..=10).map(|i| (i * 10) as f32).collect::<Vec<_>>());
        assert_eq!(sample_output(&[5.0, 6.0], 1024).len(), 2);
    }

    #[test]
    fn half_precision_noise_passes_and_broken_output_fails() {
        let reference: Vec<f32> = (0..1024).map(|i| ((i * 37 % 101) as f32 - 50.0) / 10.0).collect();
        let fp16: Vec<f32> = reference.iter().enumerate().map(|(i, x)| x * (1.0 + 0.004 * ((i % 7) as f32 - 3.0) / 3.0)).collect();
        assert!(compare_samples(&fp16, &reference, MAX_ERR).is_ok());
        let garbage: Vec<f32> = reference.iter().rev().cloned().collect();
        assert!(compare_samples(&garbage, &reference, MAX_ERR).is_err());
        assert!(compare_samples(&vec![0.0; 1024], &reference, MAX_ERR).is_err(), "zeros");
        let mut nan = reference.clone();
        nan[500] = f32::NAN;
        assert!(compare_samples(&nan, &reference, MAX_ERR).is_err(), "NaN");
        assert!(compare_samples(&reference.iter().map(|x| x * 0.7).collect::<Vec<_>>(), &reference, MAX_ERR).is_err(), "wrong scale");
        assert!(compare_samples(&[0.0, 0.0], &[0.0, 0.0], MAX_ERR).is_err(), "a zero reference proves nothing");
    }

    #[test]
    fn test_audio_is_deterministic_finite_and_quiet() {
        let (a, b) = test_audio(44100, 44100, 5);
        let (c, _) = test_audio(44100, 44100, 5);
        assert_eq!(a, c);
        assert!(a.iter().all(|x| x.is_finite() && x.abs() < 1.0));
        assert!(a != b, "channels differ");
        let rms = (a.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / a.len() as f64).sqrt();
        assert!(rms > 0.02 && rms < 0.5, "level {rms}");
    }
}
