//! "Hide on screen" on macOS: watches the main display and blurs women and nudity wherever they show up, in any
//! window (a browser, a player), by laying blurred patches over them.
//!
//! ```text
//! ScreenCaptureKit (the display without our own windows, ~5 frames/s)
//!   → whole frame + four overlapping tiles → NudeNet + gender → LiveBlur (the rules of the file timeline)
//!   → overlay window with a behind-window blur per region (mac/screen.m)
//! ```
//! Needs the "Screen Recording" permission. Nothing is recorded or sent anywhere.

use crate::blur::detect::{Detection, Detector};
use crate::blur::live::{merge, LiveBlur};
use crate::blur::Rect;
use crate::Error;
use std::ffi::{c_char, c_void};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

type FrameCb = extern "C" fn(*const u8, u32, u32, u32, *mut c_void);

extern "C" {
    fn mr_screen_access() -> i32;
    fn mr_screen_request() -> i32;
    fn mr_screen_start(cb: FrameCb, ctx: *mut c_void, max_width: u32, interval_s: f64, err: *mut c_char, err_len: usize) -> *mut c_void;
    fn mr_screen_stop(s: *mut c_void);
    fn mr_overlay_set(rects: *const f32, n: i32);
}

/// Width of the analysed frame: wide enough that a face in a video window is still more than a few pixels.
const FRAME_WIDTH: u32 = 1600;
/// Seconds between analyses (the capture delivers at this rate; slower machines just fall behind).
pub const STEP_S: f32 = 0.2;

/// Puts blurred patches on the screen (fractions of the main display); an empty slice removes them. For checking how the
/// overlay looks (`music-remover --overlay-demo`).
pub fn show_regions(rects: &[Rect]) {
    let flat: Vec<f32> = rects.iter().flat_map(|r| [r.x, r.y, r.w, r.h]).collect();
    unsafe { mr_overlay_set(flat.as_ptr(), rects.len() as i32) };
}

pub fn has_access() -> bool {
    unsafe { mr_screen_access() == 1 }
}

/// Shows the system's permission prompt (once); true when access is granted right now.
pub fn request_access() -> bool {
    unsafe { mr_screen_request() == 1 }
}

#[derive(Clone, Debug)]
pub struct ScreenConfig {
    pub nudenet: PathBuf,
    pub gender: PathBuf,
    pub cache_dir: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenState {
    Starting = 0,
    Loading = 1,
    Running = 2,
    Stopped = 3,
    Error = 4,
}

#[derive(Default)]
pub struct ScreenStats {
    state: AtomicU8,
    pub error: Mutex<Option<(String, String)>>,
    pub backend: Mutex<String>,
    /// Patches on the screen now.
    pub regions: AtomicU32,
    /// Frames analysed so far.
    pub analysed: AtomicU32,
    /// The last analysis, milliseconds.
    pub last_ms: AtomicU32,
}

impl ScreenStats {
    pub fn state(&self) -> ScreenState {
        match self.state.load(Ordering::Relaxed) {
            0 => ScreenState::Starting,
            1 => ScreenState::Loading,
            2 => ScreenState::Running,
            3 => ScreenState::Stopped,
            _ => ScreenState::Error,
        }
    }
    fn set(&self, s: ScreenState) {
        self.state.store(s as u8, Ordering::Relaxed);
    }
    fn fail(&self, code: &str, message: String) {
        *self.error.lock().unwrap() = Some((code.to_string(), message));
        self.set(ScreenState::Error);
    }
}

pub struct ScreenHandle {
    pub stats: Arc<ScreenStats>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl ScreenHandle {
    pub fn is_finished(&self) -> bool {
        self.join.as_ref().map(|j| j.is_finished()).unwrap_or(true)
    }
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for ScreenHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub fn start(cfg: ScreenConfig) -> ScreenHandle {
    let stats = Arc::new(ScreenStats::default());
    let stop = Arc::new(AtomicBool::new(false));
    let (s, st) = (stats.clone(), stop.clone());
    let join = std::thread::Builder::new()
        .name("mr-screen".into())
        .spawn(move || {
            if let Err(e) = run(&cfg, &s, &st) {
                match &e {
                    Error::Capture(m) if m == "screen_permission" => s.fail("screen_permission", "no access to the screen".into()),
                    Error::Capture(m) => s.fail("capture", m.clone()),
                    other => s.fail(other.code(), other.to_string()),
                }
            }
            unsafe { mr_overlay_set(std::ptr::null(), 0) };
        })
        .expect("thread");
    ScreenHandle { stats, stop, join: Some(join) }
}

/// The newest captured frame, as packed RGB.
struct Frame {
    rgb: Vec<u8>,
    w: usize,
    h: usize,
    seq: u64,
}

struct Shared {
    latest: Mutex<Option<Frame>>,
    seq: Mutex<u64>,
}

extern "C" fn on_frame(bgra: *const u8, w: u32, h: u32, stride: u32, ctx: *mut c_void) {
    // SAFETY: ctx is the Shared leaked by `run`, alive until the capture is stopped
    let shared = unsafe { &*(ctx as *const Shared) };
    let (w, h, stride) = (w as usize, h as usize, stride as usize);
    let src = unsafe { std::slice::from_raw_parts(bgra, stride * h) };
    let mut rgb = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for px in src[y * stride..y * stride + w * 4].chunks_exact(4) {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
    }
    let mut seq = shared.seq.lock().unwrap();
    *seq += 1;
    *shared.latest.lock().unwrap() = Some(Frame { rgb, w, h, seq: *seq });
}

fn run(cfg: &ScreenConfig, stats: &Arc<ScreenStats>, stop: &AtomicBool) -> Result<(), Error> {
    stats.set(ScreenState::Starting);
    if !has_access() {
        request_access();
        if !has_access() {
            return Err(Error::Capture("screen_permission".into()));
        }
    }
    stats.set(ScreenState::Loading);
    let mut detector = Detector::load(&cfg.nudenet, &cfg.gender, cfg.cache_dir.as_deref())?;
    *stats.backend.lock().unwrap() = detector.backend.label().to_string();

    let shared = Arc::new(Shared { latest: Mutex::new(None), seq: Mutex::new(0) });
    let ctx = Arc::into_raw(shared.clone()) as *mut c_void;
    let mut err = [0 as c_char; 512];
    let cap = unsafe { mr_screen_start(on_frame, ctx, FRAME_WIDTH, STEP_S as f64, err.as_mut_ptr(), err.len()) };
    if cap.is_null() {
        // SAFETY: balances into_raw above
        unsafe { drop(Arc::from_raw(ctx as *const Shared)) };
        let msg = unsafe { std::ffi::CStr::from_ptr(err.as_ptr()) }.to_string_lossy().to_string();
        return Err(Error::Capture(msg));
    }
    stats.set(ScreenState::Running);

    let log = std::env::var_os("MR_SCREEN_LOG").is_some(); // what was found, to stderr, for checking
    let mut rules = LiveBlur::new(STEP_S);
    let mut last_det = Detection::default();
    let mut last_thumb: Vec<u8> = Vec::new();
    let mut last_seq = 0u64;
    let mut since_analysis = 0u32;
    let mut shown: Vec<Rect> = Vec::new();
    let mut next = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        next += Duration::from_millis((STEP_S * 1000.0) as u64);
        let frame = shared.latest.lock().unwrap().take();
        if let Some(f) = frame.filter(|f| f.seq != last_seq) {
            last_seq = f.seq;
            let thumb = thumbnail(&f.rgb, f.w, f.h);
            // a still screen is not looked at again, except now and then (a face may have been missed)
            let changed = last_thumb.is_empty() || mean_diff(&thumb, &last_thumb) > 0.6;
            since_analysis += 1;
            if changed || since_analysis >= 10 {
                let t = Instant::now();
                match analyse(&mut detector, &f) {
                    Ok(d) => last_det = d,
                    Err(e) => eprintln!("screen analysis failed: {e}"),
                }
                stats.last_ms.store(t.elapsed().as_millis() as u32, Ordering::Relaxed);
                if log {
                    eprintln!(
                        "screen: {} ms · nude {} · skin {} · faces {:?}",
                        t.elapsed().as_millis(),
                        last_det.nude.len(),
                        last_det.skin.len(),
                        last_det.faces.iter().map(|f| (format!("{:.2}", f.score), format!("{:.2}", f.female))).collect::<Vec<_>>()
                    );
                }
                stats.analysed.fetch_add(1, Ordering::Relaxed);
                since_analysis = 0;
            }
            last_thumb = thumb;
        }
        let rects = rules.push(last_det.clone());
        if rects != shown {
            let flat: Vec<f32> = rects.iter().flat_map(|r| [r.x, r.y, r.w, r.h]).collect();
            unsafe { mr_overlay_set(flat.as_ptr(), rects.len() as i32) };
            stats.regions.store(rects.len() as u32, Ordering::Relaxed);
            shown = rects;
        }
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now; // behind: don't try to catch up
        }
    }
    unsafe {
        mr_overlay_set(std::ptr::null(), 0);
        mr_screen_stop(cap);
        // SAFETY: the capture is stopped, no callback is running any more
        drop(Arc::from_raw(ctx as *const Shared));
    }
    stats.set(ScreenState::Stopped);
    Ok(())
}

/// The whole frame plus four overlapping tiles: a face in a video window is a few dozen pixels on a screen, and the
/// detector sees 320 px, so the tiles give it twice the detail.
fn analyse(detector: &mut Detector, f: &Frame) -> Result<Detection, Error> {
    let mut parts = vec![(detector.analyze(&f.rgb, f.w, f.h)?, Rect::new(0.0, 0.0, 1.0, 1.0))];
    const T: f32 = 0.55;
    for (ox, oy) in [(0.0, 0.0), (1.0 - T, 0.0), (0.0, 1.0 - T), (1.0 - T, 1.0 - T)] {
        let (x0, y0) = ((ox * f.w as f32) as usize, (oy * f.h as f32) as usize);
        let (tw, th) = ((T * f.w as f32) as usize, (T * f.h as f32) as usize);
        let mut crop = Vec::with_capacity(tw * th * 3);
        for y in y0..y0 + th {
            let row = (y * f.w + x0) * 3;
            crop.extend_from_slice(&f.rgb[row..row + tw * 3]);
        }
        parts.push((detector.analyze(&crop, tw, th)?, Rect::new(ox, oy, T, T)));
    }
    Ok(merge(parts))
}

const THUMB_W: usize = 64;
const THUMB_H: usize = 36;

/// A 64×36 grey thumbnail (sparse box average), to tell whether the screen changed.
fn thumbnail(rgb: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; THUMB_W * THUMB_H];
    for ty in 0..THUMB_H {
        for tx in 0..THUMB_W {
            let (x0, x1) = (tx * w / THUMB_W, ((tx + 1) * w / THUMB_W).max(tx * w / THUMB_W + 1));
            let (y0, y1) = (ty * h / THUMB_H, ((ty + 1) * h / THUMB_H).max(ty * h / THUMB_H + 1));
            let (mut sum, mut n) = (0u32, 0u32);
            for sy in 0..4 {
                for sx in 0..4 {
                    let (x, y) = (x0 + (x1 - x0) * sx / 4, y0 + (y1 - y0) * sy / 4);
                    let i = (y.min(h - 1) * w + x.min(w - 1)) * 3;
                    sum += (rgb[i] as u32 * 3 + rgb[i + 1] as u32 * 6 + rgb[i + 2] as u32) / 10;
                    n += 1;
                }
            }
            out[ty * THUMB_W + tx] = (sum / n) as u8;
        }
    }
    out
}

fn mean_diff(a: &[u8], b: &[u8]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs() as f32).sum::<f32>() / a.len().max(1) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_still_screen_does_not_look_changed_a_moving_one_does() {
        let (w, h) = (320, 180);
        let a = vec![100u8; w * h * 3];
        let mut b = a.clone();
        assert!(mean_diff(&thumbnail(&a, w, h), &thumbnail(&b, w, h)) < 0.01);
        for y in 40..140 {
            for x in 60..260 {
                let i = (y * w + x) * 3;
                b[i] = 220;
                b[i + 1] = 30;
            }
        }
        assert!(mean_diff(&thumbnail(&a, w, h), &thumbnail(&b, w, h)) > 0.6);
    }
}
