// Music Remover desktop app: a queue of files processed one at a time on a worker thread.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod live;
mod player;
mod screen;

use mr_core::blur::detect::Detector;
use mr_core::blur::job as blur_job;
use mr_core::job;
use mr_core::mdx::{Mdx, KIM_VOCAL_2};
use mr_core::media::{self, Tools};
use mr_core::model::{Model, SelfTest, Separator};
use mr_core::preview;
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
    /// Share of the clean voice in the output, percent (the rest is the original track).
    strength: u8,
    /// Remove the music / hide nudity and women (video only).
    music: bool,
    blur: bool,
    /// What the worker is doing now: "music" | "scan" | "blur" ("" while waiting).
    stage: &'static str,
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
    music: bool,
    blur: bool,
    stage: &'static str,
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
            music: self.music,
            blur: self.blur,
            stage: self.stage,
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
    /// The GPU computed wrong numbers in the self-test and the CPU is used instead.
    gpu_check_failed: bool,
}

struct AppState {
    jobs: Mutex<Vec<Job>>,
    tx: Mutex<Sender<u64>>,
    next_id: AtomicU64,
    engine: Mutex<EngineView>,
    /// Files opened via Finder ("Open With", Dock icon) or the command line, waiting for the UI
    /// to queue them with its current settings (language suffix, output folder).
    pending: Mutex<Vec<String>>,
    /// `--play FILE` on the command line: opened in the player once the window asks.
    pending_play: Mutex<Option<String>>,
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
fn take_pending_play(state: State<AppState>) -> Option<String> {
    state.pending_play.lock().unwrap().take()
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
fn add_files(app: AppHandle, state: State<AppState>, paths: Vec<String>, suffix: String, out_dir: Option<String>, strength: Option<u8>, music: Option<bool>, blur: Option<bool>) -> Vec<JobView> {
    let blur = blur.unwrap_or(false);
    let music = music.unwrap_or(true) || !blur; // something must be done
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
            strength: strength.unwrap_or(100).min(100),
            music,
            blur,
            stage: "",
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewView {
    start: f64,
    length: f64,
}

fn preview_file(app: &AppHandle, id: u64, which: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("preview");
    Ok(dir.join(format!("{id}-{which}.wav")))
}

/// Cuts the same ~30 s stretch (starting at `position`, 0..1 of the file) out of the original and the
/// cleaned file, so the UI can switch between them while listening.
#[tauri::command(async)]
fn prepare_preview(app: AppHandle, state: State<AppState>, id: u64, position: f64) -> Result<PreviewView, String> {
    let (input, output, duration) = {
        let jobs = state.jobs.lock().unwrap();
        let j = jobs.iter().find(|j| j.id == id).ok_or("no such job")?;
        if j.status != Status::Done {
            return Err("not finished".into());
        }
        (j.input.clone(), j.output.clone().ok_or("no output")?, j.duration.unwrap_or(0.0))
    };
    let tools = Tools::locate().map_err(|e| e.to_string())?;
    let (start, length) = preview::window(duration, position);
    preview::cut_clip(&tools, &input, start, length, &preview_file(&app, id, "before")?).map_err(|e| e.to_string())?;
    preview::cut_clip(&tools, &output, start, length, &preview_file(&app, id, "after")?).map_err(|e| e.to_string())?;
    Ok(PreviewView { start, length })
}

/// The WAV bytes of one side of the preview ("before" / "after"), sent raw (not as a JSON array).
#[tauri::command(async)]
fn preview_bytes(app: AppHandle, id: u64, which: String) -> Result<tauri::ipc::Response, String> {
    if which != "before" && which != "after" {
        return Err("bad side".into());
    }
    std::fs::read(preview_file(&app, id, &which)?).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Drops the preview clips (they are only needed while listening).
#[tauri::command(async)]
fn clear_preview(app: AppHandle, id: u64) {
    for w in ["before", "after"] {
        if let Ok(p) = preview_file(&app, id, w) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// A model file: bundled in the app's resources, else the repository's `models/` (development).
pub(crate) fn model_file(app: &AppHandle, file: &str) -> PathBuf {
    let bundled = app.path().resource_dir().map(|d| d.join("models").join(file)).ok().filter(|p| p.exists());
    bundled.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models").join(file))
}

pub(crate) fn model_path(app: &AppHandle) -> PathBuf {
    model_file(app, mr_core::MODEL_FILE)
}

/// The loaded engines, kept between jobs.
#[derive(Default)]
struct Engines {
    tools: Option<Tools>,
    sep: Option<Separator>,
    detector: Option<Detector>,
}

struct Picked {
    input: PathBuf,
    out_dir: Option<PathBuf>,
    suffix: String,
    strength: u8,
    music: bool,
    blur: bool,
    cancel: Arc<AtomicBool>,
}

/// Loads the separation model (and runs its GPU self-test) unless it is loaded.
fn ensure_separator(app: &AppHandle, eng: &mut Engines) -> Result<(), mr_core::Error> {
    if eng.sep.is_some() {
        return Ok(());
    }
    set_engine(app, EngineView { state: "loading", backend: None, error_code: None, error_message: None, gpu_check_failed: false });
    let mdx = Mdx::new(KIM_VOCAL_2);
    let cache = app.path().app_cache_dir().ok().map(|d| d.join("coreml"));
    match Model::load(&model_path(app), mdx.tensor_shape(), None, cache.as_deref()) {
        Ok(model) => {
            let mut s = Separator::new(mdx, model);
            // CoreML / DirectML can compute wrong numbers without an error: compare with the CPU once
            // (the verdict is kept for a month); on a mismatch the CPU is used
            let check = s.self_test(app.path().app_cache_dir().ok().map(|d| d.join("selftest")).as_deref());
            let failed = matches!(check, Ok(SelfTest::FellBack(_)));
            if let Ok(SelfTest::FellBack(why)) = &check {
                eprintln!("GPU self-test failed ({why}): using the CPU");
            }
            set_engine(app, EngineView { state: "ready", backend: Some(s.model.backend.label().to_string()), error_code: None, error_message: None, gpu_check_failed: failed });
            eng.sep = Some(s);
            Ok(())
        }
        Err(e) => {
            set_engine(app, EngineView { state: "error", backend: None, error_code: Some(e.code().into()), error_message: Some(e.to_string()), gpu_check_failed: false });
            Err(e)
        }
    }
}

fn ensure_detector(app: &AppHandle, eng: &mut Engines) -> Result<(), mr_core::Error> {
    if eng.detector.is_none() {
        let cache = app.path().app_cache_dir().ok().map(|d| d.join("coreml"));
        eng.detector = Some(Detector::load(&model_file(app, mr_core::NUDENET_FILE), &model_file(app, mr_core::GENDER_FILE), cache.as_deref())?);
    }
    Ok(())
}

/// Runs the stages a job asks for: remove the music, then hide people. With both, the music-free file is an
/// intermediate (a hidden file next to the result) that the blur stage reads, and it is deleted afterwards.
fn run_job(app: &AppHandle, id: u64, eng: &mut Engines, p: &Picked) -> Result<PathBuf, mr_core::Error> {
    use mr_core::Error;
    if eng.tools.is_none() {
        eng.tools = Some(Tools::locate()?);
    }
    let tools = eng.tools.clone().unwrap();

    // What the file is, and where the results go.
    let prepared = if p.music { Some(job::prepare(&tools, &p.input, p.out_dir.as_deref(), &p.suffix)?) } else { None };
    let has_video = match &prepared {
        Some(pr) => pr.info.has_video,
        None => match tools.probe(&p.input) {
            Ok(i) => i.has_video,
            Err(Error::NoAudio) => true, // a silent video: fine for blurring
            Err(e) => return Err(e),
        },
    };
    let blur = p.blur && has_video;
    if !p.music && !blur {
        return Err(Error::NoVideo);
    }
    let vinfo = if blur { Some(blur_job::probe_video(&tools, &p.input)?) } else { None };
    let duration = prepared.as_ref().map(|pr| pr.info.duration).or(vinfo.as_ref().map(|v| v.duration)).unwrap_or(0.0);
    let final_path = if blur {
        let ext = blur_job::container_for(&prepared.as_ref().map(|pr| pr.plan.ext.clone()).unwrap_or_else(|| media::ext_of(&p.input)));
        media::output_path(&p.input, p.out_dir.as_deref(), &p.suffix, ext)
    } else {
        prepared.as_ref().unwrap().output.clone()
    };
    with_job(app, id, |j| {
        j.output = Some(final_path.clone());
        j.duration = Some(duration);
        j.has_video = has_video;
    });

    // Shares of the progress bar.
    let (w_music, w_scan) = match (p.music, blur) {
        (true, true) => (0.4, 0.15),
        (true, false) => (1.0, 0.0),
        (false, _) => (0.0, 0.15),
    };
    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut report = |base: f64, weight: f64, p: f64| {
        let total = base + weight * p;
        if last_emit.elapsed().as_millis() < 150 && p < 1.0 {
            return;
        }
        last_emit = Instant::now();
        let eta = if total > 0.02 { Some(started.elapsed().as_secs_f64() / total * (1.0 - total)) } else { None };
        with_job(app, id, |j| {
            j.progress = total.min(1.0);
            j.eta = eta;
        });
    };

    let mut intermediate: Option<PathBuf> = None;
    let outcome = (|| -> Result<PathBuf, Error> {
        let mut source = p.input.clone();
        if let Some(pr) = &prepared {
            ensure_separator(app, eng)?;
            with_job(app, id, |j| j.stage = "music");
            let target = if blur { pr.output.with_file_name(format!(".mr-tmp-{id}.{}", pr.plan.ext)) } else { pr.output.clone() };
            let pr = job::Prepared { output: target.clone(), ..pr.clone() };
            if blur {
                intermediate = Some(target);
            }
            let sep = eng.sep.as_mut().unwrap();
            let opts = job::Options { strength: p.strength as f32 / 100.0, keep_plain_speech: true };
            let done = job::run_with(&tools, sep, &pr, &opts, &p.cancel, |x| report(0.0, w_music, x))?;
            if !blur {
                return Ok(done);
            }
            source = done;
        }
        let vinfo = vinfo.as_ref().unwrap();
        ensure_detector(app, eng)?;
        with_job(app, id, |j| j.stage = "scan");
        let det = eng.detector.as_mut().unwrap();
        let timeline = blur_job::analyze(&tools, det, &source, vinfo, &p.cancel, |x| report(w_music, w_scan, x))?;
        with_job(app, id, |j| j.stage = "blur");
        blur_job::render(&tools, &source, &final_path, vinfo, &timeline, &p.cancel, |x| report(w_music + w_scan, 1.0 - w_music - w_scan, x))?;
        Ok(final_path.clone())
    })();
    if let Some(tmp) = intermediate {
        let _ = std::fs::remove_file(tmp);
    }
    outcome
}

fn worker(app: AppHandle, rx: Receiver<u64>) {
    let mut eng = Engines::default();
    while let Ok(id) = rx.recv() {
        // Pick up the job unless it was cancelled/removed while waiting.
        let picked = with_job(&app, id, |j| {
            if j.status != Status::Queued || j.cancel.load(Ordering::Relaxed) {
                return None;
            }
            j.status = Status::Running;
            Some(Picked {
                input: j.input.clone(),
                out_dir: j.out_dir.clone(),
                suffix: j.suffix.clone(),
                strength: j.strength,
                music: j.music,
                blur: j.blur,
                cancel: j.cancel.clone(),
            })
        })
        .flatten();
        let Some(picked) = picked else { continue };

        let fail = |code: &str, msg: String| {
            with_job(&app, id, |j| {
                j.status = if code == "cancelled" { Status::Cancelled } else { Status::Error };
                j.error = if code == "cancelled" { None } else { Some((code.to_string(), msg)) };
                j.stage = "";
            });
        };
        // A panic must fail this job, not leave it (and the queue behind it) "running" forever.
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_job(&app, id, &mut eng, &picked))) {
            Ok(Ok(out)) => {
                with_job(&app, id, |j| {
                    j.status = Status::Done;
                    j.progress = 1.0;
                    j.eta = None;
                    j.stage = "";
                    j.output = Some(out);
                });
            }
            Ok(Err(e)) => fail(e.code(), e.to_string()),
            Err(panic) => {
                let msg = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unexpected error".into());
                eng.sep = None; // their state may be inconsistent: reload for the next job
                eng.detector = None;
                fail("internal", msg);
            }
        }
    }
}

fn main() {
    let (tx, rx) = channel::<u64>();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(live::LiveSlot::default())
        .manage(player::PlayerSlot::default())
.manage(screen::ScreenSlot::default())
        .manage(AppState {
            jobs: Mutex::new(Vec::new()),
            tx: Mutex::new(tx),
            next_id: AtomicU64::new(1),
            engine: Mutex::new(EngineView { state: "idle", backend: None, error_code: None, error_message: None, gpu_check_failed: false }),
            pending: Mutex::new(Vec::new()),
            pending_play: Mutex::new(None),
        })
        .setup(move |app| {
            // preview clips don't outlive a run
            if let Ok(dir) = app.path().app_cache_dir() {
                let _ = std::fs::remove_dir_all(dir.join("preview"));
            }
            let handle = app.handle().clone();
            // Windows/Linux file associations pass files as arguments.
            let mut args: Vec<String> = std::env::args().skip(1).collect();
            if let Some(i) = args.iter().position(|a| a == "--play") {
                // `--play FILE`: watch it right away
                if let Some(file) = args.get(i + 1).cloned() {
                    *handle.state::<AppState>().pending_play.lock().unwrap() = Some(file);
                    let _ = handle.emit("play-file", ());
                }
                args.drain(i..(i + 2).min(args.len()));
            }
            if let Some(i) = args.iter().position(|a| a == "--overlay-demo") {
                // `--overlay-demo`: two blurred patches for 8 s, to see what the overlay looks like (no capture, no permission)
                args.remove(i);
                #[cfg(target_os = "macos")]
                std::thread::spawn(|| {
                    use mr_core::blur::Rect;
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    mr_core::screen::show_regions(&[Rect::new(0.55, 0.15, 0.3, 0.4), Rect::new(0.1, 0.6, 0.25, 0.25)]);
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    mr_core::screen::show_regions(&[]);
                });
            }
            let args: Vec<String> = args.into_iter().filter(|a| Path::new(a).exists()).collect();
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
            take_pending_files,
            take_pending_play,
            prepare_preview,
            preview_bytes,
            clear_preview,
            live::live_devices,
            live::live_start,
            live::live_stop,
            live::live_status,
            live::live_set_strength,
            player::player_open,
            player::player_status,
            player::player_play,
            player::player_pause,
            player::player_seek,
            player::player_set_strength,
            player::player_close,
screen::screen_start,
screen::screen_stop,
screen::screen_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building Music Remover")
        .run(|_app, _event| {
            // release the audio tap when the app quits: the system's own output is heard again
            if let tauri::RunEvent::Exit = _event {
                _app.state::<live::LiveSlot>().shutdown();
                _app.state::<player::PlayerSlot>().shutdown();
_app.state::<screen::ScreenSlot>().shutdown();
            }
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
