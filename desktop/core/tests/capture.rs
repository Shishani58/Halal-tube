//! System audio capture against the real Core Audio. Needs the "System Audio Recording" permission
//! and plays a system sound, so it is not part of the normal run:
//!
//!     cargo test -p mr-core --release --test capture -- --ignored --nocapture
#![cfg(target_os = "macos")]

use mr_core::capture::Capture;
use std::process::Command;
use std::time::{Duration, Instant};

/// The tap needs this process to be an audio client first (so that it can be excluded): play silence.
fn become_audio_client() -> cpal::Stream {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let device = cpal::default_host().default_output_device().expect("an output device");
    let cfg = device.default_output_config().unwrap();
    let stream = device.build_output_stream(&cfg.config(), |d: &mut [f32], _| d.fill(0.0), |e| eprintln!("{e}"), None).unwrap();
    stream.play().unwrap();
    stream
}

fn rms_and_peak(cap: &Capture, secs: f64) -> (f64, f32) {
    let t = Instant::now();
    let (mut sum, mut peak, mut n) = (0f64, 0f32, 0u64);
    let mut buf = vec![0f32; 4096];
    while t.elapsed().as_secs_f64() < secs {
        let k = cap.ring.pop(&mut buf);
        for v in &buf[..k] {
            sum += (*v as f64).powi(2);
            peak = peak.max(v.abs());
        }
        n += k as u64;
        std::thread::sleep(Duration::from_millis(5));
    }
    ((sum / n.max(1) as f64).sqrt(), peak)
}

#[test]
#[ignore = "needs the System Audio Recording permission and plays a sound"]
fn the_tap_hears_what_the_system_plays_and_only_that() {
    let _client = become_audio_client();
    let cap = (0..30)
        .find_map(|_| match Capture::start(false, 4.0) {
            Ok(c) => Some(c),
            Err(_) => {
                std::thread::sleep(Duration::from_millis(100));
                None
            }
        })
        .expect("the tap should start (is the permission granted?)");
    assert!(cap.sample_rate >= 8000, "rate {}", cap.sample_rate);

    // nothing plays: digital silence
    let (quiet, quiet_peak) = rms_and_peak(&cap, 1.5);
    assert!(quiet_peak < 1e-4, "silence expected, peak {quiet_peak}");

    // a system sound plays: the tap hears it
    let mut player = Command::new("afplay").arg("/System/Library/Sounds/Glass.aiff").spawn().expect("afplay");
    let (loud, loud_peak) = rms_and_peak(&cap, 2.0);
    let _ = player.wait();
    eprintln!("silence rms {quiet:.6}, with a sound rms {loud:.5}, peak {loud_peak:.3}, rate {}", cap.sample_rate);
    assert!(loud_peak > 0.02, "the tap heard nothing: peak {loud_peak}");
}
