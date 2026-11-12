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
#[tauri::command(async)]
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
    servers.0.lock().unwrap_or_else(|e| e.into_inner()).insert(window.label().to_string(), live);
    Ok(port)
}

#[tauri::command(async)]
pub fn live_stop(window: WebviewWindow, servers: State<'_, LiveServers>) {
    stop(&servers, window.label());
}

/// Tells every open page to reload; `css` only refreshes stylesheets.
#[tauri::command(async)]
pub fn live_reload(window: WebviewWindow, servers: State<'_, LiveServers>, css: bool) {
    if let Some(l) = servers.0.lock().unwrap_or_else(|e| e.into_inner()).get(window.label()) {
        let msg = format!("data: {}\n\n", if css { "css" } else { "reload" });
        l.clients.lock().unwrap_or_else(|e| e.into_inner()).retain_mut(|c| c.write_all(msg.as_bytes()).and_then(|_| c.flush()).is_ok());
    }
}

pub fn stop(servers: &LiveServers, label: &str) {
    if let Some(l) = servers.0.lock().unwrap_or_else(|e| e.into_inner()).remove(label) {
        l.stop.store(true, Ordering::SeqCst);
        l.clients.lock().unwrap_or_else(|e| e.into_inner()).clear();
        let _ = TcpStream::connect(("127.0.0.1", l.port)); // wakes the accept loop so it sees `stop`
    }
}

fn serve(mut conn: TcpStream, root: &Path, port: u16, clients: &Mutex<Vec<TcpStream>>) -> std::io::Result<()> {
    // A client that connects and says nothing mustn't hold a thread for ever.
    conn.set_read_timeout(Some(std::time::Duration::from_secs(10)))?;
    let mut reader = BufReader::new(conn.try_clone()?);
    let mut first = String::new();
    reader.read_line(&mut first)?;
    let mut host = String::new();
    let mut range = String::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("host") {
                host = v.trim().to_ascii_lowercase();
            } else if k.trim().eq_ignore_ascii_case("range") {
                range = v.trim().to_string();
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
        conn.set_read_timeout(None)?;
        conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n: ledger\n\n")?;
        clients.lock().unwrap_or_else(|e| e.into_inner()).push(conn);
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
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    // Part of a file (audio and video ask for these to skip about): only those bytes are read.
    if inside && !range.is_empty() && ext != "html" && ext != "htm" {
        if let Ok(total) = std::fs::metadata(&file).map(|m| m.len()) {
            return match parse_range(&range, total) {
                Some(Ok((a, b))) => {
                    use std::io::{Read, Seek, SeekFrom};
                    let mut f = std::fs::File::open(&file)?;
                    f.seek(SeekFrom::Start(a))?;
                    let mut body = vec![0; (b - a + 1) as usize];
                    f.read_exact(&mut body)?;
                    respond_with(&mut conn, "206 Partial Content", mime_of(&ext), &body, method, &format!("Content-Range: bytes {a}-{b}/{total}\r\n"))
                }
                Some(Err(())) => respond_with(&mut conn, "416 Range Not Satisfiable", "text/plain", b"", method, &format!("Content-Range: bytes */{total}\r\n")),
                None => serve_whole(&mut conn, &file, &ext, method, &path),
            };
        }
    }
    if !inside {
        return not_found(&mut conn, &path, method);
    }
    serve_whole(&mut conn, &file, &ext, method, &path)
}

fn serve_whole(conn: &mut TcpStream, file: &Path, ext: &str, method: &str, path: &str) -> std::io::Result<()> {
    match std::fs::read(file) {
        Ok(body) => {
            let mime = mime_of(ext);
            if ext == "html" || ext == "htm" {
                respond(conn, "200 OK", mime, &inject(body), method)
            } else {
                respond(conn, "200 OK", mime, &body, method)
            }
        }
        Err(_) => not_found(conn, path, method),
    }
}

fn not_found(conn: &mut TcpStream, path: &str, method: &str) -> std::io::Result<()> {
    let page = format!("<!doctype html><title>Not found</title><p style=\"font:15px system-ui;margin:2em\">Ledger Live Server: <b>{}</b> isn't in this folder.</p>", html_escape(path));
    respond(conn, "404 Not Found", "text/html; charset=utf-8", &inject(page.into_bytes()), method)
}

/// "bytes=0-499", "bytes=500-", "bytes=-500" (the last 500): the first and last byte, inclusive.
/// None for a header this doesn't handle (several ranges, other units): the whole file then.
/// Err for a range past the end.
fn parse_range(h: &str, total: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = h.strip_prefix("bytes=")?.trim();
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if total == 0 {
        return Some(Err(()));
    }
    let r = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return Some(Err(()));
        }
        (total.saturating_sub(n), total - 1)
    } else {
        let a: u64 = a.parse().ok()?;
        let b: u64 = if b.is_empty() { total - 1 } else { b.parse::<u64>().ok()?.min(total - 1) };
        if a > b || a >= total {
            return Some(Err(()));
        }
        (a, b)
    };
    Some(Ok(r))
}

fn respond(conn: &mut TcpStream, status: &str, mime: &str, body: &[u8], method: &str) -> std::io::Result<()> {
    respond_with(conn, status, mime, body, method, "")
}

fn respond_with(conn: &mut TcpStream, status: &str, mime: &str, body: &[u8], method: &str, extra: &str) -> std::io::Result<()> {
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n{extra}Cache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
    conn.write_all(head.as_bytes())?;
    if method != "HEAD" {
        conn.write_all(body)?;
    }
    conn.flush()
}

/// Puts the reload script before </body>, or at the end if there isn't one. Works on the bytes,
/// so a page in another encoding than UTF-8 comes through unchanged.
fn inject(mut body: Vec<u8>) -> Vec<u8> {
    let lower = body.to_ascii_lowercase();
    let at = lower.windows(7).rposition(|w| w == b"</body>").unwrap_or(body.len());
    body.splice(at..at, SCRIPT.bytes());
    body
}

#[cfg(test)]
mod tests {
    #[test]
    fn serves_part_of_a_file() {
        use std::io::{Read, Write};
        let dir = std::env::temp_dir().join(format!("ledger-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("song.mp3"), b"0123456789").unwrap();
        let root = std::fs::canonicalize(&dir).unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let ask = |req: String| {
            let r2 = root.clone();
            let l = listener.try_clone().unwrap();
            let t = std::thread::spawn(move || {
                let (c, _) = l.accept().unwrap();
                let _ = super::serve(c, &r2, port, &std::sync::Mutex::new(vec![]));
            });
            let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            c.write_all(req.as_bytes()).unwrap();
            let mut out = String::new();
            c.read_to_string(&mut out).unwrap();
            t.join().unwrap();
            out
        };
        let part = ask(format!("GET /song.mp3 HTTP/1.1\r\nHost: localhost:{port}\r\nRange: bytes=2-5\r\n\r\n"));
        assert!(part.starts_with("HTTP/1.1 206"), "{part}");
        assert!(part.contains("Content-Range: bytes 2-5/10") && part.contains("Content-Type: audio/mpeg") && part.ends_with("\r\n\r\n2345"), "{part}");
        let whole = ask(format!("GET /song.mp3 HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n"));
        assert!(whole.starts_with("HTTP/1.1 200") && whole.contains("Accept-Ranges: bytes") && whole.ends_with("0123456789"), "{whole}");
        let past = ask(format!("GET /song.mp3 HTTP/1.1\r\nHost: localhost:{port}\r\nRange: bytes=50-\r\n\r\n"));
        assert!(past.starts_with("HTTP/1.1 416"), "{past}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn byte_ranges() {
        use super::parse_range as r;
        assert_eq!(r("bytes=0-499", 1000), Some(Ok((0, 499))));
        assert_eq!(r("bytes=500-", 1000), Some(Ok((500, 999))));
        assert_eq!(r("bytes=-200", 1000), Some(Ok((800, 999))));
        assert_eq!(r("bytes=900-5000", 1000), Some(Ok((900, 999))));
        assert_eq!(r("bytes=1000-", 1000), Some(Err(())));
        assert_eq!(r("bytes=5-2", 1000), Some(Err(())));
        assert_eq!(r("bytes=0-1,5-9", 1000), None);
        assert_eq!(r("items=0-5", 1000), None);
    }

    #[test]
    fn script_goes_before_the_end_of_body() {
        let out = super::inject(b"<html><BODY>hi \xe9</body></html>".to_vec());
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("EventSource") && s.ends_with("</body></html>"));
        assert_eq!(out.iter().filter(|&&b| b == 0xe9).count(), 1); // the Latin-1 byte is untouched
        assert!(String::from_utf8_lossy(&super::inject(b"no body".to_vec())).ends_with("</script>"));
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
        "wav" | "wave" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "weba" => "audio/webm",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mkv" => "video/x-matroska",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "webmanifest" => "application/manifest+json",
        "csv" => "text/csv; charset=utf-8",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}
