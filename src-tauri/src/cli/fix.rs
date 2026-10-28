//! `ledger audit fix` and `ledger update`: change versions with each ecosystem's own tool, then
//! build and test. If that fails, everything goes back the way it was and the update that broke
//! it is named (tried one at a time when there were several).
//!
//! Only in a trusted folder: the package managers and the build run the project's code.

use crate::audit::{self, Opts, Report};
use crate::out::*;
use crate::scan::{Eco, Project};
use crate::{link, ver};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Security,
    Update,
}

/// One change to one project.
#[derive(Clone, Debug)]
pub struct Change {
    pub name: String,
    pub from: String,
    pub to: String,
    pub direct: bool,
    pub dev: bool,
    /// Needs a new major version (only with --major).
    pub breaking: bool,
    pub why: String,
}

/// What can't be done, and why.
pub struct Skip {
    pub project: usize,
    pub what: String,
    pub why: String,
}

/// The changes per project, and what's left for you.
pub fn plan(r: &Report, mode: Mode, major: bool) -> (BTreeMap<usize, Vec<Change>>, Vec<Skip>) {
    let mut plan: BTreeMap<usize, Vec<Change>> = BTreeMap::new();
    let mut skips = vec![];
    match mode {
        Mode::Security => {
            for v in &r.vulns {
                let real: Vec<_> = v.advisories.iter().filter(|a| a.kind.is_none()).collect();
                if real.is_empty() {
                    continue;
                }
                let ids = real.iter().map(|a| a.id.clone()).collect::<Vec<_>>().join(", ");
                // Every advisory must be fixed: the highest of their lowest fixes.
                if real.iter().any(|a| a.fixed.is_none()) {
                    skips.push(Skip { project: v.project, what: format!("{} {}", v.dep.name, v.dep.version), why: format!("no fixed version released yet ({ids})") });
                    continue;
                }
                let to = real.iter().filter_map(|a| a.fixed.clone()).max_by(|a, b| ver::cmp(a, b)).unwrap();
                let breaking = !ver::compatible(&v.dep.version, &to);
                let eco = r.projects[v.project].eco;
                if breaking && !major {
                    skips.push(Skip { project: v.project, what: format!("{} {} → {to}", v.dep.name, v.dep.version), why: "a new major version, which can need code changes: add --major to take it".into() });
                    continue;
                }
                if breaking && !v.dep.direct && eco == Eco::Cargo {
                    let via = if v.dep.via.is_empty() { "another package".to_string() } else { v.dep.via.join(", ") };
                    skips.push(Skip { project: v.project, what: format!("{} {} → {to}", v.dep.name, v.dep.version), why: format!("comes in through {via}, which has to move to a version that allows {to} (try ledger update --major)") });
                    continue;
                }
                let list = plan.entry(v.project).or_default();
                if let Some(c) = list.iter_mut().find(|c| eco.same_name(&c.name, &v.dep.name) && c.from == v.dep.version) {
                    if ver::cmp(&to, &c.to).is_gt() {
                        c.to = to;
                    }
                    continue;
                }
                list.push(Change { name: v.dep.name.clone(), from: v.dep.version.clone(), to, direct: v.dep.direct, dev: v.dep.dev, breaking, why: ids });
            }
        }
        Mode::Update => {
            for u in &r.updates {
                let p = &r.projects[u.project];
                let dev = p.deps.iter().find(|d| d.name == u.name).is_some_and(|d| d.dev);
                let to = if major { u.major.clone().or(u.safe.clone()) } else { u.safe.clone() };
                if !major && u.safe.is_some() {
                    if let Some(m) = &u.major {
                        skips.push(Skip { project: u.project, what: format!("{} → {m}", u.name), why: "a new major version: add --major to take it".into() });
                    }
                }
                match to {
                    Some(to) => plan.entry(u.project).or_default().push(Change { breaking: !ver::compatible(&u.from, &to), name: u.name.clone(), from: u.from.clone(), to, direct: true, dev, why: "newer version".into() }),
                    None => skips.push(Skip { project: u.project, what: format!("{} {} → {}", u.name, u.from, u.major.clone().unwrap_or_default()), why: "a new major version: add --major to take it".into() }),
                }
            }
        }
    }
    (plan, skips)
}

/// Sets a crate's version everywhere Cargo.toml lists it (dependencies, dev-dependencies, …),
/// keeping a leading = or ~ (or ^) if there was one. None if it's listed some other way.
pub fn set_cargo_version(text: &str, name: &str, to: &str) -> Option<String> {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let found = audit::cargo_lines(text, name);
    if found.is_empty() {
        return None;
    }
    let quoted = regex::Regex::new(r#"^(\s*[\w"-]+\s*=\s*")([=~^<>]*)\s*[^"]*(")"#).unwrap();
    let inline = regex::Regex::new(r#"(\bversion\s*=\s*")([=~^<>]*)\s*[^"]*(")"#).unwrap();
    let rep = |re: &regex::Regex, s: &str| re.replace(s, |c: &regex::Captures| format!("{}{}{}{}", &c[1], &c[2], to, &c[3])).into_owned();
    let mut changed = false;
    for i in found {
        if lines[i].trim_start().starts_with('[') {
            // [dependencies.name] … version = "x" on a line below.
            if let Some(j) = (i + 1..lines.len()).take_while(|&j| !lines[j].trim_start().starts_with('[')).find(|&j| inline.is_match(&lines[j])) {
                lines[j] = rep(&inline, &lines[j]);
                changed = true;
            }
        } else if inline.is_match(&lines[i]) {
            lines[i] = rep(&inline, &lines[i]);
            changed = true;
        } else if quoted.is_match(&lines[i]) {
            lines[i] = rep(&quoted, &lines[i]);
            changed = true;
        }
        // workspace = true: changed where the workspace defines it.
    }
    if !changed {
        return None;
    }
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = lines.join(eol);
    if text.ends_with('\n') {
        out.push_str(eol);
    }
    Some(out)
}

fn show(prog: &str, args: &[String], dir: &Path) {
    eprintln!("{} {}", cyan("$"), dim(&format!("{prog} {}   (in {})", args.join(" "), dir.display())));
}

/// Runs a program where you can see it; true if it worked.
fn exec(prog: &str, args: &[String], dir: &Path) -> bool {
    show(prog, args, dir);
    // npm, yarn and pnpm are .cmd files on Windows, which Command only finds with their extension.
    let real = if cfg!(windows) && ["npm", "npx", "yarn", "pnpm"].contains(&prog) { format!("{prog}.cmd") } else { prog.to_string() };
    Command::new(&real).args(args).current_dir(dir).env("DOTNET_CLI_UI_LANGUAGE", "en").env("DOTNET_NOLOGO", "1").status().map(|s| s.success()).unwrap_or_else(|e| {
        eprintln!("{} couldn't start {prog} ({e})", red("✗"));
        false
    })
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// Yarn 2 and later (Berry) have a .yarnrc.yml; classic yarn doesn't.
fn yarn_berry(dir: &Path) -> bool {
    dir.join(".yarnrc.yml").is_file()
}

/// Which npm-family tool a project uses.
fn npm_tool(p: &Project) -> &'static str {
    match p.lock.as_ref().and_then(|l| l.file_name()).map(|f| f.to_string_lossy().to_string()).as_deref() {
        Some("yarn.lock") => "yarn",
        Some("pnpm-lock.yaml") => "pnpm",
        _ => "npm",
    }
}

/// The nearest .sln/.slnx at or above the project (within the audited folder), to build and test
/// everything that uses the project.
fn solution_for(root: &Path, p: &Project) -> Option<PathBuf> {
    let mut d = Some(p.dir.as_path());
    while let Some(x) = d {
        if let Ok(rd) = std::fs::read_dir(x) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_lowercase();
                if n.ends_with(".sln") || n.ends_with(".slnx") {
                    return Some(e.path());
                }
            }
        }
        if x == root {
            break;
        }
        d = x.parent();
    }
    None
}

/// Applies changes to one project. False if a tool failed.
fn apply(root: &Path, p: &Project, list: &[Change], mode: Mode) -> bool {
    let dir = p.lock.as_ref().and_then(|l| l.parent()).unwrap_or(&p.dir).to_path_buf();
    match p.eco {
        Eco::Cargo => {
            for c in list {
                if c.breaking && c.direct {
                    // A new major: the requirement in Cargo.toml has to change.
                    for m in &p.manifests {
                        let Ok(text) = std::fs::read_to_string(m) else { continue };
                        if let Some(new) = set_cargo_version(&text, &c.name, &c.to) {
                            if std::fs::write(m, new).is_err() {
                                return false;
                            }
                            eprintln!("{} {}: {} → {}", cyan("edit"), audit::rel(root, m), c.name, c.to);
                        }
                    }
                    if !exec("cargo", &s(&["update", "-p", &format!("{}@{}", c.name, c.from)]), &dir) {
                        return false;
                    }
                } else if !exec("cargo", &s(&["update", "-p", &format!("{}@{}", c.name, c.from), "--precise", &c.to]), &dir) {
                    return false;
                }
            }
            true
        }
        Eco::Npm => {
            let tool = npm_tool(p);
            // Packages you listed: install the wanted version where that package.json is (its
            // range moves with it). One package at a time, so trying changes one by one is exact.
            for c in list.iter().filter(|c| c.direct) {
                let Some(m) = p.manifests.iter().find(|m| std::fs::read_to_string(m).map(|t| crate::scan::npm_direct(&t).contains_key(&c.name)).unwrap_or(false)) else { continue };
                let here = m.parent().unwrap_or(&dir).to_path_buf();
                let spec = format!("{}@{}", c.name, if mode == Mode::Update && !c.breaking { format!("^{}", c.to) } else { c.to.clone() });
                let root_pj: serde_json::Value = std::fs::read_to_string(dir.join("package.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
                let workspaces = !root_pj["workspaces"].is_null() || dir.join("pnpm-workspace.yaml").is_file();
                let (run_in, mut args) = match tool {
                    // npm installs into a workspace member from the root.
                    "npm" if here != dir => (dir.clone(), vec!["install".to_string(), spec, "--workspace".into(), here.strip_prefix(&dir).unwrap_or(&here).to_string_lossy().replace('\\', "/")]),
                    "npm" => (dir.clone(), vec!["install".to_string(), spec]),
                    _ => (here.clone(), vec!["add".to_string(), spec]),
                };
                if c.dev {
                    args.push((if tool == "yarn" { "--dev" } else { "--save-dev" }).into());
                }
                // At the root of a workspace, yarn classic and pnpm want to be told it's meant.
                if here == dir && workspaces {
                    match tool {
                        "pnpm" => args.push("-w".into()),
                        "yarn" if !yarn_berry(&dir) => args.push("-W".into()),
                        _ => {}
                    }
                }
                if !exec(tool, &args, &run_in) {
                    return false;
                }
            }
            // Packages that come in through others: the tool's own fixer, which knows who needs what.
            if mode == Mode::Security && list.iter().any(|c| !c.direct) {
                let force = list.iter().any(|c| !c.direct && c.breaking);
                match tool {
                    // npm audit fix exits with an error while anything is left unfixed; what moved is
                    // checked afterwards instead.
                    "npm" => {
                        exec("npm", &s(if force { &["audit", "fix", "--force"] } else { &["audit", "fix"] }), &dir);
                    }
                    "pnpm" => {
                        // Adds overrides for the fixed versions, then installs.
                        if !(exec("pnpm", &s(&["audit", "--fix"]), &dir) && exec("pnpm", &s(&["install"]), &dir)) {
                            return false;
                        }
                    }
                    _ => {
                        for c in list.iter().filter(|c| !c.direct) {
                            eprintln!("{} {} {} comes in through another package; yarn can't move it on its own. Add \"resolutions\": {{ \"{}\": \"{}\" }} to package.json.", yellow("!"), c.name, c.from, c.name, c.to);
                        }
                    }
                }
            }
            true
        }
        Eco::NuGet => {
            let proj = &p.manifests[0];
            for c in list {
                // For a package that comes in through another, this adds it to the project at the
                // fixed version, which NuGet then uses (transitive pinning).
                if !exec("dotnet", &s(&["add", &proj.display().to_string(), "package", &c.name, "--version", &c.to]), &p.dir) {
                    return false;
                }
            }
            true
        }
    }
}

/// Builds and tests a project the usual way. False if either fails.
fn check(root: &Path, p: &Project) -> bool {
    let dir = p.lock.as_ref().and_then(|l| l.parent()).unwrap_or(&p.dir).to_path_buf();
    match p.eco {
        Eco::Cargo => exec("cargo", &s(&["build", "--all-targets"]), &dir) && exec("cargo", &s(&["test"]), &dir),
        Eco::Npm => {
            let tool = npm_tool(p);
            let pj: serde_json::Value = std::fs::read_to_string(p.dir.join("package.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
            let script = |n: &str| pj["scripts"][n].as_str().filter(|s| !s.contains("no test specified")).is_some();
            (!script("build") || exec(tool, &s(&["run", "build"]), &p.dir)) && (!script("test") || exec(tool, &s(&["test"]), &p.dir))
        }
        Eco::NuGet => {
            let target = solution_for(root, p).unwrap_or_else(|| p.manifests[0].clone()).display().to_string();
            exec("dotnet", &s(&["build", &target, "-nologo"]), &p.dir) && exec("dotnet", &s(&["test", &target, "-nologo", "--no-build"]), &p.dir)
        }
    }
}

/// The files a change can touch, as they are now, to put back on failure.
struct Snapshot(Vec<(PathBuf, Option<Vec<u8>>)>);

fn snapshot(root: &Path, p: &Project) -> Snapshot {
    let mut files: Vec<PathBuf> = p.manifests.clone();
    files.extend(p.lock.clone());
    files.push(p.dir.join("package.json"));
    let top = p.lock.as_ref().and_then(|x| x.parent()).unwrap_or(&p.dir).to_path_buf();
    for l in ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs"] {
        files.push(top.join(l));
    }
    // NuGet's own lock file (RestorePackagesWithLockFile).
    files.push(p.dir.join("packages.lock.json"));
    if let Some(sln) = solution_for(root, p) {
        if let Some(d) = sln.parent() {
            files.push(d.join("Directory.Packages.props"));
        }
    }
    files.sort();
    files.dedup();
    Snapshot(files.into_iter().map(|f| {
        let b = std::fs::read(&f).ok();
        (f, b)
    }).collect())
}

impl Snapshot {
    fn restore(&self) {
        for (f, b) in &self.0 {
            match b {
                Some(b) => {
                    if std::fs::read(f).ok().as_ref() != Some(b) {
                        let _ = std::fs::write(f, b);
                    }
                }
                None => {
                    let _ = std::fs::remove_file(f);
                }
            }
        }
    }
}

/// The changes that didn't happen: the old version is still in the lock file.
fn still_there(root: &Path, p: &Project, list: &[Change]) -> Vec<Change> {
    let Some(now) = crate::scan::find(&p.dir).into_iter().chain(crate::scan::find(root)).find(|q| q.eco == p.eco && q.dir == p.dir) else { return vec![] };
    list.iter().filter(|c| now.deps.iter().any(|d| p.eco.same_name(&d.name, &c.name) && d.version == c.from)).cloned().collect()
}

/// After putting files back, make installed packages match them again, without letting the
/// tool rewrite the lock file just restored (and put the files back once more if it did anyway).
fn reinstall(p: &Project, snap: &Snapshot) {
    if p.eco == Eco::Npm {
        let tool = npm_tool(p);
        let dir = p.lock.as_ref().and_then(|l| l.parent()).unwrap_or(&p.dir).to_path_buf();
        let args: &[&str] = match tool {
            "yarn" if yarn_berry(&dir) => &["install", "--immutable"],
            "yarn" => &["install", "--frozen-lockfile"],
            "pnpm" => &["install", "--frozen-lockfile"],
            _ => &["ci"],
        };
        exec(tool, &s(args), &dir);
        snap.restore();
    }
}

pub fn run(root: &Path, mode: Mode, args: &[String]) -> i32 {
    let has = |f: &str| args.iter().any(|a| a == f);
    let (dry, major, no_check) = (has("--dry-run"), has("--major"), has("--no-check"));
    let r = audit::collect(root, &Opts { json: false, updates: mode == Mode::Update, toolchains: false, dev: true });
    if !r.errors.is_empty() {
        for e in &r.errors {
            eprintln!("{} {e}", red("✗"));
        }
        if mode == Mode::Security {
            return 2;
        }
    }
    let (plan, skips) = plan(&r, mode, major);
    let title = if mode == Mode::Security { "Security fixes" } else { "Updates" };
    if plan.is_empty() && skips.is_empty() {
        println!("{} {}", green("✓"), if mode == Mode::Security { "Nothing to fix: no known security problems with a fix." } else { "Everything is up to date." });
        return 0;
    }
    println!("{}", bold(&format!("{title} for {}", root.display())));
    for (i, list) in &plan {
        let p = &r.projects[*i];
        println!("\n  {} {}", bold(p.eco.label()), bold(&p.name));
        for c in list {
            println!("    {} {} {} → {}{}{}{}", cyan("↑"), c.name, dim(&c.from), green(&c.to), if c.breaking { magenta(" (new major)") } else { String::new() }, if c.direct { String::new() } else { dim(" (indirect)") }, if mode == Mode::Security { dim(&format!("  {}", c.why)) } else { String::new() });
        }
    }
    if !skips.is_empty() {
        println!("\n  {}", bold("Left as they are"));
        for k in &skips {
            println!("    {} {} {}: {}", yellow("!"), dim(&r.projects[k.project].name), k.what, k.why);
        }
    }
    if dry || plan.is_empty() {
        if dry {
            println!("\n{}", dim("--dry-run: nothing was changed."));
        }
        return if plan.is_empty() { 1 } else { 0 };
    }
    // The package managers and the build run the project's code: only in a trusted folder.
    match link::call("trusted", serde_json::json!({ "path": root }), 10) {
        Ok(v) if v.as_bool() == Some(true) => {}
        Ok(v) if v.is_null() => return fail(&format!("Ledger hasn't been told whether to trust {}. Open it in Ledger and trust it first (ledger trust in its terminal).", root.display())),
        Ok(_) => return fail(&format!("{} is in restricted mode, so Ledger won't run its package managers or build it. Trust it first: ledger trust", root.display())),
        Err(e) => return fail(&e),
    }
    let mut failed = 0;
    let mut done = 0;
    for (i, list) in &plan {
        let p = &r.projects[*i];
        println!("\n{} {} {}", bold("▸"), bold(p.eco.label()), bold(&p.name));
        let snap = snapshot(root, p);
        if !apply(root, p, list, mode) {
            snap.restore();
            reinstall(p, &snap);
            println!("{} The package tool couldn't make the change (see above), so {} is back as it was.", red("✗"), p.name);
            failed += list.len();
            continue;
        }
        let ok = no_check || check(root, p);
        if ok {
            // A tool can finish without having moved a package (an exact version in package.json, say).
            let left = still_there(root, p, list);
            done += list.len() - left.len();
            println!("{} {}", green("✓"), if no_check { "Updated." } else { "Updated, built and tested." });
            for c in &left {
                println!("{} {} is still {}: {} didn't move it. Its version may be pinned exactly; change it to {} where it's listed.", yellow("!"), c.name, c.from, match p.eco { Eco::Cargo => "cargo", Eco::Npm => npm_tool(p), Eco::NuGet => "dotnet" }, c.to);
                failed += 1;
            }
            continue;
        }
        snap.restore();
        reinstall(p, &snap);
        println!("{} The build or tests failed after the change, so {} is back as it was.", red("✗"), p.name);
        if list.len() == 1 || no_check {
            failed += list.len();
            continue;
        }
        // Find which ones broke it: each on its own.
        println!("{}", dim("Trying each change on its own to find the one that breaks it…"));
        let mut good: Vec<Change> = vec![];
        if list.len() > 8 {
            failed += list.len();
            println!("{} Too many changes to try one by one ({}). Try fewer at a time, or with --dry-run to see them.", yellow("!"), list.len());
            continue;
        }
        for c in list.iter() {
            let one = vec![c.clone()];
            let ok = apply(root, p, &one, mode) && check(root, p);
            snap.restore();
            if ok {
                good.push(c.clone());
            } else {
                println!("{} {} {} → {} breaks the build or tests.", red("✗"), c.name, c.from, c.to);
                failed += 1;
            }
        }
        reinstall(p, &snap);
        if good.len() == list.len() {
            // Each works alone but not together.
            failed += list.len();
            println!("{} Each change works on its own, but not all together; {} is back as it was. Take them a few at a time.", red("✗"), p.name);
        } else if !good.is_empty() {
            if apply(root, p, &good, mode) && check(root, p) {
                done += good.len();
                println!("{} Kept the {} that work.", green("✓"), good.len());
            } else {
                snap.restore();
                reinstall(p, &snap);
                failed += good.len();
                println!("{} They don't work together either; {} is back as it was.", red("✗"), p.name);
            }
        }
    }
    println!();
    if done > 0 {
        println!("{} {done} change{} made.", green("✓"), if done == 1 { "" } else { "s" });
    }
    if failed > 0 {
        println!("{} {failed} couldn't be made without breaking the build or tests.", red("✗"));
    }
    if link::available() {
        // Refresh the marks in the editor.
        let after = audit::collect(root, &Opts { json: true, updates: false, toolchains: false, dev: true });
        if after.checked {
            let _ = link::call("audit", audit::marks(&after), 10);
        }
    }
    if failed > 0 || !skips.is_empty() {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cargo_versions() {
        let t = "[dependencies]\nserde = \"=1.0.1\"\ntime = { version = \"0.1\", features = [\"x\"] }\n[dependencies.rand]\nfeatures = []\nversion = \"^0.7\"\n";
        let a = set_cargo_version(t, "serde", "1.0.200").unwrap();
        assert!(a.contains("serde = \"=1.0.200\""));
        let b = set_cargo_version(t, "time", "0.3.36").unwrap();
        assert!(b.contains("time = { version = \"0.3.36\", features"));
        let c = set_cargo_version(t, "rand", "0.8.5").unwrap();
        assert!(c.contains("version = \"^0.8.5\""));
        assert!(set_cargo_version("[dependencies]\nx.workspace = true\n", "x", "2").is_none());
        assert!(c.ends_with('\n'));
        let both = set_cargo_version("[features]\nx = []\n[dependencies]\nx = \"1\"\n[dev-dependencies]\nx = { version = \"1\" }\n", "x", "2.0.0").unwrap();
        assert!(both.contains("x = \"2.0.0\"") && both.contains("version = \"2.0.0\"") && both.contains("x = []"));
    }
}
