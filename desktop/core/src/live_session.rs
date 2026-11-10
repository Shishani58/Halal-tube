//! A live session on macOS: system audio → separator → the speakers, run on threads of its own.
//!
//! The caller (the app, or `mr-live`) starts it with a [`LiveConfig`], reads [`LiveStats`] while it
//! runs and stops it. Everything that touches audio happens on one dedicated thread, which also
//! owns the output stream (`cpal` streams can't move between threads).
//!
//! ```text
//! tap (all system audio but ours; the system's own output of it silenced)
//!   → ring → resample to 44.1 kHz → Live (sliding window, model) → resample to the device rate
//!   → ring → output stream (the default device)
//! ```

use crate::capture::Capture;
use crate::job::Options;
use crate::live::Live;
use crate::mdx::{Mdx, KIM_VOCAL_2};
use crate::model::{Backend, Model, SelfTest, Separator};
use crate::ring::Ring;
use crate::stream::StreamResampler;
use crate::Error;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct LiveConfig {
    pub model_path: PathBuf,
    pub cache_dir: Option<PathBuf>,
    pub prefer: Option<Backend>,
    /// How often the model runs, seconds (1: ~25 % of a CoreML GPU, latency ~1.8 s).
    pub hop_s: f64,
    pub keep_plain_speech: bool,
    /// Percent of clean voice in the output (see `Options::strength`); can be changed while running.
    pub strength: u8,
    /// Silence the system's own output of what is captured (what is heard is only what we play).
    pub mute_original: bool,
    /// Play the processed sound. Off: nothing is played (tests).
    pub playback: bool,
    /// Keep the processed sound / the captured input in memory for [`LiveReport`] (tests, `mr-live --record`).
    pub record_output: bool,
    pub record_input: bool,
    /// Only listen and measure (no model, nothing played, the original isn't silenced).
    pub capture_only: bool,
    /// Stop by itself after this long once running.
    pub max_seconds: Option<f64>,
}

impl LiveConfig {
    pub fn new(model_path: PathBuf, cache_dir: Option<PathBuf>) -> Self {
        LiveConfig {
            model_path,
            cache_dir,
            prefer: None,
            hop_s: 1.0,
            keep_plain_speech: true,
            strength: 100,
            mute_original: true,
            playback: true,
            record_output: false,
            record_input: false,
            capture_only: false,
            max_seconds: None,
        }
    }
}

/// Where a session is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum LiveState {
    /// Opening the output device.
    Starting = 0,
    LoadingModel = 1,
    /// Waiting for the audio tap (the first start asks for the "System Audio Recording" permission).
    StartingCapture = 2,
    Running = 3,
    Stopped = 4,
    Error = 5,
}

impl LiveState {
    fn from(v: u8) -> LiveState {
        match v {
            0 => LiveState::Starting,
            1 => LiveState::LoadingModel,
            2 => LiveState::StartingCapture,
            3 => LiveState::Running,
            4 => LiveState::Stopped,
            _ => LiveState::Error,
        }
    }
}

/// Live numbers of a session (all cheap to read from any thread).
#[derive(Default)]
pub struct LiveStats {
    state: AtomicU32,
    /// Percent of clean voice; the processing thread picks it up.
    pub strength: AtomicU32,
    /// Peak of the captured input since the last [`LiveStats::take_input_peak`], in thousandths.
    input_peak_milli: AtomicU32,
    worst_run_ms: AtomicU32,
    pub skipped_hops: AtomicU64,
    pub underruns: AtomicU64,
    pub overruns: AtomicU64,
    out_ring_ms: AtomicU32,
    pub capture_rate: AtomicU32,
    /// Hops processed.
    pub runs: AtomicU64,
    /// The GPU computed wrong numbers in the self-test and the CPU is used.
    pub gpu_check_failed: AtomicBool,
    pub backend: Mutex<String>,
    pub error: Mutex<Option<(String, String)>>,
    /// Latency of the sound in seconds ×1000 (hop + the model's trim + the margin).
    latency_ms: AtomicU32,
}

impl LiveStats {
    pub fn state(&self) -> LiveState {
        LiveState::from(self.state.load(Ordering::Relaxed) as u8)
    }
    fn set_state(&self, s: LiveState) {
        self.state.store(s as u32, Ordering::Relaxed);
    }
    pub fn take_input_peak(&self) -> f32 {
        self.input_peak_milli.swap(0, Ordering::Relaxed) as f32 / 1000.0
    }
    /// The slowest model run, milliseconds, over the last report period.
    pub fn worst_run_ms(&self) -> u32 {
        self.worst_run_ms.load(Ordering::Relaxed)
    }
    pub fn out_ring_seconds(&self) -> f64 {
        self.out_ring_ms.load(Ordering::Relaxed) as f64 / 1000.0
    }
    pub fn latency_seconds(&self) -> f64 {
        self.latency_ms.load(Ordering::Relaxed) as f64 / 1000.0
    }
    fn fail(&self, code: &str, msg: String) {
        *self.error.lock().unwrap() = Some((code.to_string(), msg));
        self.set_state(LiveState::Error);
    }
}

/// What a finished session leaves behind (the recordings are empty unless asked for).
#[derive(Default)]
pub struct LiveReport {
    pub model_rate: u32,
    /// The processed sound at the model's rate; sample m ↔ input sample m − trim.
    pub output: (Vec<f32>, Vec<f32>),
    /// The captured input at the model's rate.
    pub input: (Vec<f32>, Vec<f32>),
    /// Latency in samples at the model's rate.
    pub latency: usize,
    /// For `capture_only`: seconds captured, rms (dB), peak.
    pub capture: Option<(f64, f64, f32)>,
}

pub struct LiveHandle {
    pub stats: Arc<LiveStats>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<LiveReport>>,
}

impl LiveHandle {
    /// Changes the share of clean voice while running.
    pub fn set_strength(&self, percent: u8) {
        self.stats.strength.store(percent.min(100) as u32, Ordering::Relaxed);
    }

    /// The thread has ended (stopped by itself, or failed).
    pub fn is_finished(&self) -> bool {
        self.join.as_ref().map(|j| j.is_finished()).unwrap_or(true)
    }

    /// Stops the session: the tap is released (the system's output is heard as before) and the thread joined.
    pub fn stop(mut self) -> LiveReport {
        self.stop.store(true, Ordering::Relaxed);
        let report = self.join.take().and_then(|j| j.join().ok()).unwrap_or_default();
        if self.stats.state() != LiveState::Error {
            self.stats.set_state(LiveState::Stopped);
        }
        report
    }
}

impl Drop for LiveHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Starts a session on a thread of its own and returns at once; follow it with `stats`.
pub fn start(cfg: LiveConfig) -> LiveHandle {
    let stats = Arc::new(LiveStats::default());
    stats.strength.store(cfg.strength.min(100) as u32, Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    let (s, st) = (stats.clone(), stop.clone());
    let join = std::thread::Builder::new()
        .name("mr-live".into())
        .spawn(move || {
            let mut report = LiveReport::default();
            if let Err(e) = run(&cfg, &s, &st, &mut report) {
                let code = e.code().to_string();
                s.fail(&code, e.to_string());
            }
            report
        })
        .expect("thread");
    LiveHandle { stats, stop, join: Some(join) }
}

fn run(cfg: &LiveConfig, stats: &Arc<LiveStats>, stop: &AtomicBool, report: &mut LiveReport) -> Result<(), Error> {
    stats.set_state(LiveState::Starting);
    // ── output: the default device. Opening it also makes this process an audio client, which the
    //    tap needs in order to exclude it (what we play must not be captured again).
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or_else(|| Error::Capture("no output device".into()))?;
    let dcfg = device.default_output_config().map_err(|e| Error::Capture(e.to_string()))?;
    let out_rate = dcfg.sample_rate().0;
    let out_ch = dcfg.channels() as usize;
    let out_ring = Arc::new(Ring::new(out_rate as usize * 2 * 6));
    let armed = Arc::new(AtomicBool::new(false));
    let _stream = {
        let (ring, armed) = (out_ring.clone(), armed.clone());
        let mut tmp = vec![0f32; 16384];
        let stream = device
            .build_output_stream(
                &dcfg.config(),
                move |data: &mut [f32], _| {
                    let frames = data.len() / out_ch;
                    if !armed.load(Ordering::Relaxed) || tmp.len() < frames * 2 {
                        data.fill(0.0);
                        return;
                    }
                    ring.pop_padded(&mut tmp[..frames * 2]);
                    for f in 0..frames {
                        for c in 0..out_ch {
                            data[f * out_ch + c] = if c < 2 { tmp[f * 2 + c] } else { 0.0 };
                        }
                    }
                },
                |e| eprintln!("output stream error: {e}"),
                None,
            )
            .map_err(|e| Error::Capture(format!("cannot open the output device: {e}")))?;
        stream.play().map_err(|e| Error::Capture(e.to_string()))?;
        stream
    };

    let start_capture = |mute: bool| -> Result<Capture, Error> {
        stats.set_state(LiveState::StartingCapture);
        // the process object of an audio client appears a moment after its stream opens
        for _ in 0..40 {
            if stop.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            match Capture::start(mute, 4.0) {
                Ok(c) => return Ok(c),
                Err(Error::Capture(m)) if m.starts_with("not_audio_client") => std::thread::sleep(Duration::from_millis(100)),
                Err(e) => return Err(e),
            }
        }
        Err(Error::Capture("this process never became an audio client".into()))
    };

    if cfg.capture_only {
        let cap = start_capture(false)?;
        stats.capture_rate.store(cap.sample_rate, Ordering::Relaxed);
        stats.set_state(LiveState::Running);
        let started = Instant::now();
        let (mut sum, mut peak, mut n) = (0f64, 0f32, 0u64);
        let mut buf = vec![0f32; 4096];
        while !stop.load(Ordering::Relaxed) && cfg.max_seconds.map(|m| started.elapsed().as_secs_f64() < m).unwrap_or(true) {
            let k = cap.ring.pop(&mut buf);
            for v in &buf[..k] {
                sum += (*v as f64).powi(2);
                peak = peak.max(v.abs());
            }
            n += k as u64;
            std::thread::sleep(Duration::from_millis(5));
        }
        report.capture = Some((n as f64 / 2.0 / cap.sample_rate as f64, 10.0 * (sum / n.max(1) as f64 + 1e-12).log10(), peak));
        return Ok(());
    }

    // ── the model
    stats.set_state(LiveState::LoadingModel);
    let mdx = Mdx::new(KIM_VOCAL_2);
    let model = Model::load(&cfg.model_path, mdx.tensor_shape(), cfg.prefer, cfg.cache_dir.as_deref())?;
    *stats.backend.lock().unwrap() = model.backend.label().to_string();
    let mut sep = Separator::new(mdx, model);
    if let Ok(SelfTest::FellBack(why)) = sep.self_test(cfg.cache_dir.as_deref()) {
        eprintln!("the GPU computes wrong results ({why}): using the CPU");
        stats.gpu_check_failed.store(true, Ordering::Relaxed);
        *stats.backend.lock().unwrap() = sep.model.backend.label().to_string();
    }
    let opts = |pct: u32| Options { strength: pct as f32 / 100.0, keep_plain_speech: cfg.keep_plain_speech };
    let mut live = Live::new(&sep, cfg.hop_s, opts(stats.strength.load(Ordering::Relaxed)));
    let model_rate = sep.mdx.cfg.sample_rate;
    report.model_rate = model_rate;
    report.latency = live.latency();
    // a model run is a few hundred ms of work: the output starts after a margin that covers a slow
    // run, so that it doesn't run dry between hops
    const MARGIN_S: f64 = 0.4;
    let margin = (out_rate as f64 * MARGIN_S) as usize;
    stats.latency_ms.store(((live.latency() as f64 / model_rate as f64 + MARGIN_S + 0.3) * 1000.0) as u32, Ordering::Relaxed);
    let mut from_model = StreamResampler::new(model_rate, out_rate)?;

    // capture starts only now: audio heard while the model loaded would only add delay
    let cap = start_capture(cfg.mute_original)?;
    let mut cap_rate = cap.sample_rate;
    stats.capture_rate.store(cap_rate, Ordering::Relaxed);
    let mut to_model = StreamResampler::new(cap_rate, model_rate)?;
    stats.set_state(LiveState::Running);
    let started = Instant::now();

    let (mut in_buf, mut l, mut r) = (vec![0f32; 4800 * 2], Vec::new(), Vec::new());
    let (mut ml, mut mr_, mut pl, mut pr, mut ol, mut or) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut began, mut last_slow) = (false, Instant::now());
    let (mut last_rate_check, mut worst_ms, mut last_strength) = (Instant::now(), 0u32, stats.strength.load(Ordering::Relaxed));
    let mut inter: Vec<f32> = Vec::new();
    while !stop.load(Ordering::Relaxed) && cfg.max_seconds.map(|m| started.elapsed().as_secs_f64() < m).unwrap_or(true) {
        if last_rate_check.elapsed() >= Duration::from_millis(300) {
            last_rate_check = Instant::now();
            // a player may switch the output device to the rate of its file (44.1 ↔ 48 kHz): follow it
            let now = cap.current_rate();
            if now != cap_rate {
                eprintln!("the capture rate changed: {cap_rate} → {now} Hz");
                cap_rate = now;
                stats.capture_rate.store(now, Ordering::Relaxed);
                to_model = StreamResampler::new(cap_rate, model_rate)?;
            }
            let pct = stats.strength.load(Ordering::Relaxed);
            if pct != last_strength {
                last_strength = pct;
                live.set_options(opts(pct));
            }
            stats.out_ring_ms.store((out_ring.len() as f64 / (out_rate as f64 * 2.0) * 1000.0) as u32, Ordering::Relaxed);
            if cfg.playback {
                stats.underruns.store(out_ring.underruns.load(Ordering::Relaxed), Ordering::Relaxed);
            }
            stats.overruns.store(cap.ring.overruns.load(Ordering::Relaxed), Ordering::Relaxed);
            stats.skipped_hops.store(live.skipped, Ordering::Relaxed);
        }
        if last_slow.elapsed() >= Duration::from_secs(5) {
            // the slowest-run figure covers the last few seconds only
            last_slow = Instant::now();
            worst_ms = 0;
        }
        let n = cap.ring.pop(&mut in_buf) / 2;
        if n == 0 {
            std::thread::sleep(Duration::from_millis(4));
            continue;
        }
        l.clear();
        r.clear();
        let mut peak = 0f32;
        for f in in_buf[..n * 2].chunks_exact(2) {
            l.push(f[0]);
            r.push(f[1]);
            peak = peak.max(f[0].abs()).max(f[1].abs());
        }
        stats.input_peak_milli.fetch_max((peak * 1000.0) as u32, Ordering::Relaxed);
        ml.clear();
        mr_.clear();
        to_model.process(&l, &r, &mut ml, &mut mr_)?;
        if cfg.record_input {
            report.input.0.extend_from_slice(&ml);
            report.input.1.extend_from_slice(&mr_);
        }
        pl.clear();
        pr.clear();
        let t = Instant::now();
        live.push(&mut sep, &ml, &mr_, &mut pl, &mut pr)?;
        if pl.is_empty() {
            continue;
        }
        let ms = (t.elapsed().as_secs_f64() * 1000.0) as u32;
        worst_ms = worst_ms.max(ms);
        stats.worst_run_ms.store(worst_ms, Ordering::Relaxed);
        stats.runs.fetch_add(1, Ordering::Relaxed);
        if cfg.record_output {
            report.output.0.extend_from_slice(&pl);
            report.output.1.extend_from_slice(&pr);
        }
        ol.clear();
        or.clear();
        from_model.process(&pl, &pr, &mut ol, &mut or)?;
        if cfg.playback {
            if !began {
                out_ring.push(&vec![0f32; margin * 2]);
            }
            inter.clear();
            inter.extend(ol.iter().zip(&or).flat_map(|(a, b)| [*a, *b]));
            out_ring.push(&inter);
        }
        if !began {
            began = true;
            armed.store(true, Ordering::Relaxed);
        }
    }
    // dropping `cap` releases the tap: the system's own output is heard as before
    Ok(())
}
