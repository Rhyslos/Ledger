// The window's side of `ledger`, the terminal command (src-tauri/src/cli). Requests arrive as
// "cli-request" events through the Rust side (cli_link.rs) and are answered with cli_reply:
//
//   open        ledger file.cs:12, ledger .      → as Ledger's own command line
//   steps       ledger run|build|test|check       → what F5 and the buttons would run, for the
//                                                    terminal to run itself
//   trusted     before ledger audit fix / update / new change anything
//   trust       ledger trust / untrust
//   audit       ledger audit's findings          → Problems, and marks on the package lines
//   restoreVersion, selfUpdate
//
// Plus command palette entries that type a ledger command into a terminal.
import { invoke } from "@tauri-apps/api/core";
import { on as listen } from "./win.js";

export function initCli(app) {
  const { S, norm, isUnder } = app;
  const reply = (id, ok, value) => invoke("cli_reply", { id, ok, value: value ?? null }).catch(() => {});

  /** Whether a folder is trusted, the way Ledger decides it: inside the open folder, that folder's
   *  answer; elsewhere, only a folder trusted in its own right (no inheriting from folders above),
   *  and null for one Ledger was never asked about. */
  const trustedPath = (p) => {
    const at = norm(p);
    if (S.root && isUnder(at, S.root)) return app.trusted();
    const t = app.prefs.trust || {};
    const key = Object.keys(t).find((k) => k.toLowerCase() === at.toLowerCase());
    return key == null ? null : t[key] === true;
  };

  const handlers = {
    async open({ argv, cwd }) {
      await app.handleArgs({ argv, cwd });
      return true;
    },
    async steps({ action, cwd }) {
      if (!S.root) throw "Open a folder in Ledger first.";
      const dir = norm(cwd);
      if (!isUnder(dir, S.root)) throw `This terminal is in ${dir}, outside the folder open in Ledger (${S.root}).`;
      if (!app.trusted()) throw `${app.base(S.root)} is in restricted mode, so Ledger won't run its code. Trust it first: ledger trust`;
      const P = await app.projectFor(dir + "/.");
      if (!P) throw "No project here (Cargo.toml, .csproj, .sln, package.json, project.godot or a Lust file).";
      const steps = app.taskSteps(action, P);
      if (!steps?.length) {
        if (app.taskKind(P) === "dotnet" && action === "run" && P.sln) throw "This solution has several projects: pick the one Run starts in the Ledger window (C#: set the startup project).";
        throw `${action} isn't available for this project.`;
      }
      if (steps.some((s) => s.godot && !s.program)) throw "Set the Godot program in Settings first.";
      return steps.map((s) => ({ label: s.label, program: s.program, args: s.args, cwd: s.cwd || P.dir, env: s.env || null }));
    },
    trusted({ path }) {
      return trustedPath(path);
    },
    async trust({ path, yes }) {
      if (!S.root) throw "Open a folder in Ledger first.";
      if (!isUnder(norm(path), S.root)) throw `This terminal is in ${norm(path)}, outside the folder open in Ledger (${S.root}).`;
      // Trusting is asked in the window, as everywhere else (anything run in a terminal could
      // send this). Going back to restricted mode needs no asking.
      if (yes && !app.trusted()) {
        const c = await app.choose(`The terminal asks to trust ${app.base(S.root)}, so Ledger runs its code (builds, tests, package managers). Trust it?`, ["Cancel", "Trust it"]);
        if (c !== "Trust it") throw "Not trusted: the question in the Ledger window was answered no.";
      }
      app.setTrust(S.root, !!yes);
      return S.root;
    },
    root() {
      if (!S.root) throw "Open a folder in Ledger first.";
      return S.root;
    },
    audit({ files }) {
      // One problem per advisory on the package's line; files with none are cleared.
      const map = new Map();
      for (const [path, list] of Object.entries(files || {})) {
        map.set(norm(path), list.map((d) => ({
          range: { start: { line: d.line, character: 0 }, end: { line: d.line, character: 400 } },
          severity: d.severity, code: d.code, message: d.message,
        })));
      }
      app.setProblems("audit", map);
      return true;
    },
    async restoreVersion({ path, id }) {
      const p = norm(path);
      const text = (await invoke("history_read", { path: p, id })).replace(/\r\n/g, "\n");
      if (!(await app.openFile(p))) throw "Couldn't open " + p;
      const b = S.bufs.get(p);
      app.dispatchBuf(p, { changes: { from: 0, to: b.state.doc.length, insert: text }, userEvent: "input.restore" });
      app.toast("Restored from the terminal. Save to keep it, or undo (Ctrl Z) to go back.");
      return true;
    },
    async selfUpdate() {
      return (await app.checkUpdate?.()) || "Checking for updates in the Ledger window.";
    },
  };

  listen("cli-request", async (e) => {
    const { id, cmd, args } = e.payload || {};
    const h = handlers[cmd];
    if (!h) { reply(id, false, `This Ledger doesn't know "${cmd}". Update Ledger (ledger self-update).`); return; }
    try { reply(id, true, await h(args || {})); }
    catch (err) { reply(id, false, String(err?.message || err)); }
  });

  // A new folder: the last audit's marks were about the old one.
  app.folderHooks.push(() => app.setProblems("audit", new Map()));

  // ---------- the same commands from the palette ----------
  // --open-folder: the command asks the window which folder is open, whichever folder the terminal
  // is in. (Never the path itself typed into the shell: a folder name with $(…) in it would run.)
  const C = (id, title, line, alias) => app.command(id, title, [], () => { if (!S.root && line !== "ledger help") { app.toast("Open a folder first."); return; } app.runInTerminal?.(line === "ledger help" ? line : line + " --open-folder"); }, alias ? { alias } : undefined);
  C("ledger.audit", "Ledger: audit packages (security and updates)", "ledger audit", "vulnerabilities cve security outdated dependencies npm audit cargo audit");
  C("ledger.auditFix", "Ledger: fix security problems in packages", "ledger audit fix", "vulnerabilities upgrade");
  C("ledger.update", "Ledger: take safe package updates", "ledger update", "outdated upgrade dependencies");
  C("ledger.licenses", "Ledger: licences of every package", "ledger licenses", "license gpl mit");
  C("ledger.doctor", "Ledger: check what's installed (doctor)", "ledger doctor", "tools sdk missing");
  C("ledger.clean", "Ledger: delete build output (clean)", "ledger clean", "target bin obj node_modules disk space");
  C("ledger.todo", "Ledger: list TODO and FIXME notes", "ledger todo", "fixme hack");
  C("ledger.stats", "Ledger: lines of code per language", "ledger stats", "count loc");
  C("ledger.help", "Ledger: terminal commands (ledger help)", "ledger help", "cli terminal");
}
