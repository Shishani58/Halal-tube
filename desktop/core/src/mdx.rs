//! Pre/post-processing for UVR MDX-Net (ConvTDFNet) ONNX models.
//!
//! Port of `src/core/mdx.ts` from the extension. Mirrors the reference PyTorch code:
//! `torch.stft(center=True, reflect pad, periodic Hann)`, channel layout
//! `[L_re, L_im, R_re, R_im]`, first `dim_f` bins, `dim_t` frames.
//! Both stereo channels go through one complex FFT (L as real part, R as imaginary part).

use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::sync::Arc;

#[derive(Clone, Copy, Debug)]
pub struct MdxConfig {
    pub n_fft: usize,
    pub hop: usize,
    pub dim_f: usize,
    pub dim_t: usize,
    pub compensate: f32,
    pub sample_rate: u32,
}

pub const KIM_VOCAL_2: MdxConfig = MdxConfig {
    n_fft: 7680,
    hop: 1024,
    dim_f: 3072,
    dim_t: 256,
    compensate: 1.009,
    sample_rate: 44100,
};

pub struct Mdx {
    pub cfg: MdxConfig,
    /// Samples fed to the model per call.
    pub chunk_size: usize,
    /// Context trimmed from each side of the model output.
    pub trim: usize,
    /// Useful output samples per call (tile length).
    pub gen_size: usize,
    fwd: Arc<dyn Fft<f32>>,
    inv: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    buf: Vec<Complex32>,
    scratch: Vec<Complex32>,
    /// compensate / Σ window² for each sample of the trimmed output region.
    gain: Vec<f32>,
    ola: Vec<Complex32>,
}

impl Mdx {
    pub fn new(cfg: MdxConfig) -> Self {
        let n = cfg.n_fft;
        let chunk_size = cfg.hop * (cfg.dim_t - 1);
        let trim = n / 2;
        let gen_size = chunk_size - 2 * trim;
        let mut planner = FftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(n);
        let inv = planner.plan_fft_inverse(n);
        let scratch_len = fwd.get_inplace_scratch_len().max(inv.get_inplace_scratch_len());
        let window: Vec<f32> = (0..n)
            .map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos()) as f32)
            .collect();

        // The overlap-add window envelope only depends on the geometry, so precompute the gain.
        let ola_len = (cfg.dim_t - 1) * cfg.hop + n;
        let mut env = vec![0f64; ola_len];
        for t in 0..cfg.dim_t {
            for (i, w) in window.iter().enumerate() {
                env[t * cfg.hop + i] += (*w as f64) * (*w as f64);
            }
        }
        let start = n / 2 + trim;
        let gain = (0..gen_size)
            .map(|j| {
                let e = env[start + j];
                if e > 1e-11 { (cfg.compensate as f64 / e) as f32 } else { 0.0 }
            })
            .collect();

        Mdx {
            cfg,
            chunk_size,
            trim,
            gen_size,
            fwd,
            inv,
            window,
            buf: vec![Complex32::default(); n],
            scratch: vec![Complex32::default(); scratch_len],
            gain,
            ola: vec![Complex32::default(); ola_len],
        }
    }

    pub fn tensor_shape(&self) -> [usize; 4] {
        [1, 4, self.cfg.dim_f, self.cfg.dim_t]
    }

    pub fn tensor_len(&self) -> usize {
        4 * self.cfg.dim_f * self.cfg.dim_t
    }

    /// Stereo waveform (`chunk_size` samples each) → model input tensor data.
    pub fn stft(&mut self, left: &[f32], right: &[f32], spec: &mut [f32]) {
        let MdxConfig { n_fft: n, hop, dim_f, dim_t, .. } = self.cfg;
        let len = self.chunk_size;
        assert!(left.len() == len && right.len() == len, "stft: bad input length");
        let plane = dim_f * dim_t;
        assert_eq!(spec.len(), 4 * plane);
        let pad = (n / 2) as isize;
        for t in 0..dim_t {
            let base = (t * hop) as isize - pad;
            for i in 0..n {
                let idx = reflect(base + i as isize, len);
                let w = self.window[i];
                self.buf[i] = Complex32::new(left[idx] * w, right[idx] * w);
            }
            self.fwd.process_with_scratch(&mut self.buf, &mut self.scratch);
            for k in 0..dim_f {
                let o = k * dim_t + t;
                if k < 3 {
                    // UVR zeroes the three lowest bins before inference
                    spec[o] = 0.0;
                    spec[plane + o] = 0.0;
                    spec[2 * plane + o] = 0.0;
                    spec[3 * plane + o] = 0.0;
                    continue;
                }
                let z = self.buf[k];
                let c = self.buf[(n - k) % n].conj();
                // L = (Z_k + conj(Z_{N-k})) / 2 ; R = (Z_k - conj(Z_{N-k})) / 2i
                spec[o] = 0.5 * (z.re + c.re);
                spec[plane + o] = 0.5 * (z.im + c.im);
                spec[2 * plane + o] = 0.5 * (z.im - c.im);
                spec[3 * plane + o] = -0.5 * (z.re - c.re);
            }
        }
    }

    /// Model output tensor → stereo waveform of length `gen_size` (the trimmed, valid region).
    pub fn istft_trimmed(&mut self, spec: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let MdxConfig { n_fft: n, hop, dim_f, dim_t, .. } = self.cfg;
        let plane = dim_f * dim_t;
        let inv_n = 1.0 / n as f32;
        self.ola.fill(Complex32::default());
        for t in 0..dim_t {
            self.buf.fill(Complex32::default());
            for k in 0..dim_f {
                let o = k * dim_t + t;
                let lr = spec[o];
                let rr = spec[2 * plane + o];
                let (li, ri) = if k == 0 { (0.0, 0.0) } else { (spec[plane + o], spec[3 * plane + o]) };
                // Z[k] = L[k] + i·R[k]
                self.buf[k] = Complex32::new(lr - ri, li + rr);
                if k > 0 {
                    // Z[N-k] = conj(L[k]) + i·conj(R[k])
                    self.buf[n - k] = Complex32::new(lr + ri, -li + rr);
                }
            }
            self.inv.process_with_scratch(&mut self.buf, &mut self.scratch);
            let off = t * hop;
            for i in 0..n {
                self.ola[off + i] += self.buf[i] * (self.window[i] * inv_n);
            }
        }
        // istft output index j ↔ ola index j + pad; we keep j ∈ [trim, trim + gen_size)
        let start = n / 2 + self.trim;
        for j in 0..self.gen_size {
            let z = self.ola[start + j];
            let g = self.gain[j];
            out_l[j] = z.re * g;
            out_r[j] = z.im * g;
        }
    }
}

fn reflect(i: isize, len: usize) -> usize {
    if i < 0 {
        (-i) as usize
    } else if i as usize >= len {
        2 * (len - 1) - i as usize
    } else {
        i as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With an identity "model" the STFT → iSTFT round trip must reproduce the input
    /// (up to `compensate` and the zeroed low bins / truncated high bins).
    #[test]
    fn roundtrip_identity() {
        let mut cfg = KIM_VOCAL_2;
        cfg.compensate = 1.0;
        // keep all bins up to Nyquist so the round trip is exact
        cfg.dim_f = cfg.n_fft / 2 + 1;
        let mut mdx = Mdx::new(cfg);
        let len = mdx.chunk_size;
        let l: Vec<f32> = (0..len).map(|i| (i as f32 * 0.013).sin() * 0.5 + (i as f32 * 0.31).cos() * 0.2).collect();
        let r: Vec<f32> = (0..len).map(|i| (i as f32 * 0.021).cos() * 0.4).collect();
        let mut spec = vec![0f32; mdx.tensor_len()];
        mdx.stft(&l, &r, &mut spec);
        let mut ol = vec![0f32; mdx.gen_size];
        let mut or = vec![0f32; mdx.gen_size];
        mdx.istft_trimmed(&spec, &mut ol, &mut or);
        // The three lowest bins are zeroed, so compare against the signal with those removed:
        // our test tones sit well above bin 3 (44100·3/7680 ≈ 17 Hz).
        let mut err = 0f64;
        let mut sig = 0f64;
        for j in 0..mdx.gen_size {
            let i = j + mdx.trim;
            err += ((ol[j] - l[i]) as f64).powi(2) + ((or[j] - r[i]) as f64).powi(2);
            sig += (l[i] as f64).powi(2) + (r[i] as f64).powi(2);
        }
        let snr = 10.0 * (sig / err).log10();
        assert!(snr > 60.0, "round-trip SNR too low: {snr:.1} dB");
    }
}
