//! The States panel's feed: while a Lust program runs from Ledger with the States panel wanted,
//! `lust run` writes each thing with a state of its own, and every change to it, to a file Ledger
//! names in LUST_STATES (one JSON object per line; Lust's src/states.rs). This reads the file as
//! it grows and sends its new lines to the window as `states-lines`, then `states-done` once the
//! program has ended and the last lines are read. The file is apart from the program's output, so
//! nothing it prints can be mistaken for a state.
//!
//! A Lust older than alpha 101 doesn't know LUST_STATES and writes nothing; the panel says so
//! when `states-done` comes with no lines before it.

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// How often the file is looked at. Lust writes every 50 ms.
const EVERY: Duration = Duration::from_millis(100);
/// The most read at once, so a program making things very fast can't hold up the window.
const MOST: u64 = 1 << 20;

#[derive(Serialize, Clone)]
struct Lines {
    run: u64,
    lines: Vec<String>,
}

#[derive(Serialize, Clone)]
struct Done {
    run: u64,
}

/// A run's feed being read.
pub struct Tail {
    stop: Arc<AtomicBool>,
    job: thread::JoinHandle<()>,
}

/// Where run `run` of window `label` has its states written: a new file in the temp folder.
pub fn file_for(label: &str, run: u64) -> PathBuf {
    let safe: String = label.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    std::env::temp_dir().join(format!("ledger-states-{}-{safe}-{run}.jsonl", std::process::id()))
}

/// The whole lines in `buf`, taken out of it; a line still being written stays.
pub fn whole_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { return Vec::new() };
    let rest = buf.split_off(end + 1);
    let done = std::mem::replace(buf, rest);
    String::from_utf8_lossy(&done).lines().map(|l| l.trim_end_matches('\r')).filter(|l| !l.is_empty()).map(String::from).collect()
}

/// Starts reading `path` for run `run`, sending its lines to window `label`.
pub fn start(app: AppHandle, label: String, run: u64, path: PathBuf) -> Tail {
    let stop = Arc::new(AtomicBool::new(false));
    let s = stop.clone();
    let job = thread::spawn(move || {
        let mut at = 0u64;
        let mut buf = Vec::new();
        loop {
            let last = s.load(Ordering::Relaxed);
            // Read until caught up (at most MOST each time round), then wait.
            loop {
                let mut got = Vec::new();
                if let Ok(mut f) = std::fs::File::open(&path) {
                    if f.seek(SeekFrom::Start(at)).is_ok() {
                        let _ = (&mut f).take(MOST).read_to_end(&mut got);
                    }
                }
                at += got.len() as u64;
                let full = got.len() as u64 == MOST;
                buf.extend_from_slice(&got);
                let lines = whole_lines(&mut buf);
                if !lines.is_empty() {
                    let _ = app.emit_to(&label, "states-lines", Lines { run, lines });
                }
                if !(full && last) {
                    break;
                }
            }
            if last {
                break;
            }
            thread::sleep(EVERY);
        }
        let _ = std::fs::remove_file(&path);
        let _ = app.emit_to(&label, "states-done", Done { run });
    });
    Tail { stop, job }
}

impl Tail {
    /// The program has ended: reads what's left, says so, and tidies the file away.
    pub fn finish(self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.job.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_come_out_whole() {
        let mut buf = b"{\"ev\":\"start\"}\n{\"ev\":\"ma".to_vec();
        assert_eq!(whole_lines(&mut buf), ["{\"ev\":\"start\"}"]);
        assert_eq!(buf, b"{\"ev\":\"ma");
        assert!(whole_lines(&mut buf).is_empty());
        buf.extend_from_slice(b"de\"}\r\n\n");
        assert_eq!(whole_lines(&mut buf), ["{\"ev\":\"made\"}"]);
        assert!(buf.is_empty());
    }

    #[test]
    fn broken_text_doesnt_stop_the_lines() {
        let mut buf = vec![b'{', 0xff, b'}', b'\n', b'x', b'\n'];
        assert_eq!(whole_lines(&mut buf), ["{\u{fffd}}", "x"]);
    }

    #[test]
    fn each_run_has_a_file_of_its_own() {
        let a = file_for("main", 1);
        let b = file_for("main", 2);
        let c = file_for("win-2", 1);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert!(file_for("a/../b", 3).file_name().unwrap().to_string_lossy().starts_with("ledger-states-"));
        assert!(!file_for("a/../b", 3).file_name().unwrap().to_string_lossy().contains('/'));
    }
}
