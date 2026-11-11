//! Streaming file pipeline.
//!
//! ```text
//! ffmpeg (decode audio → f32le 44.1 kHz stereo) ─► tiles ─► model ─► ffmpeg (encode + mux)
//!                                                                     ▲
//!                       original file (video, subtitles, cover art, metadata: copied) ┘
//! ```
//! Audio is processed tile by tile, so memory use doesn't grow with the file length.

use crate::media::{output_path, output_rate, plan_output, MediaInfo, OutputPlan, Tools};
use crate::model::Separator;
use crate::passthrough::{keep_original_where_clean, mix_original, BELOW_DB};
use crate::Error;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

/// Everything decided before processing starts (shown in the UI right away).
#[derive(Clone, Debug)]
pub struct Prepared {
    pub input: PathBuf,
    pub output: PathBuf,
    pub info: MediaInfo,
    pub plan: OutputPlan,
}

pub fn prepare(tools: &Tools, input: &Path, out_dir: Option<&Path>, suffix: &str) -> Result<Prepared, Error> {
    let info = tools.probe(input)?;
    let plan = plan_output(input, &info);
    let output = output_path(input, out_dir, suffix, &plan.ext);
    Ok(Prepared { input: input.to_path_buf(), output, info, plan })
}

/// Collects the tail of a child's stderr for error messages without blocking the pipes.
struct StderrTail {
    text: Arc<Mutex<String>>,
    handle: Option<JoinHandle<()>>,
}

impl StderrTail {
    fn spawn(mut err: ChildStderr) -> Self {
        let text = Arc::new(Mutex::new(String::new()));
        let t = text.clone();
        let handle = std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = err.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut s = t.lock().unwrap();
                s.push_str(&String::from_utf8_lossy(&buf[..n]));
                if s.len() > 8192 {
                    let cut = s.len() - 4096;
                    let cut = (cut..s.len()).find(|&i| s.is_char_boundary(i)).unwrap_or(s.len());
                    s.drain(..cut);
                }
            }
        });
        StderrTail { text, handle: Some(handle) }
    }
    fn finish(mut self) -> String {
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        let s = self.text.lock().unwrap().trim().to_string();
        s
    }
}

/// Kills child processes and removes the partial file unless disarmed.
struct Cleanup {
    children: Vec<Child>,
    partial: PathBuf,
    armed: bool,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        for c in &mut self.children {
            let _ = c.kill();
            let _ = c.wait();
        }
        if self.armed {
            let _ = std::fs::remove_file(&self.partial);
        }
    }
}

/// How the separated voice is turned into the output sound.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// Share of the clean voice in the output, 0–1; the rest is the original track (1: voice only).
    pub strength: f32,
    /// Stretches where nothing was removed (plain speech) play from the original, not the model's estimate.
    pub keep_plain_speech: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { strength: 1.0, keep_plain_speech: true }
    }
}

/// Runs the pipeline with the default options. `on_progress` receives the processed fraction in [0, 1].
pub fn run(tools: &Tools, sep: &mut Separator, job: &Prepared, cancel: &AtomicBool, on_progress: impl FnMut(f64)) -> Result<PathBuf, Error> {
    run_with(tools, sep, job, &Options::default(), cancel, on_progress)
}

/// Reads interleaved f32 stereo (at the model's rate) from `src`, separates it tile by tile and hands each
/// cleaned stretch (left, right) to `sink`, which returns `Ok(false)` to stop early. `opts` is asked before every
/// tile, so the strength can change while it runs. Returns how many input samples per channel were read.
pub fn separate_stream(
    sep: &mut Separator,
    src: &mut impl Read,
    opts: &mut dyn FnMut() -> Options,
    cancel: &AtomicBool,
    sink: &mut dyn FnMut(&[f32], &[f32]) -> Result<bool, Error>,
) -> Result<usize, Error> {
    let rate = sep.mdx.cfg.sample_rate;
    let (g, trim, chunk) = (sep.mdx.gen_size, sep.mdx.trim, sep.mdx.chunk_size);
    // buffer[0] is absolute sample (k·g − trim); start with `trim` samples of silence.
    let mut buf_l: Vec<f32> = vec![0.0; trim];
    let mut buf_r: Vec<f32> = vec![0.0; trim];
    let mut total_in: usize = 0;
    let mut eof = false;
    let mut raw = vec![0u8; 1 << 16];
    let mut carry: Vec<u8> = Vec::with_capacity(8);
    let (mut win_l, mut win_r) = (vec![0f32; chunk], vec![0f32; chunk]);
    let (mut out_l, mut out_r) = (vec![0f32; g], vec![0f32; g]);
    let mut k: usize = 0;
    loop {
        while buf_l.len() < chunk && !eof {
            let n = src.read(&mut raw)?;
            if n == 0 {
                eof = true;
                break;
            }
            carry.extend_from_slice(&raw[..n]);
            let frames = carry.len() / 8;
            for f in 0..frames {
                let o = f * 8;
                buf_l.push(f32::from_le_bytes(carry[o..o + 4].try_into().unwrap()));
                buf_r.push(f32::from_le_bytes(carry[o + 4..o + 8].try_into().unwrap()));
            }
            total_in += frames;
            carry.drain(..frames * 8);
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        if eof && k * g >= total_in {
            break;
        }
        let avail = buf_l.len().min(chunk);
        win_l[..avail].copy_from_slice(&buf_l[..avail]);
        win_r[..avail].copy_from_slice(&buf_r[..avail]);
        win_l[avail..].fill(0.0);
        win_r[avail..].fill(0.0);

        sep.separate_window(&win_l, &win_r, &mut out_l, &mut out_r)?;
        // out[i] is the voice at window sample trim + i: the original over the same span
        let (orig_l, orig_r) = (&win_l[trim..trim + g], &win_r[trim..trim + g]);
        let o = opts();
        if o.keep_plain_speech {
            keep_original_where_clean(&mut out_l, &mut out_r, orig_l, orig_r, rate, BELOW_DB);
        }
        mix_original(&mut out_l, &mut out_r, orig_l, orig_r, o.strength);

        let n_out = if eof { g.min(total_in - k * g) } else { g };
        if !sink(&out_l[..n_out], &out_r[..n_out])? {
            break;
        }
        let drop_n = g.min(buf_l.len());
        buf_l.drain(..drop_n);
        buf_r.drain(..drop_n);
        k += 1;
    }
    Ok(total_in)
}

/// Runs the pipeline. `on_progress` receives the processed fraction in [0, 1].
pub fn run_with(
    tools: &Tools,
    sep: &mut Separator,
    job: &Prepared,
    opts: &Options,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f64),
) -> Result<PathBuf, Error> {
    let rate = sep.mdx.cfg.sample_rate;
    let info = &job.info;

    let dir = job.output.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let stem = job.output.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let partial = dir.join(format!(".{stem}.partial.{}", job.plan.ext));

    // Decoder: first audio track → interleaved f32 stereo at the model rate.
    let mut dec = tools
        .ffmpeg_cmd()
        .arg("-i")
        .arg(&job.input)
        .args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-f", "f32le", "-ac", "2", "-ar", &rate.to_string(), "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Ffmpeg(e.to_string()))?;
    let dec_err = StderrTail::spawn(dec.stderr.take().unwrap());
    let mut dec_out = dec.stdout.take().unwrap();

    // Encoder: original file for everything except audio + our PCM on stdin.
    let mut enc_cmd = tools.ffmpeg_cmd();
    enc_cmd.arg("-y").arg("-i").arg(&job.input);
    let offset = info.audio.start_time - info.start_time;
    if offset > 0.001 {
        enc_cmd.args(["-itsoffset", &format!("{offset:.6}")]);
    }
    enc_cmd.args(["-f", "f32le", "-ar", &rate.to_string(), "-ac", "2", "-i", "pipe:0"]);
    // Audio-only containers take no picture stream: Ogg turns embedded cover art into a video
    // stream that its muxer then rejects ("Unsupported codec id"). Matroska keeps attachments (fonts).
    if !matches!(job.plan.ext.as_str(), "ogg" | "oga" | "opus" | "aac") {
        enc_cmd.args(["-map", "0:v?"]);
    }
    if matches!(job.plan.ext.as_str(), "mkv" | "mka") {
        enc_cmd.args(["-map", "0:t?"]);
    }
    enc_cmd.args(["-map", "0:s?", "-map", "1:a", "-c:v", "copy", "-c:s", "copy"]);
    enc_cmd.args(&job.plan.codec_args);
    let out_rate = output_rate(&job.plan, info);
    let out_ch = info.audio.channels.clamp(1, 2);
    enc_cmd.args(["-ar", &out_rate.to_string(), "-ac", &out_ch.to_string()]);
    enc_cmd.args(["-map_metadata", "0", "-map_chapters", "0", "-map_metadata:s:a:0", "0:s:a:0"]);
    enc_cmd.args(&job.plan.extra_args);
    enc_cmd.arg(&partial);
    let mut enc = enc_cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Ffmpeg(e.to_string()))?;
    let enc_err = StderrTail::spawn(enc.stderr.take().unwrap());
    let enc_in = enc.stdin.take().unwrap();

    let mut cleanup = Cleanup { children: vec![dec, enc], partial: partial.clone(), armed: true };

    let total_est = (info.duration * rate as f64).max(1.0);
    let result = (|| -> Result<(), Error> {
        let mut writer = BufWriter::with_capacity(1 << 20, enc_in);
        let mut bytes: Vec<u8> = Vec::new();
        let mut done = 0usize;
        let total_in = separate_stream(sep, &mut dec_out, &mut || *opts, cancel, &mut |l, r| {
            bytes.clear();
            for i in 0..l.len() {
                bytes.extend_from_slice(&l[i].to_le_bytes());
                bytes.extend_from_slice(&r[i].to_le_bytes());
            }
            writer.write_all(&bytes)?;
            done += l.len();
            on_progress((done as f64 / total_est).min(0.999));
            Ok(true)
        })?;
        if total_in == 0 {
            return Err(Error::NoAudio);
        }
        writer.flush()?;
        drop(writer); // closes the encoder's stdin → it finishes the file
        Ok(())
    })();

    // Collect exit statuses. On failure stop both processes first so wait() can't block
    // on a decoder still writing into a pipe nobody reads.
    drop(dec_out);
    if result.is_err() {
        for c in &mut cleanup.children {
            let _ = c.kill();
        }
    }
    let enc_status = cleanup.children[1].wait();
    let dec_status = cleanup.children[0].wait();
    let enc_msg = enc_err.finish();
    let dec_msg = dec_err.finish();

    match result {
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::BrokenPipe => {
            return Err(Error::Ffmpeg(if enc_msg.is_empty() { e.to_string() } else { enc_msg }));
        }
        Err(e) => return Err(e),
        Ok(()) => {}
    }
    if !dec_status.map(|s| s.success()).unwrap_or(false) {
        return Err(Error::Ffmpeg(if dec_msg.is_empty() { "decoder failed".into() } else { dec_msg }));
    }
    if !enc_status.map(|s| s.success()).unwrap_or(false) {
        return Err(Error::Ffmpeg(if enc_msg.is_empty() { "encoder failed".into() } else { enc_msg }));
    }
    std::fs::rename(&partial, &job.output)?;
    cleanup.armed = false;
    on_progress(1.0);
    Ok(job.output.clone())
}
