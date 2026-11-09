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
