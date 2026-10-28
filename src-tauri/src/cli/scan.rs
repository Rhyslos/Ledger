//! Finds the projects under a folder and the packages each one uses, from their lock files:
//!   Rust  Cargo.toml (what you asked for) and Cargo.lock (everything, with versions)
//!   npm   package.json and package-lock.json / npm-shrinkwrap.json / yarn.lock / pnpm-lock.yaml
//!   .NET  .csproj/.fsproj/.vbproj (+ Directory.Packages.props) and obj/project.assets.json,
//!         which dotnet restore writes; packages.config for old projects
//! Nothing here runs the project's code or tools: it only reads files.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Eco {
    Cargo,
    Npm,
    NuGet,
}

impl Eco {
    /// OSV's name for the ecosystem.
    pub fn osv(self) -> &'static str {
        match self {
            Eco::Cargo => "crates.io",
            Eco::Npm => "npm",
            Eco::NuGet => "NuGet",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Eco::Cargo => "Rust",
            Eco::Npm => "npm",
            Eco::NuGet => "C#",
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Eco::Cargo => "cargo",
            Eco::Npm => "npm",
            Eco::NuGet => "nuget",
        }
    }
    /// NuGet ids ignore case; crates.io and npm names don't.
    pub fn same_name(self, a: &str, b: &str) -> bool {
        match self {
            Eco::NuGet => a.eq_ignore_ascii_case(b),
            Eco::Cargo => a.replace('-', "_") == b.replace('-', "_"),
            Eco::Npm => a == b,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Dep {
    pub name: String,
    pub version: String,
    /// Listed in the project's own file (not only pulled in by another package).
    pub direct: bool,
    pub dev: bool,
    /// The direct packages that pull this one in (for a package that isn't direct).
    pub via: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Project {
    pub eco: Eco,
    pub name: String,
    pub dir: PathBuf,
    /// The files that list the direct packages (Cargo.toml of each workspace member, package.json,
    /// the .csproj), for marks in the editor and for fixes.
    pub manifests: Vec<PathBuf>,
    pub lock: Option<PathBuf>,
    pub deps: Vec<Dep>,
    /// Something the check couldn't see (no lock file yet, say).
    pub note: Option<String>,
}

const SKIP: [&str; 9] = ["node_modules", "target", "bin", "obj", ".git", "dist", ".godot", "packages", ".vs"];

/// Every file under `root` worth looking at, skipping build output and package folders.
fn files(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let walk = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && e.depth() > 0 && SKIP.iter().any(|s| e.file_name().eq_ignore_ascii_case(s))))
        .build();
    for e in walk.flatten() {
        if e.file_type().is_some_and(|t| t.is_file()) {
            out.push(e.into_path());
        }
    }
    out
}

pub fn find(root: &Path) -> Vec<Project> {
    let all = files(root);
    let named = |n: &str| all.iter().filter(|p| p.file_name().is_some_and(|f| f.eq_ignore_ascii_case(n))).cloned().collect::<Vec<_>>();
    let mut out = vec![];
    out.extend(cargo_projects(root, &named("Cargo.toml")));
    out.extend(npm_projects(root, &named("package.json")));
    let dotnet: Vec<PathBuf> = all.iter().filter(|p| p.extension().is_some_and(|e| ["csproj", "fsproj", "vbproj"].iter().any(|x| e.eq_ignore_ascii_case(x)))).cloned().collect();
    out.extend(dotnet.iter().filter_map(|p| nuget_project(root, p)));
    out.sort_by(|a, b| a.dir.cmp(&b.dir).then(a.eco.cmp(&b.eco)));
    out
}

/// The nearest folder at or above `dir` (and not above `root`) with a file called `name`.
fn up_with(root: &Path, dir: &Path, names: &[&str]) -> Option<PathBuf> {
    let mut d = Some(dir);
    while let Some(x) = d {
        for n in names {
            if x.join(n).is_file() {
                return Some(x.join(n));
            }
        }
        if x == root {
            break;
        }
        d = x.parent().filter(|p| p.starts_with(root));
    }
    None
}

fn read(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim_start_matches('\u{feff}').to_string())
}

fn dir_name(d: &Path) -> String {
    d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| d.display().to_string())
}

// ---------------------------------------------------------------- Rust

/// The registry packages a Cargo.toml asks for: name → is it only for development (tests, benches).
pub fn cargo_direct(text: &str, workspace: Option<&toml::Table>) -> BTreeMap<String, bool> {
    let mut out = BTreeMap::new();
    let Ok(t) = text.parse::<toml::Table>() else { return out };
    let mut tables: Vec<(&toml::Table, bool)> = vec![];
    for (k, dev) in [("dependencies", false), ("build-dependencies", false), ("dev-dependencies", true)] {
        if let Some(x) = t.get(k).and_then(|v| v.as_table()) {
            tables.push((x, dev));
        }
    }
    if let Some(targets) = t.get("target").and_then(|v| v.as_table()) {
        for (_, tt) in targets {
            for (k, dev) in [("dependencies", false), ("build-dependencies", false), ("dev-dependencies", true)] {
                if let Some(x) = tt.get(k).and_then(|v| v.as_table()) {
                    tables.push((x, dev));
                }
            }
        }
    }
    if let Some(x) = t.get("workspace").and_then(|w| w.get("dependencies")).and_then(|v| v.as_table()) {
        tables.push((x, false));
    }
    for (table, dev) in tables {
        for (key, v) in table {
            let mut name = key.clone();
            let mut registry = true;
            if let Some(d) = v.as_table() {
                if let Some(p) = d.get("package").and_then(|p| p.as_str()) {
                    name = p.to_string();
                }
                if d.get("workspace").and_then(|w| w.as_bool()) == Some(true) {
                    if let Some(w) = workspace.and_then(|w| w.get(key)).and_then(|w| w.as_table()) {
                        if let Some(p) = w.get("package").and_then(|p| p.as_str()) {
                            name = p.to_string();
                        }
                        registry = !(w.contains_key("path") || w.contains_key("git"));
                    }
                } else {
                    registry = !(d.contains_key("path") || d.contains_key("git"));
                }
            }
            if registry {
                let e = out.entry(name).or_insert(dev);
                *e = *e && dev;
            }
        }
    }
    out
}

/// Cargo.lock's registry packages, and for each package the names of what it depends on.
pub fn cargo_lock(text: &str) -> (Vec<(String, String)>, HashMap<String, Vec<String>>) {
    let mut pkgs = vec![];
    let mut deps = HashMap::new();
    let Ok(t) = text.parse::<toml::Table>() else { return (pkgs, deps) };
    for p in t.get("package").and_then(|v| v.as_array()).into_iter().flatten() {
        let (Some(name), Some(ver)) = (p.get("name").and_then(|v| v.as_str()), p.get("version").and_then(|v| v.as_str())) else { continue };
        let kids: Vec<String> = p.get("dependencies").and_then(|v| v.as_array()).into_iter().flatten().filter_map(|d| d.as_str()).map(|d| d.split(' ').next().unwrap_or(d).to_string()).collect();
        deps.entry(name.to_string()).or_insert_with(Vec::new).extend(kids);
        let src = p.get("source").and_then(|v| v.as_str()).unwrap_or("");
        if src.starts_with("registry+") || src.starts_with("sparse+") {
            pkgs.push((name.to_string(), ver.to_string()));
        }
    }
    (pkgs, deps)
}

/// For each package, the direct packages it's reached through (breadth-first from each direct one).
fn reached_via(direct: &BTreeSet<String>, kids: &HashMap<String, Vec<String>>) -> HashMap<String, BTreeSet<String>> {
    let mut via: HashMap<String, BTreeSet<String>> = HashMap::new();
    for top in direct {
        let mut seen = BTreeSet::new();
        let mut queue = vec![top.clone()];
        while let Some(n) = queue.pop() {
            for k in kids.get(&n).into_iter().flatten() {
                if seen.insert(k.clone()) {
                    via.entry(k.clone()).or_default().insert(top.clone());
                    queue.push(k.clone());
                }
            }
        }
    }
    via
}

fn cargo_projects(root: &Path, tomls: &[PathBuf]) -> Vec<Project> {
    // Group each Cargo.toml with the Cargo.lock it uses: its own, or its workspace's above it.
    let mut groups: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    let mut lone = vec![];
    for t in tomls {
        let dir = t.parent().unwrap_or(root);
        match up_with(root, dir, &["Cargo.lock"]) {
            Some(lock) => groups.entry(lock).or_default().push(t.clone()),
            None => lone.push(t.clone()),
        }
    }
    let mut out = vec![];
    for (lock, manifests) in groups {
        let dir = lock.parent().unwrap_or(root).to_path_buf();
        let ws_text = read(&dir.join("Cargo.toml")).unwrap_or_default();
        let ws = ws_text.parse::<toml::Table>().ok();
        let ws_deps = ws.as_ref().and_then(|w| w.get("workspace")).and_then(|w| w.get("dependencies")).and_then(|d| d.as_table()).cloned();
        let mut direct: BTreeMap<String, bool> = BTreeMap::new();
        for m in &manifests {
            for (n, dev) in cargo_direct(&read(m).unwrap_or_default(), ws_deps.as_ref()) {
                let e = direct.entry(n).or_insert(dev);
                *e = *e && dev;
            }
        }
        let (pkgs, kids) = cargo_lock(&read(&lock).unwrap_or_default());
        let names: BTreeSet<String> = direct.keys().cloned().collect();
        let via = reached_via(&names, &kids);
        let deps = pkgs
            .into_iter()
            .map(|(name, version)| {
                let d = direct.get(&name);
                Dep { direct: d.is_some(), dev: d.copied().unwrap_or(false), via: if d.is_some() { vec![] } else { via.get(&name).map(|s| s.iter().cloned().collect()).unwrap_or_default() }, name, version }
            })
            .collect();
        let name = ws.as_ref().and_then(|w| w.get("package")).and_then(|p| p.get("name")).and_then(|n| n.as_str()).map(str::to_string).unwrap_or_else(|| dir_name(&dir));
        out.push(Project { eco: Eco::Cargo, name, dir, manifests, lock: Some(lock), deps, note: None });
    }
    for m in lone {
        let dir = m.parent().unwrap_or(root).to_path_buf();
        let text = read(&m).unwrap_or_default();
        let name = text.parse::<toml::Table>().ok().and_then(|t| t.get("package").and_then(|p| p.get("name")).and_then(|n| n.as_str()).map(str::to_string)).unwrap_or_else(|| dir_name(&dir));
        out.push(Project { eco: Eco::Cargo, name, dir, manifests: vec![m], lock: None, deps: vec![], note: Some("No Cargo.lock yet, so the versions in use aren't known. Build once (or run cargo generate-lockfile) and audit again.".into()) });
    }
    out
}

// ---------------------------------------------------------------- npm

/// package.json's packages: name → only for development.
pub fn npm_direct(text: &str) -> BTreeMap<String, bool> {
    let mut out = BTreeMap::new();
    let Ok(j) = serde_json::from_str::<Value>(text) else { return out };
    for (k, dev) in [("dependencies", false), ("optionalDependencies", false), ("peerDependencies", false), ("devDependencies", true)] {
        if let Some(o) = j[k].as_object() {
            for (n, spec) in o {
                // Not from the registry: file:, link:, workspace:, git and URLs.
                let s = spec.as_str().unwrap_or("");
                if ["file:", "link:", "workspace:", "git", "http:", "https:", "github:"].iter().any(|p| s.starts_with(p)) || s.contains('/') && !s.starts_with("npm:") {
                    continue;
                }
                let e = out.entry(n.clone()).or_insert(dev);
                *e = *e && dev;
            }
        }
    }
    out
}

/// package-lock.json's packages → what each depends on (by name), to say what pulls a package in.
pub fn npm_lock_kids(text: &str) -> HashMap<String, Vec<String>> {
    let mut kids: HashMap<String, Vec<String>> = HashMap::new();
    let Ok(j) = serde_json::from_str::<Value>(text) else { return kids };
    for (path, p) in j["packages"].as_object().into_iter().flatten() {
        let name = match path.rfind("node_modules/") {
            Some(i) => path[i + 13..].to_string(),
            None => continue,
        };
        for k in ["dependencies", "optionalDependencies", "peerDependencies"] {
            kids.entry(name.clone()).or_default().extend(p[k].as_object().into_iter().flat_map(|o| o.keys().cloned()));
        }
    }
    kids
}

/// package-lock.json / npm-shrinkwrap.json → (name, version, dev).
pub fn npm_lock(text: &str) -> Vec<(String, String, bool)> {
    let mut out = vec![];
    let Ok(j) = serde_json::from_str::<Value>(text) else { return out };
    if let Some(pk) = j["packages"].as_object() {
        for (path, p) in pk {
            let Some(i) = path.rfind("node_modules/") else { continue };
            if p["link"].as_bool() == Some(true) {
                continue;
            }
            let name = p["name"].as_str().map(str::to_string).unwrap_or_else(|| path[i + 13..].to_string());
            if let Some(v) = p["version"].as_str() {
                out.push((name, v.to_string(), p["dev"].as_bool().unwrap_or(false)));
            }
        }
    } else {
        // lockfileVersion 1: nested "dependencies".
        fn walk(o: &serde_json::Map<String, Value>, out: &mut Vec<(String, String, bool)>) {
            for (n, p) in o {
                if let Some(v) = p["version"].as_str() {
                    if !v.contains(':') || v.starts_with("npm:") {
                        out.push((n.clone(), v.trim_start_matches("npm:").rsplit('@').next().unwrap_or(v).to_string(), p["dev"].as_bool().unwrap_or(false)));
                    }
                }
                if let Some(d) = p["dependencies"].as_object() {
                    walk(d, out);
                }
            }
        }
        if let Some(d) = j["dependencies"].as_object() {
            walk(d, &mut out);
        }
    }
    out
}

/// yarn.lock (classic and Berry) → (name, version).
pub fn yarn_lock(text: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let mut names: Vec<String> = vec![];
    for line in text.lines() {
        if !line.starts_with(' ') && line.ends_with(':') && !line.starts_with('#') {
            // "@babel/core@^7.0.0", "@babel/core@npm:^7.1.0":
            names = line
                .trim_end_matches(':')
                .split(", ")
                .map(|s| s.trim_matches('"'))
                .filter_map(|s| {
                    let at = s[1..].find('@')? + 1;
                    Some(s[..at].to_string())
                })
                .collect();
            names.dedup();
        } else if let Some(v) = line.trim().strip_prefix("version ").or_else(|| line.trim().strip_prefix("version: ")) {
            let v = v.trim_matches('"').to_string();
            for n in names.drain(..) {
                if !v.contains(':') {
                    out.push((n, v.clone()));
                }
            }
        }
    }
    out
}

/// pnpm-lock.yaml → (name, version): keys like /name@1.2.3, /@scope/name@1.2.3(peer@1) or name@1.2.3.
pub fn pnpm_lock(text: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let mut in_packages = false;
    for line in text.lines() {
        if !line.starts_with(' ') {
            in_packages = line.trim_end() == "packages:";
            continue;
        }
        if !in_packages || line.starts_with("    ") {
            continue;
        }
        let key = line.trim().trim_end_matches(':').trim_matches(['\'', '"']).trim_start_matches('/');
        let key = key.split('(').next().unwrap_or(key);
        // Old pnpm: /name/1.2.3
        let (n, v) = match key[1.min(key.len())..].rfind('@') {
            Some(i) => (&key[..i + 1], &key[i + 2..]),
            None => match key.rfind('/') {
                Some(i) => (&key[..i], &key[i + 1..]),
                None => continue,
            },
        };
        if !n.is_empty() && crate::ver::parse(v).is_some() {
            out.push((n.to_string(), v.split('_').next().unwrap_or(v).to_string()));
        }
    }
    out.sort();
    out.dedup();
    out
}

fn npm_projects(root: &Path, jsons: &[PathBuf]) -> Vec<Project> {
    const LOCKS: [&str; 4] = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"];
    let mut groups: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    let mut lone = vec![];
    for j in jsons {
        let dir = j.parent().unwrap_or(root);
        match up_with(root, dir, &LOCKS) {
            Some(lock) => groups.entry(lock).or_default().push(j.clone()),
            None => lone.push(j.clone()),
        }
    }
    let mut out = vec![];
    for (lock, manifests) in groups {
        let dir = lock.parent().unwrap_or(root).to_path_buf();
        let mut direct: BTreeMap<String, bool> = BTreeMap::new();
        for m in &manifests {
            for (n, dev) in npm_direct(&read(m).unwrap_or_default()) {
                let e = direct.entry(n).or_insert(dev);
                *e = *e && dev;
            }
        }
        let text = read(&lock).unwrap_or_default();
        let fname = lock.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        let list: Vec<(String, String, bool)> = match fname.as_str() {
            "yarn.lock" => yarn_lock(&text).into_iter().map(|(a, b)| (a, b, false)).collect(),
            "pnpm-lock.yaml" => pnpm_lock(&text).into_iter().map(|(a, b)| (a, b, false)).collect(),
            _ => npm_lock(&text),
        };
        let mut seen = BTreeSet::new();
        let names: BTreeSet<String> = direct.keys().cloned().collect();
        let via = reached_via(&names, &npm_lock_kids(&text));
        let deps = list
            .into_iter()
            .filter(|(n, v, _)| seen.insert((n.clone(), v.clone())))
            .map(|(name, version, dev)| {
                let d = direct.get(&name);
                Dep { direct: d.is_some(), dev: d.copied().unwrap_or(dev), via: if d.is_some() { vec![] } else { via.get(&name).map(|s| s.iter().cloned().collect()).unwrap_or_default() }, name, version }
            })
            .collect();
        let name = serde_json::from_str::<Value>(&read(&dir.join("package.json")).unwrap_or_default()).ok().and_then(|j| j["name"].as_str().map(str::to_string)).unwrap_or_else(|| dir_name(&dir));
        out.push(Project { eco: Eco::Npm, name, dir, manifests, lock: Some(lock), deps, note: None });
    }
    for m in lone {
        let text = read(&m).unwrap_or_default();
        if npm_direct(&text).is_empty() {
            continue; // a package.json with no packages (a tool's config) isn't worth a line
        }
        let dir = m.parent().unwrap_or(root).to_path_buf();
        let name = serde_json::from_str::<Value>(&text).ok().and_then(|j| j["name"].as_str().map(str::to_string)).unwrap_or_else(|| dir_name(&dir));
        out.push(Project { eco: Eco::Npm, name, dir, manifests: vec![m], lock: None, deps: vec![], note: Some("No lock file yet (package-lock.json, yarn.lock or pnpm-lock.yaml), so the versions in use aren't known. Install once and audit again.".into()) });
    }
    out
}

// ---------------------------------------------------------------- .NET

/// The PackageReference ids and versions in a project file (Version as an attribute or element;
/// VersionOverride wins), plus packages.config's.
pub fn nuget_direct(text: &str) -> Vec<(String, Option<String>)> {
    let mut out = vec![];
    let re = regex::Regex::new(r#"(?s)<PackageReference\b([^>]*?)(?:/>|>(.*?)</PackageReference>)"#).unwrap();
    let attr = |s: &str, n: &str| regex::Regex::new(&format!(r#"(?i)\b{n}\s*=\s*"([^"]*)""#)).unwrap().captures(s).map(|c| c[1].trim().to_string());
    let elem = |s: &str, n: &str| regex::Regex::new(&format!(r"(?is)<{n}>\s*([^<]*?)\s*</{n}>")).unwrap().captures(s).map(|c| c[1].to_string());
    for c in re.captures_iter(text) {
        let a = &c[1];
        let body = c.get(2).map(|m| m.as_str()).unwrap_or("");
        let Some(id) = attr(a, "Include").or_else(|| attr(a, "Update")) else { continue };
        let v = attr(a, "VersionOverride").or_else(|| elem(body, "VersionOverride")).or_else(|| attr(a, "Version")).or_else(|| elem(body, "Version"));
        out.push((id, v));
    }
    let pc = regex::Regex::new(r#"<package\s+[^>]*id="([^"]+)"[^>]*version="([^"]+)""#).unwrap();
    for c in pc.captures_iter(text) {
        out.push((c[1].to_string(), Some(c[2].to_string())));
    }
    out
}

/// Directory.Packages.props: id → version.
pub fn nuget_central(text: &str) -> HashMap<String, String> {
    let re = regex::Regex::new(r#"<PackageVersion\b[^>]*\bInclude\s*=\s*"([^"]+)"[^>]*\bVersion\s*=\s*"([^"]+)""#).unwrap();
    re.captures_iter(text).map(|c| (c[1].to_lowercase(), c[2].to_string())).collect()
}

/// A NuGet version range ([1.2.3, ) or 1.2.3) → its lowest version.
fn range_low(s: &str) -> String {
    s.trim_matches(['[', '(', ' ']).split(',').next().unwrap_or("").trim().trim_end_matches([']', ')']).to_string()
}

/// project.assets.json → every package with its version, and what each package depends on.
pub fn nuget_assets(text: &str) -> (Vec<(String, String)>, HashMap<String, Vec<String>>) {
    let mut pkgs = vec![];
    let mut kids: HashMap<String, Vec<String>> = HashMap::new();
    let Ok(j) = serde_json::from_str::<Value>(text) else { return (pkgs, kids) };
    if let Some(libs) = j["libraries"].as_object() {
        for (k, v) in libs {
            if v["type"].as_str() != Some("package") {
                continue;
            }
            if let Some((n, ver)) = k.split_once('/') {
                pkgs.push((n.to_string(), ver.to_string()));
            }
        }
    }
    if let Some(targets) = j["targets"].as_object() {
        for t in targets.values() {
            for (k, v) in t.as_object().into_iter().flatten() {
                let n = k.split('/').next().unwrap_or(k).to_lowercase();
                let e = kids.entry(n).or_default();
                for d in v["dependencies"].as_object().into_iter().flat_map(|o| o.keys()) {
                    e.push(d.to_lowercase());
                }
            }
        }
    }
    (pkgs, kids)
}

fn nuget_project(root: &Path, proj: &Path) -> Option<Project> {
    let dir = proj.parent().unwrap_or(root).to_path_buf();
    let text = read(proj)?;
    let central = up_with(root, &dir, &["Directory.Packages.props"]).and_then(|p| read(&p)).map(|t| nuget_central(&t)).unwrap_or_default();
    let direct: Vec<(String, String)> = nuget_direct(&text).into_iter().chain(read(&dir.join("packages.config")).map(|t| nuget_direct(&t)).unwrap_or_default()).filter_map(|(id, v)| v.or_else(|| central.get(&id.to_lowercase()).cloned()).map(|v| (id, range_low(&v)))).collect();
    let name = proj.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut manifests = vec![proj.to_path_buf()];
    if let Some(props) = up_with(root, &dir, &["Directory.Packages.props"]) {
        manifests.push(props);
    }
    // obj/project.assets.json, written by dotnet restore, has every package actually used.
    let assets = dir.join("obj").join("project.assets.json");
    let names: BTreeSet<String> = direct.iter().map(|(n, _)| n.to_lowercase()).collect();
    if let Some(a) = read(&assets) {
        let (pkgs, kids) = nuget_assets(&a);
        let via = reached_via(&names, &kids);
        let deps = pkgs
            .into_iter()
            .map(|(name, version)| {
                let lc = name.to_lowercase();
                let d = names.contains(&lc);
                let via = if d { vec![] } else { via.get(&lc).map(|s| s.iter().map(|x| direct.iter().find(|(n, _)| n.eq_ignore_ascii_case(x)).map(|(n, _)| n.clone()).unwrap_or_else(|| x.clone())).collect()).unwrap_or_default() };
                Dep { direct: d, dev: false, via, name, version }
            })
            .collect();
        return Some(Project { eco: Eco::NuGet, name, dir, manifests, lock: Some(assets), deps, note: None });
    }
    if direct.is_empty() {
        return None;
    }
    let deps = direct.into_iter().map(|(name, version)| Dep { name, version, direct: true, ..Default::default() }).collect();
    Some(Project { eco: Eco::NuGet, name, dir, manifests, lock: None, deps, note: Some("Not restored yet, so only the packages listed in the project were checked, not the ones they pull in. Build once (or run dotnet restore) and audit again.".into()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_files() {
        let toml = r#"
[package]
name = "app"
[dependencies]
serde = { version = "1", features = ["derive"] }
rand = "0.8"
local = { path = "../local" }
renamed = { package = "real-name", version = "2" }
shared = { workspace = true }
[dev-dependencies]
insta = "1"
[target.'cfg(windows)'.dependencies]
winapi = "0.3"
"#;
        let ws: toml::Table = "shared = \"3\"".parse().unwrap();
        let d = cargo_direct(toml, Some(&ws));
        assert_eq!(d.keys().cloned().collect::<Vec<_>>(), ["insta", "rand", "real-name", "serde", "shared", "winapi"]);
        assert!(d["insta"] && !d["serde"]);
        let lock = r#"
version = 3
[[package]]
name = "app"
version = "0.1.0"
dependencies = ["serde", "time 0.1.43"]
[[package]]
name = "serde"
version = "1.0.190"
source = "registry+https://github.com/rust-lang/crates.io-index"
dependencies = ["serde_derive"]
[[package]]
name = "serde_derive"
version = "1.0.190"
source = "registry+https://github.com/rust-lang/crates.io-index"
"#;
        let (pkgs, kids) = cargo_lock(lock);
        assert_eq!(pkgs, [("serde".to_string(), "1.0.190".to_string()), ("serde_derive".to_string(), "1.0.190".to_string())]);
        assert_eq!(kids["app"], ["serde", "time"]);
        let via = reached_via(&["serde".to_string()].into(), &kids);
        assert_eq!(via["serde_derive"].iter().collect::<Vec<_>>(), ["serde"]);
    }

    #[test]
    fn npm_files() {
        let pj = r#"{ "dependencies": { "react": "^18", "mine": "file:../mine", "gh": "user/repo" }, "devDependencies": { "vite": "^5" } }"#;
        let d = npm_direct(pj);
        assert_eq!(d.keys().cloned().collect::<Vec<_>>(), ["react", "vite"]);
        let lock = r#"{ "lockfileVersion": 3, "packages": { "": {}, "node_modules/react": { "version": "18.2.0" }, "node_modules/vite": { "version": "5.0.0", "dev": true }, "node_modules/a/node_modules/@b/c": { "version": "1.0.0" }, "node_modules/mine": { "link": true } } }"#;
        assert_eq!(npm_lock(lock), [("@b/c".into(), "1.0.0".into(), false), ("react".into(), "18.2.0".into(), false), ("vite".into(), "5.0.0".into(), true)]);
        let v1 = r#"{ "lockfileVersion": 1, "dependencies": { "a": { "version": "1.0.0", "dependencies": { "b": { "version": "2.0.0", "dev": true } } } } }"#;
        assert_eq!(npm_lock(v1).len(), 2);
        let yarn = "# yarn lockfile v1\n\n\"@babel/core@^7.0.0\", \"@babel/core@^7.1.0\":\n  version \"7.2.0\"\n  resolved \"x\"\n\nlodash@^4:\n  version \"4.17.21\"\n";
        assert_eq!(yarn_lock(yarn), [("@babel/core".into(), "7.2.0".into()), ("lodash".into(), "4.17.21".into())]);
        let berry = "\"lodash@npm:^4.17.0\":\n  version: 4.17.21\n  resolution: \"lodash@npm:4.17.21\"\n";
        assert_eq!(yarn_lock(berry), [("lodash".into(), "4.17.21".into())]);
        let pnpm = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\npackages:\n  '@babel/core@7.2.0':\n    resolution: {}\n  lodash@4.17.21:\n    resolution: {}\n  /old/1.0.0:\n    x\n  /react-dom@18.2.0(react@18.2.0):\n    x\nsnapshots:\n  lodash@4.17.21: {}\n";
        assert_eq!(pnpm_lock(pnpm), [("@babel/core".into(), "7.2.0".into()), ("lodash".into(), "4.17.21".into()), ("old".into(), "1.0.0".into()), ("react-dom".into(), "18.2.0".into())]);
    }

    #[test]
    fn nuget_files() {
        let proj = r#"<Project><ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="12.0.1" />
  <PackageReference Include="Serilog"><Version>2.10.0</Version></PackageReference>
  <PackageReference Include="Central" />
  <PackageReference Include="Over" VersionOverride="3.0.0" />
</ItemGroup></Project>"#;
        assert_eq!(nuget_direct(proj), [("Newtonsoft.Json".into(), Some("12.0.1".into())), ("Serilog".into(), Some("2.10.0".into())), ("Central".into(), None), ("Over".into(), Some("3.0.0".into()))]);
        assert_eq!(nuget_central(r#"<PackageVersion Include="Central" Version="1.2.3" />"#)["central"], "1.2.3");
        assert_eq!(range_low("[1.2.3, )"), "1.2.3");
        let assets = r#"{ "libraries": { "Newtonsoft.Json/12.0.1": { "type": "package" }, "Lib/1.0.0": { "type": "project" }, "System.Text.Json/8.0.0": { "type": "package" } },
          "targets": { "net8.0": { "Serilog/2.10.0": { "dependencies": { "System.Text.Json": "8.0.0" } } } } }"#;
        let (p, k) = nuget_assets(assets);
        assert_eq!(p.len(), 2);
        assert_eq!(k["serilog"], ["system.text.json"]);
    }
}
