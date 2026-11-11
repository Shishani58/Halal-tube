//! Music Remover core: removes background music from video and audio files, keeping the voice.
//!
//! - [`mdx`]: STFT/iSTFT for the UVR MDX-Net model (port of the extension's `src/core/mdx.ts`).
//! - [`model`]: ONNX Runtime session (CoreML / DirectML / CPU).
//! - [`media`]: FFmpeg probing and output format choice.
//! - [`passthrough`]: original sound where nothing was removed, and the strength mix.
//! - [`preview`]: short before/after clips for listening.
//! - [`live`]: the streaming engine for a live (system audio) mode, without audio capture.
//! - [`blur`]: hides nudity and women in video (re-encodes the picture, blurs regions).
//! - [`player`]: watching a file with the music removed ahead of playback, so the voice never lags the picture.
//! - [`job`]: the streaming file pipeline: decode → separate tile by tile → encode + mux.

#[cfg(target_os = "macos")]
pub mod capture;
#[cfg(target_os = "windows")]
#[path = "capture_win.rs"]
pub mod capture;
pub mod blur;
pub mod job;
pub mod live;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub mod live_session;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub mod player;
pub mod mdx;
pub mod media;
pub mod model;
pub mod passthrough;
pub mod preview;
#[cfg(target_os = "macos")]
pub mod screen;
pub mod ring;
pub mod stream;
pub mod selftest;

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("FFmpeg not found")]
    FfmpegMissing,
    #[error("model file not found: {0}")]
    ModelMissing(PathBuf),
    #[error("not a media file: {0}")]
    NotMedia(String),
    #[error("the file has no audio track")]
    NoAudio,
    #[error("the file has no video track")]
    NoVideo,
    #[error("ffmpeg failed: {0}")]
    Ffmpeg(String),
    #[error("model error: {0}")]
    Model(String),
    #[error("cancelled")]
    Cancelled,
    #[error("audio capture: {0}")]
    Capture(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl<R> From<ort::Error<R>> for Error {
    fn from(e: ort::Error<R>) -> Self {
        Error::Model(e.to_string())
    }
}

impl Error {
    /// Stable machine-readable code for the UI to translate.
    pub fn code(&self) -> &'static str {
        match self {
            Error::FfmpegMissing => "ffmpeg_missing",
            Error::ModelMissing(_) => "model_missing",
            Error::NotMedia(_) => "not_media",
            Error::NoAudio => "no_audio",
            Error::NoVideo => "no_video",
            Error::Ffmpeg(_) => "ffmpeg",
            Error::Model(_) => "model",
            Error::Cancelled => "cancelled",
            Error::Capture(_) => "capture",
            Error::Io(_) => "io",
        }
    }
}

/// Default location of the bundled model relative to a resources directory.
pub const MODEL_FILE: &str = "Kim_Vocal_2.onnx";
/// The same model on a 32-frame window, for the live mode (made by scripts/retime-onnx.py).
pub const LIVE_MODEL_FILE: &str = "Kim_Vocal_2.t32.onnx";
/// Blur models (nudity + faces, face gender), next to the separation model.
pub const NUDENET_FILE: &str = "nudenet-320n.onnx";
pub const GENDER_FILE: &str = "genderage.onnx";
