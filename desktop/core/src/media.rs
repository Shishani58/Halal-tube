//! FFmpeg/FFprobe integration: locating the binaries, probing inputs and choosing the output
//! container and audio codec. The video stream is always copied, never re-encoded.

use crate::Error;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Tools {
    /// Finds ffmpeg/ffprobe: `MR_FFMPEG_DIR`, next to the executable (bundled build),
    /// the macOS app's Resources, Homebrew, then `PATH`.
    pub fn locate() -> Result<Self, Error> {
        let exe = |name: &str| if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(d) = std::env::var_os("MR_FFMPEG_DIR") {
            dirs.push(PathBuf::from(d));
        }
        if let Ok(me) = std::env::current_exe() {
            if let Some(d) = me.parent() {
                dirs.push(d.to_path_buf());
                dirs.push(d.join("../Resources/bin"));
                dirs.push(d.join("bin"));
            }
        }
        for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            dirs.push(PathBuf::from(d));
        }
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        for d in dirs {
            let ff = d.join(exe("ffmpeg"));
            let fp = d.join(exe("ffprobe"));
            if ff.is_file() && fp.is_file() {
                return Ok(Tools { ffmpeg: ff, ffprobe: fp });
            }
        }
        Err(Error::FfmpegMissing)
    }

    pub fn ffmpeg_cmd(&self) -> Command {
        let mut c = Command::new(&self.ffmpeg);
        c.args(["-hide_banner", "-nostdin", "-v", "error"]);
        no_window(&mut c);
        c
    }

    pub fn probe(&self, input: &Path) -> Result<MediaInfo, Error> {
        let mut c = Command::new(&self.ffprobe);
        no_window(&mut c);
        let out = c
            .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
            .arg(input)
            .output()
            .map_err(|e| Error::Ffmpeg(format!("ffprobe: {e}")))?;
        if !out.status.success() {
            return Err(Error::NotMedia(String::from_utf8_lossy(&out.stderr).trim().to_string()));
        }
        let raw: ProbeOut = serde_json::from_slice(&out.stdout).map_err(|e| Error::NotMedia(e.to_string()))?;
        MediaInfo::from_probe(raw)
    }
}

#[cfg(windows)]
fn no_window(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    c.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_c: &mut Command) {}

#[derive(Deserialize)]
struct ProbeOut {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    start_time: Option<String>,
    duration: Option<String>,
    bit_rate: Option<String>,
    #[serde(default)]
    disposition: std::collections::HashMap<String, i64>,
}

#[derive(Deserialize)]
struct ProbeFormat {
    format_name: Option<String>,
    duration: Option<String>,
    start_time: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AudioStream {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub start_time: f64,
    pub bit_rate: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct MediaInfo {
    pub format_name: String,
    pub duration: f64,
    pub start_time: f64,
    /// A real video track (cover art doesn't count).
    pub has_video: bool,
    pub audio: AudioStream,
}

fn num(s: &Option<String>) -> Option<f64> {
    s.as_deref().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite())
}

impl MediaInfo {
    fn from_probe(p: ProbeOut) -> Result<Self, Error> {
        let a = p
            .streams
            .iter()
            .find(|s| s.codec_type.as_deref() == Some("audio"))
            .ok_or(Error::NoAudio)?;
        let has_video = p.streams.iter().any(|s| {
            s.codec_type.as_deref() == Some("video") && s.disposition.get("attached_pic").copied().unwrap_or(0) == 0
        });
        let fmt = p.format.as_ref();
        let duration = num(&a.duration)
            .or_else(|| fmt.and_then(|f| num(&f.duration)))
            .unwrap_or(0.0);
        Ok(MediaInfo {
            format_name: fmt.and_then(|f| f.format_name.clone()).unwrap_or_default(),
            duration,
            start_time: fmt.and_then(|f| num(&f.start_time)).unwrap_or(0.0),
            has_video,
            audio: AudioStream {
                codec: a.codec_name.clone().unwrap_or_default(),
                sample_rate: a.sample_rate.as_deref().and_then(|v| v.parse().ok()).unwrap_or(44100),
                channels: a.channels.unwrap_or(2),
                start_time: num(&a.start_time).unwrap_or(0.0),
                bit_rate: a.bit_rate.as_deref().and_then(|v| v.parse().ok()),
            },
        })
    }
}

/// How to write the result: container extension and audio encoder arguments.
#[derive(Clone, Debug, PartialEq)]
pub struct OutputPlan {
    pub ext: String,
    pub codec_args: Vec<String>,
    pub extra_args: Vec<String>,
}

/// Input extensions the app accepts (lower-case, without the dot).
pub const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "mts", "m2ts", "3gp"];
pub const AUDIO_EXTS: &[&str] = &["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "wma", "aiff", "aif", "alac", "mka"];

pub fn is_supported(path: &Path) -> bool {
    let ext = ext_of(path);
    VIDEO_EXTS.contains(&ext.as_str()) || AUDIO_EXTS.contains(&ext.as_str())
}

pub fn ext_of(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn kbps(info: &MediaInfo, lo: u32, hi: u32, default: u32) -> String {
    let k = info.audio.bit_rate.map(|b| (b / 1000).clamp(lo, hi)).unwrap_or(default);
    format!("{k}k")
}

/// Keeps the input's container whenever FFmpeg can write it, and picks a matching audio codec.
pub fn plan_output(input: &Path, info: &MediaInfo) -> OutputPlan {
    let ext = ext_of(input);
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let aac = |info: &MediaInfo| s(&["-c:a", "aac", "-b:a", &kbps(info, 128, 320, 192)]);
    let mp3 = |info: &MediaInfo| s(&["-c:a", "libmp3lame", "-b:a", &kbps(info, 128, 320, 192)]);
    let opus = |info: &MediaInfo| s(&["-c:a", "libopus", "-b:a", &kbps(info, 96, 256, 128)]);
    let faststart = s(&["-movflags", "+faststart"]);

    let (out_ext, codec, extra): (&str, Vec<String>, Vec<String>) = match ext.as_str() {
        "mp4" | "m4v" | "mov" | "3gp" => (ext.as_str(), aac(info), faststart),
        "m4a" => match info.audio.codec.as_str() {
            "alac" => ("m4a", s(&["-c:a", "alac"]), faststart),
            _ => ("m4a", aac(info), faststart),
        },
        "aac" => ("aac", aac(info), vec![]),
        "mp3" => ("mp3", mp3(info), s(&["-id3v2_version", "3"])),
        "wav" => ("wav", s(&["-c:a", pcm_codec(&info.audio.codec)]), vec![]),
        "aiff" | "aif" => ("aiff", s(&["-c:a", "pcm_s16be"]), vec![]),
        "flac" => ("flac", s(&["-c:a", "flac"]), vec![]),
        "ogg" | "oga" | "opus" => (ext.as_str(), opus(info), vec![]),
        "webm" => ("webm", opus(info), vec![]),
        "avi" => ("avi", mp3(info), vec![]),
        "mpg" | "mpeg" => (ext.as_str(), mp3(info), vec![]),
        "ts" | "mts" | "m2ts" => (ext.as_str(), aac(info), vec![]),
        "flv" => ("flv", aac(info), vec![]),
        "mkv" | "mka" => {
            let c = match info.audio.codec.as_str() {
                "opus" | "vorbis" => opus(info),
                "flac" => s(&["-c:a", "flac"]),
                "mp3" => mp3(info),
                "ac3" | "eac3" => s(&["-c:a", "ac3", "-b:a", &kbps(info, 192, 640, 384)]),
                _ => aac(info),
            };
            (ext.as_str(), c, vec![])
        }
        // Containers we can't write well (wmv, wma, alac raw, …): fall back to a universal one.
        _ if info.has_video => ("mkv", aac(info), vec![]),
        _ => ("m4a", aac(info), faststart),
    };
    OutputPlan { ext: out_ext.to_string(), codec_args: codec, extra_args: extra }
}

fn pcm_codec(src: &str) -> &'static str {
    match src {
        "pcm_s24le" | "pcm_s32le" | "pcm_f32le" | "pcm_f64le" => "pcm_s24le",
        _ => "pcm_s16le",
    }
}

/// Output sample rate: keep the original where the encoder allows it.
pub fn output_rate(plan: &OutputPlan, info: &MediaInfo) -> u32 {
    let opus = plan.codec_args.iter().any(|a| a == "libopus");
    if opus {
        return 48000;
    }
    let r = info.audio.sample_rate;
    let mp3_or_ac3 = plan.codec_args.iter().any(|a| a == "libmp3lame" || a == "ac3");
    if mp3_or_ac3 && r > 48000 {
        return 48000;
    }
    if r == 0 { 44100 } else { r }
}

/// "name (no music).ext", adding " 2", " 3", … if that file already exists.
pub fn output_path(input: &Path, out_dir: Option<&Path>, suffix: &str, ext: &str) -> PathBuf {
    let dir = out_dir
        .map(Path::to_path_buf)
        .or_else(|| input.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = input.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "output".into());
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{stem} ({suffix}).{ext}")
        } else {
            format!("{stem} ({suffix}) {n}.{ext}")
        };
        let p = dir.join(name);
        if !p.exists() {
            return p;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(codec: &str, video: bool) -> MediaInfo {
        MediaInfo {
            format_name: String::new(),
            duration: 10.0,
            start_time: 0.0,
            has_video: video,
            audio: AudioStream { codec: codec.into(), sample_rate: 44100, channels: 2, start_time: 0.0, bit_rate: Some(256_000) },
        }
    }

    #[test]
    fn keeps_container_and_picks_codec() {
        let p = plan_output(Path::new("/a/x.MP4"), &info("aac", true));
        assert_eq!(p.ext, "mp4");
        assert!(p.codec_args.contains(&"aac".to_string()));
        assert!(p.codec_args.contains(&"256k".to_string()));
        let p = plan_output(Path::new("/a/x.webm"), &info("opus", true));
        assert_eq!((p.ext.as_str(), output_rate(&p, &info("opus", true))), ("webm", 48000));
        let p = plan_output(Path::new("/a/x.mp3"), &info("mp3", false));
        assert!(p.codec_args.contains(&"libmp3lame".to_string()));
        let p = plan_output(Path::new("/a/x.wmv"), &info("wmav2", true));
        assert_eq!(p.ext, "mkv");
        let p = plan_output(Path::new("/a/x.wma"), &info("wmav2", false));
        assert_eq!(p.ext, "m4a");
    }

    #[test]
    fn output_names() {
        let p = output_path(Path::new("/nonexistent-dir/My clip.mov"), None, "без музыки", "mov");
        assert_eq!(p, PathBuf::from("/nonexistent-dir/My clip (без музыки).mov"));
    }
}
