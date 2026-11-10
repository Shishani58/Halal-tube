//! End-to-end check of the file pipeline on a generated video.
//! Needs ffmpeg and models/Kim_Vocal_2.onnx; skips (passes) when either is missing.

use mr_core::job;
use mr_core::mdx::{Mdx, KIM_VOCAL_2};
use mr_core::media::Tools;
use mr_core::model::{Model, Separator};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::AtomicBool;

fn md5_of_video(tools: &Tools, file: &PathBuf) -> String {
    let out = Command::new(&tools.ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(file)
        .args(["-map", "0:v", "-c", "copy", "-f", "md5", "-"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn video_is_copied_and_audio_replaced() {
    let Ok(tools) = Tools::locate() else {
        eprintln!("skip: ffmpeg not found");
        return;
    };
    let model_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE);
    if !model_path.exists() {
        eprintln!("skip: model not found");
        return;
    }
    let dir = std::env::temp_dir().join(format!("mr-pipeline-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("in.mp4");
    let st = Command::new(&tools.ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=25", "-f", "lavfi"])
        .args(["-i", "sine=f=440:d=13", "-t", "13", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
        .arg(&input)
        .status()
        .unwrap();
    assert!(st.success());

    let mdx = Mdx::new(KIM_VOCAL_2);
    let model = Model::load(&model_path, mdx.tensor_shape(), None, None).expect("model");
    let mut sep = Separator::new(mdx, model);
    let prepared = job::prepare(&tools, &input, None, "no music").unwrap();
    assert_eq!(prepared.output, dir.join("in (no music).mp4"));

    let mut last = 0.0;
    let out = job::run(&tools, &mut sep, &prepared, &AtomicBool::new(false), |p| {
        assert!(p >= last, "progress went backwards");
        last = p;
    })
    .unwrap();
    assert_eq!(last, 1.0);
    assert_eq!(md5_of_video(&tools, &input), md5_of_video(&tools, &out));
    let info = tools.probe(&out).unwrap();
    assert!((info.duration - 13.0).abs() < 0.1, "duration {}", info.duration);

    // cancelling removes the partial file and leaves no output
    let prepared = job::prepare(&tools, &input, None, "cancelled").unwrap();
    let err = job::run(&tools, &mut sep, &prepared, &AtomicBool::new(true), |_| {}).unwrap_err();
    assert!(matches!(err, mr_core::Error::Cancelled));
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.contains("cancelled"))
        .collect();
    assert!(leftovers.is_empty(), "leftover files: {leftovers:?}");

    let _ = std::fs::remove_dir_all(&dir);
}

/// Mean volume (dB) of the first audio stream, by ffmpeg's volumedetect.
fn mean_volume(tools: &Tools, file: &PathBuf) -> f64 {
    let out = Command::new(&tools.ffmpeg)
        .args(["-v", "info", "-i"])
        .arg(file)
        .args(["-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"])
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stderr);
    text.lines()
        .find_map(|l| l.split("mean_volume:").nth(1))
        .and_then(|v| v.trim().trim_end_matches(" dB").parse().ok())
        .unwrap_or(-91.0)
}

#[test]
fn strength_brings_the_original_back() {
    let Ok(tools) = Tools::locate() else { return };
    let model_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE);
    if !model_path.exists() {
        return;
    }
    let dir = std::env::temp_dir().join(format!("mr-strength-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("tone.m4a");
    // a plain tone is "music" to the model: removed at 100 %, kept at 0 %
    let st = Command::new(&tools.ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=8", "-c:a", "aac"])
        .arg(&input)
        .status()
        .unwrap();
    assert!(st.success());
    let mdx = Mdx::new(KIM_VOCAL_2);
    let model = Model::load(&model_path, mdx.tensor_shape(), None, None).expect("model");
    let mut sep = Separator::new(mdx, model);
    let cancel = AtomicBool::new(false);
    let mut level = |strength: f32, suffix: &str| {
        let prepared = job::prepare(&tools, &input, None, suffix).unwrap();
        let opts = job::Options { strength, keep_plain_speech: true };
        let out = job::run_with(&tools, &mut sep, &prepared, &opts, &cancel, |_| {}).unwrap();
        mean_volume(&tools, &out)
    };
    let orig = mean_volume(&tools, &input);
    let removed = level(1.0, "full");
    let half = level(0.5, "half");
    let none = level(0.0, "none");
    eprintln!("original {orig:.1} dB · strength 100 %: {removed:.1} dB · 50 %: {half:.1} dB · 0 %: {none:.1} dB");
    assert!((none - orig).abs() < 1.5, "0 % should be the original: {none} vs {orig}");
    assert!(removed < orig - 15.0, "100 % should remove the tone: {removed} vs {orig}");
    assert!(half > removed + 3.0 && half < orig - 3.0, "50 % lies between: {half}");
    let _ = std::fs::remove_dir_all(&dir);
}
