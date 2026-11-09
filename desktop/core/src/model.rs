//! ONNX Runtime wrapper for the separation model.
//!
//! Uses the platform GPU path when available (CoreML on macOS, DirectML on Windows)
//! and falls back to the CPU.

use crate::mdx::Mdx;
use crate::Error;
use ort::session::{builder::GraphOptimizationLevel, builder::SessionBuilder, Session};
use ort::value::TensorRef;
use std::path::Path;
use std::sync::OnceLock;

fn environment() -> Result<&'static ort::environment::Environment, Error> {
    static ENV: OnceLock<ort::environment::Environment> = OnceLock::new();
    if let Some(e) = ENV.get() {
        return Ok(e);
    }
    let env = ort::init().with_name("music-remover").with_telemetry(false).build()?;
    Ok(ENV.get_or_init(|| env))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Gpu,
    Cpu,
}

impl Backend {
    pub fn label(self) -> &'static str {
        match self {
            Backend::Gpu => if cfg!(target_os = "macos") { "CoreML" } else { "DirectML" },
            Backend::Cpu => "CPU",
        }
    }
}

pub struct Model {
    session: Session,
    shape: [usize; 4],
    pub backend: Backend,
}

impl Model {
    /// Loads the model. `prefer` = None tries the GPU first, then the CPU.
    pub fn load(path: &Path, shape: [usize; 4], prefer: Option<Backend>, cache_dir: Option<&Path>) -> Result<Self, Error> {
        if !path.exists() {
            return Err(Error::ModelMissing(path.to_path_buf()));
        }
        let order: &[Backend] = match prefer {
            Some(Backend::Cpu) => &[Backend::Cpu],
            Some(Backend::Gpu) => &[Backend::Gpu],
            None => &[Backend::Gpu, Backend::Cpu],
        };
        let mut last: Option<Error> = None;
        for &b in order {
            match Self::try_load(path, shape, b, cache_dir) {
                Ok(mut m) => {
                    // warm-up: the first run compiles kernels, and a broken GPU path fails here
                    let zeros = vec![0f32; shape.iter().product()];
                    match m.run(&zeros) {
                        Ok(_) => return Ok(m),
                        Err(e) => last = Some(e),
                    }
                }
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| Error::Model("no backend".into())))
    }

    fn try_load(path: &Path, shape: [usize; 4], backend: Backend, cache_dir: Option<&Path>) -> Result<Self, Error> {
        let mut builder = Session::builder(environment()?)?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4))?;
        if backend == Backend::Gpu {
            builder = add_gpu_provider(builder, cache_dir)?;
        }
        let session = builder.commit_from_file(path)?;
        Ok(Model { session, shape, backend })
    }

    /// Runs one model window. Input and output have `shape` = [1, 4, dim_f, dim_t].
    pub fn run(&mut self, input: &[f32]) -> Result<Vec<f32>, Error> {
        let tensor = TensorRef::from_array_view((self.shape, input))?;
        let outputs = self.session.run(ort::inputs![tensor])?;
        let (_, data) = outputs[0].try_extract_tensor::<f32>()?;
        Ok(data.to_vec())
    }
}

#[cfg(target_os = "macos")]
fn add_gpu_provider(builder: SessionBuilder, cache_dir: Option<&Path>) -> Result<SessionBuilder, Error> {
    use ort::ep::coreml::{ComputeUnits, ModelFormat};
    use ort::ep::{CoreML, ExecutionProvider};
    let mut ep = CoreML::default()
        .with_model_format(ModelFormat::MLProgram)
        .with_compute_units(ComputeUnits::CPUAndGPU);
    if let Some(dir) = cache_dir {
        let _ = std::fs::create_dir_all(dir);
        ep = ep.with_model_cache_dir(dir.to_string_lossy());
    }
    if !CoreML::is_available().unwrap_or(false) {
        return Err(Error::Model("CoreML unavailable".into()));
    }
    Ok(builder.with_execution_providers([ep.build().error_on_failure()])?)
}

#[cfg(target_os = "windows")]
fn add_gpu_provider(builder: SessionBuilder, _cache_dir: Option<&Path>) -> Result<SessionBuilder, Error> {
    use ort::ep::{DirectML, ExecutionProvider};
    let ep = DirectML::default();
    if !DirectML::is_available().unwrap_or(false) {
        return Err(Error::Model("DirectML unavailable".into()));
    }
    Ok(builder.with_execution_providers([ep.build().error_on_failure()])?)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn add_gpu_provider(_builder: SessionBuilder, _cache_dir: Option<&Path>) -> Result<SessionBuilder, Error> {
    Err(Error::Model("no GPU provider on this platform".into()))
}

/// Model + DSP state for separating stereo windows.
pub struct Separator {
    pub mdx: Mdx,
    pub model: Model,
    spec: Vec<f32>,
}

impl Separator {
    pub fn new(mdx: Mdx, model: Model) -> Self {
        let spec = vec![0f32; mdx.tensor_len()];
        Separator { mdx, model, spec }
    }

    /// Stereo input of `chunk_size` samples → separated voice, `gen_size` samples per channel.
    pub fn separate_window(&mut self, left: &[f32], right: &[f32], out_l: &mut [f32], out_r: &mut [f32]) -> Result<(), Error> {
        self.mdx.stft(left, right, &mut self.spec);
        let pred = self.model.run(&self.spec)?;
        self.mdx.istft_trimmed(&pred, out_l, out_r);
        Ok(())
    }
}
