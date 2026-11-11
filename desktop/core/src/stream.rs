//! Sample-rate conversion for a stream of arbitrary-sized blocks (the capture runs at the output
//! device's rate, usually 48 kHz; the model at 44.1 kHz).

use crate::Error;
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};

/// Input frames per resampler call.
const CHUNK: usize = 480;

pub struct StreamResampler {
    inner: Option<SincFixedIn<f32>>,
    in_l: Vec<f32>,
    in_r: Vec<f32>,
}

impl StreamResampler {
    /// `None` inside when the two rates are equal (samples pass through).
    pub fn new(from: u32, to: u32) -> Result<Self, Error> {
        let inner = if from == to {
            None
        } else {
            let params = SincInterpolationParameters {
                sinc_len: 128,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Linear,
                oversampling_factor: 128,
                window: WindowFunction::BlackmanHarris2,
            };
            Some(SincFixedIn::<f32>::new(to as f64 / from as f64, 1.1, params, CHUNK, 2).map_err(|e| Error::Capture(format!("resampler: {e}")))?)
        };
        Ok(StreamResampler { inner, in_l: Vec::new(), in_r: Vec::new() })
    }

    /// Like `new`, but with a resampler even when the rates are equal, so that [`nudge`](Self::nudge) works.
    pub fn new_adjustable(from: u32, to: u32) -> Result<Self, Error> {
        let mut s = Self::new(from, to)?;
        if s.inner.is_none() {
            let params = SincInterpolationParameters {
                sinc_len: 128,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Linear,
                oversampling_factor: 128,
                window: WindowFunction::BlackmanHarris2,
            };
            s.inner = Some(SincFixedIn::<f32>::new(1.0, 1.1, params, CHUNK, 2).map_err(|e| Error::Capture(format!("resampler: {e}")))?);
        }
        Ok(s)
    }

    /// Changes the speed of what comes out by `rel` (1.003: 0.3 % more samples per second, i.e. 0.3 % lower pitch), smoothly.
    /// Used to hold the output queue at a steady level when the capture and the output clocks drift apart.
    pub fn nudge(&mut self, rel: f64) {
        if let Some(rs) = self.inner.as_mut() {
            let _ = rs.set_resample_ratio_relative(rel.clamp(0.9, 1.1), true);
        }
    }

    /// Converts a block; appends what is ready to `out_*` (it lags the input by a few milliseconds).
    pub fn process(&mut self, l: &[f32], r: &[f32], out_l: &mut Vec<f32>, out_r: &mut Vec<f32>) -> Result<(), Error> {
        let Some(rs) = self.inner.as_mut() else {
            out_l.extend_from_slice(l);
            out_r.extend_from_slice(r);
            return Ok(());
        };
        self.in_l.extend_from_slice(l);
        self.in_r.extend_from_slice(r);
        loop {
            let need = rs.input_frames_next();
            if self.in_l.len() < need {
                break;
            }
            let chunk = [self.in_l[..need].to_vec(), self.in_r[..need].to_vec()];
            let out = rs.process(&chunk, None).map_err(|e| Error::Capture(format!("resampler: {e}")))?;
            out_l.extend_from_slice(&out[0]);
            out_r.extend_from_slice(&out[1]);
            self.in_l.drain(..need);
            self.in_r.drain(..need);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(n: usize, rate: u32, hz: f32) -> Vec<f32> {
        (0..n).map(|i| (std::f32::consts::TAU * hz * i as f32 / rate as f32).sin() * 0.5).collect()
    }

    #[test]
    fn a_tone_keeps_its_pitch_across_rates_and_block_sizes() {
        let mut rs = StreamResampler::new(48000, 44100).unwrap();
        let x = tone(48000, 48000, 1000.0);
        let (mut ol, mut or) = (Vec::new(), Vec::new());
        for block in x.chunks(137) {
            rs.process(block, block, &mut ol, &mut or).unwrap();
        }
        // one second in: about one second out (minus the filter's lag)
        assert!(ol.len() > 43500 && ol.len() <= 44100, "got {}", ol.len());
        // zero crossings of a 1 kHz tone: ~2000 per second, wherever the lag put the start
        let crossings = ol[2000..].windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        let secs = (ol.len() - 2000) as f32 / 44100.0;
        assert!((crossings as f32 / secs - 1000.0).abs() < 5.0, "{crossings} rising crossings in {secs} s");
        let peak = ol[2000..].iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.5).abs() < 0.02, "peak {peak}");
        assert_eq!(ol, or);
    }

    #[test]
    fn equal_rates_pass_through() {
        let mut rs = StreamResampler::new(44100, 44100).unwrap();
        let (mut l, mut r) = (Vec::new(), Vec::new());
        rs.process(&[1.0, 2.0], &[3.0, 4.0], &mut l, &mut r).unwrap();
        assert_eq!((l, r), (vec![1.0, 2.0], vec![3.0, 4.0]));
    }
}
