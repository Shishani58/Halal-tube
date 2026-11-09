//! Music Remover core: removes background music from video and audio files, keeping the voice.
//!
//! - [`mdx`]: STFT/iSTFT for the UVR MDX-Net model (port of the extension's `src/core/mdx.ts`).
//! - [`model`]: ONNX Runtime session (CoreML / DirectML / CPU).
//! - [`media`]: FFmpeg probing and output format choice.
//! - [`job`]: the streaming file pipeline: decode → separate tile by tile → encode + mux.

pub mod job;
pub mod mdx;
pub mod media;
pub mod model;

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
    #[error("ffmpeg failed: {0}")]
    Ffmpeg(String),
    #[error("model error: {0}")]
    Model(String),
    #[error("cancelled")]
    Cancelled,
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
            Error::Ffmpeg(_) => "ffmpeg",
            Error::Model(_) => "model",
            Error::Cancelled => "cancelled",
            Error::Io(_) => "io",
        }
    }
}

/// Default location of the bundled model relative to a resources directory.
pub const MODEL_FILE: &str = "Kim_Vocal_2.onnx";
