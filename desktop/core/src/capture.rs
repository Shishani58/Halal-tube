//! System audio capture on macOS 14.2+ (Core Audio process tap), see `mac/tap.m`.
//!
//! Captures everything the system plays except this process, optionally silencing the system's own
//! output of it (so that what is heard is only what this process plays: the processed sound).
//! First use asks the user for the "System Audio Recording" permission; without it the tap delivers
//! silence or fails to start.

use crate::ring::Ring;
use crate::Error;
use std::ffi::{c_char, c_void};
use std::sync::Arc;

type Callback = extern "C" fn(*const f32, u32, u32, *mut c_void);

extern "C" {
    fn mr_tap_start(cb: Callback, ctx: *mut c_void, mute_original: i32, sample_rate: *mut f64, channels: *mut u32, status: *mut i32, err: *mut c_char, err_len: usize) -> *mut c_void;
    fn mr_tap_rate(tap: *mut c_void) -> f64;
    fn mr_tap_stop(tap: *mut c_void);
}

/// What the audio callback needs: the ring it fills.
struct Ctx {
    ring: Arc<Ring>,
}

extern "C" fn on_audio(samples: *const f32, frames: u32, channels: u32, ctx: *mut c_void) {
    // SAFETY: ctx is the Ctx leaked by Capture::start, alive until Capture is dropped (after the tap is stopped)
    let ctx = unsafe { &*(ctx as *const Ctx) };
    let (frames, ch) = (frames as usize, channels.max(1) as usize);
    let data = unsafe { std::slice::from_raw_parts(samples, frames * ch) };
    // to interleaved stereo, in small stack blocks (no allocation on the audio thread)
    let mut block = [0f32; 1024];
    let mut n = 0;
    for f in data.chunks_exact(ch) {
        block[n] = f[0];
        block[n + 1] = if ch > 1 { f[1] } else { f[0] };
        n += 2;
        if n == block.len() {
            ctx.ring.push(&block);
            n = 0;
        }
    }
    if n > 0 {
        ctx.ring.push(&block[..n]);
    }
}

pub struct Capture {
    tap: *mut c_void,
    ctx: *mut Ctx,
    /// The rate of the captured stream (the output device's, usually 48000).
    pub sample_rate: u32,
    /// Interleaved stereo samples of what the system plays.
    pub ring: Arc<Ring>,
}

// the raw pointers are only touched by start / drop
unsafe impl Send for Capture {}

impl Capture {
    /// Starts capturing. This process must already be an audio client (an output stream is open),
    /// or it can't be excluded from the tap: the error then says so and the caller may retry.
    /// `ring_seconds`: how much captured audio the ring holds.
    pub fn start(mute_original: bool, ring_seconds: f64) -> Result<Capture, Error> {
        // the rate isn't known before the tap exists: room for 192 kHz stereo
        let ring = Arc::new(Ring::new((ring_seconds * 192_000.0 * 2.0) as usize));
        let ctx = Box::into_raw(Box::new(Ctx { ring: ring.clone() }));
        let (mut rate, mut channels, mut status) = (0f64, 0u32, 0i32);
        let mut err = [0 as c_char; 256];
        let tap = unsafe { mr_tap_start(on_audio, ctx as *mut c_void, mute_original as i32, &mut rate, &mut channels, &mut status, err.as_mut_ptr(), err.len()) };
        if tap.is_null() {
            drop(unsafe { Box::from_raw(ctx) });
            let msg = unsafe { std::ffi::CStr::from_ptr(err.as_ptr()) }.to_string_lossy().to_string();
            return Err(Error::Capture(if status == 1 { format!("not_audio_client: {msg}") } else { msg }));
        }
        Ok(Capture { tap, ctx, sample_rate: rate.round() as u32, ring })
    }
}

impl Capture {
    /// The rate the blocks arrive at now. It follows the output device and changes when a player
    /// switches the device to the rate of its file; the caller then has to convert from the new rate
    /// (poll this a few times a second).
    pub fn current_rate(&self) -> u32 {
        let r = unsafe { mr_tap_rate(self.tap) };
        if r >= 8000.0 {
            r.round() as u32
        } else {
            self.sample_rate
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            mr_tap_stop(self.tap); // after this no more callbacks
            drop(Box::from_raw(self.ctx));
        }
    }
}
