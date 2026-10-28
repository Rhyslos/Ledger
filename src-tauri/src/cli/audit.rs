//! `ledger audit`: every project under the folder, the packages it uses, the known security
//! problems in them (OSV.dev), newer versions of the ones you listed yourself, and the .NET and
//! Node.js installed on this computer.

use crate::osv::{self, Advisory, Sev};
use crate::out::*;
use crate::scan::{self, Dep, Eco, Project};
use crate::{link, net, registry, toolchain, ver};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub struct Opts {
    pub json: bool,
    pub updates: bool,
    pub toolchains: bool,
    pub dev: bool,
}

pub struct Vuln {
    pub project: usize,
    pub dep: Dep,
    pub advisories: Vec<Advisory>,
}

pub struct Update {
    pub project: usize,
    pub name: String,
    pub from: String,
    /// The newest version without breaking changes (same major), if newer than `from`.
    pub safe: Option<String>,
    /// The newest version, if it's a new major.
    pub major: Option<String>,
}

pub struct Report {
    /// False when OSV.dev couldn't be asked: nothing can be said about security.
    pub checked: bool,
    pub root: PathBuf,
    pub projects: Vec<Project>,
    pub vulns: Vec<Vuln>,
    pub updates: Vec<Update>,
    pub tools: Vec<toolchain::Finding>,
    pub errors: Vec<String>,
}

impl Report {
    /// Real vulnerabilities (not notices).
    pub fn security_count(&self) -> usize {
        self.vulns.iter().map(|v| v.advisories.iter().filter(|a| a.sev != Sev::Notice).count()).sum()
    }
}

pub fn collect(root: &Path, o: &Opts) -> Report {
    let projects = scan::find(root);
    let mut errors = vec![];
    // Every package version once, across projects.
    let mut keys: Vec<(Eco, String, String)> = vec![];
    for p in &projects {
        for d in &p.deps {
            if !o.dev && d.dev {
                continue;
            }
            let k = (p.eco, d.name.clone(), d.version.clone());
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
    }
    if !o.json {
        let n = keys.len();
        step(&format!("Checking {n} package version{} in {} project{} with OSV.dev…", if n == 1 { "" } else { "s" }, projects.len(), if projects.len() == 1 { "" } else { "s" }));
    }
    let mut checked = true;
    let found: BTreeMap<(Eco, String, String), Vec<Advisory>> = if keys.is_empty() {
        BTreeMap::new()
    } else {
        match osv::check(&keys) {
            Ok(r) => keys.iter().cloned().zip(r).collect(),
            Err(e) => {
                errors.push(e);
                checked = false;
                BTreeMap::new()
            }
        }
    };
    let mut vulns = vec![];
    for (i, p) in projects.iter().enumerate() {
        for d in &p.deps {
            if let Some(a) = found.get(&(p.eco, d.name.clone(), d.version.clone())).filter(|a| !a.is_empty()) {
                vulns.push(Vuln { project: i, dep: d.clone(), advisories: a.clone() });
            }
        }
    }
    let mut updates = vec![];
    if o.updates {
        // Only the packages you listed: the rest move when those do.
        let mut asks: Vec<(usize, Eco, String, String)> = vec![];
        for (i, p) in projects.iter().enumerate() {
            for d in p.deps.iter().filter(|d| d.direct && (o.dev || !d.dev)) {
                asks.push((i, p.eco, d.name.clone(), d.version.clone()));
            }
        }
        let mut uniq: Vec<(Eco, String)> = asks.iter().map(|(_, e, n, _)| (*e, n.clone())).collect();
        uniq.sort();
        uniq.dedup();
        if !o.json && !uniq.is_empty() {
            step(&format!("Looking up newer versions of {} package{}…", uniq.len(), if uniq.len() == 1 { "" } else { "s" }));
        }
        let got: Vec<Result<Vec<String>, String>> = net::parallel(&uniq, 8, |(e, n)| registry::versions(*e, n));
        let missed: Vec<String> = uniq.iter().zip(&got).filter(|(_, r)| matches!(r, Err(e) if e != "not found")).map(|((_, n), _)| n.clone()).collect();
        if !missed.is_empty() {
            errors.push(format!("Couldn't look up newer versions of {} package{} ({}{}).", missed.len(), if missed.len() == 1 { "" } else { "s" }, missed.iter().take(4).cloned().collect::<Vec<_>>().join(", "), if missed.len() > 4 { ", …" } else { "" }));
        }
        let lists: BTreeMap<(Eco, String), Vec<String>> = uniq.iter().cloned().zip(got.into_iter().map(|r| r.unwrap_or_default())).collect();
        for (i, e, n, cur) in asks {
            let all = lists.get(&(e, n.clone())).cloned().unwrap_or_default();
            let (best, compat) = ver::newest(&all, &cur, ver::is_pre(&cur));
            let safe = compat.filter(|v| ver::cmp(v, &cur).is_gt()).cloned();
            let major = best.filter(|v| ver::cmp(v, &cur).is_gt() && !ver::compatible(&cur, v)).cloned();
            if safe.is_some() || major.is_some() {
                updates.push(Update { project: i, name: n, from: cur, safe, major });
            }
        }
    }
    let tools = if o.toolchains { toolchain::check() } else { vec![] };
    Report { checked, root: root.to_path_buf(), projects, vulns, updates, tools, errors }
}

fn sev_tag(s: Sev) -> String {
    let w = pad(s.word(), 9);
    match s {
        Sev::Critical => bold(&red(&w)),
        Sev::High => red(&w),
        Sev::Moderate => yellow(&w),
        Sev::Low | Sev::Unknown => cyan(&w),
        Sev::Notice => dim(&w),
    }
}

pub fn rel(root: &Path, p: &Path) -> String {
    let r = p.strip_prefix(root).unwrap_or(p).display().to_string();
    if r.is_empty() { ".".into() } else { r.replace('\\', "/") }
}

pub fn print(r: &Report) {
    println!("{} {}", bold("Ledger audit"), dim(&r.root.display().to_string()));
    if r.projects.is_empty() {
        println!("\n  No Rust, npm or .NET projects here.");
    }
    for (i, p) in r.projects.iter().enumerate() {
        let lock = p.lock.as_ref().and_then(|l| l.file_name()).map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| "no lock file".into());
        println!("\n  {} {}  {}", bold(p.eco.label()), bold(&p.name), dim(&format!("{} · {} · {} package{}", rel(&r.root, &p.dir), lock, p.deps.len(), if p.deps.len() == 1 { "" } else { "s" })));
        if let Some(n) = &p.note {
            println!("    {} {}", yellow("!"), n);
        }
        let vs: Vec<&Vuln> = r.vulns.iter().filter(|v| v.project == i).collect();
        for v in &vs {
            for a in &v.advisories {
                let fix = match &a.fixed {
                    Some(f) if a.kind.is_none() => green(&format!("fixed in {f}")),
                    _ if a.kind.is_some() => dim(a.kind.as_deref().unwrap_or("")),
                    _ => red("no fix yet"),
                };
                let via = if v.dep.direct { String::new() } else if v.dep.via.is_empty() { dim(" (indirect)") } else { dim(&format!(" (through {})", v.dep.via.iter().take(3).cloned().collect::<Vec<_>>().join(", "))) };
                println!("    {} {} {}{}  {}", sev_tag(a.sev), bold(&format!("{} {}", v.dep.name, v.dep.version)), fix, via, dim(&a.id));
                println!("      {}  {}", a.summary, dim(&a.url));
            }
        }
        let us: Vec<&Update> = r.updates.iter().filter(|u| u.project == i).collect();
        for u in &us {
            let mut parts = vec![];
            if let Some(s) = &u.safe {
                parts.push(green(&format!("{s} (safe)")));
            }
            if let Some(m) = &u.major {
                parts.push(magenta(&format!("{m} (new major)")));
            }
            println!("    {} {} {} → {}", cyan("↑"), u.name, dim(&u.from), parts.join(", "));
        }
        if vs.is_empty() && p.note.is_none() && r.checked && !p.deps.is_empty() {
            println!("    {} no known security problems", green("✓"));
        }
    }
    if !r.tools.is_empty() {
        println!("\n  {}", bold("This computer"));
        for t in &r.tools {
            println!("    {} {}: {}", if t.security { red(&pad("security", 9)) } else { yellow(&pad("support", 9)) }, bold(&t.what), t.problem);
            println!("      {}", dim(&format!("Fix: {}", t.fix)));
        }
    }
    for e in &r.errors {
        println!("\n  {} {e}", red("✗"));
    }
    // Summary
    let mut by: BTreeMap<Sev, usize> = BTreeMap::new();
    for v in &r.vulns {
        for a in &v.advisories {
            *by.entry(a.sev).or_default() += 1;
        }
    }
    let sec = r.security_count();
    let notices = by.get(&Sev::Notice).copied().unwrap_or(0);
    let counts: Vec<String> = [Sev::Critical, Sev::High, Sev::Moderate, Sev::Low, Sev::Unknown].iter().filter_map(|s| by.get(s).map(|n| format!("{n} {}", s.word()))).collect();
    let safe = r.updates.iter().filter(|u| u.safe.is_some()).count();
    let major = r.updates.iter().filter(|u| u.major.is_some()).count();
    println!();
    if !r.checked {
        println!("{} Security wasn't checked: OSV.dev couldn't be reached.", red("✗"));
    } else if sec == 0 {
        println!("{} No known security problems in your packages.", green("✓"));
    } else {
        println!("{} {sec} security problem{} ({}).", red("✗"), if sec == 1 { "" } else { "s" }, counts.join(", "));
    }
    if notices > 0 {
        println!("{} {notices} notice{} (unmaintained or unsound packages).", yellow("!"), if notices == 1 { "" } else { "s" });
    }
    if safe + major > 0 {
        println!("{} {} package{} can be updated: {safe} safely, {major} to a new major version.", cyan("↑"), r.updates.len(), if r.updates.len() == 1 { "" } else { "s" });
    }
    let fixable = r.vulns.iter().filter(|v| v.advisories.iter().any(|a| a.fixed.is_some() && a.kind.is_none())).count();
    if fixable > 0 {
        println!("\n{} fixes what has a fix ({} --dry-run shows the plan first).", bold("ledger audit fix"), "ledger audit fix");
    } else if safe > 0 {
        println!("\n{} takes the safe updates.", bold("ledger update"));
    }
}

pub fn to_json(r: &Report) -> Value {
    json!({
        "root": r.root,
        "checked": r.checked,
        "projects": r.projects.iter().enumerate().map(|(i, p)| json!({
            "ecosystem": p.eco.key(), "name": p.name, "dir": p.dir, "lock": p.lock, "packages": p.deps.len(), "note": p.note,
            "vulnerabilities": r.vulns.iter().filter(|v| v.project == i).flat_map(|v| v.advisories.iter().map(move |a| json!({
                "package": v.dep.name, "version": v.dep.version, "direct": v.dep.direct, "through": v.dep.via,
                "id": a.id, "aliases": a.aliases, "severity": a.sev.word(), "score": a.score, "kind": a.kind, "summary": a.summary, "fixed": a.fixed, "url": a.url,
            }))).collect::<Vec<_>>(),
            "updates": r.updates.iter().filter(|u| u.project == i).map(|u| json!({ "package": u.name, "from": u.from, "safe": u.safe, "major": u.major })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "computer": r.tools.iter().map(|t| json!({ "what": t.what, "problem": t.problem, "fix": t.fix, "security": t.security })).collect::<Vec<_>>(),
        "errors": r.errors,
    })
}

/// The line in a manifest that names a package (0-based), if there is one.
pub fn line_of(text: &str, eco: Eco, name: &str) -> Option<usize> {
    let esc = regex::escape(name);
    let pat = match eco {
        Eco::Cargo => format!(r#"^\s*(?:{esc}\s*(?:=|\.)|\[(?:[\w.'"-]*\.)?dependencies\.{esc}\]|.*\bpackage\s*=\s*"{esc}")"#),
        Eco::Npm => format!(r#"^\s*"{esc}"\s*:"#),
        Eco::NuGet => format!(r#"(?i)<Package(?:Reference|Version)\b[^>]*\b(?:Include|Update)\s*=\s*"{esc}""#),
    };
    let re = regex::Regex::new(&pat).ok()?;
    text.lines().position(|l| re.is_match(l))
}

/// What the editor marks: per manifest file, a problem on the line of each package (a package
/// that comes in through another is marked on that one's line).
pub fn marks(r: &Report) -> Value {
    let mut files: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for p in &r.projects {
        for m in &p.manifests {
            files.entry(m.display().to_string()).or_default();
        }
    }
    for v in &r.vulns {
        let p = &r.projects[v.project];
        let names: Vec<&String> = if v.dep.direct { vec![&v.dep.name] } else { v.dep.via.iter().collect() };
        let mut placed = false;
        for m in &p.manifests {
            let text = std::fs::read_to_string(m).unwrap_or_default();
            for n in &names {
                if let Some(line) = line_of(&text, p.eco, n) {
                    for a in &v.advisories {
                        let through = if v.dep.direct { String::new() } else { format!(" (in {} {}, which {n} uses)", v.dep.name, v.dep.version) };
                        let fix = match (&a.fixed, &a.kind) {
                            (_, Some(k)) => format!(" ({k})"),
                            (Some(f), None) => format!(". Fixed in {f}: ledger audit fix"),
                            (None, None) => ". No fix released yet".into(),
                        };
                        files.entry(m.display().to_string()).or_default().push(json!({
                            "line": line, "severity": match a.sev { Sev::Critical | Sev::High => 1, Sev::Notice => 3, _ => 2 },
                            "code": a.id, "message": format!("{} {}{through}: {}{fix}", a.sev.word(), if a.kind.is_some() { "notice" } else { "security problem" }, a.summary),
                        }));
                    }
                    placed = true;
                    break;
                }
            }
            if placed {
                break;
            }
        }
    }
    json!({ "root": r.root, "files": files })
}

pub fn run(root: &Path, o: Opts) -> i32 {
    let r = collect(root, &o);
    if o.json {
        println!("{}", serde_json::to_string_pretty(&to_json(&r)).unwrap_or_default());
    } else {
        print(&r);
    }
    // Into the editor's Problems and onto the package lines, when run in Ledger's terminal.
    // (Not when OSV.dev couldn't be asked: the marks from the last check still stand.)
    if link::available() && r.checked {
        let _ = link::call("audit", marks(&r), 10);
    }
    if !r.checked {
        2
    } else if r.security_count() > 0 {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lines() {
        let cargo = "[dependencies]\nserde = \"1\"\nrand.workspace = true\n[dependencies.tokio]\nversion = \"1\"\nalias = { package = \"real\", version = \"2\" }\n";
        assert_eq!(line_of(cargo, Eco::Cargo, "serde"), Some(1));
        assert_eq!(line_of(cargo, Eco::Cargo, "rand"), Some(2));
        assert_eq!(line_of(cargo, Eco::Cargo, "tokio"), Some(3));
        assert_eq!(line_of(cargo, Eco::Cargo, "real"), Some(5));
        assert_eq!(line_of("{\n  \"dependencies\": {\n    \"react\": \"^18\"\n  }\n}", Eco::Npm, "react"), Some(2));
        assert_eq!(line_of("<ItemGroup>\n  <PackageReference Include=\"newtonsoft.json\" Version=\"12\" />", Eco::NuGet, "Newtonsoft.Json"), Some(1));
    }
}
