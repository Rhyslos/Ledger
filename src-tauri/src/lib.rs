//! Ledger backend: files, build tasks (cargo, dotnet, Godot), a bridge to
//! language servers and debug adapters, terminals, git, and windows.
//!
//! The frontend owns all editor state. This side only does what a web page
//! can't: touch the disk, spawn processes and pipe their output back as events.

use std::{
    collections::HashMap,
    ffi::OsString,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// `\\?\C:\x` (what canonicalize gives on Windows) → `C:\x`, and
/// `\\?\UNC\server\share` (network and mapped drives) → `\\server\share`.
fn plain_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    s.strip_prefix(r"\\?\").map(String::from).unwrap_or(s)
}

// ---------- tool discovery ----------
//
// Apps started from the Start menu (or by Godot) don't always see the PATH a
// terminal has, so the usual install folders for cargo and dotnet are added
// for every child we spawn.

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

/// PATH as Windows has it now (user + machine), read again after Ledger installs
/// something, so new tools work without restarting Ledger.
static FRESH_PATH: std::sync::Mutex<Option<OsString>> = std::sync::Mutex::new(None);

#[tauri::command]
async fn refresh_path() {
    if !cfg!(windows) {
        return;
    }
    let mut c = command_at(Path::new("powershell"));
    c.args(["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User'); [Environment]::GetEnvironmentVariable('Path','Machine')"]);
    if let Ok(out) = c.stdin(Stdio::null()).stderr(Stdio::null()).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        let joined = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(";");
        *FRESH_PATH.lock().unwrap_or_else(|e| e.into_inner()) = Some(joined.into());
    }
}

fn child_path() -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(h) = std::env::var_os("CARGO_HOME") {
        dirs.push(PathBuf::from(h).join("bin"));
    }
    if let Some(h) = home() {
        dirs.push(h.join(".cargo").join("bin"));
        dirs.push(h.join(".dotnet").join("tools"));
    }
    if cfg!(windows) {
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            let pf = PathBuf::from(pf);
            dirs.push(pf.join("dotnet"));
            dirs.push(pf.join("nodejs"));
        }
        // Where npm puts programs installed with --global.
        if let Some(a) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(a).join("npm"));
        }
        // Where winget puts command-line tools it installs.
        if let Some(l) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(l).join("Microsoft").join("WinGet").join("Links"));
        }
    } else {
        dirs.push("/usr/local/share/dotnet".into());
        dirs.push("/usr/share/dotnet".into());
        dirs.push("/usr/local/bin".into());
    }
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    if let Some(p) = FRESH_PATH.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        dirs.extend(std::env::split_paths(p));
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// File names a bare command can have: on Windows `npm` may be `npm.cmd`.
fn exe_names(name: &str) -> Vec<String> {
    if !cfg!(windows) || Path::new(name).extension().is_some() {
        return vec![name.to_string()];
    }
    ["exe", "cmd", "bat", "com"].iter().map(|e| format!("{name}.{e}")).collect()
}

/// A bare name ("cargo") is looked up on PATH; anything with a slash is a path.
fn is_bare(name: &str) -> bool {
    !name.contains('/') && !name.contains('\\')
}

fn candidates(name: &str) -> Vec<PathBuf> {
    if !is_bare(name) {
        return vec![PathBuf::from(name)];
    }
    let names = exe_names(name);
    std::env::split_paths(&child_path())
        .flat_map(|d| names.iter().map(move |n| d.join(n)).collect::<Vec<_>>())
        .filter(|p| p.is_file())
        .collect()
}

fn responds(p: &Path) -> bool {
    // Most tools answer --version; lua only knows -v.
    ["--version", "-v"].iter().any(|a| {
        command_at(p)
            .arg(a)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

/// First candidate that actually runs. rustup puts stubs in ~/.cargo/bin that
/// fail until a component is installed, so existence alone isn't enough.
fn find_working(name: &str) -> Option<PathBuf> {
    if !is_bare(name) {
        let p = PathBuf::from(name);
        return p.is_file().then_some(p);
    }
    let found = candidates(name);
    // The HTML, CSS, JSON and ESLint servers have no --version and exit with an error, and the Lua server is
    // started the same careful way; being on PATH is enough.
    if name.starts_with("vscode-") || name == "lua-language-server" {
        return found.into_iter().next();
    }
    found.into_iter().find(|p| responds(p))
}

fn find_tool(name: &str) -> PathBuf {
    candidates(name).into_iter().next().unwrap_or_else(|| PathBuf::from(name))
}

fn command_at(exe: &Path) -> Command {
    let mut c = Command::new(exe);
    // cmd.exe (which runs .cmd shims such as npm's) looks for "node" in the working folder before
    // PATH unless this is set, so a node.cmd planted in a project would run instead.
    c.env("PATH", child_path()).env("NoDefaultCurrentDirectoryInExePath", "1");
    // Not Ledger's own working folder, which can be a project ("Open with Ledger" in Explorer):
    // callers that work in a folder say so with current_dir.
    c.current_dir(std::env::temp_dir());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

/// "Open with Ledger" in Explorer's right-click menu (the installer adds it): whether it's there,
/// and turning it on or off. Off also leaves a note so updates don't add it back.
#[tauri::command]
async fn shell_menu_state() -> Res<bool> {
    blocking(move || shell_menu_state_now()).await
}
fn shell_menu_state_now() -> bool {
    cfg!(windows) && reg(&["query", r"HKCU\Software\Classes\Directory\shell\Ledger"])
}

#[tauri::command]
async fn shell_menu(on: bool) -> Res<()> {
    blocking(move || shell_menu_now(on)).await?
}
fn shell_menu_now(on: bool) -> Res<()> {
    if !cfg!(windows) {
        return Err("This is a Windows menu.".into());
    }
    let exe = std::env::current_exe().map_err(err)?;
    let exe = plain_path(&exe);
    let keys = [(r"*", "%1"), (r"Directory", "%1"), (r"Directory\Background", "%V")];
    for (key, arg) in keys {
        let base = format!(r"HKCU\Software\Classes\{key}\shell\Ledger");
        if on {
            let ok = reg(&["add", &base, "/ve", "/d", "Open with Ledger", "/f"])
                && reg(&["add", &base, "/v", "Icon", "/d", &exe, "/f"])
                && reg(&["add", &format!(r"{base}\command"), "/ve", "/d", &format!("\"{exe}\" \"{arg}\""), "/f"]);
            if !ok {
                return Err("Windows didn't let Ledger change the menu.".into());
            }
        } else {
            reg(&["delete", &base, "/f"]);
        }
    }
    if on {
        reg(&["delete", r"HKCU\Software\Ledger", "/v", "NoShellMenu", "/f"]);
    } else {
        reg(&["add", r"HKCU\Software\Ledger", "/v", "NoShellMenu", "/d", "1", "/f"]);
    }
    Ok(())
}

fn reg(args: &[&str]) -> bool {
    command_at(Path::new("reg")).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

/// Where a tool resolves to, if it works. Used by the settings page.
#[tauri::command]
async fn tool_info(name: String) -> Res<Option<String>> {
    blocking(move || tool_info_now(name)).await
}
fn tool_info_now(name: String) -> Option<String> {
    find_working(&name).map(|p| plain_path(&p))
}

// ---------- app & arguments ----------

/// Frontend console output, mirrored to stderr in debug builds.
#[tauri::command]
fn js_log(level: String, msg: String) {
    eprintln!("[js {level}] {msg}");
}

#[derive(Serialize, Clone)]
struct Args {
    argv: Vec<String>,
    cwd: String,
}

/// The command line for this window: the process's own for the first window,
/// or the folder a new window was opened with.
#[tauri::command]
fn startup_args(window: tauri::WebviewWindow, procs: State<'_, Procs>) -> Args {
    if window.label() != "main" {
        return procs.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(window.label()).unwrap_or(Args { argv: vec![], cwd: String::new() });
    }
    Args {
        argv: std::env::args().skip(1).collect(),
        cwd: std::env::current_dir().map(|p| plain_path(&p)).unwrap_or_default(),
    }
}

#[tauri::command]
fn exe_path() -> String {
    std::env::current_exe().map(|p| plain_path(&p)).unwrap_or_default()
}

/// "dir", "file" or null, after resolving `path` against `cwd`.
#[tauri::command(async)]
fn resolve_path(path: String, cwd: String) -> Option<(String, String)> {
    let p = Path::new(&path);
    let p = if p.is_absolute() { p.to_path_buf() } else { Path::new(&cwd).join(p) };
    if !p.exists() {
        return None;
    }
    // Tidy "." and ".." by hand rather than canonicalize: that turns a mapped drive (Z:\) into
    // \\server\share and follows links, so the path wouldn't match the folder you opened.
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    let kind = if out.is_dir() { "dir" } else { "file" };
    Some((plain_path(&out), kind.into()))
}

/// "C:" on its own means "the current folder on drive C"; a folder path means the drive's root.
fn dir_arg(path: &str) -> String {
    let b = path.as_bytes();
    if b.len() == 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        format!("{path}\\")
    } else {
        path.to_string()
    }
}

/// Nearest folder above `file` that looks like a project root.
#[tauri::command(async)]
fn find_project_root(file: String) -> Option<String> {
    let has = |d: &Path, pred: &dyn Fn(&str) -> bool| {
        std::fs::read_dir(d)
            .map(|rd| rd.flatten().any(|e| pred(&e.file_name().to_string_lossy())))
            .unwrap_or(false)
    };
    let mut best: Option<PathBuf> = None;
    for dir in Path::new(&file).ancestors().skip(1) {
        // A Godot project or solution wins outright; Cargo.toml / .csproj are
        // remembered but we keep looking for a workspace above them.
        if has(dir, &|n| n == "project.godot" || n.ends_with(".sln") || n.ends_with(".slnx")) {
            return Some(plain_path(dir));
        }
        if best.is_none() && has(dir, &|n| n == "Cargo.toml" || n.ends_with(".csproj") || n == ".git") {
            best = Some(dir.to_path_buf());
        }
        if has(dir, &|n| n == ".git") {
            break;
        }
    }
    best.map(|p| plain_path(&p))
}

// ---------- settings ----------

fn settings_file(app: &AppHandle) -> Res<PathBuf> {
    Ok(app.path().app_config_dir().map_err(err)?.join("settings.json"))
}

#[tauri::command(async)]
fn settings_read(app: AppHandle) -> Res<Option<String>> {
    let f = settings_file(&app)?;
    Ok(std::fs::read_to_string(f).ok())
}

#[tauri::command(async)]
fn settings_write(app: AppHandle, json: String) -> Res<String> {
    let f = settings_file(&app)?;
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(err)?;
    }
    // A settings.json with a mistake in it (edited by hand) is kept as settings.json.bak before
    // it's replaced, so nothing typed there is lost.
    if let Ok(old) = std::fs::read_to_string(&f) {
        if !old.trim().is_empty() && serde_json::from_str::<serde_json::Value>(&old).is_err() {
            let _ = std::fs::write(f.with_extension("json.bak"), old);
        }
    }
    write_atomic(&f, json.as_bytes()).map_err(err)?;
    Ok(plain_path(&f))
}

#[tauri::command(async)]
fn settings_path(app: AppHandle) -> Res<String> {
    settings_file(&app).map(|p| plain_path(&p))
}

// ---------- files ----------

/// Runs slow work (disk, other programs) on Tauri's blocking pool, away from the window's thread
/// and the async workers that carry language-server and terminal traffic.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)
}
// File commands run off the window's thread (command(async)): a slow network share, a big file or
// the Recycle Bin mustn't freeze the window. Commands without `async` run on the UI thread.

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command(async)]
fn list_dir(path: String) -> Res<Vec<Entry>> {
    let path = dir_arg(&path);
    let mut out = Vec::new();
    for ent in std::fs::read_dir(&path).map_err(err)? {
        let ent = ent.map_err(err)?;
        let name = ent.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let p = ent.path();
        out.push(Entry { name, is_dir: p.is_dir(), path: p.to_string_lossy().into() });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// A file's bytes as they are (images), sent as binary rather than as text or JSON.
#[tauri::command]
async fn read_bytes(path: String) -> Res<tauri::ipc::Response> {
    blocking(move || read_bytes_now(path)).await?
}
fn read_bytes_now(path: String) -> Result<tauri::ipc::Response, String> {
    let meta = std::fs::metadata(&path).map_err(err)?;
    if meta.len() > 128 * 1024 * 1024 {
        return Err("This file is over 128 MB, too big to show here.".into());
    }
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(err)
}

// ---------- local history ----------
// Every save keeps a copy of the file in Ledger's own folder (not the project), the last 50 per
// file, so an earlier version can be brought back even without Git.

const HISTORY_KEEP: usize = 50;

fn history_dir(app: &AppHandle, path: &str) -> Res<PathBuf> {
    let key = path.replace('\\', "/").to_lowercase();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325; // FNV-1a: a short, stable folder name per file
    for b in key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    Ok(app.path().app_data_dir().map_err(err)?.join("history").join(format!("{h:016x}")))
}

/// The versions kept for `dir`, oldest first: (millis, file).
fn history_versions(dir: &Path) -> Vec<(u64, PathBuf)> {
    let mut v: Vec<(u64, PathBuf)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    n.strip_suffix(".txt")?.parse::<u64>().ok().map(|t| (t, e.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[derive(Serialize)]
struct Version {
    id: String,
    time: f64,
    size: u64,
}

// ---------- caches ----------
// Things worth keeping between sessions that aren't settings (Tailwind's class lists), in
// Ledger's cache folder rather than the window's localStorage, which also holds sessions and
// folder trust and would silently stop saving those once full.

fn cache_file(app: &AppHandle, key: &str) -> Res<PathBuf> {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    Ok(app.path().app_cache_dir().map_err(err)?.join("cache").join(format!("{h:016x}.json")))
}

#[tauri::command(async)]
fn cache_get(app: AppHandle, key: String) -> Option<String> {
    std::fs::read_to_string(cache_file(&app, &key).ok()?).ok()
}

#[tauri::command(async)]
fn cache_set(app: AppHandle, key: String, value: String) -> Res<()> {
    let f = cache_file(&app, &key)?;
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(err)?;
    }
    write_atomic(&f, value.as_bytes()).map_err(err)
}

/// Keeps `text` as the newest version of `path`. False if it's the same as the last one.
#[tauri::command]
async fn history_add(app: AppHandle, path: String, text: String) -> Res<bool> {
    // Files that usually hold passwords and keys aren't copied anywhere.
    let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name.starts_with(".env") || name.starts_with("id_rsa") || name.starts_with("id_ed25519") || [".pem", ".key", ".pfx", ".p12"].iter().any(|e| name.ends_with(e)) || name.contains("secret") || name.contains("credential") {
        return Ok(false);
    }
    let dir = history_dir(&app, &path)?;
    let all_dir = dir.parent().map(Path::to_path_buf);
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(err)?;
        std::fs::write(dir.join("path"), &path).map_err(err)?;
        let versions = history_versions(&dir);
        if let Some((_, last)) = versions.last() {
            if std::fs::read(last).map(|b| b == text.as_bytes()).unwrap_or(false) {
                return Ok(false);
            }
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let t = versions.last().map(|(l, _)| now.max(l + 1)).unwrap_or(now);
        std::fs::write(dir.join(format!("{t}.txt")), text.as_bytes()).map_err(err)?;
        let all = history_versions(&dir);
        if all.len() > HISTORY_KEEP {
            for (_, f) in &all[..all.len() - HISTORY_KEEP] {
                let _ = std::fs::remove_file(f);
            }
        }
        // Now and then, keep the whole history under 200 MB by dropping the oldest versions.
        if t % 16 == 0 {
            if let Some(all_dir) = all_dir {
                trim_history(&all_dir, 200 * 1024 * 1024);
            }
        }
        Ok(true)
    })
    .await
    .map_err(err)?
}

fn trim_history(root: &Path, limit: u64) {
    let mut files: Vec<(u64, u64, PathBuf)> = vec![];
    for d in std::fs::read_dir(root).into_iter().flatten().flatten() {
        for (t, f) in history_versions(&d.path()) {
            files.push((t, std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0), f));
        }
    }
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort();
    for (_, size, f) in files {
        if total <= limit {
            break;
        }
        if std::fs::remove_file(&f).is_ok() {
            total -= size;
        }
    }
}

/// A file was renamed or moved: its history goes with it.
#[tauri::command(async)]
fn history_move(app: AppHandle, from: String, to: String) -> Res<()> {
    let (a, b) = (history_dir(&app, &from)?, history_dir(&app, &to)?);
    if a.is_dir() && !b.exists() {
        std::fs::rename(&a, &b).map_err(err)?;
        let _ = std::fs::write(b.join("path"), &to);
    }
    Ok(())
}

/// The versions kept for `path`, newest first.
#[tauri::command(async)]
fn history_list(app: AppHandle, path: String) -> Res<Vec<Version>> {
    let dir = history_dir(&app, &path)?;
    Ok(history_versions(&dir)
        .into_iter()
        .rev()
        .map(|(t, f)| Version { id: t.to_string(), time: t as f64, size: std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0) })
        .collect())
}

#[tauri::command(async)]
fn history_read(app: AppHandle, path: String, id: String) -> Res<String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("No such version.".into());
    }
    let f = history_dir(&app, &path)?.join(format!("{id}.txt"));
    std::fs::read_to_string(f).map_err(|_| "That version is gone.".to_string())
}

// ---------- text encodings ----------
// Ledger edits UTF-8. UTF-16 files with a byte-order mark (PowerShell 5's `>` and Out-File, .reg
// exports) and old Windows-1252 ("ANSI") files are read too, and saved back the way they were.

/// Windows-1252's characters for bytes 0x80 to 0x9F (the rest match Latin-1).
const CP1252: [u16; 32] = [
    0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
    0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
];

/// The text in a file, and its encoding: "utf8", "utf16le", "utf16be" or "cp1252".
fn decode_text(bytes: Vec<u8>) -> Res<(String, &'static str)> {
    let utf16 = |rest: &[u8], le: bool| {
        if rest.len() % 2 == 1 {
            return Err("This UTF-16 file ends in half a character, so Ledger won't open it as text (saving would lose that byte).".to_string());
        }
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
        String::from_utf16(&units).map_err(|_| "This UTF-16 file has broken characters in it.".to_string())
    };
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Ok((utf16(&bytes[2..], true)?, "utf16le"));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Ok((utf16(&bytes[2..], false)?, "utf16be"));
    }
    // UTF-16 without a byte-order mark: mostly-English text has a zero in every other byte.
    if let Some(le) = bomless_utf16(&bytes) {
        return Ok((utf16(&bytes, le)?, if le { "utf16le-nobom" } else { "utf16be-nobom" }));
    }
    match String::from_utf8(bytes) {
        Ok(t) => Ok((t, "utf8")),
        Err(e) => {
            let bytes = e.into_bytes();
            if bytes.contains(&0) {
                return Err("This looks like a binary file.".into());
            }
            let t = bytes.iter().map(|&b| if (0x80..0xA0).contains(&b) { char::from_u32(CP1252[(b - 0x80) as usize] as u32).unwrap_or('?') } else { b as char }).collect();
            Ok((t, "cp1252"))
        }
    }
}

/// Some(true) for UTF-16 LE, Some(false) for BE, when the bytes look like UTF-16 without a BOM.
fn bomless_utf16(b: &[u8]) -> Option<bool> {
    if b.len() < 4 || b.len() % 2 == 1 {
        return None;
    }
    let pairs = (b.len() / 2).min(4096);
    let (mut even0, mut odd0) = (0, 0);
    for i in 0..pairs {
        if b[2 * i] == 0 {
            even0 += 1;
        }
        if b[2 * i + 1] == 0 {
            odd0 += 1;
        }
    }
    // Text in Latin letters: zeros in one half nearly always, almost never in the other.
    if odd0 * 10 >= pairs * 7 && even0 * 20 <= pairs {
        Some(true)
    } else if even0 * 10 >= pairs * 7 && odd0 * 20 <= pairs {
        Some(false)
    } else {
        None
    }
}

fn encode_text(text: &str, encoding: &str) -> Res<Vec<u8>> {
    let text = text.strip_prefix('\u{FEFF}').filter(|_| encoding.starts_with("utf16")).unwrap_or(text);
    Ok(match encoding {
        "utf16le" => [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(|u| u.to_le_bytes())).collect(),
        "utf16be" => [0xFE, 0xFF].into_iter().chain(text.encode_utf16().flat_map(|u| u.to_be_bytes())).collect(),
        "utf16le-nobom" => text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect(),
        "utf16be-nobom" => text.encode_utf16().flat_map(|u| u.to_be_bytes()).collect(),
        "cp1252" => {
            let mut out = Vec::with_capacity(text.len());
            for ch in text.chars() {
                let c = ch as u32;
                let byte = if c < 0x80 || (0xA0..0x100).contains(&c) {
                    Some(c as u8)
                } else {
                    CP1252.iter().position(|&u| u as u32 == c).map(|i| 0x80 + i as u8)
                };
                match byte {
                    Some(b) => out.push(b),
                    None => return Err(format!("This file is in Windows-1252, which can't store “{ch}”. Run “Convert this file to UTF-8” (Ctrl Shift P), then save.")),
                }
            }
            out
        }
        _ => text.as_bytes().to_vec(),
    })
}

fn read_bytes_checked(path: &str) -> Res<Vec<u8>> {
    let meta = std::fs::metadata(path).map_err(err)?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("File is larger than 8 MB.".into());
    }
    std::fs::read(path).map_err(err)
}

#[tauri::command(async)]
fn read_file(path: String) -> Res<String> {
    decode_text(read_bytes_checked(&path)?).map(|(t, _)| t)
}

#[derive(Serialize)]
struct TextFile {
    text: String,
    encoding: &'static str,
}

/// A file's text and how it was stored, for the editor (which saves it back the same way).
#[tauri::command(async)]
fn read_text(path: String) -> Res<TextFile> {
    decode_text(read_bytes_checked(&path)?).map(|(text, encoding)| TextFile { text, encoding })
}

#[tauri::command(async)]
fn write_file(path: String, contents: String, encoding: Option<String>) -> Res<()> {
    write_atomic(Path::new(&path), &encode_text(&contents, encoding.as_deref().unwrap_or("utf8"))?).map_err(err)
}

/// Saves without a moment where the file is half-written: the new text goes into a temporary file
/// next to it, then takes its place in one step (ReplaceFileW on Windows keeps the file's
/// attributes and permissions). A crash, a power cut or a full disk leaves the old file whole.
/// A link, or a folder where that can't be done, is written in place as before.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(path);
    let plain = match &meta {
        Err(_) => true,                       // a new file: nothing to protect
        Ok(m) => m.file_type().is_symlink(), // keep the link, write through it
    };
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if plain {
        return std::fs::write(path, bytes);
    }
    let tmp = dir.join(format!(".{name}.ledger-save-{}", std::process::id()));
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if written.is_err() {
        // A folder that doesn't allow new files: the old way.
        let _ = std::fs::remove_file(&tmp);
        return std::fs::write(path, bytes);
    }
    // A virus scanner or sync program holding the file makes the swap fail now and then: retry.
    let mut result = replace_file(path, &tmp);
    for _ in 0..4 {
        if result.is_ok() || !path.exists() {
            break;
        }
        thread::sleep(Duration::from_millis(60));
        result = replace_file(path, &tmp);
    }
    match result {
        Ok(()) => Ok(()),
        // The swap failed half-way (Windows can leave the old file gone and the new text only in
        // the temporary file): move that into place rather than lose both.
        Err(_) if !path.exists() => std::fs::rename(&tmp, path).or_else(|_| std::fs::write(path, bytes).map(|_| {
            let _ = std::fs::remove_file(&tmp);
        })),
        Err(_) => {
            // The old file is untouched: write over it the plain way, and keep the temporary copy
            // if even that fails, so the text is somewhere on disk.
            match std::fs::write(path, bytes) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&tmp);
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
    }
}

#[cfg(windows)]
fn replace_file(target: &Path, tmp: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_IGNORE_MERGE_ERRORS};
    let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let (t, s) = (wide(target), wide(tmp));
    let ok = unsafe { ReplaceFileW(t.as_ptr(), s.as_ptr(), std::ptr::null(), REPLACEFILE_IGNORE_MERGE_ERRORS, std::ptr::null(), std::ptr::null()) };
    if ok == 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
}

#[cfg(not(windows))]
fn replace_file(target: &Path, tmp: &Path) -> std::io::Result<()> {
    if let Ok(m) = std::fs::metadata(target) {
        let _ = std::fs::set_permissions(tmp, m.permissions());
    }
    std::fs::rename(tmp, target)
}

#[tauri::command(async)]
fn create_file(path: String) -> Res<()> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map(|_| ()).map_err(err)
}

#[tauri::command(async)]
fn create_dir(path: String) -> Res<()> {
    if Path::new(&path).exists() {
        return Err("Something with that name already exists.".into());
    }
    std::fs::create_dir_all(&path).map_err(err)
}

#[tauri::command(async)]
fn rename_path(from: String, to: String) -> Res<()> {
    // On Windows, main.rs → Main.rs "exists" already (same file), so allow case-only renames.
    let case_only = from.to_lowercase() == to.to_lowercase();
    if !case_only && Path::new(&to).exists() {
        return Err("Something with that name already exists.".into());
    }
    std::fs::rename(&from, &to).map_err(err)
}

/// Copies a file or a whole folder (Copy and Paste, Duplicate in the explorer). Never overwrites.
#[tauri::command(async)]
fn copy_path(from: String, to: String) -> Res<()> {
    let (from, to) = (PathBuf::from(from), PathBuf::from(to));
    if to.exists() {
        return Err("Something with that name already exists.".into());
    }
    if to.starts_with(&from) {
        return Err("A folder can't be copied into itself.".into());
    }
    fn go(from: &Path, to: &Path) -> std::io::Result<()> {
        let m = std::fs::symlink_metadata(from)?;
        if m.is_dir() {
            std::fs::create_dir(to)?;
            for e in std::fs::read_dir(from)? {
                let e = e?;
                go(&e.path(), &to.join(e.file_name()))?;
            }
            Ok(())
        } else {
            std::fs::copy(from, to).map(|_| ())
        }
    }
    go(&from, &to).map_err(err)
}

/// Moves to the recycle bin rather than deleting outright.
#[tauri::command]
async fn delete_path(path: String) -> Res<()> {
    blocking(move || delete_path_now(path)).await?
}
fn delete_path_now(path: String) -> Res<()> {
    trash::delete(&path).map_err(err)
}

const SKIP_DIRS: [&str; 7] = [".git", "target", "node_modules", "bin", "obj", ".godot", ".import"];

fn walker(root: &str) -> ignore::Walk {
    ignore::WalkBuilder::new(dir_arg(root))
        .hidden(false)
        .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && SKIP_DIRS.iter().any(|s| e.file_name() == *s)))
        .build()
}

/// Every file under root, respecting .gitignore. Used by go-to-file.
#[tauri::command]
async fn list_files(root: String) -> Res<Vec<String>> {
    blocking(move || list_files_now(root)).await?
}
fn list_files_now(root: String) -> Res<Vec<String>> {
    let mut out = Vec::new();
    for ent in walker(&root).flatten() {
        if ent.file_type().is_some_and(|t| t.is_file()) {
            out.push(ent.path().to_string_lossy().into());
            if out.len() >= 50_000 {
                break;
            }
        }
    }
    Ok(out)
}

#[derive(Serialize)]
struct Hit {
    path: String,
    line: usize,
    col: usize,
    text: String,
}

#[tauri::command]
async fn search_text(root: String, query: String, case_sensitive: bool) -> Res<Vec<Hit>> {
    blocking(move || search_text_now(root, query, case_sensitive)).await?
}
fn search_text_now(root: String, query: String, case_sensitive: bool) -> Res<Vec<Hit>> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let needle = if case_sensitive { query.clone() } else { query.to_lowercase() };
    let mut hits = Vec::new();
    'files: for ent in walker(&root).flatten() {
        if !ent.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if ent.metadata().map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(true) {
            continue;
        }
        // Any text file Ledger opens, UTF-16 and Windows-1252 too; not binary files.
        let Ok(Ok((text, _))) = std::fs::read(ent.path()).map(decode_text) else { continue };
        for (i, line) in text.lines().enumerate() {
            let hay = if case_sensitive { line.to_string() } else { line.to_lowercase() };
            if let Some(byte) = hay.find(&needle) {
                // Column in UTF-16 units, which is what the editor counts in. Count
                // characters in the searched text, then measure that many in the original.
                let chars = hay[..byte].chars().count();
                let col: usize = line.chars().take(chars).map(|c| c.len_utf16()).sum();
                let t: String = line.trim_end().chars().take(300).collect();
                hits.push(Hit { path: ent.path().to_string_lossy().into(), line: i, col, text: t });
                if hits.len() >= 500 {
                    break 'files;
                }
            }
        }
    }
    Ok(hits)
}

#[derive(Serialize)]
struct Found {
    path: String,
    line: usize,
    /// Where the match starts and how long it is, in UTF-16 units (what the editor counts).
    col: usize,
    len: usize,
    text: String,
}

#[derive(Serialize)]
struct SearchResult {
    hits: Vec<Found>,
    files: usize,
    truncated: bool,
}

/// Turns "src/**, *.ts" into a glob set; a name without a slash matches anywhere.
fn globs(list: &str) -> Res<Option<globset::GlobSet>> {
    let mut b = globset::GlobSetBuilder::new();
    let mut any = false;
    for p in list.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let p = p.trim_start_matches("./").replace('\\', "/");
        let p = if p.contains('/') { p.trim_start_matches('/').to_string() } else { format!("**/{p}") };
        // A folder name on its own means everything in it too.
        for q in [p.clone(), format!("{p}/**")] {
            b.add(globset::GlobBuilder::new(&q).literal_separator(false).build().map_err(|e| format!("“{p}” isn't a pattern Ledger understands ({e})."))?);
        }
        any = true;
    }
    Ok(if any { Some(b.build().map_err(err)?) } else { None })
}

/// Search in files: every match on every line, as plain text or a regular expression, matching
/// case or not, whole words or not, in the files `include` names (all when empty) except those
/// `exclude` names. Files .gitignore leaves out are skipped, as everywhere in Ledger.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn search_files(window: tauri::WebviewWindow, root: String, query: String, regex: bool, case_sensitive: bool, whole_word: bool, include: String, exclude: String) -> Res<SearchResult> {
    // A newer search from the same window (the next keystroke) stops this one's walk.
    let label = window.label().to_string();
    let gen = {
        let mut g = SEARCHES.lock().unwrap_or_else(|e| e.into_inner());
        let n = g.get(&label).copied().unwrap_or(0) + 1;
        g.insert(label.clone(), n);
        n
    };
    let stale = move || SEARCHES.lock().unwrap_or_else(|e| e.into_inner()).get(&label).copied() != Some(gen);
    blocking(move || search_now(&root, &query, regex, case_sensitive, whole_word, &include, &exclude, &stale)).await?
}
static SEARCHES: std::sync::LazyLock<Mutex<HashMap<String, u64>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

#[allow(clippy::too_many_arguments)]
fn search_now(root: &str, query: &str, regex: bool, case_sensitive: bool, whole_word: bool, include: &str, exclude: &str, stale: &dyn Fn() -> bool) -> Res<SearchResult> {
    {
        if query.is_empty() {
            return Ok(SearchResult { hits: vec![], files: 0, truncated: false });
        }
        let pat = if regex { query.to_string() } else { regex::escape(query) };
        let pat = if whole_word { format!(r"\b(?:{pat})\b") } else { pat };
        let re = regex::RegexBuilder::new(&pat).case_insensitive(!case_sensitive).build().map_err(|e| format!("That regular expression has a mistake: {}", e.to_string().lines().last().unwrap_or("")))?;
        let (inc, exc) = (globs(include)?, globs(exclude)?);
        let base = PathBuf::from(dir_arg(root));
        let (mut hits, mut files) = (Vec::new(), 0usize);
        const MAX: usize = 5000;
        let mut scanned = 0usize;
        'files: for ent in walker(root).flatten() {
            scanned += 1;
            if scanned % 64 == 0 && stale() {
                return Err("cancelled".into());
            }
            // A drive root or a huge tree: stop after this many files and say so.
            if scanned > 200_000 {
                return Ok(SearchResult { hits, files, truncated: true });
            }
            if !ent.file_type().is_some_and(|t| t.is_file()) || ent.metadata().map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(true) {
                continue;
            }
            let rel = ent.path().strip_prefix(&base).unwrap_or(ent.path()).to_string_lossy().replace('\\', "/");
            if inc.as_ref().is_some_and(|g| !g.is_match(&rel)) || exc.as_ref().is_some_and(|g| g.is_match(&rel)) {
                continue;
            }
            let Ok(Ok((text, _))) = std::fs::read(ent.path()).map(decode_text) else { continue };
            if !re.is_match(&text) {
                continue;
            }
            files += 1;
            for (i, line) in text.lines().enumerate() {
                for m in re.find_iter(line) {
                    if m.start() == m.end() {
                        continue; // a pattern that matches nothing (^, a*)
                    }
                    let col = line[..m.start()].encode_utf16().count();
                    let len = m.as_str().encode_utf16().count();
                    let t: String = line.trim_end().chars().take(400).collect();
                    hits.push(Found { path: ent.path().to_string_lossy().into(), line: i, col, len, text: t });
                    if hits.len() >= MAX {
                        return Ok(SearchResult { hits, files, truncated: true });
                    }
                }
            }
            if files > 20000 {
                break 'files;
            }
        }
        Ok(SearchResult { hits, files, truncated: false })
    }
}

/// Lines with TODO, FIXME, HACK, XXX or BUG in them, in one walk of the folder (the TODO panel
/// keeps the ones where the word is in a comment).
#[tauri::command]
async fn find_todos(root: String) -> Res<Vec<Hit>> {
    tauri::async_runtime::spawn_blocking(move || {
        const WORDS: [&str; 5] = ["TODO", "FIXME", "HACK", "XXX", "BUG"];
        let mut hits = Vec::new();
        'files: for ent in walker(&root).flatten() {
            if !ent.file_type().is_some_and(|t| t.is_file()) || ent.metadata().map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(true) {
                continue;
            }
            let Ok(Ok((text, _))) = std::fs::read(ent.path()).map(decode_text) else { continue };
            if !WORDS.iter().any(|w| text.contains(w)) {
                continue;
            }
            for (i, line) in text.lines().enumerate() {
                if WORDS.iter().any(|w| line.contains(w)) {
                    let t: String = line.trim_end().chars().take(300).collect();
                    hits.push(Hit { path: ent.path().to_string_lossy().into(), line: i, col: 0, text: t });
                    if hits.len() >= 5000 {
                        break 'files;
                    }
                }
            }
        }
        Ok(hits)
    })
    .await
    .map_err(err)?
}

/// Modified time (ms since 1970) of each path, or null if it's gone. Lets the
/// editor notice files changed on disk by other programs.
#[tauri::command(async)]
fn file_stats(paths: Vec<String>) -> Vec<Option<f64>> {
    paths
        .iter()
        .map(|p| {
            let m = std::fs::metadata(p).ok()?.modified().ok()?;
            Some(m.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as f64)
        })
        .collect()
}

// ---------- windows ----------
//
// Every window is its own workspace: its own folder, running program, language
// servers, debugger and terminals. Processes are kept per window label and
// events go only to the window that owns them.

type Shared<T> = Arc<Mutex<T>>;

#[derive(Default)]
struct Win {
    task: Option<Shared<Child>>,
    task_in: Shared<Option<ChildStdin>>,
    pipes: HashMap<String, Pipe>,
    terms: HashMap<u32, Term>,
    root: Option<String>,
    /// The folder is trusted: its code may run (see trust.rs). Off until the frontend says so.
    trusted: bool,
}

/// A process spoken to over stdio with Content-Length framing: language
/// servers ("rust", "csharp") and debug adapters ("dap").
struct Pipe {
    child: Child,
    /// Messages for the process, written in order by one thread (see lsp_start).
    stdin: std::sync::mpsc::Sender<String>,
}

struct Term {
    writer: Shared<Box<dyn Write + Send>>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct Procs {
    wins: Mutex<HashMap<String, Win>>,
    pending: Mutex<HashMap<String, Args>>,
    next: std::sync::atomic::AtomicU32,
}

impl Procs {
    fn with<R>(&self, label: &str, f: impl FnOnce(&mut Win) -> R) -> R {
        let mut g = self.wins.lock().unwrap_or_else(|e| e.into_inner());
        f(g.entry(label.to_string()).or_default())
    }
    fn id(&self) -> u32 {
        self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
    }
}

/// Stops everything a window started. Used when it closes, and at exit.
fn stop_window(procs: &Procs, label: &str, wait: bool) {
    let win = procs.wins.lock().unwrap_or_else(|e| e.into_inner()).remove(label);
    let Some(mut w) = win else { return };
    // Killing takes a moment per process on Windows; don't hold up the UI for it.
    let job = thread::spawn(move || {
        if let Some(c) = w.task.take() {
            kill_tree(&mut c.lock().unwrap_or_else(|e| e.into_inner()));
        }
        for (_, mut p) in w.pipes.drain() {
            kill_tree(&mut p.child);
        }
        for (_, mut t) in w.terms.drain() {
            let _ = t.killer.kill();
        }
    });
    if wait {
        let _ = job.join();
    }
}

/// Ends every program, language server, terminal and test run Ledger started, in every window.
/// Called before an update installs: the installer ends Ledger without the usual exit, and
/// anything left running would hold files the installer has to replace.
#[tauri::command(async)]
fn stop_everything(app: AppHandle) {
    let procs = app.state::<Procs>();
    let labels: Vec<String> = procs.wins.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
    for l in labels {
        stop_window(&procs, &l, true);
    }
    let pids: Vec<u32> = TEST_PIDS.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, p)| p).collect();
    for pid in pids {
        #[cfg(windows)]
        {
            let _ = command_at(Path::new("taskkill")).args(["/T", "/F", "/PID", &pid.to_string()]).status();
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill").args(["-s", "KILL", "--", &format!("-{pid}")]).status();
        }
    }
}

/// Opens another window, optionally with a folder.
#[tauri::command]
async fn new_window(app: AppHandle, procs: State<'_, Procs>, folder: Option<String>) -> Res<String> {
    let label = format!("win-{}", procs.id());
    procs.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(label.clone(), Args { argv: folder.into_iter().collect(), cwd: String::new() });
    open_window(&app, &label)?;
    Ok(label)
}

fn open_window(app: &AppHandle, label: &str) -> Res<()> {
    let mut conf = app.config().app.windows.first().cloned().ok_or("no window config")?;
    conf.label = label.to_string();
    let w = tauri::WebviewWindowBuilder::from_config(app, &conf).map_err(err)?.build().map_err(err)?;
    let _ = w.set_focus();
    Ok(())
}

/// The folder a window has open, so launches from Godot reach the right window.
#[tauri::command]
fn set_window_root(window: tauri::WebviewWindow, procs: State<'_, Procs>, root: Option<String>, trusted: Option<bool>) {
    procs.with(window.label(), |w| {
        w.root = root;
        w.trusted = trusted.unwrap_or(false);
    });
}

/// If another window already has `root` open, brings it to the front and says so: one folder in
/// two windows would mean two of every language server and sessions overwriting each other.
#[tauri::command]
fn focus_window_with(app: AppHandle, window: tauri::WebviewWindow, procs: State<'_, Procs>, root: String) -> bool {
    let me = window.label().to_string();
    let other = procs.wins.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(l, w)| **l != me && w.root.as_deref().is_some_and(|r| trust::norm(r) == trust::norm(&root))).map(|(l, _)| l.clone());
    let Some(label) = other else { return false };
    let Some(w) = app.get_webview_window(&label) else { return false };
    let _ = w.unminimize();
    let _ = w.set_focus();
    true
}

/// The user trusted (or stopped trusting) the window's folder.
#[tauri::command]
fn set_window_trust(window: tauri::WebviewWindow, procs: State<'_, Procs>, trusted: bool) {
    procs.with(window.label(), |w| w.trusted = trusted);
}

/// A TypeScript installed for the whole computer (npm -g), for the TypeScript server in a restricted
/// folder: otherwise it would load the project's own node_modules/typescript.
#[tauri::command(async)]
fn global_tsserver() -> Option<String> {
    let mut dirs = vec![];
    if let Ok(a) = std::env::var("APPDATA") {
        dirs.push(PathBuf::from(a).join("npm").join("node_modules"));
    }
    if let Ok(p) = std::env::var("ProgramFiles") {
        dirs.push(PathBuf::from(p).join("nodejs").join("node_modules"));
    }
    if let Some(h) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(&h).join(".npm-global/lib/node_modules"));
    }
    dirs.push(PathBuf::from("/usr/local/lib/node_modules"));
    dirs.push(PathBuf::from("/usr/lib/node_modules"));
    for d in dirs {
        for lib in [d.join("typescript").join("lib"), d.join("typescript-language-server").join("node_modules").join("typescript").join("lib")] {
            if lib.join("tsserver.js").is_file() {
                return Some(plain_path(&lib));
            }
        }
    }
    None
}

/// Whether `cwd` is in the window's folder and that folder isn't trusted.
fn restricted(procs: &Procs, label: &str, cwd: &str) -> bool {
    procs.with(label, |w| !w.trusted && w.root.as_deref().is_some_and(|r| trust::inside(cwd, r)))
}

/// git with Ledger's settings: no fsmonitor, no prompts, English messages, and in a restricted
/// folder no hooks (or no git at all when the repository's settings would run programs).
fn git_command(cwd: &str, restricted: bool) -> Res<Command> {
    let git = find_tool("git");
    let base = || {
        let mut c = command_at(&git);
        c.current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0");
        c
    };
    let guard = trust::git_guard(restricted, base)?;
    let mut c = command_at(&git);
    c.args(["-c", "core.quotepath=false", "-c", "core.fsmonitor=false"])
        .args(guard)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Git's messages in English whatever Windows' language, so Ledger can recognise them
        // ("would be overwritten", "not fully merged", "CONFLICT").
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C")
        .env("GIT_OPTIONAL_LOCKS", "0");
    Ok(c)
}

fn norm_path(s: &str) -> String {
    s.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Which window a second launch belongs to: the one whose folder holds a path
/// on the command line (the deepest match wins), else the main window.
fn pick_window(app: &AppHandle, argv: &[String], cwd: &str) -> Option<String> {
    let procs = app.state::<Procs>();
    let roots: Vec<(String, String)> = procs
        .wins
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(l, w)| w.root.as_ref().map(|r| (l.clone(), norm_path(r))))
        .filter(|(l, _)| app.get_webview_window(l).is_some())
        .collect();
    let mut best: Option<(usize, String)> = None;
    for a in argv.iter().filter(|a| !a.starts_with('-')) {
        let p = Path::new(a);
        let p = if p.is_absolute() { p.to_path_buf() } else { Path::new(cwd).join(p) };
        let p = norm_path(&p.to_string_lossy());
        for (label, root) in &roots {
            let inside = p == *root || p.starts_with(&format!("{root}/"));
            if inside && best.as_ref().is_none_or(|(n, _)| root.len() > *n) {
                best = Some((root.len(), label.clone()));
            }
        }
    }
    best.map(|(_, l)| l).or_else(|| {
        if app.get_webview_window("main").is_some() {
            Some("main".into())
        } else {
            app.webview_windows().keys().next().cloned()
        }
    })
}

// ---------- tasks (cargo, dotnet, Godot) ----------

#[derive(Serialize, Clone)]
struct Line {
    run: u64,
    stream: &'static str,
    text: String,
    /// The line isn't finished yet (no line ending so far), like a question waiting for an
    /// answer. The next line from the same stream carries on from it and replaces it.
    partial: bool,
}

#[derive(Serialize, Clone)]
struct Done {
    run: u64,
    code: Option<i32>,
}

/// A program cargo built (for the debugger).
#[derive(Serialize, Clone)]
struct Artifact {
    run: u64,
    path: String,
    name: String,
    kind: Vec<String>,
    test: bool,
}

fn cargo_json(sub: &str) -> bool {
    matches!(sub, "build" | "b" | "check" | "c" | "run" | "r" | "test" | "t" | "bench" | "clippy" | "doc")
}

// Program output reaches the window in batches: an event per line would swamp it (and Stop with
// it). A reader thread hands over whatever arrives; this side sends at most one event per 40 ms
// (or 512 lines). Output after a quiet spell goes out at once, and an unfinished line (a program
// asking a question) is shown when the program goes quiet, so prompts never wait.
const BATCH_MS: u64 = 40;
const BATCH_LINES: usize = 512;
/// A line with no line ending longer than this is sent anyway (minified JSON, a progress bar
/// that never ends its line), so it can't grow without limit. Cargo's JSON messages only make
/// sense whole, and a long diagnostic can pass 16 KB, so they get far more room.
const LONG_LINE: usize = 16 * 1024;
const LONG_JSON: usize = 8 * 1024 * 1024;

/// Where to cut `b` at most `max` bytes in without splitting a UTF-8 character.
fn char_cut(b: &[u8], max: usize) -> usize {
    let mut i = max.min(b.len());
    while i > 0 && i < b.len() && (b[i] & 0xC0) == 0x80 {
        i -= 1;
    }
    if i == 0 { max.min(b.len()) } else { i }
}

fn pump(app: AppHandle, label: String, run: u64, stream: impl Read + Send + 'static, name: &'static str, cargo: bool) -> thread::JoinHandle<()> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut r = stream;
        let mut chunk = [0u8; 8192];
        while let Ok(n) = r.read(&mut chunk) {
            if n == 0 || tx.send(chunk[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    thread::spawn(move || {
        use std::sync::mpsc::RecvTimeoutError;
        use std::time::{Duration, Instant};
        let limit = if cargo { LONG_JSON } else { LONG_LINE };
        // Bytes of the line being read, until its line ending arrives.
        let mut pending: Vec<u8> = Vec::new();
        let mut batch: Vec<Line> = Vec::new();
        let mut last_flush = Instant::now() - Duration::from_millis(BATCH_MS);
        let mut last_partial: Vec<u8> = Vec::new();
        let mut done = false;
        while !done {
            let wait = Duration::from_millis(BATCH_MS).saturating_sub(last_flush.elapsed());
            let quiet = match if batch.is_empty() && pending == last_partial { rx.recv().map_err(|_| RecvTimeoutError::Disconnected) } else { rx.recv_timeout(wait) } {
                Ok(data) => {
                    pending.extend_from_slice(&data);
                    while let Some(i) = pending.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=i).collect();
                        push_line(&app, &label, run, name, cargo, &line, false, &mut batch);
                        last_partial.clear();
                    }
                    while pending.len() > limit {
                        let cut = char_cut(&pending, limit);
                        let line: Vec<u8> = pending.drain(..cut).collect();
                        push_line(&app, &label, run, name, cargo, &line, false, &mut batch);
                        last_partial.clear();
                    }
                    false
                }
                Err(RecvTimeoutError::Timeout) => true,
                Err(RecvTimeoutError::Disconnected) => {
                    done = true;
                    true
                }
            };
            // Send when the program went quiet, after a quiet spell, or when enough has gathered.
            if !(quiet || batch.len() >= BATCH_LINES || last_flush.elapsed().as_millis() as u64 >= BATCH_MS) {
                continue;
            }
            // What's left has no line ending yet. Show it anyway (a program asking a question
            // waits right here), except for cargo's JSON, which only makes sense whole. Only when
            // it changed, so a long line isn't sent again and again.
            if quiet && !done && !pending.is_empty() && !cargo && pending != last_partial {
                let valid = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(e) => e.valid_up_to(),
                };
                if valid > 0 {
                    push_line(&app, &label, run, name, cargo, &pending[..valid], true, &mut batch);
                    last_partial = pending.clone();
                }
            }
            if !batch.is_empty() {
                flush(&app, &label, run, &mut batch);
                last_flush = Instant::now();
            }
        }
        if !pending.is_empty() {
            let rest = std::mem::take(&mut pending);
            push_line(&app, &label, run, name, cargo, &rest, false, &mut batch);
        }
        flush(&app, &label, run, &mut batch);
    })
}

#[derive(Serialize, Clone)]
struct Lines {
    run: u64,
    lines: Vec<Line>,
}

fn flush(app: &AppHandle, label: &str, run: u64, batch: &mut Vec<Line>) {
    if !batch.is_empty() {
        let _ = app.emit_to(label, "task-lines", Lines { run, lines: std::mem::take(batch) });
    }
}

/// What a line shows: a carriage return without a line feed (a progress counter going
/// "10%\r20%\r…") starts the line again, like in a terminal.
fn visible(text: &str) -> &str {
    let t = text.trim_end_matches(['\n', '\r']);
    match t.rfind('\r') {
        Some(i) if i + 1 < t.len() => &t[i + 1..],
        _ => t,
    }
}

/// Adds one line of output to the batch (cargo's JSON is turned into its readable message first).
#[allow(clippy::too_many_arguments)]
fn push_line(app: &AppHandle, label: &str, run: u64, name: &'static str, cargo: bool, bytes: &[u8], partial: bool, batch: &mut Vec<Line>) {
    let s = String::from_utf8_lossy(bytes);
    let mut text = visible(&s).to_string();
    if cargo && name == "stdout" && text.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            match v.get("reason").and_then(|r| r.as_str()) {
                Some("compiler-message") => {
                    text = v["message"]["rendered"].as_str().unwrap_or("").trim_end().to_string();
                    if text.is_empty() {
                        return;
                    }
                }
                Some("compiler-artifact") => {
                    if let Some(path) = v["executable"].as_str() {
                        let kind = v["target"]["kind"].as_array().map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect()).unwrap_or_default();
                        let _ = app.emit_to(label, "task-artifact", Artifact {
                            run,
                            path: path.to_string(),
                            name: v["target"]["name"].as_str().unwrap_or("").to_string(),
                            kind,
                            test: v["profile"]["test"].as_bool().unwrap_or(false),
                        });
                    }
                    return;
                }
                Some(_) => return, // build plumbing
                None => {}
            }
        }
    }
    batch.push(Line { run, stream: name, text, partial });
}

/// Runs `program args` in `root`, streaming output as `task-lines` events and
/// finishing with `task-done`. `program` is "cargo", "dotnet" or a path (Godot).
/// Anything already running in this window is stopped first.
/// `run` is chosen by the frontend, so it knows the id before any event arrives.
#[tauri::command]
async fn run_task(app: AppHandle, window: tauri::WebviewWindow, procs: State<'_, Procs>, run: u64, root: String, program: String, args: Vec<String>, install: Option<bool>) -> Res<u64> {
    let label = window.label().to_string();
    // Installing a tool (Settings: npm -g, dotnet tool, cargo install, winget, rustup) runs in your
    // home folder, never a project's: npm, NuGet and cargo read settings from the folder they run in
    // (.npmrc, NuGet.Config, .cargo/config), and a project could point them at its own packages.
    let root = if install.unwrap_or(false) { home().unwrap_or_else(std::env::temp_dir).to_string_lossy().into_owned() } else { root };
    // Running, building and testing run the project's code, and so does making a project inside it
    // (dotnet new and npm create read its Directory.Build.*, NuGet.Config and .npmrc).
    if !install.unwrap_or(false) && restricted(&procs, &label, &root) && !trust::safe_task(&program, &args) {
        return Err(trust::UNTRUSTED.into());
    }
    stop_task(&procs, &label);
    let tool = if is_bare(&program) { program.to_lowercase() } else { String::new() };
    let is_cargo = tool == "cargo" || tool == "cargo.exe";
    let mut args = args;
    if is_cargo && args.first().is_some_and(|s| cargo_json(s)) {
        args.insert(1, "--message-format=json-diagnostic-rendered-ansi".into());
    }
    let exe = if is_bare(&program) { find_tool(&program) } else { PathBuf::from(&program) };
    let mut cmd = command_at(&exe);
    cmd.args(&args)
        .current_dir(&root)
        .env("CARGO_TERM_COLOR", "always")
        .env("CARGO_TERM_PROGRESS_WHEN", "never")
        .env("DOTNET_CLI_UI_LANGUAGE", "en")
        .env("DOTNET_NOLOGO", "1")
        .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
        .stdin(Stdio::piped()) // the Input box under the output writes here
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // so Stop takes children (the program cargo/dotnet started) too
    }
    let mut child = cmd.spawn().map_err(|e| {
        let what = if is_bare(&program) { program.clone() } else { exe.display().to_string() };
        format!("Couldn't start {what} ({e}).")
    })?;
    job::adopt(child.id());
    let stdin = child.stdin.take();
    let out = pump(app.clone(), label.clone(), run, child.stdout.take().unwrap(), "stdout", is_cargo);
    let er = pump(app.clone(), label.clone(), run, child.stderr.take().unwrap(), "stderr", is_cargo);
    let child = Arc::new(Mutex::new(child));
    // Two Run presses close together both get here: whatever the other one started is stopped
    // rather than left running with no Stop button.
    let older = procs.with(&label, |w| {
        *w.task_in.lock().unwrap_or_else(|e| e.into_inner()) = stdin;
        w.task.replace(child.clone())
    });
    if let Some(o) = older {
        kill_tree(&mut o.lock().unwrap_or_else(|e| e.into_inner()));
    }
    thread::spawn(move || {
        let code = loop {
            match child.lock().unwrap_or_else(|e| e.into_inner()).try_wait() {
                Ok(Some(st)) => break st.code(),
                Ok(None) => {}
                Err(_) => break None,
            }
            thread::sleep(Duration::from_millis(40));
        };
        // The output ends when the pipes close. A program the task started that keeps them open
        // (a dev server cargo run launched, say) would hold "finished" back forever, so give it
        // two seconds.
        let _ = finish_within(out, Duration::from_secs(2));
        let _ = finish_within(er, Duration::from_secs(2));
        let _ = app.emit_to(&label, "task-done", Done { run, code });
    });
    Ok(run)
}

/// Waits for a thread up to `limit`; its result if it finished.
fn finish_within<T>(h: thread::JoinHandle<T>, limit: Duration) -> Option<T> {
    let until = std::time::Instant::now() + limit;
    while !h.is_finished() && std::time::Instant::now() < until {
        thread::sleep(Duration::from_millis(20));
    }
    if h.is_finished() { h.join().ok() } else { None }
}

/// Kills a process and everything it started (cargo run / dotnet run start the
/// real program as a child, which a plain kill would leave behind).
fn kill_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(windows)]
    {
        let _ = command_at(Path::new("taskkill")).args(["/T", "/F", "/PID", &pid.to_string()]).status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-s", "KILL", "--", &format!("-{pid}")]).status();
    }
    let _ = child.kill();
}

#[cfg(test)]
mod encoding_tests {
    use super::{decode_text, encode_text};
    #[test]
    fn round_trips() {
        for (text, enc) in [("héllo\r\nwörld", "utf8"), ("héllo €", "utf16le"), ("héllo €", "utf16be"), ("plain text here", "utf16le-nobom"), ("plain text here", "utf16be-nobom"), ("café €", "cp1252")] {
            let bytes = encode_text(text, enc).unwrap();
            let (back, got) = decode_text(bytes).unwrap();
            assert_eq!(back, text, "{enc}");
            assert_eq!(got, enc, "{enc}");
        }
    }
    #[test]
    fn refuses_what_it_cant_keep() {
        assert!(decode_text(vec![0xFF, 0xFE, 0x41, 0x00, 0x42]).is_err()); // half a UTF-16 character
        assert!(decode_text(vec![0x89, b'P', b'N', b'G', 0, 0, 0, 13, 0x49, 0x48]).is_err()); // binary
        assert!(encode_text("✓", "cp1252").is_err());
    }
}

#[cfg(test)]
mod save_tests {
    use super::write_atomic;
    #[test]
    fn saves_replace_the_file_whole() {
        let d = std::env::temp_dir().join(format!("ledger-save-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("a.txt");
        write_atomic(&f, b"new file").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"new file");
        write_atomic(&f, b"second version").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"second version");
        // No temporary files left behind.
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1);
        #[cfg(unix)]
        {
            let link = d.join("link.txt");
            std::os::unix::fs::symlink(&f, &link).unwrap();
            write_atomic(&link, b"through the link").unwrap();
            assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
            assert_eq!(std::fs::read(&f).unwrap(), b"through the link");
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod search_tests {
    use super::globs;
    #[test]
    fn include_and_exclude_patterns() {
        let g = globs("*.ts, src/lib, docs/**/*.md").unwrap().unwrap();
        assert!(g.is_match("a/b/c.ts"));
        assert!(g.is_match("src/lib/x/y.rs"));
        assert!(g.is_match("docs/a/b.md"));
        assert!(!g.is_match("src/main.rs"));
        assert!(globs("  ").unwrap().is_none());
    }
    #[test]
    fn finds_every_match_with_utf16_columns() {
        let d = std::env::temp_dir().join(format!("ledger-search-{}", std::process::id()));
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(d.join("src/a.rs"), "let colour = 1; // Colour\nlet é = colour;\n").unwrap();
        std::fs::write(d.join("b.md"), "colours\n").unwrap();
        let root = d.to_string_lossy().to_string();
        let r = super::search_now(&root, "colour", false, false, false, "", "", &|| false).unwrap();
        assert_eq!(r.hits.len(), 4);
        let r = super::search_now(&root, "colour", false, true, true, "", "", &|| false).unwrap();
        assert_eq!(r.hits.len(), 2);
        assert_eq!(r.hits.iter().find(|h| h.line == 1).unwrap().col, 8);
        let r = super::search_now(&root, "col.ur", true, false, false, "*.md", "", &|| false).unwrap();
        assert_eq!(r.hits.len(), 1);
        let r = super::search_now(&root, "colour", false, false, false, "", "src", &|| false).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert!(super::search_now(&root, "(", true, false, false, "", "", &|| false).is_err());
        std::fs::remove_dir_all(&d).ok();
    }
}

#[cfg(test)]
mod output_tests {
    use super::visible;
    #[test]
    fn carriage_returns_start_the_line_again() {
        assert_eq!(visible("plain\r\n"), "plain");
        assert_eq!(visible("10%\r20%\r30%"), "30%");
        assert_eq!(visible("done\r"), "done");
        assert_eq!(visible("a\rb\n"), "b");
    }
}

// ---------- test runs (the Tests panel) ----------
// Output streams to the window line by line ("test-out") while the tests run, all of it comes back
// at the end for reading the results, and test_stop ends the run with every process it started
// (the test program cargo launches, say, stuck in an endless loop).
static TEST_PIDS: std::sync::LazyLock<Mutex<HashMap<String, u32>>> = std::sync::LazyLock::new(Default::default);

#[tauri::command]
async fn run_test(window: tauri::WebviewWindow, procs: State<'_, Procs>, cwd: String, program: String, args: Vec<String>) -> Res<Captured> {
    let label = window.label().to_string();
    if restricted(&procs, &label, &cwd) {
        return Err(trust::UNTRUSTED.into());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let exe = if is_bare(&program) { find_tool(&program) } else { PathBuf::from(&program) };
        let mut cmd = command_at(&exe);
        cmd.args(&args).current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0); // so test_stop can end the whole group
        }
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't run {program} ({e})."))?;
        job::adopt(child.id());
        TEST_PIDS.lock().unwrap_or_else(|e| e.into_inner()).insert(label.clone(), child.id());
        let pump = |r: Box<dyn Read + Send>| {
            let (app, label) = (app.clone(), label.clone());
            thread::spawn(move || {
                const MAX: usize = 64 * 1024 * 1024; // what's kept for reading the results
                let mut all = String::new();
                // Lines go to the window in batches (at most one event per 40 ms), like Output.
                let (mut batch, mut last) = (Vec::<String>::new(), std::time::Instant::now());
                // Bytes, not lines(): one stray non-UTF-8 byte mustn't end the output there.
                for raw in BufReader::new(r).split(b'\n').map_while(Result::ok) {
                    let line = String::from_utf8_lossy(&raw).trim_end_matches('\r').to_string();
                    if all.len() + line.len() < MAX {
                        all.push_str(&line);
                        all.push('\n');
                    }
                    batch.push(line);
                    if batch.len() >= 512 || last.elapsed() >= Duration::from_millis(40) {
                        let _ = app.emit_to(label.as_str(), "test-out", std::mem::take(&mut batch));
                        last = std::time::Instant::now();
                    }
                }
                if !batch.is_empty() {
                    let _ = app.emit_to(label.as_str(), "test-out", batch);
                }
                all
            })
        };
        let out = pump(Box::new(child.stdout.take().unwrap()));
        let err = pump(Box::new(child.stderr.take().unwrap()));
        let status = child.wait();
        TEST_PIDS.lock().unwrap_or_else(|e| e.into_inner()).remove(&label);
        Ok(Captured {
            code: status.ok().and_then(|s| s.code()).unwrap_or(-1),
            out: finish_within(out, Duration::from_secs(3)).unwrap_or_default(),
            err: finish_within(err, Duration::from_secs(3)).unwrap_or_default(),
        })
    })
    .await
    .map_err(err)?
}

/// How many Ledger windows are open (updating asks each one to save first).
#[tauri::command]
fn window_count(app: AppHandle) -> usize {
    app.webview_windows().len()
}

#[tauri::command(async)]
fn test_stop(window: tauri::WebviewWindow) {
    stop_test(window.label());
}

fn stop_test(label: &str) {
    let Some(pid) = TEST_PIDS.lock().unwrap_or_else(|e| e.into_inner()).remove(label) else { return };
    #[cfg(windows)]
    {
        let _ = command_at(Path::new("taskkill")).args(["/T", "/F", "/PID", &pid.to_string()]).status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-s", "KILL", "--", &format!("-{pid}")]).status();
    }
}

fn stop_task(procs: &Procs, label: &str) {
    // Kill first: that also unblocks any input write waiting on a full pipe.
    let (c, input) = procs.with(label, |w| (w.task.take(), w.task_in.clone()));
    if let Some(c) = c {
        kill_tree(&mut c.lock().unwrap_or_else(|e| e.into_inner()));
    }
    input.lock().unwrap_or_else(|e| e.into_inner()).take();
}

#[tauri::command]
async fn task_stop(window: tauri::WebviewWindow, procs: State<'_, Procs>) -> Res<()> {
    stop_task(&procs, window.label());
    Ok(())
}

/// Sends one line to the running program's input (what `read_line` reads).
#[tauri::command]
async fn task_input(window: tauri::WebviewWindow, procs: State<'_, Procs>, text: String) -> Res<()> {
    let input = procs.with(window.label(), |w| w.task_in.clone());
    let mut g = input.lock().unwrap_or_else(|e| e.into_inner());
    let stdin = g.as_mut().ok_or("Nothing is running, or its input was already closed.")?;
    let text = text.trim_end_matches(['\r', '\n']);
    writeln!(stdin, "{text}").map_err(|_| "The program isn't reading input any more.".to_string())?;
    stdin.flush().map_err(err)
}

/// Closes the program's input, like Ctrl+Z then Enter in a Windows terminal.
#[tauri::command]
async fn task_input_end(window: tauri::WebviewWindow, procs: State<'_, Procs>) -> Res<()> {
    let input = procs.with(window.label(), |w| w.task_in.clone());
    input.lock().unwrap_or_else(|e| e.into_inner()).take();
    Ok(())
}

#[derive(Serialize)]
struct Project {
    dir: String,
    rust: bool,
    godot: bool,
    sln: Option<String>,
    csproj: Option<String>,
    /// A package.json here: its script names, the package manager its lockfile
    /// points at, and whether its packages still need installing.
    node: bool,
    scripts: Vec<String>,
    pm: String,
    needs_install: bool,
}

fn read_package(dir: &Path, p: &mut Project) {
    let Ok(text) = std::fs::read_to_string(dir.join("package.json")) else { return };
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    p.node = true;
    p.scripts = v["scripts"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    let has = |f: &str| dir.join(f).exists();
    p.pm = if has("pnpm-lock.yaml") { "pnpm" } else if has("yarn.lock") { "yarn" } else if has("bun.lockb") || has("bun.lock") { "bun" } else { "npm" }.into();
    let deps = ["dependencies", "devDependencies"].iter().any(|k| v[k].as_object().is_some_and(|o| !o.is_empty()));
    p.needs_install = deps && !dir.join("node_modules").is_dir();
}

fn project_in(dir: &Path) -> Option<Project> {
    let mut p = Project { dir: plain_path(dir).replace('\\', "/"), rust: false, godot: false, sln: None, csproj: None, node: false, scripts: vec![], pm: String::new(), needs_install: false };
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        if !e.path().is_file() {
            continue;
        }
        let n = e.file_name().to_string_lossy().to_string();
        let full = || Some(plain_path(&e.path()).replace('\\', "/"));
        if n == "Cargo.toml" {
            p.rust = true;
        } else if n == "project.godot" {
            p.godot = true;
        } else if (n.ends_with(".sln") || n.ends_with(".slnx")) && p.sln.is_none() {
            p.sln = full();
        } else if n.ends_with(".csproj") && p.csproj.is_none() {
            p.csproj = full();
        } else if n == "package.json" {
            read_package(dir, &mut p);
        }
    }
    (p.rust || p.godot || p.node || p.sln.is_some() || p.csproj.is_some()).then_some(p)
}

/// The project `path` belongs to: the nearest folder at or above it, but not
/// above `root`, holding a Cargo.toml, .csproj, .sln, project.godot or package.json. Lets one
/// folder (a course folder, say) hold many projects.
#[tauri::command(async)]
fn project_at(path: String, root: String) -> Option<Project> {
    let root = PathBuf::from(&root);
    let p = PathBuf::from(&path);
    let mut dir = if p.is_dir() { p } else { p.parent()?.to_path_buf() };
    loop {
        if !dir.starts_with(&root) {
            return None;
        }
        if let Some(found) = project_in(&dir) {
            return Some(found);
        }
        if dir == root || !dir.pop() {
            return None;
        }
    }
}

/// Starter files for the project kinds that need no tool to create.
fn web_template(kind: &str, name: &str) -> Option<Vec<(&'static str, String)>> {
    let pkg = name.to_lowercase();
    let html = |head: &str, body: &str| format!("<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{name}</title>\n{head}</head>\n<body>\n{body}</body>\n</html>\n");
    Some(match kind {
        "web" => vec![
            ("index.html", html("  <link rel=\"stylesheet\" href=\"style.css\">\n  <script src=\"script.js\" defer></script>\n", &format!("  <h1>{name}</h1>\n  <p>Click <b>Go Live</b> in the status bar. The page reloads every time you save.</p>\n  <button id=\"hello\">Say hello</button>\n"))),
            ("style.css", "body {\n  font-family: system-ui, sans-serif;\n  max-width: 40rem;\n  margin: 3rem auto;\n  padding: 0 1rem;\n  line-height: 1.5;\n}\n".into()),
            ("script.js", "document.getElementById(\"hello\").addEventListener(\"click\", () => {\n  alert(\"Hello!\");\n});\n".into()),
        ],
        "node" => vec![
            ("package.json", format!("{{\n  \"name\": \"{pkg}\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": {{\n    \"start\": \"node index.js\",\n    \"dev\": \"node --watch index.js\"\n  }}\n}}\n")),
            ("index.js", format!("// {name}: F5 runs it with node --watch, so it restarts when you save.\nconsole.log(\"Hello from {name}!\");\n")),
        ],
        "lua" => vec![("main.lua", format!("-- {name}\n-- F5 runs this file with lua.\n\nlocal function greet(who)\n  return \"Hello, \" .. who .. \"!\"\nend\n\nprint(greet(\"{name}\"))\n"))],
        _ => return None,
    })
}

/// A new Lust app's main.lst: it opens a window. NAME is the project's name.
const LUST_APP_MAIN: &str = r#"-- NAME: where the program starts. It opens a window.
--
-- Welcome to Lust! F5 runs this file, and mistakes are underlined when you save.
-- The window is described in view { }: change the data, and the window follows.
fetch "ui/counter":Counter;

assembly App {
    has {
        string name = "";
    }

    view [title "NAME", width 480, height 360] {
        column [gap 16, pad 24] {
            text "NAME" [huge, bold];
            input name [placeholder "What's your name?", width fill];
            is name != ""? then {
                text "Hello, " + name + "!" [large];
            }
            Counter { label = "Clicks" };
        }
    }
}

App:open();
end
"#;

/// A piece of the new app's window, in its own file.
const LUST_APP_COUNTER: &str = r#"-- A piece of the screen: it counts clicks, and remembers its count between redraws.
assembly Counter {
    has {
        string label = "";
        int count = 0;
    }

    view {
        row [gap 8, pad 12, round, background gray1] {
            text label + ": " + count.text();
            space;
            button "Add one" [blue] {
                count = count + 1;
            }
            button "Reset" [subtle, disabled count == 0] {
                count = 0;
            }
        }
    }
}

pass Counter;
end
"#;

/// A new LustScript project's main.lsc.
const LUST_SCRIPT_MAIN: &str = r#"-- NAME: LustScript, which turns into Lua.
--
-- F5 runs it here. Build writes main.lua next to it, plain Lua 5.1 that
-- Garry's Mod (LuaJIT), Luau and other Lua hosts can run.

method greet(string who) {
    print("Hello, " + who + "!");
}

greet("NAME");

end
"#;

/// `cargo new` / `dotnet new` style project creation. Returns the new folder.
#[tauri::command]
async fn new_project(window: tauri::WebviewWindow, procs: State<'_, Procs>, parent: String, name: String, kind: String) -> Res<String> {
    // cargo new and dotnet new read settings from the folders above (.cargo/config, Directory.Build.*).
    if restricted(&procs, window.label(), &parent) {
        return Err(trust::UNTRUSTED.into());
    }
    if kind == "lustscript" {
        // LustScript: a .lsc file that turns into Lua (lust build writes main.lua next to it).
        let dir = Path::new(&parent).join(&name);
        if dir.exists() {
            return Err(format!("There's already something called {name} there."));
        }
        std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make the folder ({e})."))?;
        let main = LUST_SCRIPT_MAIN.replace("NAME", &name);
        std::fs::write(dir.join("main.lsc"), main).map_err(|e| format!("Couldn't write main.lsc ({e})."))?;
        return Ok(plain_path(&dir));
    }
    if kind == "lust" || kind == "lust-app" {
        // A Lust project is just a folder with a main.lst; no tool needed to make it.
        let dir = Path::new(&parent).join(&name);
        if dir.exists() {
            return Err(format!("There's already something called {name} there."));
        }
        std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make the folder ({e})."))?;
        if kind == "lust-app" {
            // An app opens a window, with one piece of it in its own file in ui/.
            std::fs::create_dir_all(dir.join("ui")).map_err(|e| format!("Couldn't make the ui folder ({e})."))?;
            std::fs::write(dir.join("ui").join("counter.lst"), LUST_APP_COUNTER).map_err(|e| format!("Couldn't write ui/counter.lst ({e})."))?;
            std::fs::write(dir.join("main.lst"), LUST_APP_MAIN.replace("NAME", &name)).map_err(|e| format!("Couldn't write main.lst ({e})."))?;
            let ignore = "# What lust build makes, and saves.\n/main\n/main.exe\n*.save\n*.db\n";
            std::fs::write(dir.join(".gitignore"), ignore).map_err(|e| format!("Couldn't write .gitignore ({e})."))?;
            return Ok(plain_path(&dir));
        }
        let main = format!(
            "-- {name}: where the program starts.\n\
             --\n\
             -- Welcome to Lust! F5 runs this file, and mistakes are underlined when you save.\n\
             -- Build makes a program you can start without Ledger.\n\
             \n\
             string who = ask(\"What's your name?\");\n\
             \n\
             is who == \"\"? then {{\n\
             \x20   who = \"friend\";\n\
             }}\n\
             \n\
             print(\"Hello, \" + who + \"!\");\n\
             \n\
             loop (int n in [3, 2, 1]) {{\n\
             \x20   print(n.text() + \"...\");\n\
             }}\n\
             print(\"Lift off!\");\n\
             \n\
             end\n"
        );
        std::fs::write(dir.join("main.lst"), main).map_err(|e| format!("Couldn't write main.lst ({e})."))?;
        let ignore = "# What lust build makes, and saves.\n/main\n/main.exe\n*.save\n*.db\n";
        std::fs::write(dir.join(".gitignore"), ignore).map_err(|e| format!("Couldn't write .gitignore ({e})."))?;
        return Ok(plain_path(&dir));
    }
    if let Some(files) = web_template(&kind, &name) {
        // Web, Node and Lua projects are plain files; npm install happens on first Run.
        let dir = Path::new(&parent).join(&name);
        if dir.exists() {
            return Err(format!("There's already something called {name} there."));
        }
        for (rel, text) in files {
            let f = dir.join(rel);
            std::fs::create_dir_all(f.parent().unwrap()).map_err(|e| format!("Couldn't make the folder ({e})."))?;
            std::fs::write(&f, text).map_err(|e| format!("Couldn't write {rel} ({e})."))?;
        }
        return Ok(plain_path(&dir));
    }
    let (tool, args): (&str, Vec<String>) = match kind.as_str() {
        "rust" => ("cargo", vec!["new".into(), name.clone()]),
        "rust-lib" => ("cargo", vec!["new".into(), "--lib".into(), name.clone()]),
        "console" => ("dotnet", vec!["new".into(), "console".into(), "-o".into(), name.clone()]),
        "classlib" => ("dotnet", vec!["new".into(), "classlib".into(), "-o".into(), name.clone()]),
        _ => return Err(format!("Unknown project kind {kind}")),
    };
    let out = command_at(&find_tool(tool))
        .args(&args)
        .current_dir(&parent)
        .env("DOTNET_NOLOGO", "1")
        .env("DOTNET_CLI_UI_LANGUAGE", "en")
        .output()
        .map_err(|e| format!("Couldn't start {tool} ({e}). Is it installed?"))?;
    if !out.status.success() {
        let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if msg.is_empty() {
            msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
        return Err(msg);
    }
    Ok(plain_path(&Path::new(&parent).join(&name)))
}

// ---------- language servers and debug adapters ----------
//
// Both speak JSON over stdio with Content-Length headers. Each process is
// keyed by an id ("rust", "csharp", "dap"); outgoing messages are framed here
// and incoming ones are emitted raw as `lsp-message`. The JS side does the rest.

#[derive(Serialize, Clone)]
struct LspMsg {
    id: String,
    pid: u32,
    msg: String,
}

#[derive(Serialize)]
struct Started {
    exe: String,
    pid: u32,
    /// Ledger's own process, for the server's initialize (it can watch for Ledger going away).
    host: u32,
}

fn stop_pipe(procs: &Procs, label: &str, id: &str) {
    if let Some(mut p) = procs.with(label, |w| w.pipes.remove(id)) {
        kill_tree(&mut p.child);
    }
}

/// `probe`: check the program answers `--version` before trusting it (rustup
/// leaves stubs that don't). Debug adapters skip that.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn lsp_start(app: AppHandle, window: tauri::WebviewWindow, procs: State<'_, Procs>, id: String, root: String, exe: String, args: Vec<String>, probe: Option<bool>) -> Res<Started> {
    let label = window.label().to_string();
    // These load the project itself: rust-analyzer runs build scripts and cargo reads the repo's
    // .cargo/config, csharp-ls runs MSBuild, the Lua server loads plugins, and debugging runs the program.
    if matches!(id.as_str(), "rust" | "csharp" | "lua" | "dap") && restricted(&procs, &label, &root) {
        return Err(trust::UNTRUSTED.into());
    }
    stop_pipe(&procs, &label, &id);
    let path = if probe.unwrap_or(true) {
        find_working(&exe)
    } else if is_bare(&exe) {
        candidates(&exe).into_iter().next()
    } else {
        Some(PathBuf::from(&exe)).filter(|p| p.is_file())
    };
    let path = path.ok_or_else(|| format!("not found: {exe}"))?;
    let mut cmd = command_at(&path);
    // In a restricted folder the servers that are allowed (web, JSON) get the folder only as
    // rootUri, not as their working folder: nothing there is ever looked up as a program.
    let wd = if restricted(&procs, &label, &root) { std::env::temp_dir() } else { PathBuf::from(&root) };
    cmd.args(&args).current_dir(&wd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {} ({e})", path.display()))?;
    job::adopt(child.id());
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    // One writer per process, fed in the order messages were sent: with incremental document sync,
    // two edits written the other way round would leave the server's copy of the file wrong.
    let (stdin, rx) = std::sync::mpsc::channel::<String>();
    let mut pipe_in = child.stdin.take().unwrap();
    thread::spawn(move || {
        for msg in rx {
            if write!(pipe_in, "Content-Length: {}\r\n\r\n{}", msg.len(), msg).and_then(|_| pipe_in.flush()).is_err() {
                break;
            }
        }
    });
    let pid = child.id();
    procs.with(&label, |w| w.pipes.insert(id.clone(), Pipe { child, stdin }));

    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let tail2 = tail.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut t = tail2.lock().unwrap_or_else(|e| e.into_inner());
            t.push(line);
            if t.len() > 30 {
                t.remove(0);
            }
        }
    });

    thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        loop {
            let mut len: Option<usize> = None;
            let mut header = String::new();
            loop {
                header.clear();
                match r.read_line(&mut header) {
                    Ok(0) | Err(_) => {
                        thread::sleep(Duration::from_millis(100));
                        let why = tail.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
                        let _ = app.emit_to(&label, "lsp-exit", serde_json::json!({ "id": id, "pid": pid, "stderr": why }));
                        return;
                    }
                    Ok(_) => {}
                }
                let h = header.trim();
                if h.is_empty() {
                    if len.is_some() {
                        break;
                    }
                    continue; // stray blank line before a header
                }
                if let Some(v) = h.strip_prefix("Content-Length:") {
                    len = v.trim().parse().ok();
                }
            }
            let Some(n) = len else { continue };
            let mut body = vec![0u8; n];
            if r.read_exact(&mut body).is_err() {
                continue;
            }
            let _ = app.emit_to(&label, "lsp-message", LspMsg { id: id.clone(), pid, msg: String::from_utf8_lossy(&body).to_string() });
        }
    });
    Ok(Started { exe: plain_path(&path), pid, host: std::process::id() })
}

/// Not async on purpose: sync commands run one after another in the order they were sent, and
/// this only queues the message, so it's quick.
#[tauri::command]
fn lsp_send(window: tauri::WebviewWindow, procs: State<'_, Procs>, id: String, msg: String) -> Res<()> {
    let stdin = procs.with(window.label(), |w| w.pipes.get(&id).map(|p| p.stdin.clone())).ok_or("not running")?;
    stdin.send(msg).map_err(|_| "not running".into())
}

#[tauri::command]
async fn lsp_stop(window: tauri::WebviewWindow, procs: State<'_, Procs>, id: String) -> Res<()> {
    stop_pipe(&procs, window.label(), &id);
    Ok(())
}

// ---------- terminals ----------

#[derive(Serialize, Clone)]
struct TermData {
    id: u32,
    data: String,
}

fn default_shell() -> String {
    static SHELL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SHELL
        .get_or_init(|| {
            if cfg!(windows) {
                if find_working("pwsh").is_some() { "pwsh.exe".into() } else { "powershell.exe".into() }
            } else {
                std::env::var("SHELL").unwrap_or_else(|_| "bash".into())
            }
        })
        .clone()
}

/// "C:\Program Files\Git\bin\bash.exe" --login -i  →  program and arguments.
/// A path with spaces works with or without quotes.
fn split_command(s: &str) -> (String, Vec<String>) {
    let s = s.trim();
    if Path::new(s).is_file() {
        return (s.to_string(), vec![]);
    }
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for ch in s.chars() {
        match ch {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    parts.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    // An unquoted path with spaces: take the longest start that is a real file.
    for n in (1..=parts.len()).rev() {
        let head = parts[..n].join(" ");
        if n > 1 && Path::new(&head).is_file() {
            return (head, parts[n..].to_vec());
        }
    }
    let mut it = parts.into_iter();
    (it.next().unwrap_or_default(), it.collect())
}

#[tauri::command]
async fn term_open(app: AppHandle, window: tauri::WebviewWindow, procs: State<'_, Procs>, cwd: String, cols: u16, rows: u16, shell: Option<String>) -> Res<u32> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let label = window.label().to_string();
    let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(err)?;
    let shell = shell.filter(|s| !s.trim().is_empty()).unwrap_or_else(default_shell);
    let (prog, args) = split_command(&shell);
    let exe = if is_bare(&prog) { candidates(&prog).into_iter().next().unwrap_or_else(|| PathBuf::from(&prog)) } else { PathBuf::from(&prog) };
    let mut cmd = CommandBuilder::new(exe);
    for a in args {
        cmd.arg(a);
    }
    if Path::new(&cwd).is_dir() {
        cmd.cwd(&cwd);
    }
    cmd.env("PATH", child_path());
    cmd.env("NoDefaultCurrentDirectoryInExePath", "1"); // see command_at
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Couldn't start {shell} ({e})"))?;
    if let Some(pid) = child.process_id() {
        job::adopt(pid);
    }
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    let id = procs.id();
    let killer = child.clone_killer();
    procs.with(&label, |w| w.terms.insert(id, Term { writer: Arc::new(Mutex::new(writer)), master: pair.master, killer }));

    let (app2, label2) = (app.clone(), label.clone());
    thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            carry.extend_from_slice(&buf[..n]);
            // Don't split a UTF-8 character across two events.
            let cut = match std::str::from_utf8(&carry) {
                Ok(_) => carry.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => carry.len(),
            };
            let data = String::from_utf8_lossy(&carry[..cut]).to_string();
            carry.drain(..cut);
            let _ = app2.emit_to(&label2, "term-data", TermData { id, data });
        }
    });
    thread::spawn(move || {
        let _ = child.wait();
        let procs = app.state::<Procs>();
        procs.with(&label, |w| w.terms.remove(&id)); // drops the pty, which ends the reader
        let _ = app.emit_to(&label, "term-exit", serde_json::json!({ "id": id }));
    });
    Ok(id)
}

#[tauri::command]
async fn term_write(window: tauri::WebviewWindow, procs: State<'_, Procs>, id: u32, data: String) -> Res<()> {
    let w = procs.with(window.label(), |w| w.terms.get(&id).map(|t| t.writer.clone())).ok_or("terminal closed")?;
    let mut g = w.lock().unwrap_or_else(|e| e.into_inner());
    g.write_all(data.as_bytes()).map_err(err)?;
    g.flush().map_err(err)
}

#[tauri::command]
fn term_resize(window: tauri::WebviewWindow, procs: State<'_, Procs>, id: u32, cols: u16, rows: u16) {
    procs.with(window.label(), |w| {
        if let Some(t) = w.terms.get(&id) {
            let _ = t.master.resize(portable_pty::PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 });
        }
    });
}

#[tauri::command]
async fn term_close(window: tauri::WebviewWindow, procs: State<'_, Procs>, id: u32) -> Res<()> {
    if let Some(mut t) = procs.with(window.label(), |w| w.terms.remove(&id)) {
        let _ = t.killer.kill();
    }
    Ok(())
}

// ---------- git ----------

#[derive(Serialize)]
struct Captured {
    code: i32,
    out: String,
    err: String,
}

/// Runs git and returns what it printed. Never asks on a console; sign-ins go
/// through Git Credential Manager's own window on Windows.
#[tauri::command]
async fn git(window: tauri::WebviewWindow, procs: State<'_, Procs>, cwd: String, args: Vec<String>) -> Res<Captured> {
    let limited = restricted(&procs, window.label(), &cwd);
    tauri::async_runtime::spawn_blocking(move || {
        let out = git_command(&cwd, limited)?
            .args(&args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("Couldn't run git ({e}). Is Git installed?"))?;
        Ok(Captured {
            code: out.status.code().unwrap_or(-1),
            out: String::from_utf8_lossy(&out.stdout).to_string(),
            err: String::from_utf8_lossy(&out.stderr).to_string(),
        })
    })
    .await
    .map_err(err)?
}

/// Runs a tool and returns what it printed, without a console window.
/// Used to check Lust files (.lst, .lsc) with `lust check` after they're saved.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn run_capture(window: tauri::WebviewWindow, procs: State<'_, Procs>, cwd: String, program: String, args: Vec<String>, input: Option<String>, timeout_ms: Option<u64>) -> Res<Captured> {
    // "." means "anywhere": not Ledger's own working folder, which can be a project.
    let cwd = if cwd == "." || cwd.is_empty() { std::env::temp_dir().to_string_lossy().into_owned() } else { cwd };
    let limited = restricted(&procs, window.label(), &cwd);
    if limited && !trust::safe_program(&program, &args) {
        return Err(trust::UNTRUSTED.into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let is_git = Path::new(&program).file_stem().is_some_and(|s| s.eq_ignore_ascii_case("git"));
        let mut cmd = if is_git {
            git_command(&cwd, limited)?
        } else {
            let exe = if is_bare(&program) { find_tool(&program) } else { PathBuf::from(&program) };
            command_at(&exe)
        };
        cmd.args(&args).current_dir(&cwd).stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't run {program} ({e})."))?;
        job::adopt(child.id());
        // Text for the program's stdin (Prettier reads the file from there), written on its own
        // thread so a program that answers while it reads can't block on a full pipe.
        let feeder = match (input, child.stdin.take()) {
            (Some(text), Some(mut pipe)) => Some(thread::spawn(move || {
                let _ = pipe.write_all(text.as_bytes());
            })),
            _ => None,
        };
        // Read both pipes on their own threads, and stop the program (and what it started) if it
        // runs past the time limit: a hung formatter or git mustn't wait forever.
        let read = |r: Option<Box<dyn Read + Send>>| {
            thread::spawn(move || {
                let mut v = Vec::new();
                if let Some(mut r) = r {
                    let _ = r.read_to_end(&mut v);
                }
                v
            })
        };
        let out = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
        let errs = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
        let until = std::time::Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(5 * 60 * 1000));
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break Some(st),
                Ok(None) if std::time::Instant::now() < until => thread::sleep(Duration::from_millis(15)),
                _ => {
                    kill_tree(&mut child);
                    break None;
                }
            }
        };
        if let Some(f) = feeder {
            let _ = finish_within(f, Duration::from_secs(2));
        }
        let (out, errs) = (finish_within(out, Duration::from_secs(3)).unwrap_or_default(), finish_within(errs, Duration::from_secs(3)).unwrap_or_default());
        let Some(status) = status else {
            return Err(format!("{program} didn't finish in time, so Ledger stopped it."));
        };
        Ok(Captured {
            code: status.code().unwrap_or(-1),
            out: String::from_utf8_lossy(&out).to_string(),
            err: String::from_utf8_lossy(&errs).to_string(),
        })
    })
    .await
    .map_err(err)?
}

// ---------- web (dependency versions, debugger downloads) ----------

fn agent() -> ureq::Agent {
    // Connect and per-read limits rather than a total, so big downloads on slow lines finish.
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .user_agent("Ledger editor (dependency version hints)")
        .build()
}

#[tauri::command]
async fn http_get(url: String) -> Res<String> {
    if !url.starts_with("https://") {
        return Err("only https".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let r = agent().get(&url).timeout(Duration::from_secs(15)).call().map_err(err)?;
        r.into_string().map_err(err)
    })
    .await
    .map_err(err)?
}

/// Where a downloaded debugger lives, and the program inside it.
fn debugger_layout(app: &AppHandle, kind: &str) -> Res<(PathBuf, PathBuf, &'static str)> {
    let dir = app.path().app_local_data_dir().map_err(err)?.join("debuggers").join(kind);
    let (exe, url) = match (kind, cfg!(windows)) {
        ("codelldb", true) => ("extension/adapter/codelldb.exe", "https://github.com/vadimcn/codelldb/releases/latest/download/codelldb-win32-x64.vsix"),
        ("codelldb", false) => ("extension/adapter/codelldb", "https://github.com/vadimcn/codelldb/releases/latest/download/codelldb-linux-x64.vsix"),
        ("netcoredbg", true) => ("netcoredbg/netcoredbg.exe", "https://github.com/Samsung/netcoredbg/releases/latest/download/netcoredbg-win64.zip"),
        _ => return Err(format!("Ledger can't download {kind} on this system. Install it yourself and set its path in Settings.")),
    };
    Ok((dir.clone(), dir.join(exe), url))
}

/// The downloaded debugger, if there is one.
#[tauri::command(async)]
fn debugger_path(app: AppHandle, kind: String) -> Option<String> {
    let (_, exe, _) = debugger_layout(&app, &kind).ok()?;
    exe.is_file().then(|| plain_path(&exe))
}

/// Downloads codelldb (Rust) or netcoredbg (C#, Godot) into Ledger's data folder.
#[tauri::command]
async fn install_debugger(app: AppHandle, kind: String) -> Res<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (dir, exe, url) = debugger_layout(&app, &kind)?;
        let resp = agent().get(url).call().map_err(|e| format!("Download failed: {e}"))?;
        let mut bytes = Vec::new();
        resp.into_reader().take(400 * 1024 * 1024).read_to_end(&mut bytes).map_err(err)?;
        // Unpack next to the old copy, then swap, so a failure leaves the old one working.
        let final_dir = dir.clone();
        let dir = final_dir.with_extension("new");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(err)?;
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("The download wasn't a zip file ({e})."))?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(err)?;
            let Some(rel) = f.enclosed_name() else { continue };
            let out = dir.join(rel);
            if f.is_dir() {
                std::fs::create_dir_all(&out).map_err(err)?;
                continue;
            }
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p).map_err(err)?;
            }
            let mut w = std::fs::File::create(&out).map_err(err)?;
            std::io::copy(&mut f, &mut w).map_err(err)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = f.unix_mode() {
                    let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode | 0o600));
                }
            }
        }
        let staged = dir.join(exe.strip_prefix(&final_dir).map_err(err)?);
        if !staged.is_file() {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("Downloaded, but {} wasn't inside.", staged.display()));
        }
        let old = final_dir.with_extension("old");
        let _ = std::fs::remove_dir_all(&old);
        if final_dir.exists() {
            std::fs::rename(&final_dir, &old).map_err(|_| "The debugger is in use. Stop debugging and try again.".to_string())?;
        }
        std::fs::rename(&dir, &final_dir).map_err(err)?;
        let _ = std::fs::remove_dir_all(&old);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
        }
        Ok(plain_path(&exe))
    })
    .await
    .map_err(err)?
}

mod db;
mod trust;
mod job;
mod live;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must come first: a second launch (say, from Godot) hands its
        // arguments to the window that has that folder open and exits.
        // A plain second launch opens a new window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let argv: Vec<String> = argv.into_iter().skip(1).collect();
            if argv.is_empty() {
                let label = format!("win-{}", app.state::<Procs>().id());
                let _ = open_window(app, &label);
                return;
            }
            let Some(label) = pick_window(app, &argv, &cwd) else { return };
            let _ = app.emit_to(&label, "open-args", Args { argv, cwd });
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Procs::default())
        .manage(live::LiveServers::default())
        .on_window_event(|window, ev| {
            if let tauri::WindowEvent::Destroyed = ev {
                stop_window(&window.state::<Procs>(), window.label(), false);
                stop_test(window.label());
                live::stop(&window.state::<live::LiveServers>(), window.label());
                db::close_window(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            refresh_path,
            shell_menu,
            shell_menu_state,
            read_bytes,
            db::db_schema,
            db::db_rows,
            db::db_query,
            db::db_apply,
            db::db_export,
            db::db_create,
            db::db_close,
            db::db_stop,
            live::live_start,
            live::live_stop,
            live::live_reload,
            js_log,
            startup_args,
            exe_path,
            resolve_path,
            find_project_root,
            tool_info,
            settings_read,
            settings_write,
            settings_path,
            list_dir,
            read_file,
            read_text,
            write_file,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            list_files,
            search_text,
            file_stats,
            run_task,
            task_stop,
            task_input,
            task_input_end,
            project_at,
            new_project,
            lsp_start,
            lsp_send,
            lsp_stop,
            term_open,
            term_write,
            term_resize,
            term_close,
            git,
            run_capture,
            run_test,
            stop_everything,
            history_add,
            search_files,
            history_move,
            cache_get,
            cache_set,
            find_todos,
            history_list,
            history_read,
            test_stop,
            window_count,
            copy_path,
            http_get,
            debugger_path,
            install_debugger,
            new_window,
            set_window_root,
            set_window_trust,
            focus_window_with,
            global_tsserver
        ])
        .build(tauri::generate_context!())
        .expect("error while building Ledger")
        .run(|app, ev| {
            if let RunEvent::Exit = ev {
                let procs = app.state::<Procs>();
                let labels: Vec<String> = procs.wins.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
                for l in labels {
                    stop_window(&procs, &l, true);
                }
            }
        });
}
