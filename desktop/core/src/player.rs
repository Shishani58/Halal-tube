//! Watching a file with the music removed, in sync with the picture.
//!
//! A live stream can't be sped up: its voice always lags the picture by the model's window. A file can:
//! the music is removed **ahead** of what is playing (about 17× faster than real time), so the voice
//! comes out exactly when the picture is. The picture itself is shown by the window (a muted video
//! element) and follows the position this module reports; the sound is played here.
//!
//! ```text
//! ffmpeg (from the position) → tiles → model → resample → ring (≈10 s ahead) → the output device
//!                                                              ▲ position = samples the device has taken
//! ```
//! Seeking, or changing the strength, restarts the pipeline at the wanted time (a fresh ring, so nothing
//! old is heard). All audio work is on one thread, which owns the output stream.

use crate::job::{separate_stream, Options};
use crate::live_session::open_output;
use crate::mdx::{Mdx, KIM_VOCAL_2};
use crate::media::Tools;
use crate::model::{Model, SelfTest, Separator};
use crate::ring::Ring;
use crate::stream::StreamResampler;
use crate::Error;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// Seconds of cleaned sound kept ready ahead of the playing position.
pub const AHEAD_S: f64 = 10.0;
/// Seconds that must be ready before the sound starts (and after a stall), so it doesn't run dry at once.
const START_S: f64 = 0.6;

#[derive(Clone, Debug)]
pub struct PlayerConfig {
    pub model_path: PathBuf,
    pub cache_dir: Option<PathBuf>,
    pub input: PathBuf,
    pub output_device: Option<String>,
    /// Share of the clean voice, percent.
    pub strength: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlayerState {
    /// Opening the file, loading the model.
    Loading,
    /// Wants to play but the sound isn't ready yet (start, seek, a slow stretch).
    Buffering,
    Playing,
    Paused,
    /// The file played to its end.
    Ended,
    Error,
}

impl PlayerState {
    fn from(v: u8) -> Self {
        match v {
            0 => PlayerState::Loading,
            1 => PlayerState::Buffering,
            2 => PlayerState::Playing,
            3 => PlayerState::Paused,
            4 => PlayerState::Ended,
            _ => PlayerState::Error,
        }
    }
}

/// What the window reads: updated by the audio thread, read at any time.
#[derive(Default)]
pub struct PlayerStats {
    state: AtomicU8,
    /// The ring the output is taking from, the time its first sample is for, and its rate.
    clock: Mutex<Option<(Arc<Ring>, f64, u32)>>,
    duration_ms: AtomicU32,
    pub has_video: AtomicBool,
    pub backend: Mutex<String>,
    pub gpu_check_failed: AtomicBool,
    pub error: Mutex<Option<(String, String)>>,
}

impl PlayerStats {
    pub fn state(&self) -> PlayerState {
        PlayerState::from(self.state.load(Ordering::Relaxed))
    }
    fn set_state(&self, s: PlayerState) {
        let v = match s {
            PlayerState::Loading => 0,
            PlayerState::Buffering => 1,
            PlayerState::Playing => 2,
            PlayerState::Paused => 3,
            PlayerState::Ended => 4,
            PlayerState::Error => 5,
        };
        self.state.store(v, Ordering::Relaxed);
    }
    pub fn duration(&self) -> f64 {
        self.duration_ms.load(Ordering::Relaxed) as f64 / 1000.0
    }
    /// The time in the file that is being heard now, seconds.
    pub fn position(&self) -> f64 {
        match self.clock.lock().unwrap().as_ref() {
            Some((ring, start, rate)) => start + ring.popped() as f64 / 2.0 / *rate as f64,
            None => 0.0,
        }
    }
    /// Seconds of cleaned sound ready ahead of the position.
    pub fn buffered(&self) -> f64 {
        match self.clock.lock().unwrap().as_ref() {
            Some((ring, _, rate)) => ring.len() as f64 / 2.0 / *rate as f64,
            None => 0.0,
        }
    }
    fn fail(&self, code: &str, msg: String) {
        *self.error.lock().unwrap() = Some((code.to_string(), msg));
        self.set_state(PlayerState::Error);
    }
}

#[derive(Default)]
struct Control {
    want_play: AtomicBool,
    stop: AtomicBool,
    strength: AtomicU32,
    /// A seek (or a restart at the same time) waiting to be picked up: the time to continue from.
    seek: Mutex<Option<f64>>,
    /// Set with `seek`/`stop`: tells the separation loop to give up its tile.
    abort: AtomicBool,
}

pub struct PlayerHandle {
    pub stats: Arc<PlayerStats>,
    ctl: Arc<Control>,
    join: Option<JoinHandle<()>>,
}

impl PlayerHandle {
    pub fn play(&self) {
        self.ctl.want_play.store(true, Ordering::Relaxed);
    }
    pub fn pause(&self) {
        self.ctl.want_play.store(false, Ordering::Relaxed);
    }
    /// Continues from `seconds` into the file.
    pub fn seek(&self, seconds: f64) {
        *self.ctl.seek.lock().unwrap() = Some(seconds.max(0.0));
        self.ctl.abort.store(true, Ordering::Relaxed);
    }
    /// A new strength is heard from the current position on (the sound already prepared is redone).
    pub fn set_strength(&self, percent: u8) {
        let new = percent.min(100) as u32;
        if self.ctl.strength.swap(new, Ordering::Relaxed) != new {
            self.seek(self.stats.position());
        }
    }
    pub fn is_finished(&self) -> bool {
        self.join.as_ref().map(|j| j.is_finished()).unwrap_or(true)
    }
    pub fn stop(mut self) {
        self.shutdown();
    }
    fn shutdown(&mut self) {
        self.ctl.stop.store(true, Ordering::Relaxed);
        self.ctl.abort.store(true, Ordering::Relaxed);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for PlayerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Opens the file and starts preparing its sound; it plays when [`PlayerHandle::play`] is called.
pub fn start(tools: Tools, cfg: PlayerConfig) -> PlayerHandle {
    let stats = Arc::new(PlayerStats::default());
    let ctl = Arc::new(Control::default());
    ctl.strength.store(cfg.strength.min(100) as u32, Ordering::Relaxed);
    ctl.want_play.store(true, Ordering::Relaxed);
    let (s, c) = (stats.clone(), ctl.clone());
    let join = std::thread::Builder::new()
        .name("mr-player".into())
        .spawn(move || {
            if let Err(e) = run(&tools, &cfg, &s, &c) {
                if !matches!(e, Error::Cancelled) {
                    s.fail(e.code(), e.to_string());
                }
            }
        })
        .expect("thread");
    PlayerHandle { stats, ctl, join: Some(join) }
}

/// Kills the decoder when dropped, so a seek or a close never leaves ffmpeg running.
struct Decoder(Child);

impl Drop for Decoder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run(tools: &Tools, cfg: &PlayerConfig, stats: &Arc<PlayerStats>, ctl: &Arc<Control>) -> Result<(), Error> {
    stats.set_state(PlayerState::Loading);
    let info = tools.probe(&cfg.input)?;
    stats.duration_ms.store((info.duration * 1000.0) as u32, Ordering::Relaxed);
    stats.has_video.store(info.has_video, Ordering::Relaxed);

    let mdx = Mdx::new(KIM_VOCAL_2);
    let model = Model::load(&cfg.model_path, mdx.tensor_shape(), None, cfg.cache_dir.as_deref())?;
    *stats.backend.lock().unwrap() = model.backend.label().to_string();
    let mut sep = Separator::new(mdx, model);
    if let Ok(SelfTest::FellBack(why)) = sep.self_test(cfg.cache_dir.as_deref()) {
        eprintln!("the GPU computes wrong results ({why}): using the CPU");
        stats.gpu_check_failed.store(true, Ordering::Relaxed);
        *stats.backend.lock().unwrap() = sep.model.backend.label().to_string();
    }
    let model_rate = sep.mdx.cfg.sample_rate;

    let mut start = 0.0f64;
    loop {
        if ctl.stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        ctl.abort.store(false, Ordering::Relaxed);
        // a fresh output (and ring) per run: a seek must not leave old sound to be heard
        let out = open_output(cfg.output_device.as_deref())?;
        *stats.clock.lock().unwrap() = Some((out.ring.clone(), start, out.rate));
        let mut to_device = StreamResampler::new(model_rate, out.rate)?;
        let capacity = (out.rate as f64 * 2.0 * AHEAD_S) as usize;

        let mut dec = Decoder(
            tools
                .ffmpeg_cmd()
                .args(["-ss", &format!("{start:.3}")])
                .arg("-i")
                .arg(&cfg.input)
                .args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-f", "f32le", "-ac", "2", "-ar", &model_rate.to_string(), "pipe:1"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| Error::Ffmpeg(e.to_string()))?,
        );
        let mut src = dec.0.stdout.take().unwrap();

        // Called often while waiting: sound starts and stops with play / pause, and the state follows.
        let finished = std::cell::Cell::new(false); // the whole rest of the file is in the ring
        let tick = |out: &crate::live_session::Output| {
            let want = ctl.want_play.load(Ordering::Relaxed);
            let ready = out.ring.len() as f64 / 2.0 / out.rate as f64;
            let was_armed = out.armed.load(Ordering::Relaxed);
            // start once a little is ready; keep going until the ring is empty (then wait for START_S again)
            let armed = want && if was_armed { !out.ring.is_empty() || finished.get() } else { ready >= START_S || (finished.get() && !out.ring.is_empty()) };
            out.armed.store(armed, Ordering::Relaxed);
            stats.set_state(if !want {
                PlayerState::Paused
            } else if armed {
                PlayerState::Playing
            } else {
                PlayerState::Buffering
            });
        };
        let wait_ms = Duration::from_millis(8);

        let result = separate_stream(
            &mut sep,
            &mut src,
            &mut || Options { strength: ctl.strength.load(Ordering::Relaxed) as f32 / 100.0, keep_plain_speech: true },
            &ctl.abort,
            &mut |l, r| {
                let (mut ol, mut or) = (Vec::new(), Vec::new());
                to_device.process(l, r, &mut ol, &mut or)?;
                let inter: Vec<f32> = ol.iter().zip(&or).flat_map(|(a, b)| [*a, *b]).collect();
                // wait for room: the sound is kept only AHEAD_S ahead (so a change is heard soon)
                while out.ring.len() + inter.len() > capacity.min(out.ring.capacity()) {
                    if ctl.abort.load(Ordering::Relaxed) {
                        return Ok(false);
                    }
                    tick(&out);
                    std::thread::sleep(wait_ms);
                }
                out.ring.push(&inter);
                tick(&out);
                Ok(!ctl.abort.load(Ordering::Relaxed))
            },
        );
        match result {
            Ok(_) | Err(Error::Cancelled) => {}
            Err(e) => return Err(e),
        }
        drop(src);
        drop(dec);

        // Seek / strength change / stop asked for: go round again from there.
        if let Some(t) = ctl.seek.lock().unwrap().take() {
            start = t.min((info.duration - 0.2).max(0.0));
            continue;
        }
        if ctl.stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        // The file is all in the ring: play it out, then wait to be told what next.
        finished.set(true);
        let mut ended = false;
        loop {
            if ctl.stop.load(Ordering::Relaxed) || ctl.seek.lock().unwrap().is_some() {
                break;
            }
            if !ended {
                tick(&out);
                if out.ring.is_empty() {
                    out.armed.store(false, Ordering::Relaxed);
                    stats.set_state(PlayerState::Ended);
                    ctl.want_play.store(false, Ordering::Relaxed);
                    ended = true;
                }
            }
            std::thread::sleep(wait_ms * 4);
        }
        if let Some(t) = ctl.seek.lock().unwrap().take() {
            start = t.min((info.duration - 0.2).max(0.0));
            ctl.want_play.store(true, Ordering::Relaxed);
            continue;
        }
        return Ok(());
    }
}
