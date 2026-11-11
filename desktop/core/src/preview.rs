//! "Before / after" listening: cuts the same stretch out of the original and the cleaned file as
//! small WAV clips (any container FFmpeg can read), so the UI can switch between them while playing.

use crate::media::Tools;
use crate::Error;
use std::path::Path;

/// Length of a preview clip, seconds.
pub const CLIP_SECONDS: f64 = 30.0;

/// Where a clip starts and how long it is for a file of `duration` seconds;
/// `position` (0..=1) is the share of the file the clip starts at, clamped so the clip fits.
pub fn window(duration: f64, position: f64) -> (f64, f64) {
    let len = CLIP_SECONDS.min(duration.max(0.0));
    let start = (duration * position.clamp(0.0, 1.0)).min((duration - len).max(0.0));
    (start, len)
}

/// Writes `len` seconds of `input`'s first audio track starting at `start` as 16-bit stereo 44.1 kHz WAV.
pub fn cut_clip(tools: &Tools, input: &Path, start: f64, len: f64, out_wav: &Path) -> Result<(), Error> {
    if let Some(dir) = out_wav.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let out = tools
        .ffmpeg_cmd()
        .arg("-y")
        .args(["-ss", &format!("{start:.3}"), "-t", &format!("{len:.3}")])
        .arg("-i")
        .arg(input)
        .args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav"])
        .arg(out_wav)
        .output()
        .map_err(|e| Error::Ffmpeg(e.to_string()))?;
    if !out.status.success() {
        return Err(Error::Ffmpeg(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_fits_inside_the_file() {
        assert_eq!(window(10.0, 0.5), (0.0, 10.0)); // shorter than a clip: the whole file
        assert_eq!(window(300.0, 0.0), (0.0, 30.0));
        assert_eq!(window(300.0, 0.5), (150.0, 30.0));
        assert_eq!(window(300.0, 1.0), (270.0, 30.0)); // clamped so the clip doesn't run past the end
        assert_eq!(window(300.0, 7.0), (270.0, 30.0));
    }
}
