//! HTTPS for the terminal command: the system's proxy settings and certificates, short timeouts,
//! and several requests at once.

use std::sync::OnceLock;
use std::time::Duration;

fn build(proxy: bool) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .try_proxy_from_env(proxy)
        .user_agent(concat!("ledger-cli/", env!("CARGO_PKG_VERSION"), " (+https://github.com/Rhyslos/Ledger)"))
        .build()
}

/// Whether NO_PROXY says to go straight to this host (ureq reads the proxy, not the exceptions).
pub fn bypass(url: &str, no_proxy: &str) -> bool {
    let host = url.split("://").nth(1).unwrap_or(url).split(['/', '?']).next().unwrap_or("");
    let host = if host.starts_with('[') { host.split(']').next().unwrap_or(host).trim_start_matches('[') } else { host.rsplit_once(':').map(|(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { host }).unwrap_or(host) }.to_ascii_lowercase();
    no_proxy.split(',').map(|e| e.trim().to_ascii_lowercase()).filter(|e| !e.is_empty()).any(|e| e == "*" || host == e.trim_start_matches('.') || host.ends_with(&format!(".{}", e.trim_start_matches(['.', '*']))))
}

fn agent_for(url: &str) -> &'static ureq::Agent {
    static PROXIED: OnceLock<ureq::Agent> = OnceLock::new();
    static DIRECT: OnceLock<ureq::Agent> = OnceLock::new();
    let np = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")).unwrap_or_default();
    if bypass(url, &np) { DIRECT.get_or_init(|| build(false)) } else { PROXIED.get_or_init(|| build(true)) }
}

/// The whole response (ureq's into_string stops at 10 MB; some npm documents are bigger).
fn body(res: ureq::Response) -> Result<String, String> {
    use std::io::Read;
    let mut s = String::new();
    res.into_reader().take(200 << 20).read_to_string(&mut s).map_err(|e| e.to_string())?;
    Ok(s)
}

pub fn get_json(url: &str) -> Result<serde_json::Value, String> {
    get_json_with(url, &[])
}

pub fn get_json_with(url: &str, headers: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let mut r = agent_for(url).get(url);
    for (k, v) in headers {
        r = r.set(k, v);
    }
    match r.call() {
        Ok(res) => serde_json::from_str(&body(res)?).map_err(|e| e.to_string()),
        Err(ureq::Error::Status(404, _)) => Err("not found".into()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn get_text(url: &str) -> Result<String, String> {
    match agent_for(url).get(url).call() {
        Ok(res) => body(res),
        Err(ureq::Error::Status(404, _)) => Err("not found".into()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn post_json(url: &str, req: &serde_json::Value) -> Result<serde_json::Value, String> {
    let res = agent_for(url).post(url).set("Content-Type", "application/json").send_string(&req.to_string()).map_err(|e| e.to_string())?;
    serde_json::from_str(&body(res)?).map_err(|e| e.to_string())
}

/// Runs `f` over `items` with up to `n` at a time, keeping the order.
pub fn parallel<T: Sync, R: Send>(items: &[T], n: usize, f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let out: Vec<std::sync::Mutex<Option<R>>> = items.iter().map(|_| std::sync::Mutex::new(None)).collect();
    std::thread::scope(|s| {
        for _ in 0..n.max(1).min(items.len().max(1)) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if i >= items.len() {
                    break;
                }
                let r = f(&items[i]);
                *out[i].lock().unwrap() = Some(r);
            });
        }
    });
    out.into_iter().map(|m| m.into_inner().unwrap().unwrap()).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn no_proxy() {
        let np = "localhost,127.0.0.1,.corp.example";
        assert!(super::bypass("http://127.0.0.1:5196/v1", np));
        assert!(super::bypass("https://build.corp.example/x", np));
        assert!(!super::bypass("https://api.osv.dev/v1", np));
        assert!(super::bypass("http://[::1]:80/", "::1"));
    }
}
