//! Live separation on a 1.46 s window against the 5.9 s one, on a real recording (MR_AUDIO = any media file ffmpeg reads;
//! only analysed, never played). Prints the numbers; ignored by default.

use mr_core::job::Options;
use mr_core::live::Live;
use mr_core::mdx::{Mdx, KIM_VOCAL_2, LIVE_FRAMES};
use mr_core::media::Tools;
use mr_core::model::{Model, Separator};
use std::path::PathBuf;

fn load(file: &str, frames: usize) -> Separator {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(file);
    let mdx = Mdx::new(KIM_VOCAL_2.with_frames(frames));
    let model = Model::load(&path, mdx.tensor_shape(), None, None).expect("model");
    Separator::new(mdx, model)
}

fn agreement(reference: &[f32], est: &[f32]) -> f64 {
    let (mut s, mut e) = (0f64, 0f64);
    for (r, x) in reference.iter().zip(est) {
        s += (*r as f64).powi(2);
        e += ((*r - *x) as f64).powi(2);
    }
    10.0 * (s / e.max(1e-12)).log10()
}

fn decode(tools: &Tools, file: &str, seconds: usize) -> (Vec<f32>, Vec<f32>) {
    let out = tools
        .ffmpeg_cmd()
        .args(["-v", "error", "-ss", &std::env::var("MR_START").unwrap_or("20".into()), "-t", &seconds.to_string(), "-i", file, "-vn", "-ac", "2", "-ar", "44100", "-f", "f32le", "-"])
        .output()
        .unwrap();
    let v: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    (v.iter().step_by(2).copied().collect(), v.iter().skip(1).step_by(2).copied().collect())
}

/// Live output (aligned to the input) for one separator and hop.
fn run_live(sep: &mut Separator, xl: &[f32], xr: &[f32], hop_s: f64) -> (Vec<f32>, f64, f64) {
    let opts = Options { strength: 1.0, keep_plain_speech: false };
    let mut live = Live::new(sep, hop_s, opts);
    let (mut ol, mut or) = (Vec::new(), Vec::new());
    let rate = sep.mdx.cfg.sample_rate as usize;
    let (mut worst, mut total, mut runs) = (0f64, 0f64, 0);
    let block = rate / 100;
    let mut i = 0;
    while i < xl.len() {
        let e = (i + block).min(xl.len());
        let before = ol.len();
        let t = std::time::Instant::now();
        live.push(sep, &xl[i..e], &xr[i..e], &mut ol, &mut or).unwrap();
        if ol.len() > before {
            let d = t.elapsed().as_secs_f64();
            worst = worst.max(d);
            total += d;
            runs += 1;
        }
        i = e;
    }
    let trim = sep.mdx.trim;
    (ol.iter().skip(trim).copied().collect(), worst, total / runs as f64)
}

#[test]
#[ignore]
fn short_window_against_long() {
    let tools = Tools::locate().unwrap();
    let file = std::env::var("MR_AUDIO").expect("MR_AUDIO");
    let (xl, xr) = decode(&tools, &file, 40);
    let mut long = load(mr_core::MODEL_FILE, 256);
    let fr: usize = std::env::var("FR").ok().and_then(|v| v.parse().ok()).unwrap_or(LIVE_FRAMES);
    let mut short = load(&format!("Kim_Vocal_2.t{fr}.onnx"), fr);
    let rate = 44100usize;
    let skip = 3 * rate; // let both warm up
    let (base, w0, a0) = run_live(&mut long, &xl, &xr, 1.0);
    eprintln!("long window, hop 1.0: lat {:.2} s + run, slowest {w0:.3} s, mean {a0:.3} s", (1.0 * rate as f64 + long.mdx.trim as f64) / rate as f64);
    for hop in [0.25, 0.15, 0.1] {
        let (o, w, a) = run_live(&mut short, &xl, &xr, hop);
        let n = base.len().min(o.len());
        let rms = |x: &[f32]| (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt();
        eprintln!("  rms input {:.4} long {:.4} short {:.4}", rms(&xl[skip..n]), rms(&base[skip..n]), rms(&o[skip..n]));
        let ag = agreement(&base[skip..n], &o[skip..n]);
        let lat = hop + short.mdx.trim as f64 / rate as f64;
        eprintln!("short window, hop {hop}: lat {lat:.2} s + run, slowest {w:.3} s, mean {a:.3} s, agrees with the long window {ag:.1} dB");
    }
}
