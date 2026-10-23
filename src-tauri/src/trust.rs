//! Restricted mode. A folder you haven't trusted can't make Ledger run its code: no language
//! servers that load the project (rust-analyzer runs build scripts and reads .cargo/config,
//! csharp-ls runs MSBuild, the Lua server loads plugins), no Run, Build, Test or Debug, no
//! project tools (its Tailwind, its Prettier), and Git with the repository's hooks switched off and
//! nothing at all if its settings would run a program (filters, textconv, includes...).
//! The frontend asks the question; the answer is kept here, per window, and every command that
//! starts a process in the folder checks it.

use std::path::{Path, PathBuf};

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

/// The repository's own config file, if `cwd` is in one.
fn git_config(cwd: &Path) -> Option<PathBuf> {
    let mut d = Some(cwd);
    while let Some(dir) = d {
        let g = dir.join(".git");
        if g.is_dir() {
            return Some(g.join("config"));
        }
        if g.is_file() {
            // A worktree or submodule: ".git" holds "gitdir: <path>".
            let t = std::fs::read_to_string(&g).ok()?;
            let p = t.trim().strip_prefix("gitdir:")?.trim().to_string();
            let p = if Path::new(&p).is_absolute() { PathBuf::from(p) } else { dir.join(p) };
            return Some(p.join("config"));
        }
        d = dir.parent();
    }
    None
}

/// Settings in a repository's config that make git start another program.
const RISKY: [&str; 16] = [
    "filter.", ".textconv", ".command", ".driver", "include", "core.sshcommand", "core.editor", "core.pager", "core.askpass",
    "core.gitproxy", "credential.", "gpg.", "diff.external", "core.hookspath", "core.fsmonitor", "uploadpack.",
];

/// What makes this repository's config unsafe, if anything ("filter.lfs.smudge", say).
pub fn risky_git_config(cwd: &str) -> Option<String> {
    let text = std::fs::read_to_string(git_config(Path::new(cwd))?).ok()?.to_lowercase();
    let mut section = String::new();
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('#') || l.starts_with(';') || l.is_empty() {
            continue;
        }
        if let Some(s) = l.strip_prefix('[') {
            // [filter "lfs"] -> filter.lfs.   [core] -> core.
            let s = s.trim_end_matches(']').replace('"', "").replace(' ', ".");
            section = s + ".";
            if section.starts_with("include") {
                return Some(section.trim_end_matches('.').to_string());
            }
            continue;
        }
        let key = format!("{section}{}", l.split('=').next().unwrap_or("").trim());
        if RISKY.iter().any(|r| key.starts_with(r) || (r.starts_with('.') && key.ends_with(r)) || key.contains(r)) {
            return Some(key);
        }
    }
    None
}

/// Extra arguments for git in a restricted folder (hooks off), or an error when the repository's
/// settings would run programs.
pub fn git_guard(cwd: &str, restricted: bool) -> Result<Vec<String>, String> {
    if !restricted {
        return Ok(vec![]);
    }
    if let Some(key) = risky_git_config(cwd) {
        return Err(format!("{UNTRUSTED}. This repository's settings start other programs ({key}), so Git stays off here until you trust the folder."));
    }
    // A folder that doesn't exist: no hooks at all, whatever .git/hooks holds.
    let none = std::env::temp_dir().join("ledger-no-hooks");
    Ok(vec!["-c".into(), format!("core.hooksPath={}", none.display())])
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn risky_repository_settings() {
        let d = std::env::temp_dir().join(format!("ledger-trust-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".git")).unwrap();
        let cfg = d.join(".git/config");
        std::fs::write(&cfg, "[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote \"origin\"]\n\turl = x\n").unwrap();
        assert_eq!(risky_git_config(d.to_str().unwrap()), None);
        std::fs::create_dir_all(d.join("sub")).unwrap();
        for (bad, want) in [
            ("[filter \"lfs\"]\n\tsmudge = evil\n", "filter.lfs.smudge"),
            ("[diff \"x\"]\n\ttextconv = evil\n", "diff.x.textconv"),
            ("[include]\n\tpath = other\n", "include"),
            ("[core]\n\tsshCommand = evil\n", "core.sshcommand"),
            ("[core]\n\thooksPath = h\n", "core.hookspath"),
        ] {
            std::fs::write(&cfg, bad).unwrap();
            assert_eq!(risky_git_config(d.join("sub").to_str().unwrap()).as_deref(), Some(want), "{bad}");
            assert!(git_guard(d.to_str().unwrap(), true).is_err());
            assert!(git_guard(d.to_str().unwrap(), false).unwrap().is_empty());
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
