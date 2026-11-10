//! Command-line front end, used for testing the pipeline without the UI.
//!
//! mr-cli [--cpu|--gpu] [--model PATH] [--out-dir DIR] [--suffix TEXT] [--strength 0-100] [--no-passthrough] [--no-selftest] FILE...

use mr_core::job;
use mr_core::mdx::{Mdx, KIM_VOCAL_2};
use mr_core::media::Tools;
use mr_core::model::{Backend, Model, SelfTest, Separator};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

fn main() {
    let mut prefer = None;
    let mut model_path: Option<PathBuf> = None;
    let mut out_dir: Option<PathBuf> = None;
    let mut suffix = "no music".to_string();
    let mut strength = 100u32;
    let mut keep_plain_speech = true;
    let mut selftest = true;
    let mut files = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--cpu" => prefer = Some(Backend::Cpu),
            "--gpu" => prefer = Some(Backend::Gpu),
            "--model" => model_path = args.next().map(PathBuf::from),
            "--out-dir" => out_dir = args.next().map(PathBuf::from),
            "--suffix" => suffix = args.next().unwrap_or(suffix),
            "--strength" => strength = args.next().and_then(|v| v.parse().ok()).unwrap_or(100).min(100),
            "--no-passthrough" => keep_plain_speech = false,
            "--no-selftest" => selftest = false,
            _ => files.push(PathBuf::from(a)),
        }
    }
    if files.is_empty() {
        eprintln!("usage: mr-cli [--cpu|--gpu] [--model PATH] [--out-dir DIR] [--suffix TEXT] [--strength 0-100] [--no-passthrough] [--no-selftest] FILE...");
        std::process::exit(2);
    }
    let model_path = model_path.unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE)
    });

    let tools = Tools::locate().unwrap_or_else(|e| fail(&e.to_string()));
    let mdx = Mdx::new(KIM_VOCAL_2);
    let t0 = Instant::now();
    let cache = std::env::temp_dir().join("mr-coreml-cache");
    let model = Model::load(&model_path, mdx.tensor_shape(), prefer, Some(&cache)).unwrap_or_else(|e| fail(&e.to_string()));
    eprintln!("model loaded on {} in {:.1} s", model.backend.label(), t0.elapsed().as_secs_f64());
    let mut sep = Separator::new(mdx, model);
    if selftest {
        let t = Instant::now();
        match sep.self_test(Some(&cache)) {
            Ok(SelfTest::Passed(err)) => eprintln!("GPU self-test passed (error {:.3} %, {:.1} s)", err * 100.0, t.elapsed().as_secs_f64()),
            Ok(SelfTest::Cached) => eprintln!("GPU self-test passed earlier"),
            Ok(SelfTest::Skipped) => {}
            Ok(SelfTest::FellBack(why)) => eprintln!("GPU computes wrong results ({why}): using the CPU"),
            Err(e) => eprintln!("GPU self-test could not run: {e}"),
        }
    }
    let opts = job::Options { strength: strength as f32 / 100.0, keep_plain_speech };

    let cancel = AtomicBool::new(false);
    let mut failed = false;
    for f in files {
        let prepared = match job::prepare(&tools, &f, out_dir.as_deref(), &suffix) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("{}: {e}", f.display());
                failed = true;
                continue;
            }
        };
        let t = Instant::now();
        let mut last = -1i32;
        let res = job::run_with(&tools, &mut sep, &prepared, &opts, &cancel, |p| {
            let pct = (p * 100.0) as i32;
            if pct / 10 != last / 10 {
                eprint!("{pct}% ");
                last = pct;
            }
        });
        eprintln!();
        match res {
            Ok(out) => {
                let secs = t.elapsed().as_secs_f64();
                eprintln!(
                    "{} → {} ({:.1} s, {:.1}× realtime)",
                    f.display(),
                    out.display(),
                    secs,
                    prepared.info.duration / secs
                );
                println!("{}", out.display());
            }
            Err(e) => {
                eprintln!("{}: {e}", f.display());
                failed = true;
            }
        }
    }
    if failed {
        std::process::exit(1);
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(1)
}
