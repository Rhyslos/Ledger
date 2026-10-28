//! Talking to the Ledger window this terminal belongs to (see cli_link.rs in the app).

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;

pub fn available() -> bool {
    std::env::var("LEDGER_LINK").is_ok() && std::env::var("LEDGER_TOKEN").is_ok()
}

pub const OUTSIDE: &str = "This command works in Ledger's own terminal (View › Terminal, or Ctrl+`), where it can reach the Ledger window.";

/// Sends one request and waits for the answer. `wait` is how long the window may take (seconds).
pub fn call(cmd: &str, mut args: Value, wait: u64) -> Result<Value, String> {
    let (Ok(port), Ok(token)) = (std::env::var("LEDGER_LINK"), std::env::var("LEDGER_TOKEN")) else { return Err(OUTSIDE.into()) };
    let window = std::env::var("LEDGER_WINDOW").unwrap_or_default();
    if let Some(o) = args.as_object_mut() {
        o.insert("wait".into(), json!(wait));
    }
    let mut s = TcpStream::connect(("127.0.0.1", port.parse::<u16>().map_err(|_| "LEDGER_LINK isn't a port.")?)).map_err(|_| "Ledger isn't running any more (or this terminal is from an older Ledger).".to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(wait + 15))).ok();
    let req = json!({ "token": token, "window": window, "cmd": cmd, "args": args });
    s.write_all(format!("{req}\n").as_bytes()).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(&s).read_line(&mut line).map_err(|_| "Ledger didn't answer.".to_string())?;
    let v: Value = serde_json::from_str(&line).map_err(|_| "Ledger's answer didn't make sense.".to_string())?;
    if v["ok"].as_bool() == Some(true) { Ok(v["value"].clone()) } else { Err(v["error"].as_str().unwrap_or("Failed.").to_string()) }
}
