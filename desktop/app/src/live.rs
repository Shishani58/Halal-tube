//! Live mode in the app: removes the music from everything the Mac plays, as it plays.
//! The audio work is `mr_core::live_session`; this is its switch, status and strength for the UI.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct LiveSlot {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    handle: Mutex<Option<mr_core::live_session::LiveHandle>>,
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    _unused: Mutex<()>,
}

impl LiveSlot {
    /// Stops a running session (the app is closing): the system's own output is heard again.
    pub fn shutdown(&self) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(h) = self.handle.lock().unwrap().take() {
            h.stop();
        }
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveView {
    supported: bool,
    /// off | starting | loading | capture | running | error
    state: &'static str,
    backend: Option<String>,
    /// Seconds between what is played and what is heard.
    latency: f64,
    /// Share of real time the model is busy (0–1), from its slowest recent run.
    load: f64,
    /// Something is playing (the capture is not silent).
    activity: bool,
    strength: u8,
    error_code: Option<String>,
    error_message: Option<String>,
    gpu_check_failed: bool,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn view_of(slot: &LiveSlot) -> LiveView {
    use mr_core::live_session::LiveState;
    use std::sync::atomic::Ordering;
    let guard = slot.handle.lock().unwrap();
    let Some(h) = guard.as_ref() else { return LiveView { supported: true, state: "off", strength: 100, ..Default::default() } };
    let s = &h.stats;
    let state = match s.state() {
        LiveState::Starting => "starting",
        LiveState::LoadingModel => "loading",
        LiveState::StartingCapture => "capture",
        LiveState::Running => "running",
        LiveState::Stopped => "off",
        LiveState::Error => "error",
    };
    let (code, msg) = s.error.lock().unwrap().clone().map(|(c, m)| (Some(c), Some(m))).unwrap_or((None, None));
    let view = LiveView {
        supported: true,
        state,
        backend: Some(s.backend.lock().unwrap().clone()).filter(|b| !b.is_empty()),
        latency: s.latency_seconds(),
        load: (s.worst_run_ms() as f64 / 1000.0).min(1.0),
        activity: s.take_input_peak() > 0.001,
        strength: s.strength.load(Ordering::Relaxed) as u8,
        error_code: code,
        error_message: msg,
        gpu_check_failed: s.gpu_check_failed.load(Ordering::Relaxed),
    };
    view
}

/// Output devices the sound can be played to (the default one marked); empty off macOS.
#[tauri::command]
pub fn live_devices() -> Vec<serde_json::Value> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        mr_core::live_session::list_output_devices().into_iter().map(|d| serde_json::json!({ "name": d.name, "isDefault": d.is_default })).collect()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Vec::new()
}

#[tauri::command(async)]
pub fn live_start(app: AppHandle, slot: State<LiveSlot>, strength: u8, device: Option<String>, capture_device: Option<String>) -> LiveView {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use mr_core::live_session::{self, LiveConfig};
        {
            let mut guard = slot.handle.lock().unwrap();
            if guard.as_ref().map(|h| !h.is_finished()).unwrap_or(false) {
                drop(guard);
                return view_of(&slot);
            }
            if let Some(old) = guard.take() {
                old.stop(); // a session that ended with an error
            }
            let cache = app.path().app_cache_dir().ok().map(|d| d.join("coreml"));
            let mut cfg = LiveConfig::new(crate::model_path(&app), cache);
            cfg.strength = strength.min(100);
            cfg.output_device = device.filter(|d| !d.is_empty());
            cfg.capture_device = capture_device.filter(|d| !d.is_empty());
            *guard = Some(live_session::start(cfg));
        }
        return view_of(&slot);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (&app, &slot, strength, &device, &capture_device);
        LiveView { supported: false, state: "off", ..Default::default() }
    }
}

#[tauri::command(async)]
pub fn live_stop(slot: State<LiveSlot>) -> LiveView {
    slot.shutdown();
    live_status(slot)
}

#[tauri::command]
pub fn live_status(slot: State<LiveSlot>) -> LiveView {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        view_of(&slot)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = &slot;
        LiveView { supported: false, state: "off", ..Default::default() }
    }
}

#[tauri::command]
pub fn live_set_strength(slot: State<LiveSlot>, strength: u8) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(h) = slot.handle.lock().unwrap().as_ref() {
        h.set_strength(strength);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (&slot, strength);
}
