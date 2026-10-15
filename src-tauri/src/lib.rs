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
            dirs.push(PathBuf::from(pf).join("dotnet"));
        }
    } else {
        dirs.push("/usr/local/share/dotnet".into());
        dirs.push("/usr/share/dotnet".into());
        dirs.push("/usr/local/bin".into());
    }
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
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
    command_at(p)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// First candidate that actually runs. rustup puts stubs in ~/.cargo/bin that
/// fail until a component is installed, so existence alone isn't enough.
fn find_working(name: &str) -> Option<PathBuf> {
    if !is_bare(name) {
        let p = PathBuf::from(name);
        return p.is_file().then_some(p);
    }
    candidates(name).into_iter().find(|p| responds(p))
}

fn find_tool(name: &str) -> PathBuf {
    candidates(name).into_iter().next().unwrap_or_else(|| PathBuf::from(name))
}

fn command_at(exe: &Path) -> Command {
    let mut c = Command::new(exe);
    c.env("PATH", child_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

/// Where a tool resolves to, if it works. Used by the settings page.
#[tauri::command]
async fn tool_info(name: String) -> Option<String> {
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

/// The command line this process started with (minus the program itself).
/// The command line for this window: the process's own for the first window,
/// or the folder a new window was opened with.
#[tauri::command]
fn startup_args(window: tauri::WebviewWindow, procs: State<'_, Procs>) -> Args {
    if window.label() != "main" {
        return procs.pending.lock().unwrap().remove(window.label()).unwrap_or(Args { argv: vec![], cwd: String::new() });
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
#[tauri::command]
fn resolve_path(path: String, cwd: String) -> Option<(String, String)> {
    let p = Path::new(&path);
    let p = if p.is_absolute() { p.to_path_buf() } else { Path::new(&cwd).join(p) };
    let p = std::fs::canonicalize(p).ok()?;
    let kind = if p.is_dir() { "dir" } else { "file" };
    Some((plain_path(&p), kind.into()))
}

/// Nearest folder above `file` that looks like a project root.
#[tauri::command]
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

#[tauri::command]
fn settings_read(app: AppHandle) -> Res<Option<String>> {
    let f = settings_file(&app)?;
    Ok(std::fs::read_to_string(f).ok())
}

#[tauri::command]
fn settings_write(app: AppHandle, json: String) -> Res<String> {
    let f = settings_file(&app)?;
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(err)?;
    }
    std::fs::write(&f, json).map_err(err)?;
    Ok(plain_path(&f))
}

#[tauri::command]
fn settings_path(app: AppHandle) -> Res<String> {
    settings_file(&app).map(|p| plain_path(&p))
}

// ---------- files ----------

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn list_dir(path: String) -> Res<Vec<Entry>> {
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

#[tauri::command]
fn read_file(path: String) -> Res<String> {
    let meta = std::fs::metadata(&path).map_err(err)?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("File is larger than 8 MB.".into());
    }
    let bytes = std::fs::read(&path).map_err(err)?;
    String::from_utf8(bytes).map_err(|_| "This looks like a binary file.".into())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Res<()> {
    std::fs::write(&path, contents).map_err(err)
}

#[tauri::command]
fn create_file(path: String) -> Res<()> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map(|_| ()).map_err(err)
}

#[tauri::command]
fn create_dir(path: String) -> Res<()> {
    if Path::new(&path).exists() {
        return Err("Something with that name already exists.".into());
    }
    std::fs::create_dir_all(&path).map_err(err)
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Res<()> {
    // On Windows, main.rs → Main.rs "exists" already (same file), so allow case-only renames.
    let case_only = from.to_lowercase() == to.to_lowercase();
    if !case_only && Path::new(&to).exists() {
        return Err("Something with that name already exists.".into());
    }
    std::fs::rename(&from, &to).map_err(err)
}

/// Moves to the recycle bin rather than deleting outright.
#[tauri::command]
fn delete_path(path: String) -> Res<()> {
    trash::delete(&path).map_err(err)
}

const SKIP_DIRS: [&str; 7] = [".git", "target", "node_modules", "bin", "obj", ".godot", ".import"];

fn walker(root: &str) -> ignore::Walk {
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && SKIP_DIRS.iter().any(|s| e.file_name() == *s)))
        .build()
}

/// Every file under root, respecting .gitignore. Used by go-to-file.
#[tauri::command]
async fn list_files(root: String) -> Res<Vec<String>> {
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
        let Ok(text) = std::fs::read_to_string(ent.path()) else { continue };
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

/// Modified time (ms since 1970) of each path, or null if it's gone. Lets the
/// editor notice files changed on disk by other programs.
#[tauri::command]
async fn file_stats(paths: Vec<String>) -> Vec<Option<f64>> {
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
}

/// A process spoken to over stdio with Content-Length framing: language
/// servers ("rust", "csharp") and debug adapters ("dap").
struct Pipe {
    child: Child,
    stdin: Shared<ChildStdin>,
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
        let mut g = self.wins.lock().unwrap();
        f(g.entry(label.to_string()).or_default())
    }
    fn id(&self) -> u32 {
        self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
    }
}

/// Stops everything a window started. Used when it closes, and at exit.
fn stop_window(procs: &Procs, label: &str, wait: bool) {
    let win = procs.wins.lock().unwrap().remove(label);
    let Some(mut w) = win else { return };
    // Killing takes a moment per process on Windows; don't hold up the UI for it.
    let job = thread::spawn(move || {
        if let Some(c) = w.task.take() {
            kill_tree(&mut c.lock().unwrap());
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

/// Opens another window, optionally with a folder.
#[tauri::command]
async fn new_window(app: AppHandle, procs: State<'_, Procs>, folder: Option<String>) -> Res<String> {
    let label = format!("win-{}", procs.id());
    procs.pending.lock().unwrap().insert(label.clone(), Args { argv: folder.into_iter().collect(), cwd: String::new() });
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
fn set_window_root(window: tauri::WebviewWindow, procs: State<'_, Procs>, root: Option<String>) {
    procs.with(window.label(), |w| w.root = root);
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

fn pump(app: AppHandle, label: String, run: u64, stream: impl Read + Send + 'static, name: &'static str, cargo: bool) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut r = stream;
        let mut chunk = [0u8; 8192];
        // Bytes of the line being read, until its line ending arrives.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let n = match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.extend_from_slice(&chunk[..n]);
            while let Some(i) = pending.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = pending.drain(..=i).collect();
                emit_line(&app, &label, run, name, cargo, &line, false);
            }
            // What's left has no line ending yet. Show it anyway (a program asking a question
            // waits right here), except for cargo's JSON, which only makes sense whole.
            if !pending.is_empty() && !cargo {
                let valid = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(e) => e.valid_up_to(),
                };
                if valid > 0 {
                    emit_line(&app, &label, run, name, cargo, &pending[..valid], true);
                }
            }
        }
        if !pending.is_empty() {
            let rest = std::mem::take(&mut pending);
            emit_line(&app, &label, run, name, cargo, &rest, false);
        }
    })
}

/// Sends one line of output to the window (cargo's JSON is turned into its readable message first).
fn emit_line(app: &AppHandle, label: &str, run: u64, name: &'static str, cargo: bool, bytes: &[u8], partial: bool) {
    let s = String::from_utf8_lossy(bytes);
    let mut text = s.trim_end_matches(['\n', '\r']).to_string();
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
    let _ = app.emit_to(label, "task-line", Line { run, stream: name, text, partial });
}

/// Runs `program args` in `root`, streaming output as `task-line` events and
/// finishing with `task-done`. `program` is "cargo", "dotnet" or a path (Godot).
/// Anything already running in this window is stopped first.
/// `run` is chosen by the frontend, so it knows the id before any event arrives.
#[tauri::command]
async fn run_task(app: AppHandle, window: tauri::WebviewWindow, procs: State<'_, Procs>, run: u64, root: String, program: String, args: Vec<String>) -> Res<u64> {
    let label = window.label().to_string();
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
    let stdin = child.stdin.take();
    let out = pump(app.clone(), label.clone(), run, child.stdout.take().unwrap(), "stdout", is_cargo);
    let er = pump(app.clone(), label.clone(), run, child.stderr.take().unwrap(), "stderr", is_cargo);
    let child = Arc::new(Mutex::new(child));
    procs.with(&label, |w| {
        *w.task_in.lock().unwrap() = stdin;
        w.task = Some(child.clone());
    });
    thread::spawn(move || {
        let code = loop {
            match child.lock().unwrap().try_wait() {
                Ok(Some(st)) => break st.code(),
                Ok(None) => {}
                Err(_) => break None,
            }
            thread::sleep(Duration::from_millis(40));
        };
        let _ = out.join();
        let _ = er.join();
        let _ = app.emit_to(&label, "task-done", Done { run, code });
    });
    Ok(run)
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
        let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
    }
    let _ = child.kill();
}

fn stop_task(procs: &Procs, label: &str) {
    // Kill first: that also unblocks any input write waiting on a full pipe.
    let (c, input) = procs.with(label, |w| (w.task.take(), w.task_in.clone()));
    if let Some(c) = c {
        kill_tree(&mut c.lock().unwrap());
    }
    input.lock().unwrap().take();
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
    let mut g = input.lock().unwrap();
    let stdin = g.as_mut().ok_or("Nothing is running, or its input was already closed.")?;
    let text = text.trim_end_matches(['\r', '\n']);
    writeln!(stdin, "{text}").map_err(|_| "The program isn't reading input any more.".to_string())?;
    stdin.flush().map_err(err)
}

/// Closes the program's input, like Ctrl+Z then Enter in a Windows terminal.
#[tauri::command]
async fn task_input_end(window: tauri::WebviewWindow, procs: State<'_, Procs>) -> Res<()> {
    let input = procs.with(window.label(), |w| w.task_in.clone());
    input.lock().unwrap().take();
    Ok(())
}

#[derive(Serialize)]
struct Project {
    dir: String,
    rust: bool,
    godot: bool,
    sln: Option<String>,
    csproj: Option<String>,
}

fn project_in(dir: &Path) -> Option<Project> {
    let mut p = Project { dir: plain_path(dir).replace('\\', "/"), rust: false, godot: false, sln: None, csproj: None };
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
        }
    }
    (p.rust || p.godot || p.sln.is_some() || p.csproj.is_some()).then_some(p)
}

/// The project `path` belongs to: the nearest folder at or above it, but not
/// above `root`, holding a Cargo.toml, .csproj, .sln or project.godot. Lets one
/// folder (a course folder, say) hold many projects.
#[tauri::command]
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

/// `cargo new` / `dotnet new` style project creation. Returns the new folder.
#[tauri::command]
async fn new_project(parent: String, name: String, kind: String) -> Res<String> {
    if kind == "lust" {
        // A Lust project is just a folder with a main.lust; no tool needed to make it.
        let dir = Path::new(&parent).join(&name);
        if dir.exists() {
            return Err(format!("There's already something called {name} there."));
        }
        std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make the folder ({e})."))?;
        let main = format!(
            "// {name}\n\
             //\n\
             // Welcome to Lust! F5 runs this file, and mistakes are underlined when you save.\n\
             // Ctrl+Shift+B builds a program you can start without Ledger.\n\
             // Want a window? Make a new .lust file, type window and press Tab.\n\
             \n\
             string who = ask(\"What's your name?\");\n\
             \n\
             is who \"\"? then {{\n\
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
        std::fs::write(dir.join("main.lust"), main).map_err(|e| format!("Couldn't write main.lust ({e})."))?;
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
    cmd.args(&args).current_dir(&root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {} ({e})", path.display()))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let pid = child.id();
    procs.with(&label, |w| w.pipes.insert(id.clone(), Pipe { child, stdin }));

    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let tail2 = tail.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut t = tail2.lock().unwrap();
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
                        let why = tail.lock().unwrap().join("\n");
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
    Ok(Started { exe: plain_path(&path), pid })
}

#[tauri::command]
async fn lsp_send(window: tauri::WebviewWindow, procs: State<'_, Procs>, id: String, msg: String) -> Res<()> {
    let stdin = procs.with(window.label(), |w| w.pipes.get(&id).map(|p| p.stdin.clone())).ok_or("not running")?;
    let mut s = stdin.lock().unwrap();
    write!(s, "Content-Length: {}\r\n\r\n{}", msg.len(), msg).map_err(err)?;
    s.flush().map_err(err)
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
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Couldn't start {shell} ({e})"))?;
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
    let mut g = w.lock().unwrap();
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
async fn git(cwd: String, args: Vec<String>) -> Res<Captured> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = command_at(&find_tool("git"))
            .arg("-c")
            .arg("core.quotepath=false")
            .args(&args)
            .current_dir(&cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
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
/// Used to check .lust files with `lust check` after they're saved.
#[tauri::command]
async fn run_capture(cwd: String, program: String, args: Vec<String>) -> Res<Captured> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = if is_bare(&program) { find_tool(&program) } else { PathBuf::from(&program) };
        let out = command_at(&exe)
            .args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("Couldn't run {program} ({e})."))?;
        Ok(Captured {
            code: out.status.code().unwrap_or(-1),
            out: String::from_utf8_lossy(&out.stdout).to_string(),
            err: String::from_utf8_lossy(&out.stderr).to_string(),
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
#[tauri::command]
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
        .manage(Procs::default())
        .on_window_event(|window, ev| {
            if let tauri::WindowEvent::Destroyed = ev {
                stop_window(&window.state::<Procs>(), window.label(), false);
            }
        })
        .invoke_handler(tauri::generate_handler![
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
            http_get,
            debugger_path,
            install_debugger,
            new_window,
            set_window_root
        ])
        .build(tauri::generate_context!())
        .expect("error while building Ledger")
        .run(|app, ev| {
            if let RunEvent::Exit = ev {
                let procs = app.state::<Procs>();
                let labels: Vec<String> = procs.wins.lock().unwrap().keys().cloned().collect();
                for l in labels {
                    stop_window(&procs, &l, true);
                }
            }
        });
}
