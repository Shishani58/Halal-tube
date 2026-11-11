//! Before/after clips: the same stretch is cut out of two files, in any container. Needs ffmpeg; skips without it.
//! Synthetic tones only, nothing is played.

use mr_core::media::Tools;
use mr_core::preview;
use std::process::Command;

#[test]
fn clips_have_the_requested_window() {
    let Ok(tools) = Tools::locate() else {
        eprintln!("skip: ffmpeg not found");
        return;
    };
    let dir = std::env::temp_dir().join(format!("mr-preview-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // a 70 s file in a container a browser can't play (MKV with FLAC), to prove the WAV conversion
    let src = dir.join("long.mkv");
    let st = Command::new(&tools.ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=70:sample_rate=48000", "-c:a", "flac"])
        .arg(&src)
        .status()
        .unwrap();
    assert!(st.success());

    let (start, len) = preview::window(70.0, 0.5);
    assert_eq!((start, len), (35.0, 30.0));
    let wav = dir.join("clip.wav");
    preview::cut_clip(&tools, &src, start, len, &wav).unwrap();

    let info = tools.probe(&wav).unwrap();
    assert!((info.duration - 30.0).abs() < 0.05, "duration {}", info.duration);
    let a = info.audio;
    assert_eq!((a.sample_rate, a.channels), (44100, 2));

    assert!(preview::cut_clip(&tools, &dir.join("missing.mp4"), 0.0, 5.0, &wav).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
