//! Streaming separation for a live mode (system audio): the engine, without any audio capture.
//!
//! The model wants a fixed window of `chunk_size` samples (5.9 s) and is accurate for all but the
//! last `trim` samples of it (87 ms), which are only context. So, instead of cutting the audio into
//! tiles, every `hop` samples the window ending at the newest audio is run and only its last `hop`
//! accurate samples are kept. The cost is one model run per hop (a run takes ~0.3 s on CoreML), the
//! latency `hop + trim` plus the run. Measured on a real recording (narration over music) the
//! result agrees with the tile-by-tile result to 26–28 dB, i.e. it is the same sound.
//!
//! Output is the input delayed by [`Live::latency`] samples; the first `trim` output samples are
//! silence (the audio before the stream began).

use crate::job::Options;
use crate::model::Separator;
use crate::passthrough::{keep_original_where_clean, mix_original, BELOW_DB};
use crate::Error;

pub struct Live {
    hop: usize,
    chunk: usize,
    trim: usize,
    rate: u32,
    opts: Options,
    /// The newest `chunk` input samples (the window), oldest first.
    win_l: Vec<f32>,
    win_r: Vec<f32>,
    /// Input received since the last run (fewer than `hop` samples).
    new_l: Vec<f32>,
    new_r: Vec<f32>,
    out_l: Vec<f32>,
    out_r: Vec<f32>,
    /// Hops that were silent and cost no model run.
    pub skipped: u64,
}

impl Live {
    /// `hop_s`: how often the model runs, in seconds (1 s: ~30 % of a CoreML GPU, latency ~1.1 s + a run).
    pub fn new(sep: &Separator, hop_s: f64, opts: Options) -> Self {
        let (chunk, trim, rate) = (sep.mdx.chunk_size, sep.mdx.trim, sep.mdx.cfg.sample_rate);
        let hop = ((hop_s * rate as f64).round() as usize).clamp(rate as usize / 20, sep.mdx.gen_size);
        Live {
            hop,
            chunk,
            trim,
            rate,
            opts,
            win_l: vec![0.0; chunk],
            win_r: vec![0.0; chunk],
            new_l: Vec::with_capacity(hop),
            new_r: Vec::with_capacity(hop),
            out_l: vec![0.0; sep.mdx.gen_size],
            out_r: vec![0.0; sep.mdx.gen_size],
            skipped: 0,
        }
    }

    /// Samples by which the output lags the input once the first hop is done (`hop + trim`, plus the model's run time).
    pub fn latency(&self) -> usize {
        self.hop + self.trim
    }

    pub fn set_options(&mut self, opts: Options) {
        self.opts = opts;
    }

    /// Feeds input; appends to `out_*` whatever became ready (nothing until a full hop is in, then
    /// `hop` samples at a time). The stream is silent at the start: the first `trim` samples it emits
    /// are the (absent) audio before the stream.
    pub fn push(&mut self, sep: &mut Separator, left: &[f32], right: &[f32], out_l: &mut Vec<f32>, out_r: &mut Vec<f32>) -> Result<(), Error> {
        let n = left.len().min(right.len());
        let mut at = 0;
        while at < n {
            let take = (self.hop - self.new_l.len()).min(n - at);
            self.new_l.extend_from_slice(&left[at..at + take]);
            self.new_r.extend_from_slice(&right[at..at + take]);
            at += take;
            if self.new_l.len() == self.hop {
                self.run(sep, out_l, out_r)?;
            }
        }
        Ok(())
    }

    fn run(&mut self, sep: &mut Separator, out_l: &mut Vec<f32>, out_r: &mut Vec<f32>) -> Result<(), Error> {
        let hop = self.hop;
        // slide the window by one hop: drop the oldest hop, append the new one
        self.win_l.copy_within(hop.., 0);
        self.win_r.copy_within(hop.., 0);
        self.win_l[self.chunk - hop..].copy_from_slice(&self.new_l);
        self.win_r[self.chunk - hop..].copy_from_slice(&self.new_r);
        self.new_l.clear();
        self.new_r.clear();
        // out[j] is the voice at window sample trim + j: the accurate end of it is out[gen − hop..],
        // the window samples [chunk − trim − hop, chunk − trim)
        let gen = self.out_l.len();
        let (a, b) = (gen - hop, gen);
        let o0 = self.chunk - self.trim - hop;
        let (orig_l, orig_r) = (&self.win_l[o0..o0 + hop], &self.win_r[o0..o0 + hop]);
        // nothing is playing (the capture is digital silence): no model run, no GPU load
        if orig_l.iter().chain(orig_r.iter()).all(|x| x.abs() < 1e-6) {
            out_l.extend(std::iter::repeat(0.0).take(hop));
            out_r.extend(std::iter::repeat(0.0).take(hop));
            self.skipped += 1;
            return Ok(());
        }
        sep.separate_window(&self.win_l, &self.win_r, &mut self.out_l, &mut self.out_r)?;
        let (mut vl, mut vr) = (self.out_l[a..b].to_vec(), self.out_r[a..b].to_vec());
        if self.opts.keep_plain_speech {
            keep_original_where_clean(&mut vl, &mut vr, orig_l, orig_r, self.rate, BELOW_DB);
        }
        mix_original(&mut vl, &mut vr, orig_l, orig_r, self.opts.strength);
        out_l.extend_from_slice(&vl);
        out_r.extend_from_slice(&vr);
        Ok(())
    }
}
