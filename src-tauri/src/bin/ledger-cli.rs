//! `ledger`, the terminal command that comes with Ledger. In Ledger's terminal it's on PATH as
//! `ledger`; some commands talk to the window (open, run, trust…), the rest work on their own.

#[path = "../cli/audit.rs"]
mod audit;
#[path = "../cli/cmds.rs"]
mod cmds;
#[path = "../cli/fix.rs"]
mod fix;
#[path = "../cli/link.rs"]
mod link;
#[path = "../cli/net.rs"]
mod net;
#[path = "../cli/osv.rs"]
mod osv;
#[path = "../cli/out.rs"]
mod out;
#[path = "../cli/registry.rs"]
mod registry;
#[path = "../cli/scan.rs"]
mod scan;
#[path = "../cli/toolchain.rs"]
mod toolchain;
#[path = "../cli/ver.rs"]
mod ver;


use std::path::PathBuf;

const HELP: &str = "\
ledger: Ledger's terminal command

Packages
  ledger audit [folder]         security problems and updates in every project's packages
         --json                   as JSON (for scripts)
         --no-updates             skip looking for newer versions
         --prod                   leave out packages only used for development
  ledger audit fix              update what has a security fix, then build and test
         --dry-run                show the plan, change nothing
         --major                  also take fixes that need a new major version
         --no-check               don't build and test afterwards
  ledger update                 take the safe updates (same major version), then build and test
         --major                  every update, new majors too
         --dry-run, --no-check    as for audit fix
  ledger licenses [--json]      the licence of every package, with ones that set conditions marked

Your project (these use the Ledger window)
  ledger <file>[:line]          open a file in Ledger (ledger . opens this folder)
  ledger run | build | test | check
                                what F5 and the Build, Test and Check buttons do, here
  ledger trust | untrust        restricted mode for this folder
  ledger history <file>         saved versions of a file (--show N, --restore N)
  ledger self-update            update Ledger

Tools
  ledger new <kind> <name>      a new project (ledger new --list shows the kinds)
  ledger doctor [--fix]         what's installed, what's missing, and installing it
  ledger clean [--yes]          delete build output (target, bin, obj, node_modules)
  ledger todo                   every TODO, FIXME and HACK
  ledger stats                  lines of code per language

  ledger help | --version
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(run(args));
}

fn has(args: &[String], f: &str) -> bool {
    args.iter().any(|a| a == f)
}

/// The folder given (the first argument that isn't a --flag), or where you are.
fn folder(args: &[String]) -> PathBuf {
    let here = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let p = args.iter().find(|a| !a.starts_with('-')).map(|a| here.join(a)).unwrap_or(here);
    std::fs::canonicalize(&p).map(cmds::plain).unwrap_or(p)
}

fn run(args: Vec<String>) -> i32 {
    let Some(first) = args.first().cloned() else {
        // Like `code`: on its own, it brings up Ledger on this folder.
        return cmds::open(&[".".into()]);
    };
    let rest = &args[1..];
    match first.as_str() {
        "help" | "--help" | "-h" | "/?" => {
            print!("{HELP}");
            0
        }
        "--version" | "-V" | "version" => {
            // Ledger's own version, which its terminals pass on.
            println!("ledger {}", std::env::var("LEDGER_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string()));
            0
        }
        "audit" if rest.first().map(String::as_str) == Some("fix") => fix::run(&folder(&rest[1..]), fix::Mode::Security, &rest[1..]),
        "audit" => audit::run(&folder(rest), audit::Opts { json: has(rest, "--json"), updates: !has(rest, "--no-updates"), toolchains: !has(rest, "--no-computer"), dev: !has(rest, "--prod") }),
        "update" | "upgrade" => fix::run(&folder(rest), fix::Mode::Update, rest),
        "licenses" | "licences" | "license" => cmds::licenses(&folder(rest), has(rest, "--json")),
        "run" | "build" | "test" | "check" => cmds::task(&first, rest),
        "trust" => cmds::trust(true),
        "untrust" => cmds::trust(false),
        "history" => cmds::history(rest),
        "self-update" => cmds::self_update(),
        "new" => cmds::new(rest),
        "doctor" => cmds::doctor(&folder(rest), has(rest, "--fix")),
        "clean" => cmds::clean(&folder(rest), has(rest, "--yes") || has(rest, "-y")),
        "todo" | "todos" => cmds::todo(&folder(rest)),
        "stats" => cmds::stats(&folder(rest)),
        "open" => cmds::open(rest),
        f if f.starts_with('-') => {
            eprintln!("Unknown option {f}. ledger help lists the commands.");
            2
        }
        // Anything else is a file or folder to open (ledger src/main.rs:12, ledger .).
        _ => cmds::open(&args),
    }
}
