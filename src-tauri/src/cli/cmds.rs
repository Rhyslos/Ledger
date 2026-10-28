//! The rest of `ledger`'s commands.

use crate::out::*;
use crate::scan::{self, Eco};
use crate::{link, net, registry};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

/// A full path with . and .. worked out, written the way the window writes it: mapped drives,
/// subst drives and junctions stay as they are (canonicalize would turn them into \\?\UNC\…).
pub fn abs(p: &Path) -> PathBuf {
    let a = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let mut out = PathBuf::new();
    for c in a.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out
}

fn cwd() -> PathBuf {
    abs(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn need_link() -> Result<(), i32> {
    if link::available() { Ok(()) } else { Err(fail(link::OUTSIDE)) }
}

fn ask(q: &str) -> bool {
    print!("{q} [y/N] ");
    let _ = std::io::stdout().flush();
    let mut s = String::new();
    let _ = std::io::stdin().lock().read_line(&mut s);
    matches!(s.trim().to_lowercase().as_str(), "y" | "yes")
}

fn size_text(b: u64) -> String {
    let f = b as f64;
    if f >= 1e9 { format!("{:.1} GB", f / 1e9) } else if f >= 1e6 { format!("{:.0} MB", f / 1e6) } else if f >= 1e3 { format!("{:.0} kB", f / 1e3) } else { format!("{b} B") }
}

// ---------------------------------------------------------------- open, tasks, trust, history

/// `ledger file.cs:12`, `ledger .`: open in the Ledger window (as Ledger's own command line does).
pub fn open(args: &[String]) -> i32 {
    if let Err(c) = need_link() {
        return c;
    }
    let here = cwd();
    for a in args.iter().filter(|a| !a.starts_with('-')) {
        // file.rs:12 or file.rs:12:5 → the part before the numbers must exist.
        let re = regex::Regex::new(r"^(.*?)(?::\d+){1,2}$").unwrap();
        let file = re.captures(a).map(|c| c[1].to_string()).filter(|f| !f.is_empty() && !Path::new(a).exists()).unwrap_or_else(|| a.clone());
        let real = if Path::new(&file).is_absolute() { PathBuf::from(&file) } else { here.join(&file) };
        if !real.exists() {
            let looks_like_command = !a.contains(['.', '/', '\\', ':']);
            return fail(&if looks_like_command { format!("There's no ledger command or file called {a}. ledger help lists the commands.") } else { format!("{} doesn't exist.", real.display()) });
        }
    }
    match link::call("open", json!({ "argv": args, "cwd": here }), 30) {
        Ok(_) => 0,
        Err(e) => fail(&e),
    }
}

/// `ledger run|build|test|check`: the steps the window would run, run here.
pub fn task(action: &str, rest: &[String]) -> i32 {
    if let Err(c) = need_link() {
        return c;
    }
    let steps = match link::call("steps", json!({ "action": action, "cwd": cwd() }), 600) {
        Ok(v) => v,
        Err(e) => return fail(&e),
    };
    let list = steps.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return fail(&format!("Nothing to {action} here."));
    }
    // ledger run -- --port 3000: the rest goes to the program.
    let extra: Vec<String> = rest.iter().skip_while(|a| *a != "--").cloned().collect();
    for (i, s) in list.iter().enumerate() {
        let prog = s["program"].as_str().unwrap_or("");
        let mut args: Vec<String> = s["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_string)).collect();
        if i == list.len() - 1 {
            args.extend(extra.iter().cloned());
        }
        let dir = s["cwd"].as_str().map(PathBuf::from).unwrap_or_else(cwd);
        eprintln!("{} {}", cyan("$"), dim(&format!("{prog} {}", args.join(" "))));
        let real = if cfg!(windows) && ["npm", "npx", "yarn", "pnpm"].contains(&prog) { format!("{prog}.cmd") } else { prog.to_string() };
        let mut cmd = Command::new(real);
        cmd.args(&args).current_dir(&dir);
        if let Some(env) = s["env"].as_object() {
            for (k, v) in env {
                cmd.env(k, v.as_str().unwrap_or(""));
            }
        }
        match cmd.status() {
            Ok(st) if st.success() => {}
            Ok(st) => return st.code().unwrap_or(1),
            Err(e) => return fail(&format!("Couldn't start {prog} ({e}).")),
        }
    }
    0
}

pub fn trust(yes: bool) -> i32 {
    if let Err(c) = need_link() {
        return c;
    }
    if yes {
        println!("{}", dim("Answer the question in the Ledger window…"));
    }
    match link::call("trust", json!({ "path": cwd(), "yes": yes }), 600) {
        Ok(v) => {
            let root = v.as_str().unwrap_or("");
            if yes {
                println!("{} {root} is trusted: Ledger runs, builds and tests it, and its language servers load it fully.", green("✓"));
            } else {
                println!("{} {root} is in restricted mode: Ledger won't run its code until you trust it.", yellow("!"));
            }
            0
        }
        Err(e) => fail(&e),
    }
}

pub fn self_update() -> i32 {
    if let Err(c) = need_link() {
        return c;
    }
    match link::call("selfUpdate", json!({}), 600) {
        Ok(v) => {
            println!("{}", v.as_str().unwrap_or("Done."));
            0
        }
        Err(e) => fail(&e),
    }
}

fn ago(ms: f64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(ms);
    let s = ((now - ms) / 1000.0).max(0.0) as u64;
    match s {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", s / 60),
        3600..=86_399 => format!("{} h ago", s / 3600),
        _ => format!("{} days ago", s / 86_400),
    }
}

/// `ledger history <file>` lists saved versions (1 is the newest); --show N prints one, --restore N
/// puts it in the editor (save there to keep it).
pub fn history(rest: &[String]) -> i32 {
    if let Err(c) = need_link() {
        return c;
    }
    let Some(f) = rest.iter().find(|a| !a.starts_with('-') && rest.iter().position(|x| x == *a).map_or(true, |i| i == 0 || !rest[i - 1].starts_with("--"))) else {
        return fail("Which file? ledger history src/main.rs");
    };
    let path = abs(&cwd().join(f));
    let p = path.display().to_string();
    let list = match link::call("history_list", json!({ "path": p }), 10) {
        Ok(v) => v.as_array().cloned().unwrap_or_default(),
        Err(e) => return fail(&e),
    };
    if list.is_empty() {
        println!("No saved versions of {f} yet. Ledger keeps one each time you save in it.");
        return 0;
    }
    let pick = |flag: &str| rest.iter().position(|a| a == flag).and_then(|i| rest.get(i + 1)).and_then(|n| n.parse::<usize>().ok());
    let nth = |n: usize| list.get(n.saturating_sub(1)).and_then(|v| v["id"].as_str()).map(str::to_string);
    if let Some(n) = pick("--show") {
        let Some(id) = nth(n) else { return fail(&format!("There are {} versions.", list.len())) };
        return match link::call("history_read", json!({ "path": p, "id": id }), 10) {
            Ok(v) => {
                print!("{}", v.as_str().unwrap_or(""));
                0
            }
            Err(e) => fail(&e),
        };
    }
    if let Some(n) = pick("--restore") {
        let Some(id) = nth(n) else { return fail(&format!("There are {} versions.", list.len())) };
        return match link::call("restoreVersion", json!({ "path": p, "id": id }), 30) {
            Ok(_) => {
                println!("{} Version {n} is in the editor. Save it there to keep it (Ctrl+Z takes it back).", green("✓"));
                0
            }
            Err(e) => fail(&e),
        };
    }
    println!("{} {}", bold("Saved versions of"), f);
    for (i, v) in list.iter().enumerate() {
        println!("  {:>3}  {}  {}", i + 1, pad(&ago(v["time"].as_f64().unwrap_or(0.0)), 12), dim(&size_text(v["size"].as_u64().unwrap_or(0))));
    }
    println!("{}", dim("ledger history <file> --show N prints one; --restore N puts it back in the editor."));
    0
}

// ---------------------------------------------------------------- new

const KINDS: &[(&str, &str)] = &[
    ("rust", "Rust program (cargo new)"),
    ("rust-lib", "Rust library"),
    ("console", "C# console app"),
    ("classlib", "C# class library"),
    ("webapi", "ASP.NET Core Web API"),
    ("blazor", "Blazor web app"),
    ("mvc", "ASP.NET Core MVC"),
    ("webapp", "ASP.NET Core Razor Pages"),
    ("worker", "Worker service"),
    ("wpf", "WPF app (Windows)"),
    ("winforms", "Windows Forms app"),
    ("xunit", "xUnit test project"),
    ("nunit", "NUnit test project"),
    ("mstest", "MSTest test project"),
    ("react", "React with Vite (react-ts for TypeScript)"),
    ("vue", "Vue with Vite (vue-ts)"),
    ("svelte", "Svelte with Vite (svelte-ts)"),
    ("preact", "Preact with Vite (preact-ts)"),
    ("solid", "Solid with Vite (solid-ts)"),
    ("lit", "Lit with Vite (lit-ts)"),
    ("vanilla", "plain JavaScript with Vite (vanilla-ts)"),
    ("next", "Next.js"),
    ("node", "Node.js package"),
    ("website", "HTML, CSS and JavaScript"),
    ("lua", "Lua program"),
    ("lust", "Lust program"),
    ("lust-app", "Lust app"),
];

pub fn new(rest: &[String]) -> i32 {
    let words: Vec<&String> = rest.iter().filter(|a| !a.starts_with('-')).collect();
    if rest.iter().any(|a| a == "--list") || words.len() < 2 {
        println!("{}", bold("ledger new <kind> <name>"));
        for (k, d) in KINDS {
            println!("  {}  {}", pad(k, 10), dim(d));
        }
        println!("{}", dim("Any other dotnet template works too: ledger new grpc MyService"));
        return if words.len() < 2 && !rest.iter().any(|a| a == "--list") { 2 } else { 0 };
    }
    let (kind, name) = (words[0].as_str(), words[1].as_str());
    if !kind.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_')) {
        return fail(&format!("{kind} isn't a kind of project. ledger new --list shows them."));
    }
    if name.is_empty() || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) || name.starts_with('.') {
        return fail("The name is the new folder's name: letters, digits, - and _.");
    }
    let here = cwd();
    let dir = here.join(name);
    if dir.exists() {
        return fail(&format!("{} already exists.", dir.display()));
    }
    // dotnet new and npm create read the folder's settings (Directory.Build.props, .npmrc): a
    // restricted folder of Ledger's is asked about first.
    if link::available() {
        if let Ok(v) = link::call("trusted", json!({ "path": here }), 10) {
            if v.as_bool() == Some(false) {
                return fail("This folder is in restricted mode, and making a project here reads its settings. Trust it first (ledger trust), or make the project somewhere else.");
            }
        }
    }
    let vite = ["react", "react-ts", "react-swc", "react-swc-ts", "vue", "vue-ts", "svelte", "svelte-ts", "preact", "preact-ts", "solid", "solid-ts", "lit", "lit-ts", "vanilla", "vanilla-ts", "qwik", "qwik-ts"];
    let lust = std::env::var("LEDGER_LUST").unwrap_or_else(|_| "lust".into());
    let (prog, args): (String, Vec<String>) = match kind {
        "rust" | "rust-bin" => ("cargo".into(), vec!["new".into(), name.into()]),
        "rust-lib" => ("cargo".into(), vec!["new".into(), "--lib".into(), name.into()]),
        k if vite.contains(&k) => ("npm".into(), vec!["create".into(), "vite@latest".into(), name.into(), "--".into(), "--template".into(), k.into()]),
        "next" => ("npx".into(), vec!["--yes".into(), "create-next-app@latest".into(), name.into()]),
        "lust" => (lust, vec!["new".into(), name.into()]),
        "lust-app" => (lust, vec!["new".into(), name.into(), "app".into()]),
        "node" | "website" | "lua" => {
            let files: Vec<(&str, String)> = match kind {
                "node" => vec![("package.json", format!("{{\n  \"name\": \"{}\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"main\": \"index.js\",\n  \"scripts\": {{\n    \"start\": \"node index.js\"\n  }}\n}}\n", name.to_lowercase())), ("index.js", "console.log(\"Hello\");\n".into())],
                "website" => vec![("index.html", format!("<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{name}</title>\n  <link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n  <h1>{name}</h1>\n  <script src=\"script.js\"></script>\n</body>\n</html>\n")), ("style.css", "body {\n  font-family: system-ui, sans-serif;\n  margin: 2rem;\n}\n".into()), ("script.js", "".into())],
                _ => vec![("main.lua", "print(\"Hello\")\n".into())],
            };
            if std::fs::create_dir_all(&dir).is_err() {
                return fail(&format!("Couldn't make {}.", dir.display()));
            }
            for (f, t) in files {
                if std::fs::write(dir.join(f), t).is_err() {
                    return fail(&format!("Couldn't write {f}."));
                }
            }
            return made(&dir, rest);
        }
        // Everything else is a dotnet template (console, webapi, grpc, maui…).
        k => ("dotnet".into(), vec!["new".into(), k.into(), "-n".into(), name.into(), "-o".into(), name.into()]),
    };
    eprintln!("{} {}", cyan("$"), dim(&format!("{prog} {}", args.join(" "))));
    let real = if cfg!(windows) && (prog == "npm" || prog == "npx") { format!("{prog}.cmd") } else { prog.clone() };
    match Command::new(&real).args(&args).current_dir(&here).status() {
        Ok(s) if s.success() && dir.exists() => made(&dir, rest),
        Ok(s) => s.code().unwrap_or(1),
        Err(e) => fail(&format!("Couldn't start {prog} ({e}).")),
    }
}

fn made(dir: &Path, rest: &[String]) -> i32 {
    println!("{} Made {}", green("✓"), dir.display());
    if rest.iter().any(|a| a == "--open") && link::available() {
        return open(&[dir.display().to_string()]);
    }
    println!("{}", dim(&format!("Open it: ledger {}", dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())));
    0
}

// ---------------------------------------------------------------- doctor

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

/// A tool's version, asked from your home folder: in the project's folder, rustup would read its
/// rust-toolchain.toml (which can name a toolchain inside the project) and dotnet its global.json.
fn version_of(prog: &str, args: &[&str]) -> Option<String> {
    let real = if cfg!(windows) && ["npm", "npx"].contains(&prog) { format!("{prog}.cmd") } else { prog.to_string() };
    let o = Command::new(real).current_dir(home_dir()).args(args).env("DOTNET_CLI_UI_LANGUAGE", "en").env("DOTNET_NOLOGO", "1").output().ok()?;
    let text = String::from_utf8_lossy(if o.stdout.is_empty() { &o.stderr } else { &o.stdout }).trim().to_string();
    (o.status.success()).then(|| text.lines().next().unwrap_or("").to_string())
}

struct Tool {
    lang: &'static str,
    name: &'static str,
    cmd: &'static str,
    args: &'static [&'static str],
    /// How to install it: a program and its arguments.
    install: Option<(&'static str, &'static [&'static str])>,
    what: &'static str,
}

const TOOLS: &[Tool] = &[
    Tool { lang: "all", name: "Git", cmd: "git", args: &["--version"], install: Some(("winget", &["install", "--id", "Git.Git", "-e", "--source", "winget"])), what: "source control" },
    Tool { lang: "rust", name: "Rust (cargo)", cmd: "cargo", args: &["--version"], install: Some(("winget", &["install", "--id", "Rustlang.Rustup", "-e", "--source", "winget"])), what: "builds Rust" },
    Tool { lang: "rust", name: "rust-analyzer", cmd: "rust-analyzer", args: &["--version"], install: Some(("rustup", &["component", "add", "rust-analyzer", "rust-src"])), what: "Rust language server" },
    Tool { lang: "dotnet", name: ".NET SDK", cmd: "dotnet", args: &["--version"], install: Some(("winget", &["install", "--id", "Microsoft.DotNet.SDK.10", "-e", "--source", "winget"])), what: "builds C#" },
    Tool { lang: "dotnet", name: "csharp-ls", cmd: "csharp-ls", args: &["--version"], install: Some(("dotnet", &["tool", "install", "--global", "csharp-ls"])), what: "C# language server (or Roslyn, in Settings)" },
    Tool { lang: "dotnet", name: "dotnet-ef", cmd: "dotnet-ef", args: &["--version"], install: Some(("dotnet", &["tool", "install", "--global", "dotnet-ef"])), what: "Entity Framework migrations" },
    Tool { lang: "node", name: "Node.js", cmd: "node", args: &["--version"], install: Some(("winget", &["install", "--id", "OpenJS.NodeJS.LTS", "-e", "--source", "winget"])), what: "runs JavaScript" },
    Tool { lang: "node", name: "Web language servers", cmd: "typescript-language-server", args: &["--version"], install: Some(("npm", &["install", "--global", "typescript", "typescript-language-server", "vscode-langservers-extracted"])), what: "JavaScript, TypeScript, HTML and CSS" },
    Tool { lang: "lua", name: "Lua", cmd: "lua", args: &["-v"], install: Some(("winget", &["install", "--id", "DEVCOM.Lua", "-e", "--source", "winget"])), what: "runs .lua files" },
    Tool { lang: "lua", name: "Lua language server", cmd: "lua-language-server", args: &["--version"], install: Some(("winget", &["install", "--id", "LuaLS.lua-language-server", "-e", "--source", "winget"])), what: "Lua completions and errors" },
    Tool { lang: "lust", name: "Lust", cmd: "lust", args: &["version"], install: Some(("cargo", &["install", "--git", "https://github.com/Rhyslos/Lust", "--locked", "--force", "lust"])), what: "runs Lust" },
];

/// Which languages the folder (and below) uses.
fn languages(root: &Path) -> std::collections::BTreeSet<&'static str> {
    let mut out = std::collections::BTreeSet::from(["all"]);
    for p in scan::find(root) {
        out.insert(match p.eco {
            Eco::Cargo => "rust",
            Eco::Npm => "node",
            Eco::NuGet => "dotnet",
        });
    }
    let walk = ignore::WalkBuilder::new(root).max_depth(Some(4)).build();
    for e in walk.flatten().take(5000) {
        match e.path().extension().and_then(|x| x.to_str()) {
            Some("lua") => {
                out.insert("lua");
            }
            Some("lst") | Some("lsc") => {
                out.insert("lust");
            }
            Some("sln") | Some("slnx") | Some("csproj") => {
                out.insert("dotnet");
            }
            _ => {}
        }
    }
    out
}

pub fn doctor(here: &Path, fix: bool) -> i32 {
    let here = here.to_path_buf();
    let used = languages(&here);
    println!("{} {}", bold("Ledger doctor"), dim(&here.display().to_string()));
    let mut missing: Vec<&Tool> = vec![];
    let mut lang = "";
    for t in TOOLS {
        if t.lang != lang {
            lang = t.lang;
        }
        let needed = used.contains(t.lang);
        match version_of(t.cmd, t.args) {
            Some(v) => println!("  {} {}  {}", green("✓"), pad(t.name, 22), dim(&v)),
            None if needed => {
                println!("  {} {}  {}", red("✗"), pad(t.name, 22), format!("not found · {}", t.what));
                missing.push(t);
            }
            None => println!("  {} {}  {}", dim("–"), pad(t.name, 22), dim(&format!("not installed · {} (not used here)", t.what))),
        }
    }
    // global.json pinning an SDK that isn't here: dotnet itself says so. That runs dotnet in the
    // folder, so only in one Ledger trusts.
    let trusted = link::available() && link::call("trusted", json!({ "path": here }), 10).ok().and_then(|v| v.as_bool()) == Some(true);
    if here.join("global.json").is_file() && !trusted {
        println!("  {} {}  {}", dim("–"), pad("global.json", 22), dim("checked in trusted folders only (ledger trust)"));
    } else if trusted && (here.join("global.json").is_file() || used.contains("dotnet")) {
        let o = Command::new("dotnet").arg("--version").current_dir(&here).env("DOTNET_CLI_UI_LANGUAGE", "en").output();
        if let Ok(o) = o {
            if !o.status.success() {
                let msg = String::from_utf8_lossy(&o.stderr).to_string() + &String::from_utf8_lossy(&o.stdout);
                println!("  {} {}  {}", red("✗"), pad("global.json", 22), msg.lines().find(|l| !l.trim().is_empty()).unwrap_or("dotnet can't find the SDK this folder asks for."));
            }
        }
    }
    let data = std::env::var("LEDGER_DATA").ok().map(PathBuf::from);
    if let Some(d) = data {
        for (kind, exe, what) in [("codelldb", if cfg!(windows) { "extension/adapter/codelldb.exe" } else { "extension/adapter/codelldb" }, "Rust debugger"), ("netcoredbg", if cfg!(windows) { "netcoredbg/netcoredbg.exe" } else { "netcoredbg/netcoredbg" }, "C# debugger")] {
            let ok = d.join("debuggers").join(kind).join(exe).is_file();
            let needed = (kind == "codelldb" && used.contains("rust")) || (kind == "netcoredbg" && used.contains("dotnet"));
            if ok {
                println!("  {} {}  {}", green("✓"), pad(kind, 22), dim(what));
            } else {
                println!("  {} {}  {}", if needed { yellow("!") } else { dim("–") }, pad(kind, 22), dim(&format!("{what}: Ledger downloads it the first time you debug")));
            }
        }
    }
    if missing.is_empty() {
        println!("\n{} Everything this folder needs is installed.", green("✓"));
        return 0;
    }
    if !fix {
        println!("\n{} {} missing. {} installs {}.", yellow("!"), missing.len(), bold("ledger doctor --fix"), if missing.len() == 1 { "it" } else { "them" });
        return 1;
    }
    let mut bad = 0;
    for t in missing {
        let Some((prog, args)) = t.install else { continue };
        if prog == "winget" && !cfg!(windows) {
            println!("  {} {}: install it with your system's package manager.", yellow("!"), t.name);
            bad += 1;
            continue;
        }
        let mut a: Vec<&str> = args.to_vec();
        if prog == "winget" {
            a.extend(["--accept-source-agreements", "--accept-package-agreements"]);
        }
        eprintln!("{} {}", cyan("$"), dim(&format!("{prog} {}", a.join(" "))));
        let real = if cfg!(windows) && prog == "npm" { "npm.cmd".to_string() } else { prog.to_string() };
        // Installs run in your home folder, not the project's (npm and NuGet read settings from the folder they run in).
        let ok = Command::new(real).args(&a).current_dir(home_dir()).status().map(|s| s.success()).unwrap_or(false);
        if ok {
            println!("  {} {}", green("✓"), t.name);
        } else {
            println!("  {} {} didn't install (see above).", red("✗"), t.name);
            bad += 1;
        }
    }
    if bad == 0 {
        println!("\n{} Done. A new terminal (or restarting Ledger) picks up new programs.", green("✓"));
        0
    } else {
        1
    }
}

// ---------------------------------------------------------------- clean

fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                stack.push(e.path());
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    total
}

/// Build output next to the files that make it: target/ by Cargo.toml, bin/ and obj/ by a .NET
/// project, node_modules/ by package.json. Nothing else is touched.
pub fn clean_targets(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        let entries: Vec<std::fs::DirEntry> = rd.flatten().collect();
        let names: Vec<String> = entries.iter().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        let has = |f: &dyn Fn(&str) -> bool| names.iter().any(|n| f(n));
        let mut take: Vec<&str> = vec![];
        if has(&|n| n == "Cargo.toml") {
            take.push("target");
        }
        if has(&|n| { let l = n.to_lowercase(); l.ends_with(".csproj") || l.ends_with(".fsproj") || l.ends_with(".vbproj") }) {
            take.extend(["bin", "obj"]);
        }
        if has(&|n| n == "package.json") {
            take.push("node_modules");
        }
        for e in entries {
            let Ok(t) = e.file_type() else { continue };
            if !t.is_dir() || t.is_symlink() {
                continue;
            }
            let n = e.file_name().to_string_lossy().to_string();
            if take.contains(&n.as_str()) {
                out.push(e.path());
            } else if !matches!(n.as_str(), ".git" | "node_modules" | "target" | ".godot") {
                stack.push(e.path());
            }
        }
    }
    out.sort();
    out
}

pub fn clean(root: &Path, yes: bool) -> i32 {
    let list = clean_targets(root);
    if list.is_empty() {
        println!("{} No build output here.", green("✓"));
        return 0;
    }
    let sizes: Vec<u64> = net::parallel(&list, 4, |p| dir_size(p));
    let total: u64 = sizes.iter().sum();
    println!("{}", bold("Build output that can be made again"));
    for (p, s) in list.iter().zip(&sizes) {
        println!("  {}  {}", pad(&size_text(*s), 8), crate::audit::rel(root, p));
    }
    println!("  {}  in all", bold(&size_text(total)));
    if !yes && !ask("Delete them?") {
        println!("Nothing deleted.");
        return 0;
    }
    let mut freed = 0;
    let mut stuck = vec![];
    for (p, s) in list.iter().zip(&sizes) {
        match std::fs::remove_dir_all(p) {
            Ok(_) => freed += s,
            Err(e) => stuck.push(format!("{} ({e})", crate::audit::rel(root, p))),
        }
    }
    println!("{} Freed {}.", green("✓"), size_text(freed));
    for s in &stuck {
        println!("  {} couldn't delete {s}: is a program from it still running?", yellow("!"));
    }
    if stuck.is_empty() { 0 } else { 1 }
}

// ---------------------------------------------------------------- todo, stats

/// Each text file under a folder (respecting .gitignore), skipping big and binary ones, one at a
/// time so a big tree never sits in memory at once.
fn each_text_file(root: &Path, mut f: impl FnMut(&Path, &str)) {
    let walk = ignore::WalkBuilder::new(root).hidden(true).filter_entry(|e| !e.file_name().eq_ignore_ascii_case("node_modules")).build();
    for e in walk.flatten() {
        if !e.file_type().is_some_and(|t| t.is_file()) || e.metadata().map(|m| m.len() > 2_000_000).unwrap_or(true) {
            continue;
        }
        let Ok(b) = std::fs::read(e.path()) else { continue };
        if b.iter().take(8000).any(|&c| c == 0) {
            continue;
        }
        f(e.path(), &String::from_utf8_lossy(&b));
    }
}

pub fn todo(root: &Path) -> i32 {
    let re = regex::Regex::new(r"\b(TODO|FIXME|HACK|XXX|BUG)\b[:(\s]?\s*(.*)").unwrap();
    let mut n = 0;
    let mut by: BTreeMap<&str, usize> = BTreeMap::new();
    each_text_file(root, |path, text| {
        let mut shown = false;
        for (i, line) in text.lines().enumerate() {
            let Some(c) = re.captures(line) else { continue };
            if !shown {
                println!("\n{}", bold(&crate::audit::rel(root, path)));
                shown = true;
            }
            let word = c.get(1).unwrap().as_str();
            let tag = match word { "FIXME" | "BUG" => red(&pad(word, 5)), "HACK" | "XXX" => yellow(&pad(word, 5)), _ => cyan(&pad(word, 5)) };
            *by.entry(match word { "TODO" => "TODO", "FIXME" => "FIXME", "HACK" => "HACK", "XXX" => "XXX", _ => "BUG" }).or_default() += 1;
            let rest: String = c.get(2).map(|m| m.as_str()).unwrap_or("").trim_end_matches(['*', '/', '-', '>', ' ']).chars().take(140).collect();
            println!("  {}  {} {}", dim(&format!("{:>5}", i + 1)), tag, rest);
            n += 1;
        }
    });
    if n == 0 {
        println!("{} No TODO, FIXME or HACK notes.", green("✓"));
    } else {
        println!("\n{n} note{}: {}", if n == 1 { "" } else { "s" }, by.iter().map(|(k, v)| format!("{v} {k}")).collect::<Vec<_>>().join(", "));
    }
    0
}

fn language_of(p: &Path) -> Option<&'static str> {
    let ext = p.extension()?.to_str()?.to_lowercase();
    Some(match ext.as_str() {
        "rs" => "Rust",
        "cs" | "csx" => "C#",
        "razor" | "cshtml" => "Razor",
        "xaml" | "axaml" => "XAML",
        "fs" => "F#",
        "js" | "mjs" | "cjs" | "jsx" => "JavaScript",
        "ts" | "mts" | "cts" | "tsx" => "TypeScript",
        "vue" => "Vue",
        "svelte" => "Svelte",
        "html" | "htm" => "HTML",
        "css" | "scss" | "sass" | "less" => "CSS",
        "lua" | "luau" => "Lua",
        "lst" | "lsc" | "lust" => "Lust",
        "gd" => "GDScript",
        "gdshader" => "Godot shader",
        "py" => "Python",
        "go" => "Go",
        "c" | "h" => "C",
        "cpp" | "cc" | "hpp" => "C++",
        "java" => "Java",
        "kt" => "Kotlin",
        "sql" => "SQL",
        "ps1" | "psm1" => "PowerShell",
        "sh" | "bash" => "Shell",
        "md" => "Markdown",
        "toml" | "yaml" | "yml" | "json" | "jsonc" | "xml" | "csproj" | "props" | "targets" | "ini" | "cfg" => "Config",
        _ => return None,
    })
}

pub fn stats(root: &Path) -> i32 {
    let mut by: BTreeMap<&str, (usize, usize, usize)> = BTreeMap::new(); // files, lines, non-blank
    each_text_file(root, |path, text| {
        if path.file_name().is_some_and(|f| f.to_string_lossy().contains(".lock") || f == "package-lock.json" || f == "project.assets.json") {
            return;
        }
        let Some(l) = language_of(path) else { return };
        let e = by.entry(l).or_default();
        e.0 += 1;
        e.1 += text.lines().count();
        e.2 += text.lines().filter(|x| !x.trim().is_empty()).count();
    });
    if by.is_empty() {
        println!("No code here.");
        return 0;
    }
    let mut rows: Vec<_> = by.into_iter().collect();
    rows.sort_by(|a, b| b.1 .2.cmp(&a.1 .2));
    let total: (usize, usize, usize) = rows.iter().fold((0, 0, 0), |a, (_, r)| (a.0 + r.0, a.1 + r.1, a.2 + r.2));
    println!("{}", bold(&format!("{}  {:>7}  {:>9}  {:>9}", pad("Language", 14), "Files", "Lines", "Code")));
    for (l, (f, n, c)) in &rows {
        println!("{}  {:>7}  {:>9}  {:>9}", pad(l, 14), f, n, c);
    }
    println!("{}", dim(&format!("{}  {:>7}  {:>9}  {:>9}", pad("All", 14), total.0, total.1, total.2)));
    println!("{}", dim("Code = lines that aren't blank. Files .gitignore leaves out aren't counted."));
    0
}

// ---------------------------------------------------------------- licenses

/// How much a licence asks of you: 0 permissive, 1 file-level copyleft (MPL, LGPL, EPL), 2 strong
/// copyleft (GPL, AGPL), 3 unknown. "A OR B" takes the easier one, "A AND B" the harder.
pub fn license_level(expr: &str) -> u8 {
    // Older Cargo files write "MIT/Apache-2.0" for "MIT OR Apache-2.0".
    let e = expr.trim().replace(" / ", " OR ").replace('/', " OR ");
    let e = strip_parens(e.trim());
    if e.is_empty() || e.starts_with("see ") || e.eq_ignore_ascii_case("UNLICENSED") || e.eq_ignore_ascii_case("UNKNOWN") {
        return 3;
    }
    // Split at the top level only: "(A OR B) AND C" is (A OR B), AND, C.
    for (op, pick_easiest) in [(" OR ", true), (" AND ", false)] {
        let parts = split_top(e, op);
        if parts.len() > 1 {
            let lv = parts.iter().map(|p| license_level(p));
            return if pick_easiest { lv.min().unwrap_or(3) } else { lv.max().unwrap_or(3) };
        }
    }
    let id = e.split(" WITH ").next().unwrap_or(e).trim().to_uppercase();
    if id.starts_with("AGPL") || id.starts_with("GPL") || id.starts_with("SSPL") || id.starts_with("OSL") {
        2
    } else if id.starts_with("LGPL") || id.starts_with("MPL") || id.starts_with("EPL") || id.starts_with("CDDL") || id.starts_with("CC-BY-SA") {
        1
    } else if ["MIT", "MIT-0", "APACHE-2.0", "APACHE-1.1", "BSD-2-CLAUSE", "BSD-3-CLAUSE", "BSD-2-CLAUSE-PATENT", "ISC", "ZLIB", "UNLICENSE", "0BSD", "CC0-1.0", "BSL-1.0", "UNICODE-DFS-2016", "UNICODE-3.0", "BLUEOAK-1.0.0", "PYTHON-2.0", "CC-BY-3.0", "CC-BY-4.0", "MS-PL", "WTFPL", "X11", "POSTGRESQL", "NCSA", "CDLA-PERMISSIVE-2.0", "OFL-1.1", "ARTISTIC-2.0"].contains(&id.as_str()) {
        0
    } else {
        3
    }
}

/// "(A OR B)" → "A OR B", only when the brackets go round the whole thing.
fn strip_parens(mut e: &str) -> &str {
    while e.starts_with('(') && e.ends_with(')') {
        let mut depth = 0;
        let whole = e.char_indices().all(|(i, c)| {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            depth > 0 || i == e.len() - 1
        });
        if !whole {
            break;
        }
        e = e[1..e.len() - 1].trim();
    }
    e
}

fn split_top<'a>(e: &'a str, op: &str) -> Vec<&'a str> {
    let mut out = vec![];
    let (mut depth, mut start, mut i) = (0i32, 0, 0);
    let b = e.as_bytes();
    while i < b.len() {
        match b[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ if depth == 0 && e[i..].starts_with(op) => {
                out.push(e[start..i].trim());
                i += op.len();
                start = i;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(e[start..].trim());
    out
}

/// A package's licence from what's already on this computer (Cargo's and NuGet's caches,
/// node_modules), before asking the registry.
fn local_license(eco: Eco, dir: &Path, name: &str, version: &str) -> Option<String> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)?;
    match eco {
        Eco::Cargo => {
            let cargo_home = std::env::var_os("CARGO_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".cargo"));
            for reg in std::fs::read_dir(cargo_home.join("registry").join("src")).ok()?.flatten() {
                let t = std::fs::read_to_string(reg.path().join(format!("{name}-{version}")).join("Cargo.toml"));
                if let Ok(t) = t {
                    let v: toml::Table = t.parse().ok()?;
                    return v.get("package")?.get("license").and_then(|l| l.as_str()).map(str::to_string);
                }
            }
            None
        }
        Eco::Npm => {
            let t = std::fs::read_to_string(dir.join("node_modules").join(name).join("package.json")).ok()?;
            let j: Value = serde_json::from_str(&t).ok()?;
            if j["version"].as_str() != Some(version) {
                return None;
            }
            match &j["license"] {
                Value::String(s) => Some(s.clone()),
                Value::Object(o) => o.get("type").and_then(|t| t.as_str()).map(str::to_string),
                _ => None,
            }
        }
        Eco::NuGet => {
            let pk = std::env::var_os("NUGET_PACKAGES").map(PathBuf::from).unwrap_or_else(|| home.join(".nuget").join("packages"));
            let id = name.to_lowercase();
            let t = std::fs::read_to_string(pk.join(&id).join(version.to_lowercase()).join(format!("{id}.nuspec"))).ok()?;
            let re = regex::Regex::new(r#"(?s)<license\s+type="expression"\s*>\s*([^<]+?)\s*</license>"#).ok()?;
            re.captures(&t).map(|c| c[1].to_string())
        }
    }
}

const LEVELS: [&str; 4] = ["permissive", "file copyleft", "copyleft", "unknown"];

pub fn licenses(root: &Path, as_json: bool) -> i32 {
    let projects = scan::find(root);
    let mut pkgs: Vec<(Eco, String, String, PathBuf)> = vec![];
    for p in &projects {
        let dir = p.lock.as_ref().and_then(|l| l.parent()).unwrap_or(&p.dir).to_path_buf();
        for d in &p.deps {
            if !pkgs.iter().any(|(e, n, v, _)| *e == p.eco && n == &d.name && v == &d.version) {
                pkgs.push((p.eco, d.name.clone(), d.version.clone(), dir.clone()));
            }
        }
    }
    if pkgs.is_empty() {
        println!("No packages here (or no lock files yet).");
        return 0;
    }
    if !as_json {
        step(&format!("Reading the licences of {} packages…", pkgs.len()));
    }
    // From what's on this computer first; then the registries. crates.io asks tools for one
    // request a second, so crates are asked one at a time (and only so many).
    let mut found: Vec<Option<String>> = net::parallel(&pkgs, 8, |(e, n, v, d)| local_license(*e, d, n, v));
    let missing: Vec<usize> = (0..pkgs.len()).filter(|&i| found[i].is_none()).collect();
    let others: Vec<usize> = missing.iter().copied().filter(|&i| pkgs[i].0 != Eco::Cargo).collect();
    for (i, l) in others.iter().zip(net::parallel(&others, 8, |&i| registry::license(pkgs[i].0, &pkgs[i].1, &pkgs[i].2))) {
        found[*i] = l;
    }
    let crates: Vec<usize> = missing.iter().copied().filter(|&i| pkgs[i].0 == Eco::Cargo).collect();
    const MAX_CRATES: usize = 60;
    if crates.len() > MAX_CRATES && !as_json {
        step(&format!("{} crates aren't in Cargo's cache; asking crates.io about the first {MAX_CRATES} (a build fills the cache, then audit again for all).", crates.len()));
    }
    for (k, &i) in crates.iter().take(MAX_CRATES).enumerate() {
        if k > 0 {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        found[i] = registry::license(Eco::Cargo, &pkgs[i].1, &pkgs[i].2);
    }
    let rows: Vec<(Eco, String, String, String, u8)> = pkgs.into_iter().zip(found).map(|((e, n, v, _), l)| {
        let l = l.unwrap_or_default();
        let lv = license_level(&l);
        (e, n, v, l, lv)
    }).collect();
    if as_json {
        let j: Vec<Value> = rows.iter().map(|(e, n, v, l, lv)| json!({ "ecosystem": e.key(), "package": n, "version": v, "license": l, "level": LEVELS[*lv as usize] })).collect();
        println!("{}", serde_json::to_string_pretty(&j).unwrap_or_default());
        return 0;
    }
    let mut by: BTreeMap<String, usize> = BTreeMap::new();
    for r in &rows {
        *by.entry(if r.3.is_empty() { "(not stated)".into() } else { r.3.clone() }).or_default() += 1;
    }
    let mut counts: Vec<_> = by.into_iter().collect();
    counts.sort_by(|a, b| b.1.cmp(&a.1));
    println!("{}", bold("Licences"));
    for (l, n) in &counts {
        let lv = license_level(if l == "(not stated)" { "" } else { l });
        let mark = match lv { 0 => green("✓"), 1 => yellow("!"), 2 => red("✗"), _ => dim("?") };
        println!("  {mark} {:>5}  {}", n, l);
    }
    let attention: Vec<_> = rows.iter().filter(|r| r.4 > 0).collect();
    if !attention.is_empty() {
        println!("\n{}", bold("Worth a look"));
        for (e, n, v, l, lv) in attention {
            let why = match lv {
                1 => "changes to its own files must be shared under the same licence",
                2 => "a program that includes it must be shared under the same licence",
                _ => "licence not stated or not recognised: check its project page",
            };
            println!("  {} {} {} {}  {}", dim(e.label()), n, dim(v), if l.is_empty() { dim("(none)") } else { l.clone() }, dim(why));
        }
    }
    println!("\n{}", dim("✓ permissive (MIT, Apache, BSD…)  ! file-level copyleft (MPL, LGPL)  ✗ copyleft (GPL, AGPL)  ? unknown. Not legal advice."));
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn licence_levels() {
        assert_eq!(license_level("MIT OR Apache-2.0"), 0);
        assert_eq!(license_level("GPL-3.0-only OR MIT"), 0);
        assert_eq!(license_level("MIT AND GPL-2.0"), 2);
        assert_eq!(license_level("MPL-2.0"), 1);
        assert_eq!(license_level("(Apache-2.0 WITH LLVM-exception)"), 0);
        assert_eq!(license_level(""), 3);
        assert_eq!(license_level("see https://x"), 3);
        assert_eq!(license_level("MIT/Apache-2.0"), 0);
        assert_eq!(license_level("(MIT OR Apache-2.0) AND GPL-3.0"), 2);
        assert_eq!(license_level("(MIT OR Apache-2.0) AND Unicode-3.0"), 0);
        assert_eq!(license_level("(MPL-2.0 OR GPL-2.0) AND MIT"), 1);
    }
    #[test]
    fn clean_only_takes_build_output() {
        let d = std::env::temp_dir().join(format!("ledger-clean-{}", std::process::id()));
        for p in ["rs/target/debug", "rs/src", "web/node_modules/x", "web/dist", "cs/bin/Debug", "cs/obj", "notes/target", "rs/target/nested/node_modules"] {
            std::fs::create_dir_all(d.join(p)).unwrap();
        }
        std::fs::write(d.join("rs/Cargo.toml"), "").unwrap();
        std::fs::write(d.join("web/package.json"), "{}").unwrap();
        std::fs::write(d.join("cs/App.csproj"), "").unwrap();
        let got: Vec<String> = clean_targets(&d).iter().map(|p| p.strip_prefix(&d).unwrap().to_string_lossy().replace('\\', "/")).collect();
        assert_eq!(got, ["cs/bin", "cs/obj", "rs/target", "web/node_modules"]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
