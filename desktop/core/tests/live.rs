//! The live (sliding-window) engine against tile-by-tile separation on the real model.
//! Skips (passes) when the model is missing.

use mr_core::job::Options;
use mr_core::live::Live;
use mr_core::mdx::{Mdx, KIM_VOCAL_2};
use mr_core::model::{Model, Separator};
use mr_core::selftest::test_audio;
use std::path::PathBuf;
use std::time::Instant;

fn agreement(reference: &[f32], est: &[f32]) -> f64 {
    let (mut s, mut e) = (0f64, 0f64);
    for (r, x) in reference.iter().zip(est) {
        s += (*r as f64).powi(2);
        e += ((*r - *x) as f64).powi(2);
    }
    10.0 * (s / e.max(1e-12)).log10()
}

#[test]
fn live_output_is_the_tiled_output_delayed() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE);
    if !path.exists() {
        eprintln!("skip: model not found");
        return;
    }
    let mdx = Mdx::new(KIM_VOCAL_2);
    let model = Model::load(&path, mdx.tensor_shape(), None, None).expect("model");
    let mut sep = Separator::new(mdx, model);
    let rate = sep.mdx.cfg.sample_rate;
    let (g, trim, chunk) = (sep.mdx.gen_size, sep.mdx.trim, sep.mdx.chunk_size);
    let n = 16 * rate as usize;
    let (xl, xr) = test_audio(n, rate, 7);

    // reference: tile by tile, as the file pipeline does (the options are off on both sides)
    let (mut ref_l, mut ref_r) = (vec![0f32; n], vec![0f32; n]);
    let (mut wl, mut wr) = (vec![0f32; chunk], vec![0f32; chunk]);
    let (mut ol, mut or) = (vec![0f32; g], vec![0f32; g]);
    for k in 0..n.div_ceil(g) {
        for j in 0..chunk {
            let i = (k * g + j) as isize - trim as isize;
            let ok = i >= 0 && (i as usize) < n;
            wl[j] = if ok { xl[i as usize] } else { 0.0 };
            wr[j] = if ok { xr[i as usize] } else { 0.0 };
        }
        sep.separate_window(&wl, &wr, &mut ol, &mut or).unwrap();
        for j in 0..g.min(n - k * g) {
            ref_l[k * g + j] = ol[j];
            ref_r[k * g + j] = or[j];
        }
    }

    // live: the same audio in small blocks (10 ms, like an audio callback)
    let opts = Options { strength: 1.0, keep_plain_speech: false };
    let mut live = Live::new(&sep, 1.0, opts);
    let (mut out_l, mut out_r) = (Vec::new(), Vec::new());
    let block = rate as usize / 100;
    let (mut worst, mut runs) = (0f64, 0);
    let mut i = 0;
    while i < n {
        let e = (i + block).min(n);
        let before = out_l.len();
        let t = Instant::now();
        live.push(&mut sep, &xl[i..e], &xr[i..e], &mut out_l, &mut out_r).unwrap();
        if out_l.len() > before {
            worst = worst.max(t.elapsed().as_secs_f64());
            runs += 1;
        }
        i = e;
    }
    // out[m] is the voice at input sample m − trim: compare out[m + trim] with the tiled result at m
    let lat = live.latency();
    assert!(out_l.len() >= n - lat, "output length {} for {} in", out_l.len(), n);
    let (a, b) = (2 * rate as usize, out_l.len() - trim - 1);
    let live_part: Vec<f32> = (a..b.min(n)).map(|m| out_l[m + trim]).collect();
    let agree = agreement(&ref_l[a..a + live_part.len()], &live_part);
    eprintln!("live vs tiled: {agree:.1} dB · {runs} model runs · slowest block {worst:.2} s · latency {:.2} s + a run", lat as f64 / rate as f64);
    assert!(agree > 20.0, "live output differs from the tiled one: {agree} dB");
    assert!(worst < 1.0, "a model run took {worst} s: too slow for a 1 s hop");
}
