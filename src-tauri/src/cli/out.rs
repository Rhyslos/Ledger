//! Colours in the terminal (unless NO_COLOR is set or the output goes to a file).

use std::io::IsTerminal;
use std::sync::OnceLock;

pub fn on() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal() && vt())
}

/// Windows consoles show colour codes only once asked to (cmd.exe as Ledger's shell, say).
#[cfg(windows)]
fn vt() -> bool {
    use windows_sys::Win32::System::Console::{GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_OUTPUT_HANDLE};
    unsafe {
        let h = GetStdHandle(STD_OUTPUT_HANDLE);
        let mut mode = 0;
        if GetConsoleMode(h, &mut mode) == 0 {
            return false;
        }
        mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 || SetConsoleMode(h, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0
    }
}
#[cfg(not(windows))]
fn vt() -> bool {
    true
}

fn paint(code: &str, s: &str) -> String {
    if on() {
        format!("\x1b[{code}m{s}\x1b[0m")
    } else {
        s.to_string()
    }
}

pub fn bold(s: &str) -> String { paint("1", s) }
pub fn dim(s: &str) -> String { paint("2", s) }
pub fn red(s: &str) -> String { paint("31", s) }
pub fn green(s: &str) -> String { paint("32", s) }
pub fn yellow(s: &str) -> String { paint("33", s) }
pub fn cyan(s: &str) -> String { paint("36", s) }
pub fn magenta(s: &str) -> String { paint("35", s) }

/// Pads to a width counted in characters (colour codes aside).
pub fn pad(s: &str, w: usize) -> String {
    let n = s.chars().count();
    if n >= w { s.to_string() } else { format!("{s}{}", " ".repeat(w - n)) }
}

/// A note while working, on stderr so `--json > file` stays clean.
pub fn step(s: &str) {
    eprintln!("{}", dim(s));
}

pub fn fail(s: &str) -> i32 {
    eprintln!("{} {s}", red("✗"));
    2
}
