//! Known security problems from OSV.dev, the open database that gathers the RustSec, GitHub
//! (npm and NuGet) and other advisories. One batch query says which advisories touch which
//! package versions; each advisory's details give its severity and the versions that fix it.
//!
//! LEDGER_OSV_URL replaces https://api.osv.dev (for a mirror, or tests).

use crate::net;
use crate::scan::Eco;
use crate::ver;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Sev {
    /// Not a vulnerability: unmaintained, unsound, a yanked release (RustSec's informational).
    Notice,
    Unknown,
    Low,
    Moderate,
    High,
    Critical,
}

impl Sev {
    pub fn word(self) -> &'static str {
        match self {
            Sev::Notice => "notice",
            Sev::Unknown => "unrated",
            Sev::Low => "low",
            Sev::Moderate => "moderate",
            Sev::High => "high",
            Sev::Critical => "critical",
        }
    }
    fn from_word(s: &str) -> Option<Sev> {
        Some(match s.to_ascii_uppercase().as_str() {
            "LOW" => Sev::Low,
            "MODERATE" | "MEDIUM" => Sev::Moderate,
            "HIGH" => Sev::High,
            "CRITICAL" => Sev::Critical,
            _ => return None,
        })
    }
    fn from_score(s: f64) -> Sev {
        if s >= 9.0 {
            Sev::Critical
        } else if s >= 7.0 {
            Sev::High
        } else if s >= 4.0 {
            Sev::Moderate
        } else if s > 0.0 {
            Sev::Low
        } else {
            Sev::Unknown
        }
    }
}

#[derive(Debug, Clone)]
pub struct Advisory {
    pub id: String,
    /// CVE and GHSA names for the same problem.
    pub aliases: Vec<String>,
    pub summary: String,
    pub sev: Sev,
    pub score: Option<f64>,
    /// "unmaintained", "unsound"… for notices.
    pub kind: Option<String>,
    /// The lowest version that fixes it, above the one in use (None: no fix released).
    pub fixed: Option<String>,
    pub url: String,
}

fn base() -> String {
    std::env::var("LEDGER_OSV_URL").unwrap_or_else(|_| "https://api.osv.dev".into()).trim_end_matches('/').to_string()
}

/// CVSS 3.x base score from its vector (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H → 9.8).
pub fn cvss3(vector: &str) -> Option<f64> {
    let m: HashMap<&str, &str> = vector.split('/').filter_map(|p| p.split_once(':')).collect();
    if !m.get("CVSS")?.starts_with('3') {
        return None;
    }
    let changed = *m.get("S")? == "C";
    let av = match *m.get("AV")? { "N" => 0.85, "A" => 0.62, "L" => 0.55, "P" => 0.2, _ => return None };
    let ac = match *m.get("AC")? { "L" => 0.77, "H" => 0.44, _ => return None };
    let pr = match (*m.get("PR")?, changed) { ("N", _) => 0.85, ("L", false) => 0.62, ("L", true) => 0.68, ("H", false) => 0.27, ("H", true) => 0.5, _ => return None };
    let ui = match *m.get("UI")? { "N" => 0.85, "R" => 0.62, _ => return None };
    let cia = |k: &str| -> Option<f64> { Some(match *m.get(k)? { "H" => 0.56, "L" => 0.22, "N" => 0.0, _ => return None }) };
    let iss = 1.0 - (1.0 - cia("C")?) * (1.0 - cia("I")?) * (1.0 - cia("A")?);
    let impact = if changed { 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02).powi(15) } else { 6.42 * iss };
    let exploit = 8.22 * av * ac * pr * ui;
    if impact <= 0.0 {
        return Some(0.0);
    }
    let raw = if changed { (1.08 * (impact + exploit)).min(10.0) } else { (impact + exploit).min(10.0) };
    // CVSS's "round up" to one decimal, done in whole numbers to dodge float noise.
    let i = (raw * 100_000.0).round() as i64;
    Some(if i % 10_000 == 0 { i as f64 / 100_000.0 } else { ((i / 10_000) + 1) as f64 / 10.0 })
}

/// Whether `v` is in one of an "affected" entry's ranges, and the fixed versions of those ranges.
fn affected_by(entry: &Value, v: &str) -> (bool, Vec<String>) {
    let mut hit = entry["versions"].as_array().is_some_and(|l| l.iter().any(|x| x.as_str().is_some_and(|x| ver::cmp(x, v).is_eq())));
    let mut fixes = vec![];
    for r in entry["ranges"].as_array().into_iter().flatten() {
        if r["type"].as_str() == Some("GIT") {
            continue;
        }
        // Events in order: introduced, then fixed or last_affected, possibly several times.
        let mut start: Option<String> = None;
        for e in r["events"].as_array().into_iter().flatten() {
            if let Some(i) = e["introduced"].as_str() {
                start = Some(i.to_string());
            } else if let Some(end) = e["fixed"].as_str().map(|f| (f, true)).or_else(|| e["last_affected"].as_str().map(|f| (f, false))) {
                if let Some(s) = start.take() {
                    let after_start = s == "0" || ver::cmp(v, &s).is_ge();
                    let before_end = if end.1 { ver::cmp(v, end.0).is_lt() } else { ver::cmp(v, end.0).is_le() };
                    if after_start && before_end {
                        hit = true;
                        if end.1 {
                            fixes.push(end.0.to_string());
                        }
                    }
                }
            }
        }
        if let Some(s) = start {
            if s == "0" || ver::cmp(v, &s).is_ge() {
                hit = true; // affected with no fix yet
            }
        }
    }
    (hit, fixes)
}

/// Reads one advisory's details for a package at a version.
pub fn advisory(doc: &Value, eco: Eco, name: &str, version: &str) -> Option<Advisory> {
    if doc["withdrawn"].is_string() {
        return None;
    }
    let mut fixes: Vec<String> = vec![];
    let mut kind = None;
    let mut eco_sev = None;
    let mut any = false;
    for a in doc["affected"].as_array().into_iter().flatten() {
        let p = &a["package"];
        if p["ecosystem"].as_str() != Some(eco.osv()) || !p["name"].as_str().is_some_and(|n| eco.same_name(n, name)) {
            continue;
        }
        let (hit, f) = affected_by(a, version);
        if hit {
            any = true;
            fixes.extend(f);
        }
        if let Some(i) = a["database_specific"]["informational"].as_str().or_else(|| a["ecosystem_specific"]["informational"].as_str()) {
            kind = Some(i.to_string());
        }
        eco_sev = eco_sev.or_else(|| a["ecosystem_specific"]["severity"].as_str().and_then(Sev::from_word));
    }
    if !any {
        return None; // OSV matched the name; this version isn't in the ranges after all
    }
    let score = doc["severity"].as_array().into_iter().flatten().filter_map(|s| s["score"].as_str()).filter_map(cvss3).fold(None::<f64>, |m, s| Some(m.map_or(s, |m| m.max(s))));
    let sev = if kind.is_some() {
        Sev::Notice
    } else if let Some(s) = doc["database_specific"]["severity"].as_str().and_then(Sev::from_word) {
        s
    } else if let Some(s) = eco_sev {
        s
    } else {
        score.map(Sev::from_score).unwrap_or(Sev::Unknown)
    };
    let fixed = fixes.into_iter().filter(|f| ver::cmp(f, version).is_gt()).min_by(|a, b| ver::cmp(a, b));
    let id = doc["id"].as_str().unwrap_or("").to_string();
    let refs: Vec<&Value> = doc["references"].as_array().map(|r| r.iter().collect()).unwrap_or_default();
    let url = refs.iter().find(|r| r["type"].as_str() == Some("ADVISORY")).and_then(|r| r["url"].as_str()).map(str::to_string).unwrap_or_else(|| format!("https://osv.dev/vulnerability/{id}"));
    let summary = doc["summary"].as_str().map(str::to_string).filter(|s| !s.is_empty()).unwrap_or_else(|| doc["details"].as_str().unwrap_or("").lines().next().unwrap_or("").chars().take(120).collect());
    let aliases = doc["aliases"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_string)).collect();
    Some(Advisory { id, aliases, summary: summary.trim().to_string(), sev, score, kind, fixed, url })
}

/// Advisories for each package (in the same order as `pkgs`).
pub fn check(pkgs: &[(Eco, String, String)]) -> Result<Vec<Vec<Advisory>>, String> {
    let b = base();
    let mut ids_per: Vec<Vec<String>> = vec![];
    for chunk in pkgs.chunks(500) {
        let queries: Vec<Value> = chunk.iter().map(|(e, n, v)| json!({ "package": { "name": n, "ecosystem": e.osv() }, "version": v })).collect();
        let r = net::post_json(&format!("{b}/v1/querybatch"), &json!({ "queries": queries })).map_err(|e| format!("Couldn't reach OSV.dev ({e})."))?;
        let results = r["results"].as_array().cloned().unwrap_or_default();
        for i in 0..chunk.len() {
            ids_per.push(results.get(i).and_then(|x| x["vulns"].as_array()).into_iter().flatten().filter_map(|v| v["id"].as_str().map(str::to_string)).collect());
        }
    }
    let unique: Vec<String> = ids_per.iter().flatten().cloned().collect::<BTreeSet<_>>().into_iter().collect();
    let docs: BTreeMap<String, Value> = unique.iter().cloned().zip(net::parallel(&unique, 8, |id| net::get_json(&format!("{b}/v1/vulns/{id}")).unwrap_or(Value::Null))).collect();
    Ok(pkgs
        .iter()
        .zip(ids_per)
        .map(|((e, n, v), ids)| {
            let mut list: Vec<Advisory> = ids.iter().filter_map(|id| docs.get(id)).filter_map(|d| advisory(d, *e, n, v)).collect();
            // The same problem filed twice (a GHSA and a RustSec id that alias each other): keep one.
            let mut seen: BTreeSet<String> = BTreeSet::new();
            // RustSec's own entry for crates (it links rustsec.org), GitHub's for the rest.
            let rank = |a: &Advisory| if a.id.starts_with(if *e == Eco::Cargo { "RUSTSEC" } else { "GHSA" }) { 0 } else { 1 };
            list.sort_by(|a, b| b.sev.cmp(&a.sev).then(rank(a).cmp(&rank(b))).then(a.id.cmp(&b.id)));
            list.retain(|a| {
                let names: Vec<String> = std::iter::once(a.id.clone()).chain(a.aliases.iter().cloned()).collect();
                let dup = names.iter().any(|x| seen.contains(x));
                seen.extend(names);
                !dup
            });
            list
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scores() {
        assert_eq!(cvss3("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), Some(9.8));
        assert_eq!(cvss3("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N"), Some(6.1));
        assert_eq!(cvss3("CVSS:3.0/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:L"), Some(1.8));
        assert_eq!(cvss3("CVSS:4.0/AV:N"), None);
    }
    #[test]
    fn reads_an_advisory() {
        let doc: Value = serde_json::from_str(r#"{
          "id": "GHSA-xxxx", "aliases": ["CVE-2024-1"], "summary": "Prototype pollution",
          "severity": [{ "type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
          "database_specific": { "severity": "HIGH" },
          "references": [{ "type": "WEB", "url": "https://x" }, { "type": "ADVISORY", "url": "https://adv" }],
          "affected": [
            { "package": { "ecosystem": "npm", "name": "lodash" }, "ranges": [{ "type": "SEMVER", "events": [{ "introduced": "0" }, { "fixed": "4.17.21" }] }] },
            { "package": { "ecosystem": "npm", "name": "lodash" }, "ranges": [{ "type": "SEMVER", "events": [{ "introduced": "5.0.0" }, { "fixed": "5.0.2" }] }] }
          ] }"#).unwrap();
        let a = advisory(&doc, Eco::Npm, "lodash", "4.17.15").unwrap();
        assert_eq!((a.sev, a.fixed.as_deref(), a.url.as_str(), a.score), (Sev::High, Some("4.17.21"), "https://adv", Some(9.8)));
        let b = advisory(&doc, Eco::Npm, "lodash", "5.0.1").unwrap();
        assert_eq!(b.fixed.as_deref(), Some("5.0.2"));
        assert!(advisory(&doc, Eco::Npm, "lodash", "4.17.21").is_none());
        assert!(advisory(&doc, Eco::Npm, "other", "1.0.0").is_none());
    }
    #[test]
    fn notices_and_open_ended() {
        let doc: Value = serde_json::from_str(r#"{ "id": "RUSTSEC-2021-0139", "summary": "ansi_term is Unmaintained",
          "affected": [{ "package": { "ecosystem": "crates.io", "name": "ansi_term" }, "database_specific": { "informational": "unmaintained" },
            "ranges": [{ "type": "SEMVER", "events": [{ "introduced": "0.0.0-0" }] }] }] }"#).unwrap();
        let a = advisory(&doc, Eco::Cargo, "ansi_term", "0.12.1").unwrap();
        assert_eq!((a.sev, a.kind.as_deref(), a.fixed.clone()), (Sev::Notice, Some("unmaintained"), None));
    }
}
