//! Blur pipeline end to end. Needs ffmpeg (with the VideoToolbox encoder: macOS); skips without it.
//! Synthetic video and tones only; nothing is played.

use mr_core::blur::job::{probe_video, render};
use mr_core::blur::timeline::Timeline;
use mr_core::blur::Rect;
use mr_core::media::Tools;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;

/// Mean absolute horizontal+vertical gradient of the luma in the pixel rect of the frame at `t` (detail measure).
fn detail(tools: &Tools, file: &Path, t: f64, rect: (usize, usize, usize, usize), size: (usize, usize)) -> f64 {
    let out = Command::new(&tools.ffmpeg)
        .args(["-v", "error", "-ss", &format!("{t}"), "-i"])
        .arg(file)
        .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
        .output()
        .unwrap();
    let (w, _h) = size;
    let px = out.stdout;
    let (x0, y0, x1, y1) = rect;
    let mut sum = 0.0;
    let mut n = 0.0;
    for y in y0..y1 - 1 {
        for x in x0..x1 - 1 {
            let p = |xx: usize, yy: usize| px[yy * w + xx] as f64;
            sum += (p(x + 1, y) - p(x, y)).abs() + (p(x, y + 1) - p(x, y)).abs();
            n += 1.0;
        }
    }
    sum / n
}

#[test]
fn regions_are_blurred_only_while_listed_and_audio_survives() {
    let Ok(tools) = Tools::locate() else {
        eprintln!("skip: ffmpeg not found");
        return;
    };
    let has_vt = Command::new(&tools.ffmpeg).args(["-hide_banner", "-encoders"]).output().map(|o| String::from_utf8_lossy(&o.stdout).contains("h264_videotoolbox")).unwrap_or(false);
    if !has_vt {
        eprintln!("skip: no h264_videotoolbox");
        return;
    }
    let dir: PathBuf = std::env::temp_dir().join(format!("mr-blur-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("in.mp4");
    let st = Command::new(&tools.ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=f=440:d=6", "-t", "6"])
        .args(["-c:v", "h264_videotoolbox", "-b:v", "4M", "-pix_fmt", "yuv420p", "-c:a", "aac"])
        .arg(&input)
        .status()
        .unwrap();
    assert!(st.success());

    let info = probe_video(&tools, &input).unwrap();
    assert_eq!((info.width, info.height), (320, 240));
    assert!((info.fps - 25.0).abs() < 0.01);

    // seconds 2–4 (samples 8..=16 at 0.25 s) have the middle of the picture blurred
    let mut rects = vec![Vec::new(); 25];
    for r in rects.iter_mut().take(17).skip(8) {
        r.push(Rect::new(0.25, 0.25, 0.5, 0.5));
    }
    let timeline = Timeline { step: 0.25, rects };
    let output = dir.join("out.mp4");
    let mut last = 0.0;
    render(&tools, &input, &output, &info, &timeline, &AtomicBool::new(false), |p| {
        assert!(p >= last);
        last = p;
    })
    .unwrap();
    assert_eq!(last, 1.0);

    let out_info = probe_video(&tools, &output).unwrap();
    assert_eq!((out_info.width, out_info.height), (320, 240));
    assert!((out_info.duration - 6.0).abs() < 0.2, "duration {}", out_info.duration);
    let audio = tools.probe(&output).unwrap().audio;
    assert_eq!(audio.codec, "aac", "audio is copied, not re-encoded");

    let centre = (100, 80, 220, 160);
    let before = detail(&tools, &input, 3.0, centre, (320, 240));
    let after = detail(&tools, &output, 3.0, centre, (320, 240));
    assert!(after < before * 0.5, "blurred part still has detail: {after} vs {before}");
    let clear_in = detail(&tools, &input, 1.0, centre, (320, 240));
    let clear_out = detail(&tools, &output, 1.0, centre, (320, 240));
    assert!(clear_out > clear_in * 0.6, "a frame outside the interval lost detail: {clear_out} vs {clear_in}");
    let corner_in = detail(&tools, &input, 3.0, (0, 0, 60, 60), (320, 240));
    let corner_out = detail(&tools, &output, 3.0, (0, 0, 60, 60), (320, 240));
    assert!(corner_out > corner_in * 0.6, "outside the region lost detail: {corner_out} vs {corner_in}");

    // cancelling removes the half-written file
    let cancelled = dir.join("c.mp4");
    let r = render(&tools, &input, &cancelled, &info, &timeline, &AtomicBool::new(true), |_| {});
    assert!(matches!(r, Err(mr_core::Error::Cancelled)));
    assert!(!cancelled.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Real portraits (not in the repository): a slideshow woman / man / landscape / woman is scanned and blurred.
/// Skips when the photos or models are missing. `MR_PHOTOS` = folder with 0.jpg (landscape), 1.jpg (woman), 2.jpg (man), 6.jpg (woman).
#[test]
fn women_are_found_in_a_slideshow_men_and_landscapes_are_not() {
    use mr_core::blur::detect::Detector;
    use mr_core::blur::job::analyze;
    let Ok(tools) = Tools::locate() else { return };
    let photos = PathBuf::from(std::env::var("MR_PHOTOS").unwrap_or_else(|_| "/tmp/mr/blur-src".into()));
    let models = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models");
    let (n, g) = (models.join(mr_core::NUDENET_FILE), models.join(mr_core::GENDER_FILE));
    if !["0.jpg", "1.jpg", "2.jpg", "6.jpg"].iter().all(|f| photos.join(f).exists()) || !n.exists() || !g.exists() {
        eprintln!("skip: photos or models missing");
        return;
    }
    let dir: PathBuf = std::env::temp_dir().join(format!("mr-blur-photos-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // 4 s each: woman (1), man (2), landscape (0), woman (6)
    let slides = ["1.jpg", "2.jpg", "0.jpg", "6.jpg"];
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(["-v", "error", "-y"]);
    for s in slides {
        cmd.args(["-loop", "1", "-framerate", "25", "-t", "4", "-i"]).arg(photos.join(s));
    }
    let input = dir.join("slides.mp4");
    let filter = "[0]scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,setsar=1[a];[1]scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,setsar=1[b];[2]scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,setsar=1[c];[3]scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,setsar=1[d];[a][b][c][d]concat=n=4:v=1:a=0[v]";
    cmd.args(["-f", "lavfi", "-t", "16", "-i", "sine=f=300:d=16", "-filter_complex", filter, "-map", "[v]", "-map", "4:a", "-c:v", "h264_videotoolbox", "-b:v", "6M", "-pix_fmt", "yuv420p", "-c:a", "aac"]).arg(&input);
    assert!(cmd.status().unwrap().success());

    let mut det = Detector::load(&n, &g, None).unwrap();
    let info = probe_video(&tools, &input).unwrap();
    let timeline = analyze(&tools, &mut det, &input, &info, &AtomicBool::new(false), |_| {}).unwrap();
    let share = |from: f64, to: f64| {
        let (a, b) = ((from / 0.25) as usize, (to / 0.25) as usize);
        let hit = (a..b).filter(|&i| !timeline.rects[i].is_empty()).count();
        hit as f64 / (b - a) as f64
    };
    // keep 0.5 s clear of the cuts (the picture is held a little around a woman)
    assert!(share(0.5, 3.5) > 0.9, "woman 1: {}", share(0.5, 3.5));
    assert!(share(4.7, 7.3) == 0.0, "man hidden: {}", share(4.7, 7.3));
    assert!(share(8.7, 11.3) == 0.0, "landscape hidden: {}", share(8.7, 11.3));
    assert!(share(12.5, 15.5) > 0.9, "woman 2: {}", share(12.5, 15.5));

    let output = dir.join("out.mp4");
    render(&tools, &input, &output, &info, &timeline, &AtomicBool::new(false), |_| {}).unwrap();
    // the man's slide is untouched in spirit (same detail), the woman's face is flat
    let size = (640, 480);
    let whole = (0, 0, 640, 480);
    let man_in = detail(&tools, &input, 6.0, whole, size);
    let man_out = detail(&tools, &output, 6.0, whole, size);
    assert!(man_out > man_in * 0.8, "man changed: {man_out} vs {man_in}");
    let w_in = detail(&tools, &input, 2.0, (160, 20, 480, 300), size);
    let w_out = detail(&tools, &output, 2.0, (160, 20, 480, 300), size);
    assert!(w_out < w_in * 0.6, "woman not blurred: {w_out} vs {w_in}");
    let _ = std::fs::remove_dir_all(&dir);
}
