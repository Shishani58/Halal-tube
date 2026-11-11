//! ONNX Runtime wrapper for the separation model.
//!
//! Uses the platform GPU path when available (CoreML on macOS, DirectML on Windows)
//! and falls back to the CPU.

use crate::mdx::Mdx;
use crate::Error;
use ort::session::{builder::GraphOptimizationLevel, builder::SessionBuilder, Session};
use ort::value::TensorRef;
use std::path::{Path, PathBuf};
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
    /// The model file (the self-test loads a CPU copy of it).
    path: PathBuf,
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
        Ok(Model { session, shape, backend, path: path.to_path_buf() })
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

/// A plain ONNX network with one f32 input and one f32 output (the blur detectors use these).
pub struct Net {
    session: Session,
    pub backend: Backend,
}

impl Net {
    /// Loads `path` on the GPU when `gpu` (falling back to the CPU if that fails to load or run), else on the CPU.
    /// `probe_shape` is run once on zeros: a broken GPU path fails here, not mid-file.
    pub fn load(path: &Path, probe_shape: &[usize], gpu: bool, cache_dir: Option<&Path>) -> Result<Self, Error> {
        if !path.exists() {
            return Err(Error::ModelMissing(path.to_path_buf()));
        }
        let order: &[Backend] = if gpu { &[Backend::Gpu, Backend::Cpu] } else { &[Backend::Cpu] };
        let mut last: Option<Error> = None;
        for &backend in order {
            let built = (|| -> Result<Session, Error> {
                let mut builder = Session::builder(environment()?)?
                    .with_optimization_level(GraphOptimizationLevel::Level3)?
                    .with_intra_threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4))?;
                if backend == Backend::Gpu {
                    builder = add_gpu_provider(builder, cache_dir)?;
                }
                Ok(builder.commit_from_file(path)?)
            })();
            match built {
                Ok(session) => {
                    let mut net = Net { session, backend };
                    match net.run(probe_shape, &vec![0f32; probe_shape.iter().product()]) {
                        Ok(_) => return Ok(net),
                        Err(e) => last = Some(e),
                    }
                }
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| Error::Model("no backend".into())))
    }

    /// Runs the network on one input tensor; returns the first output, flattened.
    pub fn run(&mut self, shape: &[usize], data: &[f32]) -> Result<Vec<f32>, Error> {
        let tensor = TensorRef::from_array_view((shape.to_vec(), data))?;
        let outputs = self.session.run(ort::inputs![tensor])?;
        let (_, out) = outputs[0].try_extract_tensor::<f32>()?;
        Ok(out.to_vec())
    }
}

/// What the GPU self-test found (see [`Separator::self_test`]).
#[derive(Clone, Debug, PartialEq)]
pub enum SelfTest {
    /// The GPU matched the CPU (relative error).
    Passed(f64),
    /// Passed on an earlier run (the verdict is kept for a month per model file and backend).
    Cached,
    /// Nothing to check: already on the CPU.
    Skipped,
    /// The GPU computed wrong numbers: the CPU is used now. Says why.
    FellBack(String),
}

/// ONNX Runtime version, part of the key of a kept self-test verdict.
const ORT_VERSION: &str = "2.0.0-rc.15";
/// How long a passed self-test is trusted.
const VERDICT_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 3600);

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

    /// Checks that the GPU computes what the CPU does, on a fixed realistic signal; on a mismatch
    /// switches to the CPU. The CPU run takes a few seconds, so a passed verdict is kept in
    /// `cache_dir` (per model file size, backend and ONNX Runtime version, for a month).
    pub fn self_test(&mut self, cache_dir: Option<&Path>) -> Result<SelfTest, Error> {
        self.self_test_with(cache_dir, 1.0)
    }

    /// [`Self::self_test`] with the GPU output scaled by `tamper` (tests use it to simulate a broken GPU).
    pub fn self_test_with(&mut self, cache_dir: Option<&Path>, tamper: f32) -> Result<SelfTest, Error> {
        use crate::selftest::{compare_samples, sample_output, test_audio, MAX_ERR, SAMPLES};
        if self.model.backend == Backend::Cpu {
            return Ok(SelfTest::Skipped);
        }
        let size = std::fs::metadata(&self.model.path).map(|m| m.len()).unwrap_or(0);
        let verdict = cache_dir.map(|d| d.join(format!("selftest-{size}-{}-{ORT_VERSION}.ok", self.model.backend.label())));
        if tamper == 1.0 {
            if let Some(v) = &verdict {
                let fresh = std::fs::metadata(v).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|age| age < VERDICT_MAX_AGE);
                if fresh == Some(true) {
                    return Ok(SelfTest::Cached);
                }
            }
        }
        let (l, r) = test_audio(self.mdx.chunk_size, self.mdx.cfg.sample_rate, 20240601);
        let mut spec = vec![0f32; self.mdx.tensor_len()];
        self.mdx.stft(&l, &r, &mut spec);
        let gpu: Vec<f32> = self.model.run(&spec)?.into_iter().map(|x| x * tamper).collect();
        let mut cpu = Self::cpu_copy(&self.model)?;
        let reference = cpu.run(&spec)?;
        match compare_samples(&sample_output(&gpu, SAMPLES), &sample_output(&reference, SAMPLES), MAX_ERR) {
            Ok(err) => {
                if let Some(v) = &verdict {
                    if let Some(dir) = v.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::write(v, format!("{err}"));
                }
                Ok(SelfTest::Passed(err))
            }
            Err(why) => {
                self.model = cpu;
                Ok(SelfTest::FellBack(why))
            }
        }
    }

    fn cpu_copy(m: &Model) -> Result<Model, Error> {
        Model::try_load(&m.path, m.shape, Backend::Cpu, None)
    }

    /// Stereo input of `chunk_size` samples → separated voice, `gen_size` samples per channel.
    pub fn separate_window(&mut self, left: &[f32], right: &[f32], out_l: &mut [f32], out_r: &mut [f32]) -> Result<(), Error> {
        self.mdx.stft(left, right, &mut self.spec);
        let pred = self.model.run(&self.spec)?;
        self.mdx.istft_trimmed(&pred, out_l, out_r);
        Ok(())
    }
}
