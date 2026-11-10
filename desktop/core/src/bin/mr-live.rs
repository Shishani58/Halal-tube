//! Live mode, command line: removes the music from everything the Mac plays, as it plays (macOS 14.2+).
//!
//! ```text
//! mr-live [--hop S] [--strength 0-100] [--no-passthrough] [--keep-original] [--seconds N]
//!         [--record FILE.wav] [--no-playback] [--capture-test] [--cpu|--gpu] [--model PATH]
//! ```
//! System audio → tap (the system's own output of it is silenced) → resample to 44.1 kHz → the
//! sliding-window separator (live.rs) → resample back → the default output device. The first sound
//! is heard about `hop + 0.1 s + a model run + a short safety margin` after it was played.
//! `--record` also writes the processed sound to a WAV file (for checking without listening),
//! `--no-playback` plays nothing (the original is silenced too), `--capture-test` only measures
//! what the tap hears.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("mr-live works on macOS only for now");
    std::process::exit(2);
}

#[cfg(target_os = "macos")]
fn main() {
    mac::main();
}

#[cfg(target_os = "macos")]
mod mac {
    use mr_core::live_session::{self, LiveConfig, LiveState};
    use mr_core::model::Backend;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    fn fail(msg: &str) -> ! {
        eprintln!("error: {msg}");
        std::process::exit(1);
    }

    fn write_wav(path: &str, l: &[f32], r: &[f32], rate: u32) -> std::io::Result<()> {
        use std::io::Write;
        let n = l.len().min(r.len());
        let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
        f.write_all(b"RIFF")?;
        f.write_all(&(36 + n as u32 * 4).to_le_bytes())?;
        f.write_all(b"WAVEfmt ")?;
        f.write_all(&16u32.to_le_bytes())?;
        f.write_all(&1u16.to_le_bytes())?;
        f.write_all(&2u16.to_le_bytes())?;
        f.write_all(&rate.to_le_bytes())?;
        f.write_all(&(rate * 4).to_le_bytes())?;
        f.write_all(&4u16.to_le_bytes())?;
        f.write_all(&16u16.to_le_bytes())?;
        f.write_all(b"data")?;
        f.write_all(&(n as u32 * 4).to_le_bytes())?;
        for i in 0..n {
            f.write_all(&((l[i].clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
            f.write_all(&((r[i].clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
        }
        f.flush()
    }

    fn rms_db(x: &[f32]) -> f64 {
        if x.is_empty() {
            return -120.0;
        }
        10.0 * ((x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64) + 1e-12).log10()
    }

    pub fn main() {
        let model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE);
        let mut cfg = LiveConfig::new(model, Some(std::env::temp_dir().join("mr-coreml-cache")));
        let (mut seconds, mut record, mut record_input) = (0f64, None::<String>, None::<String>);
        let mut args = std::env::args().skip(1);
        while let Some(a) = args.next() {
            match a.as_str() {
                "--cpu" => cfg.prefer = Some(Backend::Cpu),
                "--gpu" => cfg.prefer = Some(Backend::Gpu),
                "--model" => cfg.model_path = args.next().map(PathBuf::from).unwrap_or(cfg.model_path),
                "--hop" => cfg.hop_s = args.next().and_then(|v| v.parse().ok()).unwrap_or(1.0),
                "--strength" => cfg.strength = args.next().and_then(|v| v.parse().ok()).unwrap_or(100).min(100),
                "--no-passthrough" => cfg.keep_plain_speech = false,
                "--keep-original" => cfg.mute_original = false,
                "--seconds" => seconds = args.next().and_then(|v| v.parse().ok()).unwrap_or(0.0),
                "--record" => record = args.next(),
                "--record-input" => record_input = args.next(),
                "--no-playback" => cfg.playback = false,
                "--capture-test" => cfg.capture_only = true,
                other => fail(&format!("unknown option {other}")),
            }
        }
        cfg.record_output = record.is_some();
        cfg.record_input = record_input.is_some();
        cfg.max_seconds = if seconds > 0.0 { Some(seconds) } else { None };

        let handle = live_session::start(cfg.clone());
        let (mut last, mut state) = (Instant::now(), LiveState::Starting);
        while !handle.is_finished() {
            std::thread::sleep(Duration::from_millis(100));
            let s = &handle.stats;
            if s.state() != state {
                state = s.state();
                eprintln!("{state:?} (backend {})", s.backend.lock().unwrap());
            }
            if state == LiveState::Running && last.elapsed() >= Duration::from_secs(2) {
                last = Instant::now();
                eprintln!(
                    "input peak {:.3} · slowest model hop {} ms · skipped silent hops {} · output ring {:.2} s · underruns {} · capture overruns {} · capture {} Hz · latency about {:.1} s",
                    s.take_input_peak(),
                    s.worst_run_ms(),
                    s.skipped_hops.load(std::sync::atomic::Ordering::Relaxed),
                    s.out_ring_seconds(),
                    s.underruns.load(std::sync::atomic::Ordering::Relaxed),
                    s.overruns.load(std::sync::atomic::Ordering::Relaxed),
                    s.capture_rate.load(std::sync::atomic::Ordering::Relaxed),
                    s.latency_seconds(),
                );
            }
        }
        if let Some((code, msg)) = handle.stats.error.lock().unwrap().clone() {
            fail(&format!("{msg} ({code})"));
        }
        let report = handle.stop();
        if let Some((secs, rms, peak)) = report.capture {
            println!("captured {secs:.2} s, rms {rms:.2} dB, peak {peak:.4}");
            return;
        }
        if let Some(path) = record_input {
            write_wav(&path, &report.input.0, &report.input.1, report.model_rate).unwrap_or_else(|e| fail(&e.to_string()));
            eprintln!("wrote {path}: the captured input at {} Hz", report.model_rate);
        }
        if let Some(path) = record {
            write_wav(&path, &report.output.0, &report.output.1, report.model_rate).unwrap_or_else(|e| fail(&e.to_string()));
            eprintln!(
                "wrote {path}: {:.1} s, rms {:.1} dB (the sound is delayed by {:.2} s against what was played)",
                report.output.0.len() as f64 / report.model_rate as f64,
                rms_db(&report.output.0),
                report.latency as f64 / report.model_rate as f64
            );
        }
    }
}
