//! "Hide on screen" in the app: its switch and status for the UI. The work is `mr_core::screen`.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct ScreenSlot {
    #[cfg(target_os = "macos")]
    handle: Mutex<Option<mr_core::screen::ScreenHandle>>,
    #[cfg(not(target_os = "macos"))]
    _unused: Mutex<()>,
}

impl ScreenSlot {
    /// Stops it (the app is closing): the overlay goes away.
    pub fn shutdown(&self) {
        #[cfg(target_os = "macos")]
        if let Some(h) = self.handle.lock().unwrap().take() {
            h.stop();
        }
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenView {
    supported: bool,
    /// off | starting | loading | running | error
    state: &'static str,
    backend: Option<String>,
    /// Patches on the screen right now.
    regions: u32,
    /// The window being watched; None: the whole display.
    window: Option<u32>,
    /// Milliseconds the last look at the screen took.
    last_ms: u32,
    error_code: Option<String>,
    error_message: Option<String>,
}

#[cfg(target_os = "macos")]
fn view_of(slot: &ScreenSlot) -> ScreenView {
    use mr_core::screen::ScreenState;
    use std::sync::atomic::Ordering;
    let guard = slot.handle.lock().unwrap();
    let Some(h) = guard.as_ref() else { return ScreenView { supported: true, state: "off", ..Default::default() } };
    let s = &h.stats;
    let state = match s.state() {
        ScreenState::Starting => "starting",
        ScreenState::Loading => "loading",
        ScreenState::Running => "running",
        ScreenState::Stopped => "off",
        ScreenState::Error => "error",
    };
    let (code, msg) = s.error.lock().unwrap().clone().map(|(c, m)| (Some(c), Some(m))).unwrap_or((None, None));
    let view = ScreenView {
        supported: true,
        state,
        backend: Some(s.backend.lock().unwrap().clone()).filter(|b| !b.is_empty()),
        regions: s.regions.load(Ordering::Relaxed),
        window: h.window,
        last_ms: s.last_ms.load(Ordering::Relaxed),
        error_code: code,
        error_message: msg,
    };
    view
}

#[tauri::command(async)]
pub fn screen_start(app: AppHandle, slot: State<ScreenSlot>, window: Option<u32>, delay_ms: Option<u32>) -> ScreenView {
    #[cfg(target_os = "macos")]
    {
        use mr_core::screen::{self, ScreenConfig};
        {
            let mut guard = slot.handle.lock().unwrap();
            if guard.as_ref().map(|h| !h.is_finished()).unwrap_or(false) {
                drop(guard);
                return view_of(&slot);
            }
            if let Some(old) = guard.take() {
                old.stop(); // one that ended with an error
            }
            let cache = app.path().app_cache_dir().ok().map(|d| d.join("coreml"));
            *guard = Some(screen::start(ScreenConfig {
                nudenet: crate::model_file(&app, mr_core::NUDENET_FILE),
                gender: crate::model_file(&app, mr_core::GENDER_FILE),
                cache_dir: cache,
                window,
                delay_s: delay_ms.unwrap_or(400) as f64 / 1000.0,
            }));
        }
        return view_of(&slot);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &slot, window, delay_ms);
        ScreenView { supported: false, state: "off", ..Default::default() }
    }
}

#[tauri::command(async)]
pub fn screen_stop(slot: State<ScreenSlot>) -> ScreenView {
    slot.shutdown();
    screen_status(slot)
}

#[tauri::command]
pub fn screen_status(slot: State<ScreenSlot>) -> ScreenView {
    #[cfg(target_os = "macos")]
    {
        view_of(&slot)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &slot;
        ScreenView { supported: false, state: "off", ..Default::default() }
    }
}

/// The windows that can be chosen for the window mode.
#[tauri::command(async)]
pub fn screen_windows() -> Vec<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        mr_core::screen::list_windows()
            .into_iter()
            .map(|w| serde_json::json!({ "id": w.id, "app": w.app, "title": w.title, "width": w.width, "height": w.height }))
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

/// Window mode: how far the picture is held back (the live audio's latency plus the user's correction), milliseconds.
#[tauri::command]
pub fn screen_set_delay(slot: State<ScreenSlot>, delay_ms: u32) {
    #[cfg(target_os = "macos")]
    if let Some(h) = slot.handle.lock().unwrap().as_ref() {
        h.set_delay(delay_ms as f64 / 1000.0);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (&slot, delay_ms);
}
