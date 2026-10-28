//! The link between the `ledger` terminal command and the window it was typed in.
//!
//! Ledger's terminals get three variables: LEDGER_LINK (a port on 127.0.0.1), LEDGER_TOKEN and
//! LEDGER_WINDOW. `ledger` connects, sends one JSON line { token, window, cmd, args } and reads one
//! JSON line back: { ok, value } or { ok: false, error }. Only programs started from Ledger's
//! terminals know the token. Some requests are answered here (history); the rest go to the window
//! as a "cli-request" event, and the window answers with cli_reply.
//!
//! The terminals also get a folder first on PATH holding `ledger` (a copy of ledger-cli, so the
//! command doesn't clash with Ledger.exe itself).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

struct Link {
    port: u16,
    token: String,
}
static LINK: OnceLock<Link> = OnceLock::new();
static WAITING: OnceLock<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);
static OPEN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static CLI_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static VERSION: OnceLock<String> = OnceLock::new();

fn waiting() -> &'static Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>> {
    WAITING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A random token as hex: RandomState's 128-bit keys come from the system's random source.
fn new_token() -> String {
    let mut out = String::new();
    for i in 0..4u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// Starts listening (once, when Ledger starts) and puts the `ledger` command in place.
pub fn start(app: AppHandle) {
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else { return };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
    // Development builds can be given the token, so the command can be tried without a terminal.
    #[cfg(debug_assertions)]
    let token = std::env::var("LEDGER_TEST_TOKEN").unwrap_or_else(|_| new_token());
    #[cfg(not(debug_assertions))]
    let token = new_token();
    if cfg!(debug_assertions) {
        eprintln!("ledger link on 127.0.0.1:{port}");
    }
    let _ = LINK.set(Link { port, token });
    let _ = VERSION.set(app.package_info().version.to_string());
    if let Ok(d) = app.path().app_local_data_dir() {
        let _ = DATA_DIR.set(d);
    }
    // Before any terminal opens, so the first one already has `ledger` (an unchanged copy is
    // only a size and date check).
    let _ = CLI_DIR.set(install_cli(&app));
    let a2 = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            // A few at a time: anything can connect to the port (without the token it gets nowhere,
            // but it could hold connections open).
            if OPEN.load(Ordering::Relaxed) >= 16 {
                continue;
            }
            OPEN.fetch_add(1, Ordering::Relaxed);
            let app = a2.clone();
            std::thread::spawn(move || {
                handle(app, stream);
                OPEN.fetch_sub(1, Ordering::Relaxed);
            });
        }
    });
}

/// The variables a terminal of window `label` gets, and the folder to put first on PATH.
pub fn terminal_env(label: &str) -> (Vec<(String, String)>, Option<PathBuf>) {
    let vars = match LINK.get() {
        Some(l) => vec![("LEDGER_LINK".into(), l.port.to_string()), ("LEDGER_TOKEN".into(), l.token.clone()), ("LEDGER_WINDOW".into(), label.to_string())],
        None => vec![],
    };
    let mut vars = vars;
    if let Some(v) = VERSION.get() {
        vars.push(("LEDGER_VERSION".into(), v.clone()));
    }
    if let Some(d) = DATA_DIR.get() {
        vars.push(("LEDGER_DATA".into(), d.display().to_string()));
    }
    (vars, CLI_DIR.get().cloned().flatten())
}

/// Copies ledger-cli (next to Ledger's own program) to <app data>/cli/ledger, when it changed.
fn install_cli(app: &AppHandle) -> Option<PathBuf> {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let here = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let src = here.join(format!("ledger-cli{ext}"));
    if !src.is_file() {
        return None;
    }
    let dir = app.path().app_local_data_dir().ok()?.join("cli");
    std::fs::create_dir_all(&dir).ok()?;
    let dst = dir.join(format!("ledger{ext}"));
    let same = |a: &std::fs::Metadata, b: &std::fs::Metadata| a.len() == b.len() && a.modified().ok() <= b.modified().ok();
    let fresh = match (std::fs::metadata(&src), std::fs::metadata(&dst)) {
        (Ok(s), Ok(d)) => same(&s, &d),
        _ => false,
    };
    if !fresh {
        // Through a temporary name, so a half-copied `ledger` never runs. A copy that's running
        // right now can't be replaced on Windows: the next start tries again.
        let tmp = dir.join(format!("ledger.new{ext}"));
        if std::fs::copy(&src, &tmp).is_ok() && std::fs::rename(&tmp, &dst).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
    dst.is_file().then_some(dir)
}

fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn handle(app: AppHandle, mut stream: TcpStream) {
    // The whole request within 10 seconds, however slowly it trickles in.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() || buf.len() > (4 << 20) {
            return;
        }
        let _ = stream.set_read_timeout(Some(left));
        match (&stream).read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
        }
    }
    let line = String::from_utf8_lossy(&buf).into_owned();
    let reply = match serde_json::from_str::<Value>(&line) {
        Ok(req) => answer(&app, &req),
        Err(_) => Err("Not a request.".into()),
    };
    let out = match reply {
        Ok(v) => json!({ "ok": true, "value": v }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    let _ = stream.write_all(format!("{out}\n").as_bytes());
}

fn answer(app: &AppHandle, req: &Value) -> Result<Value, String> {
    let link = LINK.get().ok_or("Ledger isn't ready.")?;
    if !same_token(req["token"].as_str().unwrap_or(""), &link.token) {
        return Err("This isn't one of Ledger's terminals.".into());
    }
    let window = req["window"].as_str().unwrap_or("").to_string();
    let cmd = req["cmd"].as_str().unwrap_or("");
    let args = &req["args"];
    match cmd {
        "ping" => return Ok(json!({ "window": window })),
        "history_list" => return super::history_list(app.clone(), args["path"].as_str().unwrap_or("").into()).map(|v| json!(v)),
        "history_read" => return super::history_read(app.clone(), args["path"].as_str().unwrap_or("").into(), args["id"].as_str().unwrap_or("").into()).map(Value::String),
        _ => {}
    }
    if app.get_webview_window(&window).is_none() {
        return Err("The Ledger window this terminal belongs to is closed.".into());
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    waiting().lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
    let _ = app.emit_to(&window, "cli-request", json!({ "id": id, "cmd": cmd, "args": args }));
    // Most answers are instant; a few wait for you (a question in the window).
    let wait = args["wait"].as_u64().unwrap_or(120).min(3600);
    let got = rx.recv_timeout(Duration::from_secs(wait));
    waiting().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    got.unwrap_or_else(|_| Err("The Ledger window didn't answer.".into()))
}

/// The window's answer to a cli-request.
#[tauri::command]
pub fn cli_reply(id: u64, ok: bool, value: Value) {
    if let Some(tx) = waiting().lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        let _ = tx.send(if ok { Ok(value) } else { Err(value.as_str().unwrap_or("Failed.").to_string()) });
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn tokens() {
        let (a, b) = (super::new_token(), super::new_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(super::same_token(&a, &a));
        assert!(!super::same_token(&a, &b));
        assert!(!super::same_token(&a, ""));
    }
}
