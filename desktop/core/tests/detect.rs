//! Detector on real photos. Manual: `MR_PHOTOS=/folder/with/jpgs cargo test -p mr-core --release --test detect -- --ignored --nocapture`
//! (prints what is found per photo; the photos are not in the repository).

use mr_core::blur::detect::Detector;
use mr_core::media::Tools;
use std::path::PathBuf;
use std::process::Command;

#[test]
#[ignore]
fn photos() {
    let tools = Tools::locate().expect("ffmpeg");
    let models = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models");
    let mut det = Detector::load(&models.join("nudenet-320n.onnx"), &models.join("genderage.onnx"), None).expect("models");
    println!("backend: {}", det.backend.label());
    let dir = PathBuf::from(std::env::var("MR_PHOTOS").unwrap_or_else(|_| "/tmp/mr/blur-src".into()));
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().map(|e| e == "jpg").unwrap_or(false)).collect();
    files.sort();
    for f in files {
        let probe = tools.probe(&f);
        let _ = probe; // images aren't "media" for the audio probe; get the size from ffmpeg itself
        let out = Command::new(&tools.ffmpeg)
            .args(["-v", "error", "-i"])
            .arg(&f)
            .args(["-vf", "scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
            .output()
            .unwrap();
        let info = Command::new(&tools.ffprobe).args(["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x"]).arg(&f).output().unwrap();
        let wh = String::from_utf8_lossy(&info.stdout);
        let (ow, oh): (f64, f64) = { let mut it = wh.trim().split('x').map(|v| v.parse::<f64>().unwrap()); (it.next().unwrap(), it.next().unwrap()) };
        let s = (640.0 / ow.max(oh)).min(1.0);
        let even = |v: f64| ((v * s).round() as usize + 1) / 2 * 2;
        let (w, h) = (even(ow), even(oh));
        assert_eq!(out.stdout.len(), w * h * 3, "{:?}", f);
        let t = std::time::Instant::now();
        let d = det.analyze(&out.stdout, w, h).unwrap();
        println!(
            "{:?} {}x{}: {:.0} ms | nude {:?} | skin {:?} | faces {:?}",
            f.file_name().unwrap(),
            w,
            h,
            t.elapsed().as_secs_f64() * 1000.0,
            d.nude.iter().map(|b| (b.1 * 100.0).round() / 100.0).collect::<Vec<_>>(),
            d.skin.iter().map(|b| (b.1 * 100.0).round() / 100.0).collect::<Vec<_>>(),
            d.faces.iter().map(|f| (f.score, f.female)).map(|(a, b)| ((a * 100.0).round() / 100.0, (b * 100.0).round() / 100.0)).collect::<Vec<_>>(),
        );
    }
}
