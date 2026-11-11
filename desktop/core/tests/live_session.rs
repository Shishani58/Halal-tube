//! A live session against the real Core Audio and the real model, with a synthetic tone as the
//! "music" (a plain tone is music to the model). Not part of the normal run: it needs the System
//! Audio Recording permission, and while the session runs the system's own output is silenced
//! (the tone is not heard), so a few seconds of the Mac's sound go missing.
//!
//!     cargo test -p mr-core --release --test live_session -- --ignored --nocapture
#![cfg(target_os = "macos")]

use mr_core::live_session::{self, LiveConfig, LiveState};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt()
}

#[test]
#[ignore = "needs the System Audio Recording permission; silences the system's output while it runs"]
fn a_session_removes_a_tone_survives_a_restart_and_follows_the_strength() {
    let model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE);
    if !model.exists() {
        eprintln!("skip: model not found");
        return;
    }
    let dir = std::env::temp_dir().join(format!("mr-live-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let tone = dir.join("tone.wav");
    let ok = Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=14", "-ar", "44100", "-ac", "2"])
        .arg(&tone)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("skip: ffmpeg not found");
        return;
    }

    let mut cfg = LiveConfig::new(model, Some(dir.join("cache")));
    cfg.playback = false; // nothing is played; the system's own output is silenced by the tap
    cfg.record_output = true;
    cfg.record_input = true;
    cfg.keep_plain_speech = false;
    let handle = live_session::start(cfg);
    let t = Instant::now();
    while handle.stats.state() != LiveState::Running {
        assert!(handle.stats.state() != LiveState::Error, "session failed: {:?}", handle.stats.error.lock().unwrap());
        assert!(t.elapsed() < Duration::from_secs(60), "never got running");
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut player = Command::new("afplay").arg(&tone).spawn().expect("afplay");
    std::thread::sleep(Duration::from_secs(3));
    // what a change of the default output device does: the output stream and the tap are made again
    handle.restart_audio();
    std::thread::sleep(Duration::from_secs(4));
    assert_eq!(handle.stats.restarts.load(Ordering::Relaxed), 1, "the audio should have been reopened once");
    assert_eq!(handle.stats.state(), LiveState::Running);
    handle.set_strength(0); // from now on the original is heard in full
    std::thread::sleep(Duration::from_secs(7));
    let _ = player.wait();
    let runs = handle.stats.runs.load(Ordering::Relaxed);
    let report = handle.stop();
    let rate = report.model_rate as usize;
    eprintln!("model runs {runs}, output {:.1} s", report.output.0.len() as f64 / rate as f64);
    assert!(runs >= 10, "runs {runs}");

    // the tone started about 1 s into the session's running state and lasted 14 s; the output lags by
    // the latency. Compare the same stretches of the input and the output: strength 100 % (first
    // half) removes the tone, strength 0 % (second half) passes it.
    let level = |x: &[f32], from: f64, to: f64| rms(&x[(from * rate as f64) as usize..(to * rate as f64) as usize]);
    let (inp, out) = (&report.input.0, &report.output.0);
    let first = (level(out, 4.5, 6.0), level(inp, 4.5, 6.0));
    let second = (level(out, 9.5, 11.5), level(inp, 9.5, 11.5));
    eprintln!("100 %: output {:.4} vs input {:.4} · 0 %: output {:.4} vs input {:.4}", first.0, first.1, second.0, second.1);
    assert!(first.1 > 0.05, "the tone should have been captured: {}", first.1);
    assert!(first.0 < first.1 * 0.1, "the tone should be removed at 100 %");
    assert!(second.0 > second.1 * 0.5, "the tone should pass at 0 %");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_unknown_output_device_is_an_error_not_a_silent_fallback() {
    let model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE);
    let mut cfg = LiveConfig::new(model, None);
    cfg.output_device = Some("No Such Device 123".into());
    let handle = live_session::start(cfg);
    let t = Instant::now();
    while handle.stats.state() != LiveState::Error {
        assert!(t.elapsed() < Duration::from_secs(10), "should fail at once");
        std::thread::sleep(Duration::from_millis(50));
    }
    let (_, msg) = handle.stats.error.lock().unwrap().clone().expect("an error message");
    assert!(msg.contains("No Such Device 123"), "{msg}");
}

#[test]
#[ignore = "needs the System Audio Recording permission; silences the system's output while it runs"]
fn playing_to_a_device_chosen_by_name_works() {
    let model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE);
    if !model.exists() {
        return;
    }
    let devices = live_session::list_output_devices();
    let Some(device) = devices.iter().find(|d| d.is_default).or(devices.first()) else { return };
    eprintln!("devices: {devices:?}");
    let dir = std::env::temp_dir().join(format!("mr-live-dev-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let tone = dir.join("tone.wav");
    if !Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=8", "-ar", "44100", "-ac", "2"]).arg(&tone).status().map(|s| s.success()).unwrap_or(false) {
        return;
    }
    let mut cfg = LiveConfig::new(model, Some(dir.join("cache")));
    cfg.output_device = Some(device.name.clone());
    cfg.playback = false;
    cfg.record_output = true;
    cfg.record_input = true;
    cfg.keep_plain_speech = false;
    let handle = live_session::start(cfg);
    let t = Instant::now();
    while handle.stats.state() != LiveState::Running {
        assert!(handle.stats.state() != LiveState::Error, "failed: {:?}", handle.stats.error.lock().unwrap());
        assert!(t.elapsed() < Duration::from_secs(60));
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut player = Command::new("afplay").arg(&tone).spawn().unwrap();
    std::thread::sleep(Duration::from_secs(8));
    let _ = player.wait();
    let report = handle.stop();
    let rate = report.model_rate as usize;
    let (a, b) = (3 * rate, 6 * rate);
    let (out, inp) = (rms(&report.output.0[a..b]), rms(&report.input.0[a..b]));
    eprintln!("named device {:?}: output {out:.4} vs input {inp:.4}", device.name);
    assert!(inp > 0.05 && out < inp * 0.1, "the tone should be captured and removed");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Plays for real (strength 100 on a tone: the output is near-silent) and reports the latency and whether the output ran dry.
#[test]
#[ignore = "needs the System Audio Recording permission; plays (near-silence) to the default output"]
fn the_output_does_not_run_dry_at_the_default_hop() {
    let model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE);
    let dir = std::env::temp_dir().join(format!("mr-live-dry-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let tone = dir.join("tone.wav");
    assert!(Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=40", "-ar", "44100", "-ac", "2"])
        .arg(&tone)
        .status()
        .unwrap()
        .success());
    let cfg = LiveConfig::new(model, Some(dir.join("cache")));
    let handle = live_session::start(cfg);
    let t = Instant::now();
    while handle.stats.state() != LiveState::Running {
        assert!(handle.stats.state() != LiveState::Error, "session failed: {:?}", handle.stats.error.lock().unwrap());
        assert!(t.elapsed() < Duration::from_secs(60));
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut player = Command::new("afplay").arg(&tone).spawn().expect("afplay");
    let mut series = Vec::new();
    for _ in 0..35 {
        std::thread::sleep(Duration::from_secs(1));
        series.push((handle.stats.out_ring_seconds() * 1000.0) as u32);
    }
    eprintln!("out ring ms each second: {series:?}");
    let _ = player.kill();
    let s = &handle.stats;
    eprintln!(
        "latency {:.2} s · underruns {} · overruns {} · runs {} · worst run {} ms · out ring {} ms · backend {}",
        s.latency_seconds(),
        s.underruns.load(Ordering::Relaxed),
        s.overruns.load(Ordering::Relaxed),
        s.runs.load(Ordering::Relaxed),
        s.worst_run_ms(),
        (s.out_ring_seconds() * 1000.0) as u32,
        s.backend.lock().unwrap()
    );
    assert_eq!(s.underruns.load(Ordering::Relaxed), 0, "the output ran dry");
}
