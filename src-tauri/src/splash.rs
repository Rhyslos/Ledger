//! The small window Ledger opens first to check for an update (splash.html, src/splash.js). The
//! main window loads hidden meanwhile and shows when the splash is done: no update, the check
//! took too long, or you chose Later. Off with the setting "updateOnStart": false, and in
//! development builds (unless LEDGER_SPLASH is set).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

static READY: AtomicBool = AtomicBool::new(false);
static DONE: AtomicBool = AtomicBool::new(false);

fn wanted(app: &AppHandle) -> bool {
    if cfg!(debug_assertions) && std::env::var_os("LEDGER_SPLASH").is_none() {
        return false;
    }
    let settings = app.path().app_config_dir().ok().and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok());
    let v: serde_json::Value = settings.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    v["updateOnStart"].as_bool() != Some(false)
}

/// At start: the splash, or the main window straight away.
pub fn start(app: &AppHandle) {
    if !wanted(app) {
        show_main(app);
        return;
    }
    let built = WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
        .title("Ledger")
        .inner_size(420.0, 250.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .center()
        .focused(true)
        .build();
    if built.is_err() {
        show_main(app);
        return;
    }
    // If the splash page never starts (a broken build, say), don't leave Ledger invisible.
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(10));
        if !READY.load(Ordering::SeqCst) {
            finish(&a);
        }
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn finish(app: &AppHandle) {
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    show_main(app);
    if let Some(s) = app.get_webview_window("splash") {
        let _ = s.destroy();
    }
}

/// The splash page is running (so the safety net above can stand down).
#[tauri::command]
pub fn splash_ready() {
    READY.store(true, Ordering::SeqCst);
}

/// No update to install now: show Ledger.
#[tauri::command]
pub fn splash_done(app: AppHandle) {
    finish(&app);
}
