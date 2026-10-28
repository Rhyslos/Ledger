//! The installed .NET runtimes and Node.js: security releases you haven't installed, and versions
//! past the end of their support.

use crate::net;
use crate::ver;
use std::process::Command;

pub struct Finding {
    pub what: String,
    pub problem: String,
    pub fix: String,
    /// Security fixes missing (true) or only out of support (false).
    pub security: bool,
}

/// Today as YYYY-MM-DD (UTC).
pub fn today() -> String {
    let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    // Howard Hinnant's days → civil date.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn output(prog: &str, args: &[&str]) -> Option<String> {
    let o = Command::new(prog).args(args).env("DOTNET_CLI_UI_LANGUAGE", "en").env("DOTNET_NOLOGO", "1").output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// The newest installed patch of each .NET runtime channel (8.0, 9.0…): apps roll forward to it.
pub fn dotnet_runtimes(list: &str) -> Vec<String> {
    let mut best: std::collections::BTreeMap<String, String> = Default::default();
    for l in list.lines() {
        let mut p = l.split_whitespace();
        if p.next() != Some("Microsoft.NETCore.App") {
            continue;
        }
        let Some(v) = p.next() else { continue };
        let ch = v.split('.').take(2).collect::<Vec<_>>().join(".");
        let e = best.entry(ch).or_insert_with(|| v.to_string());
        if ver::cmp(v, e).is_gt() {
            *e = v.to_string();
        }
    }
    best.into_values().collect()
}

/// What a channel's releases.json says about an installed runtime version.
pub fn dotnet_check(rel: &serde_json::Value, installed: &str, today: &str) -> Vec<Finding> {
    let mut out = vec![];
    let latest = rel["latest-runtime"].as_str().unwrap_or("");
    let cves: Vec<String> = rel["releases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["security"].as_bool() == Some(true))
        .filter(|r| r["runtime"]["version"].as_str().is_some_and(|v| ver::cmp(v, installed).is_gt()))
        .flat_map(|r| r["cve-list"].as_array().cloned().unwrap_or_default())
        .filter_map(|c| c["cve-id"].as_str().map(str::to_string))
        .collect();
    if !latest.is_empty() && ver::cmp(latest, installed).is_gt() && !cves.is_empty() {
        let n = cves.len();
        out.push(Finding {
            what: format!(".NET runtime {installed}"),
            problem: format!("{n} security fix{} since: {}", if n == 1 { "" } else { "es" }, cves.iter().take(6).cloned().collect::<Vec<_>>().join(", ") + if n > 6 { ", …" } else { "" }),
            fix: format!("install .NET {latest} (winget upgrade Microsoft.DotNet.SDK.{})", installed.split('.').next().unwrap_or("")),
            security: true,
        });
    }
    let eol = rel["eol-date"].as_str().unwrap_or("");
    if rel["support-phase"].as_str() == Some("eol") || (!eol.is_empty() && eol < today) {
        out.push(Finding { what: format!(".NET runtime {installed}"), problem: format!("out of support since {eol}: no more security fixes"), fix: "move projects to a supported .NET (see dotnet.microsoft.com/platform/support/policy)".into(), security: false });
    }
    out
}

/// Node.js: newer releases of the same major marked as security releases, and end of life.
pub fn node_check(index: &serde_json::Value, schedule: &serde_json::Value, installed: &str, today: &str) -> Vec<Finding> {
    let mut out = vec![];
    let major = installed.trim_start_matches('v').split('.').next().unwrap_or("").to_string();
    let same: Vec<&serde_json::Value> = index.as_array().into_iter().flatten().filter(|r| r["version"].as_str().is_some_and(|v| v.trim_start_matches('v').split('.').next() == Some(major.as_str()))).collect();
    let newer_security = same.iter().any(|r| r["security"].as_bool() == Some(true) && r["version"].as_str().is_some_and(|v| ver::cmp(v, installed).is_gt()));
    let newest = same.iter().filter_map(|r| r["version"].as_str()).max_by(|a, b| ver::cmp(a, b)).unwrap_or(installed);
    if newer_security {
        out.push(Finding { what: format!("Node.js {installed}"), problem: "security releases since".into(), fix: format!("install Node.js {newest}"), security: true });
    }
    if let Some(end) = schedule[format!("v{major}")]["end"].as_str() {
        if end < today {
            out.push(Finding { what: format!("Node.js {installed}"), problem: format!("out of support since {end}"), fix: "install the current LTS (winget install OpenJS.NodeJS.LTS)".into(), security: false });
        }
    }
    out
}

/// Everything above, for this computer (skipping what isn't installed or can't be reached).
pub fn check() -> Vec<Finding> {
    let today = today();
    let mut out = vec![];
    if let Some(list) = output("dotnet", &["--list-runtimes"]) {
        for v in dotnet_runtimes(&list) {
            let ch = v.split('.').take(2).collect::<Vec<_>>().join(".");
            let rel = net::get_json(&format!("https://builds.dotnet.microsoft.com/dotnet/release-metadata/{ch}/releases.json")).or_else(|_| net::get_json(&format!("https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/{ch}/releases.json")));
            if let Ok(rel) = rel {
                out.extend(dotnet_check(&rel, &v, &today));
            }
        }
    }
    if let Some(v) = output("node", &["--version"]) {
        let v = v.trim().to_string();
        if let (Ok(index), Ok(schedule)) = (net::get_json("https://nodejs.org/dist/index.json"), net::get_json("https://raw.githubusercontent.com/nodejs/Release/main/schedule.json")) {
            out.extend(node_check(&index, &schedule, &v, &today));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dates() {
        assert_eq!(today().len(), 10);
    }
    #[test]
    fn dotnet() {
        assert_eq!(dotnet_runtimes("Microsoft.AspNetCore.App 8.0.3 [x]\nMicrosoft.NETCore.App 8.0.3 [x]\nMicrosoft.NETCore.App 8.0.10 [x]\nMicrosoft.NETCore.App 9.0.0 [x]\n"), ["8.0.10", "9.0.0"]);
        let rel: serde_json::Value = serde_json::from_str(r#"{ "latest-runtime": "8.0.12", "support-phase": "active", "eol-date": "2026-11-10",
          "releases": [ { "runtime": { "version": "8.0.12" }, "security": true, "cve-list": [{ "cve-id": "CVE-2025-1" }] },
                        { "runtime": { "version": "8.0.11" }, "security": false },
                        { "runtime": { "version": "8.0.10" }, "security": true, "cve-list": [{ "cve-id": "CVE-2024-9" }] } ] }"#).unwrap();
        let f = dotnet_check(&rel, "8.0.10", "2026-01-01");
        assert_eq!(f.len(), 1);
        assert!(f[0].problem.contains("CVE-2025-1") && !f[0].problem.contains("CVE-2024-9"));
        assert_eq!(dotnet_check(&rel, "8.0.12", "2026-01-01").len(), 0);
        assert_eq!(dotnet_check(&rel, "8.0.12", "2026-12-01").len(), 1); // past its end
    }
    #[test]
    fn node() {
        let idx: serde_json::Value = serde_json::from_str(r#"[{ "version": "v20.11.1", "security": true }, { "version": "v20.11.0", "security": false }, { "version": "v18.0.0" }]"#).unwrap();
        let sched: serde_json::Value = serde_json::from_str(r#"{ "v18": { "end": "2025-04-30" }, "v20": { "end": "2026-04-30" } }"#).unwrap();
        assert_eq!(node_check(&idx, &sched, "v20.11.0", "2026-01-01").len(), 1);
        assert_eq!(node_check(&idx, &sched, "v18.0.0", "2026-01-01")[0].security, false);
    }
}
