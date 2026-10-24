//! Restricted mode. A folder you haven't trusted can't make Ledger run its code: no language
//! servers that load the project (rust-analyzer runs build scripts and reads .cargo/config,
//! csharp-ls runs MSBuild, the Lua server loads plugins), no Run, Build, Test or Debug, no
//! project tools (its Tailwind, its Prettier), and Git with the repository's hooks switched off and
//! nothing at all if its settings would run a program (filters, textconv, includes...).
//! The frontend asks the question; the answer is kept here, per window, and every command that
//! starts a process in the folder checks it.

use std::path::Path;

/// The error text the frontend recognises: it asks "Trust this folder?" and tries again.
pub const UNTRUSTED: &str = "untrusted: this folder isn't trusted, so Ledger won't run its code";

pub fn norm(s: &str) -> String {
    s.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Whether `cwd` is inside `root` (both as given by the frontend or the OS).
pub fn inside(cwd: &str, root: &str) -> bool {
    let (c, r) = (norm(cwd), norm(root));
    !r.is_empty() && (c == r || c.starts_with(&(r + "/")))
}

/// Programs that are safe to run in a restricted folder, with these arguments: they read the
/// project but don't run any of it.
pub fn safe_program(program: &str, args: &[String]) -> bool {
    let stem = Path::new(program).file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    let first = args.first().map(String::as_str).unwrap_or("");
    match stem.as_str() {
        // Lust's checker and translators only read the program (Lust has no build scripts or macros).
        "lust" => matches!(first, "check" | "lua" | "rust"),
        "dotnet" => first == "--list-sdks" || first == "--version",
        "git" => true, // goes through git_guard
        _ => false,
    }
}

/// The same, for programs started as a task (whose git doesn't go through git_guard).
pub fn safe_task(program: &str, args: &[String]) -> bool {
    let git = Path::new(program).file_stem().is_some_and(|s| s.eq_ignore_ascii_case("git"));
    !git && safe_program(program, args)
}

/// Settings git is told on its command line in a restricted folder. Command-line settings win
/// over the repository's, and some (safe.bareRepository) are only honoured from here.
pub fn restricted_git_flags() -> Vec<String> {
    // A folder that doesn't exist: no hooks at all, whatever .git/hooks holds.
    let none = std::env::temp_dir().join("ledger-no-hooks");
    let mut v = vec![format!("core.hooksPath={}", none.display())];
    v.extend(
        [
            "core.fsmonitor=false",
            // Leave submodules alone: their files aren't diffed, committed or fetched.
            "diff.ignoreSubmodules=all",
            "submodule.recurse=false",
            "status.submoduleSummary=false",
            "fetch.recurseSubmodules=false",
            "push.recurseSubmodules=no",
            // A folder that is itself a repository's insides (HEAD, objects/, config at the top)
            // isn't picked up as a repository unless named with --git-dir.
            "safe.bareRepository=explicit",
            // ext:: and fd:: remotes run commands, file:// ones read local uploadpack settings.
            "protocol.allow=never",
            "protocol.https.allow=always",
            "protocol.http.allow=always",
            "protocol.ssh.allow=always",
            "protocol.git.allow=always",
        ]
        .map(String::from),
    );
    v.into_iter().flat_map(|kv| ["-c".to_string(), kv]).collect()
}

/// Repository settings that are only data: anything else in a repository's own config (filters,
/// textconv, includes, pagers, credential helpers, uploadpack, settings git adds in the future…)
/// keeps Git off in a restricted folder. A list of what's allowed fails safe; a list of what isn't
/// misses whatever it forgot.
fn allowed_key(key: &str) -> bool {
    const EXACT: [&str; 26] = [
        "core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "core.ignorecase", "core.symlinks",
        "core.autocrlf", "core.eol", "core.safecrlf", "core.precomposeunicode", "core.longpaths", "core.checkstat", "core.quotepath",
        "core.fsmonitor", "core.untrackedcache", "core.sparsecheckout", "core.splitindex", "core.commitgraph", "core.multipackindex",
        "pull.rebase", "pull.ff", "push.default", "push.autosetupremote", "fetch.prune", "init.defaultbranch", "lfs.repositoryformatversion",
    ];
    if EXACT.contains(&key) || key.starts_with("user.") || key.starts_with("extensions.") || key.starts_with("i18n.") || key.starts_with("color.") {
        return true;
    }
    // Per-branch, per-remote and per-submodule settings: the name is in the middle.
    let mut parts = key.splitn(2, '.');
    let (section, rest) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let last = rest.rsplit('.').next().unwrap_or("");
    match section {
        "branch" => matches!(last, "remote" | "merge" | "rebase" | "pushremote" | "description" | "vscode-merge-base"),
        "remote" => matches!(last, "url" | "pushurl" | "fetch" | "push" | "prune" | "tagopt" | "mirror" | "skipdefaultupdate"),
        "submodule" => matches!(last, "url" | "active" | "branch" | "shallow"),
        _ => false,
    }
}

/// From `git config --list --null --show-scope --includes`: the first setting of the repository's
/// own (local or worktree) config that isn't plain data, if any.
pub fn risky_in_listing(listing: &str) -> Option<String> {
    let mut it = listing.split('\0');
    while let (Some(scope), Some(entry)) = (it.next(), it.next()) {
        let scope = scope.trim_start_matches('\n');
        if scope != "local" && scope != "worktree" {
            continue;
        }
        let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
        let key = key.to_lowercase();
        let url = key.ends_with(".url") || key.ends_with(".pushurl");
        let value = value.to_lowercase();
        if !allowed_key(&key) || (url && (value.starts_with("ext::") || value.starts_with("fd::"))) {
            return Some(key);
        }
    }
    None
}

/// Extra arguments for git in a restricted folder, or an error when the repository's settings
/// would run programs. `git()` makes a git command in that folder; it's used to ask git itself what
/// the repository's settings are (listing them runs nothing), so worktrees, includes and
/// unusual layouts are read the way git reads them.
pub fn git_guard(restricted: bool, git: impl Fn() -> std::process::Command) -> Result<Vec<String>, String> {
    if !restricted {
        return Ok(vec![]);
    }
    let flags = restricted_git_flags();
    let out = git().args(&flags).args(["config", "--list", "--null", "--show-scope", "--includes"]).output().map_err(|e| format!("Couldn't start Git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{UNTRUSTED}. Git couldn't read this repository's settings safely ({}), so it stays off here until you trust the folder.", err.trim().lines().next().unwrap_or("unknown error")));
    }
    if let Some(key) = risky_in_listing(&String::from_utf8_lossy(&out.stdout)) {
        return Err(format!("{UNTRUSTED}. This repository has settings that can start other programs ({key}), so Git stays off here until you trust the folder."));
    }
    // Submodules keep their own settings (in <git dir>/modules/<name>/config), which the listing
    // above doesn't show, and commit -a or a diff can run their filters. Read each one too.
    let common = git().args(&flags).args(["rev-parse", "--path-format=absolute", "--git-common-dir"]).output().ok().filter(|o| o.status.success());
    if let Some(dir) = common.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|d| !d.is_empty()) {
        for cfg in module_configs(&std::path::Path::new(&dir).join("modules")) {
            let out = git().args(&flags).args(["config", "--file"]).arg(&cfg).args(["--list", "--null", "--includes"]).output().map_err(|e| format!("Couldn't start Git: {e}"))?;
            // Same check, as if it were the repository's own settings.
            // (core.worktree is how every submodule points at its files.)
            let listing: String = String::from_utf8_lossy(&out.stdout).split('\0').filter(|e| !e.is_empty() && !e.to_lowercase().starts_with("core.worktree\n")).map(|e| format!("local\0{e}\0")).collect();
            if !out.status.success() || risky_in_listing(&listing).is_some() {
                let key = risky_in_listing(&listing).unwrap_or_else(|| "unreadable settings".into());
                return Err(format!("{UNTRUSTED}. A submodule of this repository has settings that can start other programs ({key}), so Git stays off here until you trust the folder."));
            }
        }
    }
    Ok(flags)
}

/// Every submodule's config file under `modules` (submodules can nest).
fn module_configs(modules: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![modules.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if out.len() < 500 {
                    stack.push(p);
                }
            } else if e.file_name() == "config" && p.parent().is_some_and(|x| x.join("HEAD").exists()) {
                out.push(p);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn paths_inside_the_folder() {
        assert!(inside("C:\\Proj\\src", "c:/proj"));
        assert!(inside("C:/Proj", "C:/Proj/"));
        assert!(!inside("C:/Project2", "C:/Proj"));
        assert!(!inside("C:/Proj", ""));
    }

    #[test]
    fn safe_programs() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(safe_program("C:/tools/lust.exe", &a(&["check", "main.lst"])));
        assert!(!safe_program("lust", &a(&["run", "main.lst"])));
        assert!(!safe_program("node", &a(&["-e", "x"])));
        assert!(!safe_program("cargo", &a(&["test"])));
    }

    fn git_in(dir: &Path) -> impl Fn() -> std::process::Command + '_ {
        move || {
            let mut c = std::process::Command::new("git");
            c.current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1");
            c
        }
    }
    fn sh(dir: &Path, args: &[&str]) {
        assert!(std::process::Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap().status.success(), "{args:?}");
    }
    fn fresh(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ledger-trust-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn allowlist() {
        let l = |s: &[(&str, &str)]| s.iter().map(|(k, v)| format!("local\0{k}\n{v}\0")).collect::<String>();
        assert_eq!(risky_in_listing(&l(&[("core.bare", "false"), ("remote.origin.url", "https://x"), ("branch.main.merge", "refs/heads/main"), ("user.name", "a")])), None);
        assert_eq!(risky_in_listing("global\0core.pager\nless\0"), None); // yours, not the folder's
        assert_eq!(risky_in_listing(&l(&[("filter.x.clean", "evil")])).as_deref(), Some("filter.x.clean"));
        assert_eq!(risky_in_listing(&l(&[("remote.origin.uploadpack", "evil")])).as_deref(), Some("remote.origin.uploadpack"));
        assert_eq!(risky_in_listing(&l(&[("remote.origin.url", "ext::sh -c evil")])).as_deref(), Some("remote.origin.url"));
        assert_eq!(risky_in_listing(&l(&[("submodule.a.update", "!evil")])).as_deref(), Some("submodule.a.update"));
        assert_eq!(risky_in_listing(&l(&[("core.worktree", ".")])).as_deref(), Some("core.worktree"));
    }

    // The layouts the hand-written parser missed, checked with the real git.
    #[test]
    fn repository_layouts() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        // 1. A key on its section's line.
        let d = fresh("sameline");
        sh(&d, &["init", "-q"]);
        let cfg = d.join(".git/config");
        let mut t = std::fs::read_to_string(&cfg).unwrap();
        t.push_str("[filter \"x\"] clean = touch PWNED; cat\n");
        std::fs::write(&cfg, t).unwrap();
        assert!(git_guard(true, git_in(&d)).unwrap_err().contains("filter.x.clean"));
        assert!(git_guard(false, git_in(&d)).unwrap().is_empty());

        // 2. A worktree whose settings live in another folder (commondir).
        let d = fresh("worktree");
        std::fs::create_dir_all(d.join("main")).unwrap();
        sh(&d.join("main"), &["init", "-q"]);
        sh(&d.join("main"), &["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "--allow-empty", "-m", "x"]);
        sh(&d.join("main"), &["worktree", "add", "-q", "../wt"]);
        assert!(git_guard(true, git_in(&d.join("wt"))).is_ok());
        sh(&d.join("main"), &["config", "core.pager", "evil"]);
        assert!(git_guard(true, git_in(&d.join("wt"))).unwrap_err().contains("core.pager"));

        // 3. A folder that is itself a repository's insides.
        let d = fresh("bare");
        sh(&d, &["init", "-q", "--bare", "."]);
        sh(&d, &["config", "core.bare", "false"]);
        sh(&d, &["config", "core.worktree", "."]);
        // Listing finds no repository here, and neither does any git command with the flags.
        let flags = git_guard(true, git_in(&d)).unwrap();
        let st = git_in(&d)().args(&flags).arg("status").output().unwrap();
        assert!(!st.status.success() && String::from_utf8_lossy(&st.stderr).contains("bare repository"));

        // 5. A submodule whose own settings run a program.
        let d = fresh("submodule");
        std::fs::create_dir_all(d.join("lib")).unwrap();
        sh(&d.join("lib"), &["init", "-q"]);
        sh(&d.join("lib"), &["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "--allow-empty", "-m", "x"]);
        std::fs::create_dir_all(d.join("top")).unwrap();
        sh(&d.join("top"), &["init", "-q"]);
        sh(&d.join("top"), &["-c", "protocol.file.allow=always", "submodule", "add", "-q", "../lib", "lib"]);
        assert!(git_guard(true, git_in(&d.join("top"))).is_ok());
        let sub_cfg = d.join("top/.git/modules/lib/config");
        let mut t = std::fs::read_to_string(&sub_cfg).unwrap();
        t.push_str("[filter \"x\"]\n\tclean = touch PWNED\n");
        std::fs::write(&sub_cfg, t).unwrap();
        assert!(git_guard(true, git_in(&d.join("top"))).unwrap_err().contains("submodule"));

        // 4. Include files and a plain, safe repository.
        let d = fresh("include");
        sh(&d, &["init", "-q"]);
        std::fs::write(d.join("inc"), "[core]\n\tsshCommand = evil\n").unwrap();
        sh(&d, &["config", "include.path", "../inc"]);
        assert!(git_guard(true, git_in(&d)).is_err());
        let d = fresh("plain");
        sh(&d, &["init", "-q"]);
        sh(&d, &["remote", "add", "origin", "https://example.com/x.git"]);
        let flags = git_guard(true, git_in(&d)).unwrap();
        assert!(flags.iter().any(|f| f == "safe.bareRepository=explicit"));
    }
}
