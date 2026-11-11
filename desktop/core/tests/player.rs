//! The player's clock: the position follows real time with no lag behind the picture's clock, pause holds it,
//! a seek continues from the new time. Opens the real output device, so it is manual (`-- --ignored`);
//! the file is a quiet synthetic tone that the model removes (what comes out is silence, about -90 dBFS).

use mr_core::media::Tools;
use mr_core::player::{start, PlayerConfig, PlayerState};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

fn wait_for(what: &str, secs: f64, mut f: impl FnMut() -> bool) {
    let t = Instant::now();
    while t.elapsed().as_secs_f64() < secs {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {what}");
}

#[test]
#[ignore]
fn position_follows_real_time_and_seeks() {
    let tools = Tools::locate().expect("ffmpeg");
    let models = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models");
    let dir = std::env::temp_dir().join(format!("mr-player-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("tone.wav");
    let st = Command::new(&tools.ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=60:sample_rate=44100", "-af", "volume=0.05", "-c:a", "pcm_s16le"])
        .arg(&input)
        .status()
        .unwrap();
    assert!(st.success());

    let h = start(tools, PlayerConfig { model_path: models.join(mr_core::MODEL_FILE), cache_dir: None, input, output_device: None, strength: 100 });
    wait_for("playing", 30.0, || h.stats.state() == PlayerState::Playing);
    assert!((h.stats.duration() - 60.0).abs() < 0.5);

    // 1) the position advances at real time
    let (p0, t0) = (h.stats.position(), Instant::now());
    std::thread::sleep(Duration::from_secs(3));
    let advanced = h.stats.position() - p0;
    let real = t0.elapsed().as_secs_f64();
    assert!((advanced - real).abs() < 0.25, "position moved {advanced:.2} s in {real:.2} s");
    // 2) the cleaned sound is ready well ahead
    let ahead = h.stats.buffered();
    assert!(ahead > 5.0, "only {ahead:.1} s ready ahead");

    // 3) pause holds the position
    h.pause();
    wait_for("paused", 2.0, || h.stats.state() == PlayerState::Paused);
    std::thread::sleep(Duration::from_millis(300));
    let held = h.stats.position();
    std::thread::sleep(Duration::from_millis(700));
    assert!((h.stats.position() - held).abs() < 0.05, "moved while paused");

    // 4) a seek continues from the new time, after a short wait
    h.seek(40.0);
    h.play();
    let t = Instant::now();
    wait_for("playing after seek", 5.0, || h.stats.state() == PlayerState::Playing && h.stats.position() >= 40.0);
    println!("seek to sound: {:.2} s", t.elapsed().as_secs_f64());
    assert!(t.elapsed().as_secs_f64() < 3.0);
    let (p1, t1) = (h.stats.position(), Instant::now());
    std::thread::sleep(Duration::from_secs(2));
    let adv = h.stats.position() - p1;
    assert!((adv - t1.elapsed().as_secs_f64()).abs() < 0.25, "after the seek moved {adv:.2}");

    // 5) a strength change redoes the sound from here: the position doesn't jump
    let before = h.stats.position();
    h.set_strength(50);
    std::thread::sleep(Duration::from_millis(1500));
    let after = h.stats.position();
    assert!(after >= before && after - before < 3.0, "jumped {before:.2} → {after:.2}");

    // 6) to the end
    h.seek(58.5);
    wait_for("ended", 12.0, || h.stats.state() == PlayerState::Ended);
    h.stop();
    let _ = std::fs::remove_dir_all(&dir);
}
