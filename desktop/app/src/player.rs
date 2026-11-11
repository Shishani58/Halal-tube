//! The in-app player: watch a file with the music removed in sync with the picture.
//! The sound is `mr_core::player` (cleaned ahead of playback); the window shows the picture in a muted
//! video element that follows the position reported here.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct PlayerSlot {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    handle: Mutex<Option<mr_core::player::PlayerHandle>>,
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    _unused: Mutex<()>,
}

impl PlayerSlot {
    /// Stops the player (closing it, or the app quitting).
    pub fn shutdown(&self) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(h) = self.handle.lock().unwrap().take() {
            h.stop();
        }
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayerView {
    supported: bool,
    /// closed | loading | buffering | playing | paused | ended | error
    state: &'static str,
    position: f64,
    duration: f64,
    /// Seconds of cleaned sound ready ahead.
    buffered: f64,
    has_video: bool,
    backend: Option<String>,
    gpu_check_failed: bool,
    error_code: Option<String>,
    error_message: Option<String>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn view_of(slot: &PlayerSlot) -> PlayerView {
    use mr_core::player::PlayerState;
    use std::sync::atomic::Ordering;
    let guard = slot.handle.lock().unwrap();
    let Some(h) = guard.as_ref() else { return PlayerView { supported: true, state: "closed", ..Default::default() } };
    let s = &h.stats;
    let (code, msg) = s.error.lock().unwrap().clone().map(|(c, m)| (Some(c), Some(m))).unwrap_or((None, None));
    let view = PlayerView {
        supported: true,
        state: match s.state() {
            PlayerState::Loading => "loading",
            PlayerState::Buffering => "buffering",
            PlayerState::Playing => "playing",
            PlayerState::Paused => "paused",
            PlayerState::Ended => "ended",
            PlayerState::Error => "error",
        },
        position: s.position(),
        duration: s.duration(),
        buffered: s.buffered(),
        has_video: s.has_video.load(Ordering::Relaxed),
        backend: Some(s.backend.lock().unwrap().clone()).filter(|b| !b.is_empty()),
        gpu_check_failed: s.gpu_check_failed.load(Ordering::Relaxed),
        error_code: code,
        error_message: msg,
    };
    view
}

/// Opens `path` in the player (replacing the one open, and switching live mode off: both would play).
/// The window may then read the file through the asset protocol, for the picture.
#[tauri::command(async)]
pub fn player_open(app: AppHandle, slot: State<PlayerSlot>, live: State<crate::live::LiveSlot>, path: String, strength: u8, device: Option<String>) -> PlayerView {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use mr_core::media::Tools;
        use mr_core::player::{start, PlayerConfig};
        live.shutdown();
        slot.shutdown();
        let input = PathBuf::from(&path);
        let _ = app.asset_protocol_scope().allow_file(&input);
        let cache = app.path().app_cache_dir().ok().map(|d| d.join("coreml"));
        let tools = match Tools::locate() {
            Ok(t) => t,
            Err(e) => {
                return PlayerView { supported: true, state: "error", error_code: Some(e.code().into()), error_message: Some(e.to_string()), ..Default::default() };
            }
        };
        let cfg = PlayerConfig { model_path: crate::model_path(&app), cache_dir: cache, input, output_device: device.filter(|d| !d.is_empty()), strength: strength.min(100) };
        *slot.handle.lock().unwrap() = Some(start(tools, cfg));
        return view_of(&slot);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (&app, &slot, &live, &path, strength, &device);
        PlayerView { supported: false, state: "closed", ..Default::default() }
    }
}

#[tauri::command]
pub fn player_status(slot: State<PlayerSlot>) -> PlayerView {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        view_of(&slot)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = &slot;
        PlayerView { supported: false, state: "closed", ..Default::default() }
    }
}

#[tauri::command]
pub fn player_play(slot: State<PlayerSlot>) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(h) = slot.handle.lock().unwrap().as_ref() {
        // after the end, "play" starts over
        if h.stats.state() == mr_core::player::PlayerState::Ended {
            h.seek(0.0);
        }
        h.play();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = &slot;
}

#[tauri::command]
pub fn player_pause(slot: State<PlayerSlot>) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(h) = slot.handle.lock().unwrap().as_ref() {
        h.pause();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = &slot;
}

#[tauri::command]
pub fn player_seek(slot: State<PlayerSlot>, seconds: f64) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(h) = slot.handle.lock().unwrap().as_ref() {
        h.seek(seconds);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (&slot, seconds);
}

#[tauri::command]
pub fn player_set_strength(slot: State<PlayerSlot>, strength: u8) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(h) = slot.handle.lock().unwrap().as_ref() {
        h.set_strength(strength);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (&slot, strength);
}

#[tauri::command(async)]
pub fn player_close(slot: State<PlayerSlot>) {
    slot.shutdown();
}
