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
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use mr_core::capture::Capture;
    use mr_core::job::Options;
    use mr_core::live::Live;
    use mr_core::mdx::{Mdx, KIM_VOCAL_2};
    use mr_core::model::{Backend, Model, SelfTest, Separator};
    use mr_core::ring::Ring;
    use mr_core::stream::StreamResampler;
    use mr_core::Error;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
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
        let (mut prefer, mut model_path, mut hop, mut strength) = (None, None::<PathBuf>, 1.0f64, 100u32);
        let (mut keep_plain_speech, mut mute, mut seconds, mut record, mut playback, mut capture_test) = (true, true, 0f64, None::<String>, true, false);
        let mut record_input = None::<String>;
        let mut args = std::env::args().skip(1);
        while let Some(a) = args.next() {
            match a.as_str() {
                "--cpu" => prefer = Some(Backend::Cpu),
                "--gpu" => prefer = Some(Backend::Gpu),
                "--model" => model_path = args.next().map(PathBuf::from),
                "--hop" => hop = args.next().and_then(|v| v.parse().ok()).unwrap_or(1.0),
                "--strength" => strength = args.next().and_then(|v| v.parse().ok()).unwrap_or(100).min(100),
                "--no-passthrough" => keep_plain_speech = false,
                "--keep-original" => mute = false,
                "--seconds" => seconds = args.next().and_then(|v| v.parse().ok()).unwrap_or(0.0),
                "--record" => record = args.next(),
                "--record-input" => record_input = args.next(),
                "--no-playback" => playback = false,
                "--capture-test" => capture_test = true,
                other => fail(&format!("unknown option {other}")),
            }
        }

        // ── output: the default device; opening it also makes this process an audio client, which
        //    the tap needs to exclude it (what we play must not be captured again)
        let host = cpal::default_host();
        let device = host.default_output_device().unwrap_or_else(|| fail("no output device"));
        let cfg = device.default_output_config().unwrap_or_else(|e| fail(&e.to_string()));
        let out_rate = cfg.sample_rate().0;
        let out_ch = cfg.channels() as usize;
        let out_ring = Arc::new(Ring::new(out_rate as usize * 2 * 6));
        let armed = Arc::new(AtomicBool::new(false));
        let stream = {
            let (ring, armed) = (out_ring.clone(), armed.clone());
            let mut tmp = vec![0f32; 8192];
            device
                .build_output_stream(
                    &cfg.config(),
                    move |data: &mut [f32], _| {
                        let frames = data.len() / out_ch;
                        if !armed.load(Ordering::Relaxed) || tmp.len() < frames * 2 {
                            data.fill(0.0);
                            return;
                        }
                        ring.pop_padded(&mut tmp[..frames * 2]);
                        for f in 0..frames {
                            for c in 0..out_ch {
                                data[f * out_ch + c] = if c < 2 { tmp[f * 2 + c] } else { 0.0 };
                            }
                        }
                    },
                    |e| eprintln!("output stream error: {e}"),
                    None,
                )
                .unwrap_or_else(|e| fail(&format!("cannot open the output device: {e}")))
        };
        stream.play().unwrap_or_else(|e| fail(&e.to_string()));
        eprintln!("output: {} at {out_rate} Hz, {out_ch} channels", device.name().unwrap_or_default());

        let start_capture = || {
            // ── capture (retry: the process object of an audio client appears a moment after the stream opens)
            let mut cap = None;
            for _ in 0..30 {
                match Capture::start(mute && !capture_test, 4.0) {
                    Ok(c) => {
                        cap = Some(c);
                        break;
                    }
                    Err(Error::Capture(m)) if m.starts_with("not_audio_client") => std::thread::sleep(Duration::from_millis(100)),
                    Err(e) => fail(&e.to_string()),
                }
            }
            let cap = cap.unwrap_or_else(|| fail("this process never became an audio client"));
            eprintln!("capturing system audio at {} Hz{}", cap.sample_rate, if mute && !capture_test { " (the system's own output of it is silenced)" } else { "" });
            cap
        };
        if capture_test {
            let cap = start_capture();
            let t_end = if seconds > 0.0 { Some(Instant::now() + Duration::from_secs_f64(seconds)) } else { None };
            let mut buf = vec![0f32; 4096];
            let (mut sum, mut peak, mut frames) = (0f64, 0f32, 0u64);
            while t_end.map(|t| Instant::now() < t).unwrap_or(true) {
                let n = cap.ring.pop(&mut buf);
                for v in &buf[..n] {
                    sum += (*v as f64).powi(2);
                    peak = peak.max(v.abs());
                }
                frames += n as u64 / 2;
                std::thread::sleep(Duration::from_millis(5));
            }
            println!("captured {:.2} s, rms {:.2} dB, peak {:.4}", frames as f64 / cap.sample_rate as f64, 10.0 * (sum / (frames * 2) as f64 + 1e-12).log10(), peak);
            return;
        }

        // ── the model
        let model_path = model_path.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE));
        let mdx = Mdx::new(KIM_VOCAL_2);
        let cache = std::env::temp_dir().join("mr-coreml-cache");
        let t0 = Instant::now();
        let model = Model::load(&model_path, mdx.tensor_shape(), prefer, Some(&cache)).unwrap_or_else(|e| fail(&e.to_string()));
        eprintln!("model on {} ({:.1} s)", model.backend.label(), t0.elapsed().as_secs_f64());
        let mut sep = Separator::new(mdx, model);
        match sep.self_test(Some(&cache)) {
            Ok(SelfTest::FellBack(why)) => eprintln!("the GPU computes wrong results ({why}): using the CPU"),
            Ok(_) => {}
            Err(e) => eprintln!("GPU self-test could not run: {e}"),
        }
        let mut live = Live::new(&sep, hop, Options { strength: strength as f32 / 100.0, keep_plain_speech });
        let model_rate = sep.mdx.cfg.sample_rate;
        // the model's windows are a few hundred ms of work: the output starts after a safety margin
        // that covers a slow run, so that it doesn't run dry between hops
        let margin = (out_rate as f64 * 0.4) as usize;
        let mut from_model = StreamResampler::new(model_rate, out_rate).unwrap_or_else(|e| fail(&e.to_string()));

        // capture starts only now: audio heard while the model loaded would only add delay
        let cap = start_capture();
        let t_end = if seconds > 0.0 { Some(Instant::now() + Duration::from_secs_f64(seconds)) } else { None };
        let mut to_model = StreamResampler::new(cap.sample_rate, model_rate).unwrap_or_else(|e| fail(&e.to_string()));
        eprintln!("running: hop {hop} s → latency about {:.1} s{}", hop + 0.09 + 0.3 + 0.4, if playback { "" } else { " (no playback)" });
        let (mut in_buf, mut l, mut r) = (vec![0f32; 4800 * 2], Vec::new(), Vec::new());
        let (mut ml, mut mr_) = (Vec::new(), Vec::new());
        let (mut pl, mut pr) = (Vec::new(), Vec::new());
        let (mut ol, mut or) = (Vec::new(), Vec::new());
        let (mut rec_l, mut rec_r) = (Vec::<f32>::new(), Vec::<f32>::new());
        let (mut in_rec_l, mut in_rec_r) = (Vec::<f32>::new(), Vec::<f32>::new());
        let (mut started, mut last_report) = (false, Instant::now());
        let (mut cap_rate, mut last_rate_check) = (cap.sample_rate, Instant::now());
        let (mut worst_run, mut in_peak) = (0f64, 0f32);
        loop {
            if t_end.map(|t| Instant::now() >= t).unwrap_or(false) {
                break;
            }
            // a player may switch the output device to the rate of its file (44.1 ↔ 48 kHz): follow it
            if last_rate_check.elapsed() >= Duration::from_millis(300) {
                last_rate_check = Instant::now();
                let now = cap.current_rate();
                if now != cap_rate {
                    eprintln!("the capture rate changed: {cap_rate} → {now} Hz");
                    cap_rate = now;
                    to_model = StreamResampler::new(cap_rate, model_rate).unwrap_or_else(|e| fail(&e.to_string()));
                }
            }
            let n = cap.ring.pop(&mut in_buf) / 2;
            if n == 0 {
                std::thread::sleep(Duration::from_millis(4));
            } else {
                l.clear();
                r.clear();
                for f in in_buf[..n * 2].chunks_exact(2) {
                    l.push(f[0]);
                    r.push(f[1]);
                    in_peak = in_peak.max(f[0].abs()).max(f[1].abs());
                }
                ml.clear();
                mr_.clear();
                to_model.process(&l, &r, &mut ml, &mut mr_).unwrap_or_else(|e| fail(&e.to_string()));
                if record_input.is_some() {
                    in_rec_l.extend_from_slice(&ml);
                    in_rec_r.extend_from_slice(&mr_);
                }
                pl.clear();
                pr.clear();
                let t = Instant::now();
                if let Err(e) = live.push(&mut sep, &ml, &mr_, &mut pl, &mut pr) {
                    fail(&e.to_string());
                }
                if !pl.is_empty() {
                    worst_run = worst_run.max(t.elapsed().as_secs_f64());
                    if record.is_some() {
                        rec_l.extend_from_slice(&pl);
                        rec_r.extend_from_slice(&pr);
                    }
                    ol.clear();
                    or.clear();
                    from_model.process(&pl, &pr, &mut ol, &mut or).unwrap_or_else(|e| fail(&e.to_string()));
                    if playback {
                        if !started {
                            out_ring.push(&vec![0f32; margin * 2]);
                        }
                        let inter: Vec<f32> = ol.iter().zip(&or).flat_map(|(a, b)| [*a, *b]).collect();
                        out_ring.push(&inter);
                    }
                    if !started {
                        started = true;
                        armed.store(true, Ordering::Relaxed);
                    }
                }
            }
            if last_report.elapsed() >= Duration::from_secs(2) {
                last_report = Instant::now();
                eprintln!(
                    "input peak {in_peak:.3} · slowest model hop {worst_run:.2} s · skipped silent hops {} · output ring {:.2} s · underruns {} · capture overruns {}",
                    live.skipped,
                    out_ring.len() as f64 / (out_rate as f64 * 2.0),
                    out_ring.underruns.load(Ordering::Relaxed),
                    cap.ring.overruns.load(Ordering::Relaxed)
                );
                in_peak = 0.0;
            }
        }
        drop(cap); // stops the tap: the system's output is heard as before
        if let Some(path) = record_input {
            write_wav(&path, &in_rec_l, &in_rec_r, model_rate).unwrap_or_else(|e| fail(&e.to_string()));
            eprintln!("wrote {path}: the captured input at {model_rate} Hz");
        }
        if let Some(path) = record {
            write_wav(&path, &rec_l, &rec_r, model_rate).unwrap_or_else(|e| fail(&e.to_string()));
            eprintln!("wrote {path}: {:.1} s, rms {:.1} dB (the sound is delayed by {:.2} s against what was played)", rec_l.len() as f64 / model_rate as f64, rms_db(&rec_l), live.latency() as f64 / model_rate as f64);
        }
    }
}
