//! The blur pipeline for one video file.
//!
//! ```text
//! pass 1  ffmpeg (4 frames/s, ≤ 640 px) ─► detector ─► timeline
//! pass 2  ffmpeg (every frame, RGB) ─► blur the timeline's regions ─► ffmpeg (hardware H.264) ─► file
//!                                                      audio, subtitles, chapters: copied from the input ┘
//! ```
//! The picture is re-encoded (the one place the app touches video quality); everything else is copied.

use super::detect::Detector;
use super::render::blur_regions;
use super::shots;
use super::timeline::{self, Timeline};
use crate::media::Tools;
use crate::Error;
use serde::Deserialize;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

/// Seconds between analysed frames.
pub const STEP: f32 = 0.25;
/// Long side of the analysed frames, pixels.
const ANALYSIS_LONG_SIDE: usize = 640;

#[derive(Clone, Debug)]
pub struct VideoInfo {
    /// Upright size (after the rotation tag is applied, as ffmpeg decodes it).
    pub width: usize,
    pub height: usize,
    pub fps: f64,
    pub duration: f64,
    pub start_time: f64,
    /// Bits per second of the video track, when known.
    pub bit_rate: Option<f64>,
}

#[derive(Deserialize)]
struct ProbeOut {
    #[serde(default)]
    streams: Vec<S>,
    format: Option<F>,
}
#[derive(Deserialize)]
struct S {
    width: Option<usize>,
    height: Option<usize>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    bit_rate: Option<String>,
    start_time: Option<String>,
    duration: Option<String>,
    #[serde(default)]
    tags: std::collections::HashMap<String, String>,
    #[serde(default)]
    side_data_list: Vec<serde_json::Value>,
}
#[derive(Deserialize)]
struct F {
    duration: Option<String>,
}

fn fraction(s: &Option<String>) -> Option<f64> {
    let s = s.as_deref()?;
    let (a, b) = s.split_once('/')?;
    let (a, b): (f64, f64) = (a.parse().ok()?, b.parse().ok()?);
    (b > 0.0 && a > 0.0).then(|| a / b)
}

/// Size, frame rate and length of the first real video track.
pub fn probe_video(tools: &Tools, input: &Path) -> Result<VideoInfo, Error> {
    let mut c = std::process::Command::new(&tools.ffprobe);
    let out = c
        .args(["-v", "error", "-select_streams", "v:0", "-print_format", "json", "-show_streams", "-show_format"])
        .arg(input)
        .output()
        .map_err(|e| Error::Ffmpeg(format!("ffprobe: {e}")))?;
    if !out.status.success() {
        return Err(Error::NotMedia(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    let raw: ProbeOut = serde_json::from_slice(&out.stdout).map_err(|e| Error::NotMedia(e.to_string()))?;
    let s = raw.streams.into_iter().next().ok_or_else(|| Error::NotMedia("no video track".into()))?;
    let (mut width, mut height) = (s.width.unwrap_or(0), s.height.unwrap_or(0));
    if width == 0 || height == 0 {
        return Err(Error::NotMedia("no video size".into()));
    }
    let rotation = s
        .side_data_list
        .iter()
        .filter_map(|d| d.get("rotation").and_then(|r| r.as_f64()))
        .next()
        .or_else(|| s.tags.get("rotate").and_then(|r| r.parse().ok()))
        .unwrap_or(0.0);
    if (rotation.abs().round() as i64 / 90) % 2 == 1 {
        std::mem::swap(&mut width, &mut height);
    }
    let duration = s
        .duration
        .as_deref()
        .and_then(|d| d.parse().ok())
        .or_else(|| raw.format.as_ref().and_then(|f| f.duration.as_deref()).and_then(|d| d.parse().ok()))
        .unwrap_or(0.0);
    Ok(VideoInfo {
        width,
        height,
        fps: fraction(&s.avg_frame_rate).or_else(|| fraction(&s.r_frame_rate)).unwrap_or(25.0),
        duration,
        start_time: s.start_time.as_deref().and_then(|d| d.parse().ok()).unwrap_or(0.0),
        bit_rate: s.bit_rate.as_deref().and_then(|b| b.parse().ok()),
    })
}

/// The container the blurred copy is written to: the input's own when it holds H.264, else MKV
/// (WebM can't, and the rest are rare enough that MKV is the safe choice).
pub fn container_for(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "mp4" => "mp4",
        "m4v" => "m4v",
        "mov" => "mov",
        "avi" => "avi",
        "3gp" => "3gp",
        "ts" | "mts" | "m2ts" => "ts",
        _ => "mkv",
    }
}

/// The size analysed frames have: long side ≤ 640, even numbers.
pub fn analysis_size(info: &VideoInfo) -> (usize, usize) {
    let long = info.width.max(info.height);
    let s = (ANALYSIS_LONG_SIDE as f64 / long as f64).min(1.0);
    let even = |v: f64| ((v.round() as usize).max(2) + 1) / 2 * 2;
    (even(info.width as f64 * s), even(info.height as f64 * s))
}

fn read_frame(src: &mut impl Read, buf: &mut [u8]) -> Result<bool, Error> {
    let mut got = 0;
    while got < buf.len() {
        let n = src.read(&mut buf[got..])?;
        if n == 0 {
            return Ok(false); // a trailing partial frame is dropped
        }
        got += n;
    }
    Ok(true)
}

fn finish(mut child: Child, what: &str) -> Result<(), Error> {
    let mut err = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    let st = child.wait()?;
    if st.success() {
        Ok(())
    } else {
        Err(Error::Ffmpeg(format!("{what}: {}", err.trim())))
    }
}

/// Pass 1: looks at four frames a second and decides what to hide. `progress` gets 0–1.
pub fn analyze(
    tools: &Tools,
    detector: &mut Detector,
    input: &Path,
    info: &VideoInfo,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> Result<Timeline, Error> {
    let (w, h) = analysis_size(info);
    let mut dec = tools
        .ffmpeg_cmd()
        .arg("-i")
        .arg(input)
        .args(["-map", "0:v:0", "-an", "-sn", "-dn", "-vf", &format!("fps={},scale={w}:{h}:flags=bilinear", 1.0 / STEP), "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Ffmpeg(e.to_string()))?;
    let mut out = dec.stdout.take().unwrap();
    let mut frame = vec![0u8; w * h * 3];
    let mut frames = Vec::new();
    let mut prev: Option<shots::Thumb> = None;
    let result = (|| -> Result<(), Error> {
        while read_frame(&mut out, &mut frame)? {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            let mut det = detector.analyze(&frame, w, h)?;
            let th = shots::thumb(&frame, w, h);
            det.cut = prev.as_ref().map(|p| shots::is_cut(p, &th)).unwrap_or(false);
            prev = Some(th);
            frames.push(det);
            if info.duration > 0.0 {
                progress((frames.len() as f64 * STEP as f64 / info.duration).min(1.0));
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = dec.kill();
    }
    drop(out);
    let fin = finish(dec, "decode");
    result?;
    fin?;
    progress(1.0);
    Ok(timeline::build(&frames, STEP))
}

/// Pass 2: writes `output` with the timeline's regions blurred and everything but the picture copied from `input`.
/// `progress` gets 0–1.
pub fn render(
    tools: &Tools,
    input: &Path,
    output: &Path,
    info: &VideoInfo,
    timeline: &Timeline,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> Result<(), Error> {
    let (w, h) = (info.width, info.height);
    let mut dec = tools
        .ffmpeg_cmd()
        .arg("-i")
        .arg(input)
        .args(["-map", "0:v:0", "-an", "-sn", "-dn", "-r", &format!("{}", info.fps), "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Ffmpeg(e.to_string()))?;

    let bitrate = info.bit_rate.unwrap_or_else(|| (w * h) as f64 * info.fps * 0.08).max(1_000_000.0);
    let ext = crate::media::ext_of(output);
    let mut enc_cmd = tools.ffmpeg_cmd();
    enc_cmd.arg("-y").args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", &format!("{w}x{h}"), "-framerate", &format!("{}", info.fps)]);
    if info.start_time.abs() > 1e-3 {
        enc_cmd.args(["-itsoffset", &format!("{:.6}", info.start_time)]);
    }
    enc_cmd.args(["-i", "pipe:0"]).arg("-i").arg(input);
    enc_cmd
        .args(["-map", "0:v:0", "-map", "1:a?", "-map", "1:s?", "-map", "1:t?", "-c:v", "h264_videotoolbox", "-b:v", &format!("{}", bitrate as u64), "-pix_fmt", "yuv420p"])
        .args(["-c:a", "copy", "-c:s", "copy", "-c:t", "copy", "-map_metadata", "1", "-map_chapters", "1"]);
    if matches!(ext.as_str(), "mp4" | "m4v" | "mov") {
        enc_cmd.args(["-movflags", "+faststart", "-tag:v", "avc1"]);
    }
    let mut enc = enc_cmd
        .arg(output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Ffmpeg(e.to_string()))?;

    let mut src = dec.stdout.take().unwrap();
    let mut sink = std::io::BufWriter::with_capacity(w * h * 3, enc.stdin.take().unwrap());
    let mut frame = vec![0u8; w * h * 3];
    let total = (info.duration * info.fps).max(1.0);
    let mut n: u64 = 0;
    let result = (|| -> Result<(), Error> {
        while read_frame(&mut src, &mut frame)? {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            let rects = timeline.rects_at(n as f64 / info.fps);
            if !rects.is_empty() {
                blur_regions(&mut frame, w, h, &rects);
            }
            sink.write_all(&frame)?;
            n += 1;
            if n % 15 == 0 {
                progress((n as f64 / total).min(0.999));
            }
        }
        sink.flush()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = dec.kill();
        let _ = enc.kill();
    }
    drop(sink); // closes the encoder's stdin: it finishes the file
    drop(src);
    let d = finish(dec, "decode");
    let e = finish(enc, "encode");
    if let Err(err) = result {
        let _ = std::fs::remove_file(output);
        return Err(err);
    }
    d?;
    e?;
    progress(1.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analysis_frames_are_even_and_at_most_640() {
        let i = |w, h| VideoInfo { width: w, height: h, fps: 25.0, duration: 1.0, start_time: 0.0, bit_rate: None };
        assert_eq!(analysis_size(&i(1920, 1080)), (640, 360));
        assert_eq!(analysis_size(&i(1080, 1920)), (360, 640));
        assert_eq!(analysis_size(&i(320, 240)), (320, 240)); // never scaled up
        let (w, h) = analysis_size(&i(1001, 563));
        assert!(w % 2 == 0 && h % 2 == 0 && w <= 640);
    }

    #[test]
    fn containers_that_cannot_hold_h264_become_mkv() {
        assert_eq!(container_for("MP4"), "mp4");
        assert_eq!(container_for("webm"), "mkv");
        assert_eq!(container_for("wmv"), "mkv");
        assert_eq!(container_for("m2ts"), "ts");
    }

    #[test]
    fn frame_rates_parse() {
        assert_eq!(fraction(&Some("30000/1001".into())).map(|f| (f * 1000.0).round()), Some(29970.0));
        assert_eq!(fraction(&Some("0/0".into())), None);
    }
}
