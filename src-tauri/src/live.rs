//! Live Server: a small static web server for the open folder. HTML pages get a
//! script that listens on /__ledger/live; saving a file sends "reload" (or
//! "css", which swaps stylesheets without reloading). One server per window.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{State, WebviewWindow};

const LIVE_PATH: &str = "/__ledger/live";
const SCRIPT: &str = r#"<script>(()=>{const s=new EventSource("/__ledger/live");s.onmessage=(e)=>{if(e.data==="css"){for(const l of document.querySelectorAll('link[rel="stylesheet"]')){const u=new URL(l.href);u.searchParams.set("_ledger",Date.now());l.href=u.href;}}else location.reload();};})();</script>"#;

struct Live {
    port: u16,
    stop: Arc<AtomicBool>,
    clients: Arc<Mutex<Vec<TcpStream>>>,
}

#[derive(Default)]
pub struct LiveServers(Mutex<HashMap<String, Live>>);

/// Starts serving `root` (or restarts on a new root). Returns the port.
#[tauri::command]
pub fn live_start(window: WebviewWindow, servers: State<'_, LiveServers>, root: String, port: u16) -> Result<u16, String> {
    stop(&servers, window.label());
    // The real folder (symlinks and junctions resolved), so served files can be checked against it.
    let root = std::fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
    if !root.is_dir() {
        return Err("That folder doesn't exist.".into());
    }
    let first = if port == 0 { 5500 } else { port };
    let listener = (first..first.saturating_add(20))
        .find_map(|p| TcpListener::bind(("127.0.0.1", p)).ok())
        .or_else(|| TcpListener::bind(("127.0.0.1", 0)).ok())
        .ok_or("Couldn't open a port for Live Server.")?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let live = Live { port, stop: Arc::new(AtomicBool::new(false)), clients: Arc::default() };
    let (stop_flag, clients) = (live.stop.clone(), live.clients.clone());
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            let Ok(conn) = conn else { continue };
            let (root, clients) = (root.clone(), clients.clone());
            std::thread::spawn(move || {
                let _ = serve(conn, &root, port, &clients);
            });
        }
    });
    servers.0.lock().unwrap().insert(window.label().to_string(), live);
    Ok(port)
}

#[tauri::command]
pub fn live_stop(window: WebviewWindow, servers: State<'_, LiveServers>) {
    stop(&servers, window.label());
}

/// Tells every open page to reload; `css` only refreshes stylesheets.
#[tauri::command]
pub fn live_reload(window: WebviewWindow, servers: State<'_, LiveServers>, css: bool) {
    if let Some(l) = servers.0.lock().unwrap().get(window.label()) {
        let msg = format!("data: {}\n\n", if css { "css" } else { "reload" });
        l.clients.lock().unwrap().retain_mut(|c| c.write_all(msg.as_bytes()).and_then(|_| c.flush()).is_ok());
    }
}

pub fn stop(servers: &LiveServers, label: &str) {
    if let Some(l) = servers.0.lock().unwrap().remove(label) {
        l.stop.store(true, Ordering::SeqCst);
        l.clients.lock().unwrap().clear();
        let _ = TcpStream::connect(("127.0.0.1", l.port)); // wakes the accept loop so it sees `stop`
    }
}

fn serve(mut conn: TcpStream, root: &Path, port: u16, clients: &Mutex<Vec<TcpStream>>) -> std::io::Result<()> {
    let mut reader = BufReader::new(conn.try_clone()?);
    let mut first = String::new();
    reader.read_line(&mut first)?;
    let mut host = String::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("host") {
                host = v.trim().to_ascii_lowercase();
            }
        }
    }
    // Only pages asked for as this computer: another website can't reach the folder by pointing its
    // own name at 127.0.0.1 (DNS rebinding).
    if !["localhost", "127.0.0.1", "[::1]"].iter().any(|h| host == format!("{h}:{port}")) {
        return respond(&mut conn, "403 Forbidden", "text/plain", b"Live Server only answers localhost.", "GET");
    }
    let mut parts = first.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));
    let path = decode(target.split(['?', '#']).next().unwrap_or("/"));

    if path == LIVE_PATH {
        conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n: ledger\n\n")?;
        clients.lock().unwrap().push(conn);
        return Ok(());
    }
    if method != "GET" && method != "HEAD" {
        return respond(&mut conn, "405 Method Not Allowed", "text/plain", b"Only GET here.", method);
    }
    // Only plain names below root: no "..", no drive letters, and nothing hidden (.git, .env).
    let rel: PathBuf = Path::new(path.trim_start_matches('/')).components().filter_map(|c| match c {
        Component::Normal(n) if n.to_string_lossy().starts_with('.') => Some(Err(())),
        Component::Normal(n) => Some(Ok(n)),
        Component::CurDir => None,
        _ => Some(Err(())),
    }).collect::<Result<_, _>>().unwrap_or_else(|_| PathBuf::from("\0"));
    let mut file = root.join(rel);
    if file.is_dir() {
        if !path.ends_with('/') {
            let to = format!("{path}/");
            return conn.write_all(format!("HTTP/1.1 301 Moved Permanently\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
        }
        file = file.join("index.html");
    }
    // A symlink or junction inside the folder mustn't lead out of it.
    let inside = std::fs::canonicalize(&file).map(|f| f.starts_with(root)).unwrap_or(true);
    match if inside { std::fs::read(&file) } else { Err(std::io::ErrorKind::NotFound.into()) } {
        Ok(body) => {
            let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let mime = mime_of(&ext);
            if ext == "html" || ext == "htm" {
                respond(&mut conn, "200 OK", mime, &inject(body), method)
            } else {
                respond(&mut conn, "200 OK", mime, &body, method)
            }
        }
        Err(_) => {
            let page = format!("<!doctype html><title>Not found</title><p style=\"font:15px system-ui;margin:2em\">Ledger Live Server: <b>{}</b> isn't in this folder.</p>", html_escape(&path));
            respond(&mut conn, "404 Not Found", "text/html; charset=utf-8", &inject(page.into_bytes()), method)
        }
    }
}

fn respond(conn: &mut TcpStream, status: &str, mime: &str, body: &[u8], method: &str) -> std::io::Result<()> {
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
    conn.write_all(head.as_bytes())?;
    if method != "HEAD" {
        conn.write_all(body)?;
    }
    conn.flush()
}

/// Puts the reload script before </body>, or at the end if there isn't one.
fn inject(body: Vec<u8>) -> Vec<u8> {
    let text = String::from_utf8_lossy(&body);
    match text.to_ascii_lowercase().rfind("</body>") {
        Some(i) => format!("{}{SCRIPT}{}", &text[..i], &text[i..]).into_bytes(),
        None => format!("{text}{SCRIPT}").into_bytes(),
    }
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}
