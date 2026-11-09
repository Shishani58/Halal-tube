// Music Remover desktop app: a queue of files processed one at a time on a worker thread.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mr_core::job;
use mr_core::mdx::{Mdx, KIM_VOCAL_2};
use mr_core::media::{self, Tools};
use mr_core::model::{Model, Separator};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Queued,
    Running,
    Done,
    Error,
    Cancelled,
}

struct Job {
    id: u64,
    input: PathBuf,
    out_dir: Option<PathBuf>,
    suffix: String,
    output: Option<PathBuf>,
    status: Status,
    progress: f64,
    eta: Option<f64>,
    duration: Option<f64>,
    has_video: bool,
    error: Option<(String, String)>,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobView {
    id: u64,
    input: String,
    name: String,
    output: Option<String>,
    output_name: Option<String>,
    status: Status,
    progress: f64,
    eta: Option<f64>,
    duration: Option<f64>,
    is_video: bool,
    error_code: Option<String>,
    error_message: Option<String>,
}

impl Job {
    fn view(&self) -> JobView {
        let name_of = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let ext = media::ext_of(&self.input);
        JobView {
            id: self.id,
            input: self.input.to_string_lossy().to_string(),
            name: name_of(&self.input),
            output: self.output.as_ref().map(|p| p.to_string_lossy().to_string()),
            output_name: self.output.as_deref().map(name_of),
            status: self.status,
            progress: self.progress,
            eta: self.eta,
            duration: self.duration,
            is_video: self.has_video || media::VIDEO_EXTS.contains(&ext.as_str()),
            error_code: self.error.as_ref().map(|e| e.0.clone()),
            error_message: self.error.as_ref().map(|e| e.1.clone()),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineView {
    state: &'static str, // idle | loading | ready | error
    backend: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
}

struct AppState {
    jobs: Mutex<Vec<Job>>,
    tx: Mutex<Sender<u64>>,
    next_id: AtomicU64,
    engine: Mutex<EngineView>,
    /// Files opened via Finder ("Open With", Dock icon) or the command line, waiting for the UI
    /// to queue them with its current settings (language suffix, output folder).
    pending: Mutex<Vec<String>>,
}

fn push_pending(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    app.state::<AppState>().pending.lock().unwrap().extend(paths);
    let _ = app.emit("open-files", ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn take_pending_files(state: State<AppState>) -> Vec<String> {
    std::mem::take(&mut *state.pending.lock().unwrap())
}

fn emit_job(app: &AppHandle, job: &Job) {
    let _ = app.emit("job-update", job.view());
}

fn with_job<R>(app: &AppHandle, id: u64, f: impl FnOnce(&mut Job) -> R) -> Option<R> {
    let state = app.state::<AppState>();
    let mut jobs = state.jobs.lock().unwrap();
    let job = jobs.iter_mut().find(|j| j.id == id)?;
    let r = f(job);
    emit_job(app, job);
    Some(r)
}

fn set_engine(app: &AppHandle, view: EngineView) {
    *app.state::<AppState>().engine.lock().unwrap() = view.clone();
    let _ = app.emit("engine", view);
}

/// Expands dropped folders (one level) and keeps only supported media files.
fn collect_files(paths: Vec<String>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for p in paths.into_iter().map(PathBuf::from) {
        if p.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&p) {
                let mut inner: Vec<PathBuf> = rd
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.is_file() && media::is_supported(p) && !is_hidden(p))
                    .collect();
                inner.sort();
                out.extend(inner);
            }
        } else {
            out.push(p);
        }
    }
    out
}

fn is_hidden(p: &Path) -> bool {
    p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false)
}

#[tauri::command]
fn add_files(app: AppHandle, state: State<AppState>, paths: Vec<String>, suffix: String, out_dir: Option<String>) -> Vec<JobView> {
    let out_dir = out_dir.filter(|s| !s.is_empty()).map(PathBuf::from);
    let mut added = Vec::new();
    let mut jobs = state.jobs.lock().unwrap();
    for input in collect_files(paths) {
        // the same file already waiting or in progress → don't queue it twice
        if jobs.iter().any(|j| j.input == input && matches!(j.status, Status::Queued | Status::Running)) {
            continue;
        }
        let id = state.next_id.fetch_add(1, Ordering::Relaxed);
        let mut job = Job {
            id,
            input: input.clone(),
            out_dir: out_dir.clone(),
            suffix: suffix.clone(),
            output: None,
            status: Status::Queued,
            progress: 0.0,
            eta: None,
            duration: None,
            has_video: false,
            error: None,
            cancel: Arc::new(AtomicBool::new(false)),
        };
        if !input.is_file() {
            job.status = Status::Error;
            job.error = Some(("not_found".into(), input.to_string_lossy().to_string()));
        } else if !media::is_supported(&input) {
            job.status = Status::Error;
            job.error = Some(("unsupported".into(), media::ext_of(&input)));
        }
        let queued = job.status == Status::Queued;
        added.push(job.view());
        jobs.push(job);
        if queued {
            let _ = state.tx.lock().unwrap().send(id);
        }
    }
    drop(jobs);
    for v in &added {
        let _ = app.emit("job-update", v.clone());
    }
    added
}

#[tauri::command]
fn list_jobs(state: State<AppState>) -> Vec<JobView> {
    state.jobs.lock().unwrap().iter().map(Job::view).collect()
}

#[tauri::command]
fn engine_status(state: State<AppState>) -> EngineView {
    state.engine.lock().unwrap().clone()
}

#[tauri::command]
fn cancel_job(app: AppHandle, id: u64) {
    with_job(&app, id, |j| {
        j.cancel.store(true, Ordering::Relaxed);
        if j.status == Status::Queued {
            j.status = Status::Cancelled;
        }
    });
}

#[tauri::command]
fn remove_job(state: State<AppState>, id: u64) {
    let mut jobs = state.jobs.lock().unwrap();
    if let Some(j) = jobs.iter().find(|j| j.id == id) {
        j.cancel.store(true, Ordering::Relaxed);
    }
    jobs.retain(|j| j.id != id || j.status == Status::Running);
}

#[tauri::command]
fn clear_finished(state: State<AppState>) {
    state
        .jobs
        .lock()
        .unwrap()
        .retain(|j| matches!(j.status, Status::Queued | Status::Running));
}

fn model_path(app: &AppHandle) -> PathBuf {
    let bundled = app
        .path()
        .resource_dir()
        .map(|d| d.join("models").join(mr_core::MODEL_FILE))
        .ok()
        .filter(|p| p.exists());
    bundled.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(mr_core::MODEL_FILE))
}

fn worker(app: AppHandle, rx: Receiver<u64>) {
    let mut sep: Option<Separator> = None;
    let mut tools: Option<Tools> = None;
    while let Ok(id) = rx.recv() {
        // Pick up the job unless it was cancelled/removed while waiting.
        let picked = with_job(&app, id, |j| {
            if j.status != Status::Queued || j.cancel.load(Ordering::Relaxed) {
                return None;
            }
            j.status = Status::Running;
            Some((j.input.clone(), j.out_dir.clone(), j.suffix.clone(), j.cancel.clone()))
        })
        .flatten();
        let Some((input, out_dir, suffix, cancel)) = picked else { continue };

        let fail = |code: &str, msg: String| {
            with_job(&app, id, |j| {
                j.status = if code == "cancelled" { Status::Cancelled } else { Status::Error };
                j.error = if code == "cancelled" { None } else { Some((code.to_string(), msg)) };
            });
        };

        if tools.is_none() {
            match Tools::locate() {
                Ok(t) => tools = Some(t),
                Err(e) => {
                    fail(e.code(), e.to_string());
                    continue;
                }
            }
        }
        let tools_ref = tools.as_ref().unwrap();

        if sep.is_none() {
            set_engine(&app, EngineView { state: "loading", backend: None, error_code: None, error_message: None });
            let mdx = Mdx::new(KIM_VOCAL_2);
            let cache = app.path().app_cache_dir().ok().map(|d| d.join("coreml"));
            match Model::load(&model_path(&app), mdx.tensor_shape(), None, cache.as_deref()) {
                Ok(model) => {
                    set_engine(&app, EngineView {
                        state: "ready",
                        backend: Some(model.backend.label().to_string()),
                        error_code: None,
                        error_message: None,
                    });
                    sep = Some(Separator::new(mdx, model));
                }
                Err(e) => {
                    set_engine(&app, EngineView {
                        state: "error",
                        backend: None,
                        error_code: Some(e.code().into()),
                        error_message: Some(e.to_string()),
                    });
                    fail(e.code(), e.to_string());
                    continue;
                }
            }
        }
        let separator = sep.as_mut().unwrap();

        let prepared = match job::prepare(tools_ref, &input, out_dir.as_deref(), &suffix) {
            Ok(p) => p,
            Err(e) => {
                fail(e.code(), e.to_string());
                continue;
            }
        };
        with_job(&app, id, |j| {
            j.output = Some(prepared.output.clone());
            j.duration = Some(prepared.info.duration);
            j.has_video = prepared.info.has_video;
        });

        let started = Instant::now();
        let mut last_emit = Instant::now();
        let res = job::run(tools_ref, separator, &prepared, &cancel, |p| {
            if last_emit.elapsed().as_millis() < 150 && p < 1.0 {
                return;
            }
            last_emit = Instant::now();
            let elapsed = started.elapsed().as_secs_f64();
            let eta = if p > 0.02 { Some(elapsed / p * (1.0 - p)) } else { None };
            with_job(&app, id, |j| {
                j.progress = p;
                j.eta = eta;
            });
        });
        match res {
            Ok(out) => {
                with_job(&app, id, |j| {
                    j.status = Status::Done;
                    j.progress = 1.0;
                    j.eta = None;
                    j.output = Some(out);
                });
            }
            Err(e) => fail(e.code(), e.to_string()),
        }
    }
}

fn main() {
    let (tx, rx) = channel::<u64>();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            jobs: Mutex::new(Vec::new()),
            tx: Mutex::new(tx),
            next_id: AtomicU64::new(1),
            engine: Mutex::new(EngineView { state: "idle", backend: None, error_code: None, error_message: None }),
            pending: Mutex::new(Vec::new()),
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            // Windows/Linux file associations pass files as arguments.
            let args: Vec<String> = std::env::args().skip(1).filter(|a| Path::new(a).exists()).collect();
            push_pending(&handle, args);
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("mr-worker".into())
                .spawn(move || worker(handle, rx))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_files,
            list_jobs,
            engine_status,
            cancel_job,
            remove_job,
            clear_finished,
            take_pending_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building Music Remover")
        .run(|_app, _event| {
            // macOS delivers "Open With" / Dock-icon drops as an Opened event.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                push_pending(_app, paths);
            }
        });
}
