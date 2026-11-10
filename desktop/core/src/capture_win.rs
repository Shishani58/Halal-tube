//! System audio capture on Windows: WASAPI loopback of a render device, through `cpal`.
//!
//! Loopback hears everything a render device plays, our own playback included, so the device
//! listened to must not be the one we play to (that would be a feedback loop). The usual way to
//! have it so: a virtual cable (VB-CABLE) as the system's output device, listened to here, and the
//! processed sound played to the real speakers. Windows can't silence the original, so without a
//! cable the original is heard together with the processed sound. (Process-exclusion loopback,
//! Windows 10 2004+ / 11, would remove the need for a cable; it is not implemented.)
//!
//! NOT TESTED: written on a Mac, compiled for Windows only.

use crate::ring::Ring;
use crate::Error;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::Arc;

pub struct Capture {
    _stream: cpal::Stream,
    /// The rate of the device (blocks arrive at it).
    pub sample_rate: u32,
    /// Interleaved stereo samples of what the device plays.
    pub ring: Arc<Ring>,
}

impl Capture {
    /// Starts listening to the render device called `source` (it must be given: listening to the
    /// device we play to would feed our own sound back). `mute_original` can't be honoured.
    pub fn start(_mute_original: bool, ring_seconds: f64, source: Option<&str>) -> Result<Capture, Error> {
        let name = source.ok_or_else(|| Error::Capture("choose the device to listen to (a virtual cable set as the system output), different from the one played to".into()))?;
        let host = cpal::default_host();
        let device = host
            .output_devices()
            .map_err(|e| Error::Capture(e.to_string()))?
            .find(|d| d.name().ok().as_deref() == Some(name))
            .ok_or_else(|| Error::Capture(format!("the device \"{name}\" was not found")))?;
        // for loopback cpal builds an input stream on a render device, in that device's output format
        let cfg = device.default_output_config().map_err(|e| Error::Capture(e.to_string()))?;
        if cfg.sample_format() != cpal::SampleFormat::F32 {
            return Err(Error::Capture(format!("the device's format {:?} is not 32-bit float", cfg.sample_format())));
        }
        let (rate, ch) = (cfg.sample_rate().0, cfg.channels() as usize);
        let ring = Arc::new(Ring::new((ring_seconds * rate as f64 * 2.0) as usize));
        let r = ring.clone();
        let stream = device
            .build_input_stream(
                &cfg.config(),
                move |data: &[f32], _| {
                    let mut block = [0f32; 1024];
                    let mut n = 0;
                    for f in data.chunks_exact(ch.max(1)) {
                        block[n] = f[0];
                        block[n + 1] = if ch > 1 { f[1] } else { f[0] };
                        n += 2;
                        if n == block.len() {
                            r.push(&block);
                            n = 0;
                        }
                    }
                    if n > 0 {
                        r.push(&block[..n]);
                    }
                },
                |e| eprintln!("loopback stream error: {e}"),
                None,
            )
            .map_err(|e| Error::Capture(format!("cannot listen to \"{name}\": {e}")))?;
        stream.play().map_err(|e| Error::Capture(e.to_string()))?;
        Ok(Capture { _stream: stream, sample_rate: rate, ring })
    }

    /// The rate blocks arrive at (a render device's mix format doesn't change under us).
    pub fn current_rate(&self) -> u32 {
        self.sample_rate
    }
}
