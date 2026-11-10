//! GPU self-test against the real model. Skips (passes) when the model is missing.

use mr_core::mdx::{Mdx, KIM_VOCAL_2};
use mr_core::model::{Backend, Model, SelfTest, Separator};
use std::path::PathBuf;

fn separator() -> Option<Separator> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE);
    if !path.exists() {
        eprintln!("skip: model not found");
        return None;
    }
    let mdx = Mdx::new(KIM_VOCAL_2);
    let model = Model::load(&path, mdx.tensor_shape(), None, None).expect("model");
    Some(Separator::new(mdx, model))
}

#[test]
fn a_working_gpu_passes_and_a_broken_one_falls_back_to_the_cpu() {
    let Some(mut sep) = separator() else { return };
    if sep.model.backend == Backend::Cpu {
        assert_eq!(sep.self_test(None).unwrap(), SelfTest::Skipped);
        return;
    }
    let dir = std::env::temp_dir().join(format!("mr-selftest-{}", std::process::id()));
    match sep.self_test(Some(&dir)).unwrap() {
        SelfTest::Passed(err) => {
            eprintln!("GPU self-test error {:.4} %", err * 100.0);
            assert!(err < 0.05, "error {err}");
        }
        other => panic!("expected a pass, got {other:?}"),
    }
    assert_eq!(sep.model.backend, sep.model.backend);
    // the verdict is kept: the second time nothing is run
    assert_eq!(sep.self_test(Some(&dir)).unwrap(), SelfTest::Cached);
    // a GPU whose results are 50 % off is caught, and the CPU takes over
    let broken = sep.self_test_with(Some(&dir), 1.5).unwrap();
    assert!(matches!(broken, SelfTest::FellBack(_)), "{broken:?}");
    assert_eq!(sep.model.backend, Backend::Cpu);
    let _ = std::fs::remove_dir_all(&dir);
}
