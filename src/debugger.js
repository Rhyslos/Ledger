// The debugger: breakpoints in the gutter (F9), start with Shift+F9, step with
// F10 / F11 / Shift+F11, continue with F5. Rust uses codelldb; C# and Godot
// use netcoredbg. Variables, watches, the call stack and breakpoints live in
// the Debug side view; program output and an evaluate box in the Debug console.
import { invoke } from "@tauri-apps/api/core";
import { StateField, StateEffect, Facet, RangeSet, Prec } from "@codemirror/state";
import { EditorView, Decoration, gutter, GutterMarker, hoverTooltip } from "@codemirror/view";
import { on } from "./win.js";
import { Dap } from "./dap.js";
import { norm } from "./lsp.js";
import { dotOf } from "./langs.js";
import { followBottom } from "./follow.js";

const isWin = navigator.userAgent.includes("Windows");
const native = (p) => (isWin && /^[A-Za-z]:\//.test(p) ? p.replace(/\//g, "\\") : p);
const fromNative = (p) => { let s = norm(p); if (/^[a-z]:\//.test(s)) s = s[0].toUpperCase() + s.slice(1); return s; };

export function initDebugger(app) {
  const { $, S, esc, settings } = app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- breakpoints ----------
  // model: path -> [{ line (1-based), enabled, verified }]
  const model = new Map();
  const bpKey = () => (S.root ? S.root : "");
  function loadModel() {
    model.clear();
    const saved = app.prefs.breakpoints?.[bpKey()] || {};
    for (const [p, lines] of Object.entries(saved)) model.set(p, lines.map((l) => (typeof l === "number" ? { line: l, enabled: true } : { line: l.line, enabled: l.enabled !== false })));
  }
  function persist() {
    if (!S.root) return;
    app.prefs.breakpoints ||= {};
    const out = {};
    for (const [p, list] of model) if (list.length) out[p] = list.map((b) => (b.enabled ? b.line : { line: b.line, enabled: false }));
    app.prefs.breakpoints[bpKey()] = out;
    for (const k of Object.keys(app.prefs.breakpoints)) if (!app.prefs.recent.includes(k)) delete app.prefs.breakpoints[k];
    app.savePrefs();
  }

  class BpMarker extends GutterMarker {
    constructor(kind) { super(); this.kind = kind; }
    eq(o) { return o.kind === this.kind; }
    toDOM() {
      const s = document.createElement("span");
      if (this.kind === "spacer") { s.className = "cm-bp-space"; s.style.cssText = "display:block;width:9px;height:9px"; return s; }
      if (this.kind === "exec") { s.className = "cm-execArrow"; s.textContent = "➜"; return s; }
      s.className = "cm-bp" + (this.kind === "off" ? " off" : this.kind === "bad" ? " bad" : "");
      s.title = this.kind === "off" ? "Breakpoint (turned off)" : this.kind === "bad" ? "Breakpoint the debugger couldn't place (no code on this line?)" : "Breakpoint";
      return s;
    }
  }
  const M = { on: new BpMarker("on"), off: new BpMarker("off"), bad: new BpMarker("bad"), exec: new BpMarker("exec") };
  const kindOf = (b) => (!b.enabled ? "off" : b.verified === false ? "bad" : "on");
  const bpPath = Facet.define({ combine: (v) => v[0] || "" });
  const setBps = StateEffect.define();
  const build = (doc, list) => RangeSet.of((list || []).filter((b) => b.line <= doc.lines).map((b) => M[kindOf(b)].range(doc.line(b.line).from)), true);
  const bpField = StateField.define({
    create: (st) => build(st.doc, model.get(st.facet(bpPath))),
    update(v, tr) {
      for (const e of tr.effects) if (e.is(setBps)) return build(tr.state.doc, e.value);
      return tr.docChanged ? v.map(tr.changes) : v;
    },
  });
  // The line the program is stopped on.
  const setExec = StateEffect.define();
  const execLine = Decoration.line({ class: "cm-execLine" });
  const execField = StateField.define({
    create: () => null,
    update(v, tr) {
      for (const e of tr.effects) if (e.is(setExec)) return e.value;
      return v && tr.docChanged ? tr.changes.mapPos(v) : v;
    },
    provide: (f) => EditorView.decorations.from(f, (pos) => (pos == null ? Decoration.none : Decoration.set([execLine.range(pos)]))),
  });
  const bpGutter = Prec.high(gutter({
    class: "cm-bpgutter",
    markers: (v) => {
      const pos = v.state.field(execField, false);
      return pos == null ? v.state.field(bpField) : [v.state.field(bpField), RangeSet.of([M.exec.range(pos)])];
    },
    initialSpacer: () => new BpMarker("spacer"),
    domEventHandlers: {
      mousedown(view, line, ev) {
        if (ev.button !== 0) return false;
        toggle(view.state.facet(bpPath), view.state.doc.lineAt(line.from).number);
        return true;
      },
    },
  }));
  function linesFromState(state) {
    const out = [];
    const set = state.field(bpField, false);
    if (!set) return null;
    const old = model.get(state.facet(bpPath)) || [];
    set.between(0, state.doc.length, (from, _to, m) => {
      const line = state.doc.lineAt(from).number;
      if (out.some((b) => b.line === line)) return;
      const prev = old.find((b) => b.line === line);
      out.push({ line, enabled: m.kind !== "off", verified: prev?.verified });
    });
    return out.sort((a, b) => a.line - b.line);
  }
  function setModel(path, list) {
    if (list.length) model.set(path, list); else model.delete(path);
    app.dispatchBuf(path, { effects: setBps.of(list) });
    persist();
    renderView();
  }
  function toggle(path, line) {
    if (!path || !app.isAbs(path)) return;
    const list = [...(model.get(path) || [])];
    const i = list.findIndex((b) => b.line === line);
    if (i >= 0) list.splice(i, 1); else list.push({ line, enabled: true });
    list.sort((a, b) => a.line - b.line);
    setModel(path, list);
    sendBreakpoints(path);
  }
  function toggleAtCursor() {
    if (!S.bufs.has(S.active)) { app.toast("Open a file to set a breakpoint."); return; }
    toggle(S.active, app.view.state.doc.lineAt(app.view.state.selection.main.head).number);
  }
  function setEnabled(path, line, enabled) {
    const list = (model.get(path) || []).map((b) => (b.line === line ? { ...b, enabled } : b));
    setModel(path, list);
    sendBreakpoints(path);
  }
  function removeAll() {
    const paths = [...model.keys()];
    for (const p of paths) setModel(p, []);
    for (const p of paths) sendBreakpoints(p);
  }
  app.bufListeners.push((path, b) => {
    const l = linesFromState(b.state);
    if (!l) return;
    const old = model.get(path) || [];
    if (JSON.stringify(l.map((x) => [x.line, x.enabled])) === JSON.stringify(old.map((x) => [x.line, x.enabled]))) return;
    if (l.length) model.set(path, l); else model.delete(path);
    clearTimeout(app._bpT);
    app._bpT = setTimeout(() => { persist(); renderView(); }, 400);
  });
  app.saveHooks.push((path) => { if (model.has(path)) sendBreakpoints(path); });
  app.extraExt.push((path, b) => (b.virtual || !app.isAbs(path) ? [] : [bpPath.of(path), bpField, execField, bpGutter, hoverEval]));
  app.decorationCopiers.push((path, b) => {
    const v = b.state.field(execField, false);
    if (v != null) app.panes.find((p) => p.view?.state === b.mirror)?.view.dispatch({ effects: setExec.of(v) });
  });
  app.folderHooks.push(() => { loadModel(); renderView(); });
  app.activeHooks.push(() => { if (!ses) setTimeout(renderView, 400); });

  // ---------- adapters ----------
  const adapterKind = (kind) => (kind === "rust" ? "codelldb" : "netcoredbg");
  async function adapterPath(kind) {
    const custom = kind === "rust" ? settings.debugRust : settings.debugCsharp;
    if (custom) return (await invoke("tool_info", { name: custom }).catch(() => null)) || null;
    const dl = await invoke("debugger_path", { kind: adapterKind(kind) }).catch(() => null);
    if (dl) return dl;
    return (await invoke("tool_info", { name: adapterKind(kind) }).catch(() => null)) || null;
  }
  async function install(kind) {
    const name = adapterKind(kind);
    app.toast(`Downloading ${name}…`, 60000);
    const p = await invoke("install_debugger", { kind: name });
    app.toast(`${name} is ready.`);
    return p;
  }
  async function ensureAdapter(kind) {
    let p = await adapterPath(kind);
    if (p) return p;
    const name = adapterKind(kind);
    const custom = kind === "rust" ? settings.debugRust : settings.debugCsharp;
    if (custom) { app.toast(`The debugger set in Settings wasn't found: ${custom}`, 6000); return null; }
    const c = await app.choose(`Debugging ${kind === "rust" ? "Rust" : "C#"} needs ${name}, which isn't installed yet. Download it now? (${kind === "rust" ? "about 40" : "about 10"} MB from GitHub)`, [`Download ${name}`, "Cancel"]);
    if (c !== `Download ${name}`) return null;
    try { p = await install(kind); } catch (e) { app.toast(String(e), 8000); return null; }
    return p;
  }

  // ---------- the session ----------
  let ses = null; // { dap, cfg, state, threadId, frames, frame, scopes, vars: Map, open: Set, exitCode }
  const watches = () => (app.prefs.watches ||= []);
  let dconFollowing = null;
  const dconFollow = () => (dconFollowing ||= followBottom($("dconOut")));
  const dconsole = (html, cls = "") => {
    const out = $("dconOut");
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.innerHTML = html;
    out.append(d);
    while (out.childElementCount > 5000) out.firstElementChild.remove();
    dconFollow().changed();
  };

  // Artifacts (built programs) reported by cargo for each run.
  const artifacts = [];
  on("task-artifact", (e) => { artifacts.push(e.payload); if (artifacts.length > 200) artifacts.shift(); });
  const dllLines = [];
  on("task-line", (e) => {
    if (e.payload.partial) return;
    const m = /^\s*([\w.-]+) -> (.+\.(?:dll|exe))\s*$/i.exec(e.payload.text.replace(/\x1b\[[0-9;]*m/g, ""));
    if (m) { dllLines.push({ run: e.payload.run, name: m[1], path: m[2].trim() }); if (dllLines.length > 200) dllLines.shift(); }
  });
  const buildThen = (steps) => new Promise((resolve) => {
    app.startSteps(steps, () => resolve(app.S.run), () => resolve(null));
  });

  /** Start debugging the project of the open file (Shift+F9). */
  let again = null; // what Restart repeats
  async function start() {
    if (ses) { if (ses.state === "paused") return cont(); app.toast("Already debugging. Shift F5 stops it."); return; }
    again = start;
    if (!S.root) { app.toast("Open a folder first."); return; }
    const P = await app.updateCtx();
    const kind = app.taskKind(P);
    if (!kind) { app.toast("Open a file from the project you want to debug."); return; }
    if (kind === "rust") return debugRust(P, { build: ["build"], pick: (a) => a.kind.includes("bin"), args: [], label: "Debug " + app.base(P.dir) });
    if (kind === "dotnet") return debugDotnet(P);
    if (kind === "godot") return debugGodot(P);
  }
  async function debugRust(P, { build, pick, args, label }) {
    const adapter = await ensureAdapter("rust");
    if (!adapter) return;
    const run = await buildThen([{ label: "cargo " + build.join(" "), program: "cargo", args: build, cwd: P.dir }]);
    if (!run) return;
    const list = artifacts.filter((a) => a.run === run && pick(a));
    let a = list[list.length - 1];
    if (list.length > 1) {
      const i = await app.choose("Which program?", list.map((x) => x.name + (x.test ? " (tests)" : "")), true);
      if (i == null) return;
      a = list[i];
    }
    if (!a) { app.toast("cargo didn't build a program to debug. Is this a library? Debug a test instead (the Debug link above it)."); return; }
    launch({ kind: "rust", adapter, program: a.path, args, cwd: P.dir, label });
  }
  /** A ▶ Run / Debug link from rust-analyzer. */
  async function runnable(r) {
    if (ses) { app.toast("Stop the current debug session first (Shift F5)."); return; }
    again = () => runnable(r);
    const a = r.args, cargoArgs = [...(a.cargoArgs || []), ...(a.cargoExtraArgs || [])];
    const sub = cargoArgs[0];
    const cwd = norm(a.cwd || a.workspaceRoot || app.cwd());
    const rest = cargoArgs.slice(1);
    const want = (flag) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : null; };
    if (sub === "run") {
      const bin = want("--bin");
      return debugRust({ dir: cwd }, { build: ["build", ...rest], pick: (x) => x.kind.includes("bin") && (!bin || x.name === bin), args: a.executableArgs || [], label: "Debug " + (bin || "program") });
    }
    const isLib = rest.includes("--lib"), bin = want("--bin"), test = want("--test");
    return debugRust({ dir: cwd }, {
      build: ["test", ...rest, "--no-run"],
      pick: (x) => x.test && (isLib ? x.kind.some((k) => /lib/.test(k)) : bin ? x.kind.includes("bin") && x.name === bin : test ? x.kind.includes("test") && x.name === test : true),
      args: (a.executableArgs || []).filter((x) => x !== "--show-output" && x !== "--include-ignored").concat(["--nocapture"]),
      label: r.label.replace(/^test(-mod)? /, "Debug "),
    });
  }
  async function dotnetProgram(P) {
    const target = P.sln || P.csproj;
    const run = await buildThen([{ label: "dotnet build", program: "dotnet", args: ["build", ...(target ? [target] : []), "-nologo", "-clp:NoSummary"], cwd: P.dir }]);
    if (!run) return { failed: true };
    const lines = dllLines.filter((l) => l.run === run);
    const want = P.csproj ? app.base(P.csproj).replace(/\.csproj$/i, "") : null;
    const hit = lines.find((l) => l.name === want) || lines[lines.length - 1];
    return { dll: hit ? norm(hit.path) : null };
  }
  async function debugDotnet(P) {
    const adapter = await ensureAdapter("csharp");
    if (!adapter) return;
    const { dll, failed } = await dotnetProgram(P);
    if (failed) return;
    if (!dll) { app.toast("Couldn't find the program dotnet built.", 5000); return; }
    // The .exe next to the .dll starts faster under the debugger on Windows.
    const exe = dll.replace(/\.dll$/i, isWin ? ".exe" : "");
    const hasExe = exe !== dll && (await invoke("resolve_path", { path: exe, cwd: P.dir }).catch(() => null));
    launch({ kind: "csharp", adapter, program: hasExe ? exe : dll, args: [], cwd: P.dir, label: "Debug " + app.base(dll).replace(/\.dll$/i, "") });
  }
  async function debugGodot(P) {
    if (!settings.godot) { app.toast("Set the Godot program in Settings first.", 4000); return; }
    if (!P.dotnet) { app.toast("Ledger debugs Godot's C# scripts. This project has no C# project yet."); return; }
    const adapter = await ensureAdapter("csharp");
    if (!adapter) return;
    const { failed } = await dotnetProgram(P);
    if (failed) return;
    launch({ kind: "csharp", adapter, program: settings.godot, args: ["--path", P.dir], cwd: P.dir, label: "Debug in Godot" });
  }

  async function launch(cfg) {
    const dap = new Dap({ event: (n, b) => onEvent(n, b), exit: (why) => ended(why) });
    ses = { dap, cfg, state: "starting", threadId: null, frames: [], frame: 0, scopes: [], vars: new Map(), open: new Set(), configured: false };
    $("dconOut").innerHTML = "";
    dconFollow().reset();
    dconsole(`<span class="dim">${esc(cfg.label)} · ${esc(app.base(cfg.program))}${cfg.args.length ? " " + esc(cfg.args.join(" ")) : ""}</span>`);
    app.showPanel("dconsole");
    app.showSideView("debug");
    render();
    try {
      await dap.start(cfg.adapter, cfg.kind === "rust" ? [] : ["--interpreter=vscode"], cfg.cwd);
      ses.caps = await dap.request("initialize", {
        clientID: "ledger", clientName: "Ledger", adapterID: cfg.kind === "rust" ? "lldb" : "coreclr", pathFormat: "path",
        linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsRunInTerminalRequest: false, locale: "en",
      }, 20000);
      const args = cfg.kind === "rust"
        ? { type: "lldb", request: "launch", name: cfg.label, program: native(cfg.program), args: cfg.args, cwd: native(cfg.cwd), stopOnEntry: false, terminal: "console", sourceLanguages: ["rust"], _adapterSettings: { consoleMode: "evaluate", displayFormat: "auto", dereferencePointers: true } }
        : { type: "coreclr", request: "launch", name: cfg.label, program: native(cfg.program), args: cfg.args, cwd: native(cfg.cwd), stopAtEntry: false, console: "internalConsole", justMyCode: true };
      const launched = dap.request("launch", args);
      // Adapters ask for breakpoints with the "initialized" event; some send it before
      // launch is answered, some after. Wait for it, but not forever.
      await Promise.race([new Promise((r) => (ses.onInitialized = r)), sleep(5000)]);
      await configure();
      await launched;
      if (ses?.dap === dap && ses.state === "starting") { ses.state = "running"; render(); }
    } catch (e) {
      if (ses?.dap !== dap) return;
      dconsole(esc(String(e.message || e)), "err");
      app.toast("Couldn't start debugging: " + (e.message || e), 7000);
      await stop(true);
    }
  }
  async function configure() {
    if (!ses || ses.configured) return;
    ses.configured = true;
    for (const p of model.keys()) await sendBreakpoints(p);
    try { await ses.dap.request("setExceptionBreakpoints", { filters: [] }); } catch {}
    try { await ses.dap.request("configurationDone", {}); } catch {}
  }
  async function sendBreakpoints(path) {
    if (!ses?.dap.alive || !ses.configured && ses.state !== "starting") return;
    const list = model.get(path) || [];
    const on = list.filter((b) => b.enabled);
    try {
      const r = await ses.dap.request("setBreakpoints", { source: { path: native(path), name: app.base(path) }, breakpoints: on.map((b) => ({ line: b.line })), sourceModified: false });
      (r.breakpoints || []).forEach((rb, i) => { if (on[i]) { on[i].verified = rb.verified !== false; on[i].id = rb.id; } });
      app.dispatchBuf(path, { effects: setBps.of(model.get(path) || []) });
      renderView();
    } catch {}
  }

  function onEvent(name, b) {
    if (!ses) return;
    if (name === "initialized") { ses.onInitialized?.(); configure(); return; }
    if (name === "output") {
      const cat = b.category || "console";
      if (cat === "telemetry") return;
      const text = String(b.output || "");
      dconsole(esc(text.replace(/\n$/, "")), cat === "stderr" ? "err" : cat === "console" || cat === "important" ? "dim" : "");
      return;
    }
    if (name === "stopped") { paused(b); return; }
    if (name === "continued") { resumed(); return; }
    if (name === "exited") { ses.exitCode = b.exitCode; return; }
    if (name === "terminated") { stop(true); return; }
    if (name === "breakpoint" && b.breakpoint) {
      for (const [p, list] of model) for (const bp of list) if (bp.id != null && bp.id === b.breakpoint.id) { bp.verified = b.breakpoint.verified !== false; app.dispatchBuf(p, { effects: setBps.of(list) }); }
      renderView();
    }
  }
  async function paused(b) {
    const s = ses;
    s.state = "paused";
    s.reason = b.reason;
    s.description = b.description || b.text || "";
    s.threadId = b.threadId ?? s.threadId;
    if (s.threadId == null) {
      const t = await s.dap.request("threads").catch(() => ({ threads: [] }));
      s.threadId = t.threads?.[0]?.id ?? 1;
    }
    const st = await s.dap.request("stackTrace", { threadId: s.threadId, startFrame: 0, levels: 60 }).catch(() => ({ stackFrames: [] }));
    if (ses !== s) return;
    s.frames = (st.stackFrames || []).map((f) => ({ ...f, path: f.source?.path ? fromNative(f.source.path) : null }));
    const first = s.frames.findIndex((f) => f.path && app.isUnder(f.path, S.root));
    await selectFrame(first >= 0 ? first : Math.max(0, s.frames.findIndex((f) => f.path)), true);
    getCurrentWindowFocus();
  }
  function getCurrentWindowFocus() { try { window.focus(); } catch {} }
  function clearExec() {
    if (ses?.execPath) app.dispatchBuf(ses.execPath, { effects: setExec.of(null) });
    if (ses) ses.execPath = null;
  }
  function resumed() {
    if (!ses) return;
    clearExec();
    ses.state = "running";
    ses.frames = []; ses.scopes = []; ses.vars.clear();
    render();
  }
  async function selectFrame(i, jump) {
    const s = ses;
    if (!s || !s.frames[i]) { render(); return; }
    s.frame = i;
    const f = s.frames[i];
    clearExec();
    if (f.path) {
      await app.openFile(f.path, { line: Math.max(0, f.line - 1), character: Math.max(0, (f.column || 1) - 1) }, { keepFocus: !jump });
      const b = S.bufs.get(f.path);
      if (b && ses === s) {
        const pos = b.state.doc.line(Math.min(Math.max(1, f.line), b.state.doc.lines)).from;
        app.dispatchBuf(f.path, { effects: setExec.of(pos) });
        s.execPath = f.path;
      }
    }
    s.vars.clear();
    const sc = await s.dap.request("scopes", { frameId: f.id }).catch(() => ({ scopes: [] }));
    if (ses !== s) return;
    s.scopes = sc.scopes || [];
    // Locals open by default; registers and the like stay closed.
    for (const scope of s.scopes.slice(0, 1)) { s.open.add("s:" + scope.name); await loadVars(scope.variablesReference); }
    for (const scope of s.scopes) if (s.open.has("s:" + scope.name)) await loadVars(scope.variablesReference);
    await evalWatches();
    render();
  }
  async function loadVars(ref) {
    if (!ses || !ref || ses.vars.has(ref)) return;
    const r = await ses.dap.request("variables", { variablesReference: ref }).catch(() => ({ variables: [] }));
    ses?.vars.set(ref, r.variables || []);
  }
  async function evalWatches() {
    if (!ses) return;
    const f = ses.frames[ses.frame];
    ses.watch = await Promise.all(watches().map(async (expr) => {
      try { const r = await ses.dap.request("evaluate", { expression: expr, frameId: f?.id, context: "watch" }); return { expr, value: r.result, ref: r.variablesReference, type: r.type }; }
      catch (e) { return { expr, error: String(e.message || e) }; }
    }));
  }

  const can = (state) => ses && ses.state === state;
  const tid = () => ({ threadId: ses.threadId });
  async function cont() { if (!can("paused")) return; resumed(); await ses.dap.request("continue", tid()).catch((e) => app.toast(String(e.message || e))); }
  async function step(kind) {
    if (!can("paused")) { app.toast(ses ? "The program is running. Pause it first, or wait for a breakpoint." : "Not debugging. Shift F9 starts."); return; }
    const t = tid();
    resumed();
    await ses.dap.request(kind, t).catch((e) => app.toast(String(e.message || e)));
  }
  async function pause() { if (!can("running")) return; await ses.dap.request("pause", { threadId: ses.threadId ?? 1 }).catch((e) => app.toast(String(e.message || e))); }
  async function stop(already) {
    const s = ses;
    if (!s) return;
    ses = null;
    if (s.execPath) app.dispatchBuf(s.execPath, { effects: setExec.of(null) });
    if (!already && s.dap.alive) {
      try { await s.dap.request("disconnect", { terminateDebuggee: true, restart: false }, 2500); } catch {}
    }
    await s.dap.stop();
    dconsole(`<span class="dim">Debugging ended${s.exitCode != null ? ` · the program exited with code ${s.exitCode}` : ""}.</span>`);
    render();
  }
  function ended(why) {
    if (!ses) return;
    if (why && ses.state === "starting") dconsole(esc(why), "err");
    stop(true);
  }
  async function restart() {
    const go = again || start;
    if (ses) { await stop(); await sleep(200); }
    go(); // builds again first, so edits are included
  }

  // Hover a name while paused to see its value.
  const hoverEval = hoverTooltip(async (view, pos) => {
    if (!can("paused")) return null;
    const line = view.state.doc.lineAt(pos);
    const t = line.text, c = pos - line.from;
    const re = /[A-Za-z_][\w]*(?:(?:\.|::|->)[A-Za-z_]\w*)*/g;
    let m, expr = null, from = 0, to = 0;
    while ((m = re.exec(t))) {
      if (m.index <= c && c <= m.index + m[0].length) {
        // Up to the part under the mouse: hovering `counts` in self.counts.len shows self.counts.
        const end = m.index + m[0].slice(c - m.index).search(/\.|::|->|$/) + (c - m.index);
        expr = t.slice(m.index, end); from = line.from + m.index; to = line.from + end;
        break;
      }
    }
    if (!expr || /^(fn|let|mut|pub|use|struct|impl|if|else|for|while|loop|match|return|var|new|public|private|static|void|class|using)$/.test(expr)) return null;
    const f = ses.frames[ses.frame];
    try {
      const r = await ses.dap.request("evaluate", { expression: expr, frameId: f?.id, context: "hover" }, 3000);
      const dom = document.createElement("div");
      dom.className = "hv";
      dom.innerHTML = `<pre><b>${esc(expr)}</b> = ${esc(r.result)}${r.type ? `\n<span style="color:var(--faint)">${esc(r.type)}</span>` : ""}</pre>`;
      return { pos: from, end: to, above: true, create: () => ({ dom }) };
    } catch { return null; }
  }, { hoverTime: 300 });

  // ---------- debug console ----------
  $("dconForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const inp = $("dconIn"), expr = inp.value.trim();
    if (!expr) return;
    inp.value = "";
    dconsole(`<span class="ev">› ${esc(expr)}</span>`);
    if (!ses) { dconsole("Not debugging.", "dim"); return; }
    try {
      const r = await ses.dap.request("evaluate", { expression: expr, frameId: ses.frames[ses.frame]?.id, context: "repl" });
      dconsole(esc(r.result));
    } catch (e) { dconsole(esc(String(e.message || e)), "err"); }
  });
  $("dconIn").addEventListener("keydown", (ev) => { if (app.keyString(ev) === "Esc") { ev.preventDefault(); app.focusZone("editor"); } });

  // ---------- the Debug view ----------
  function render() { renderView(); renderStatus(); }
  function renderStatus() {
    const st = $("stDebug");
    $("dbgBadge").hidden = !ses;
    if (!ses) { st.hidden = true; st.innerHTML = ""; return; }
    st.hidden = false;
    const k = (id) => app.keymap.label(id);
    const f = ses.frames[ses.frame];
    const where = ses.state === "paused" && f ? `${f.path ? app.base(f.path) : f.name}:${f.line}` : "";
    const btn = (act, label, id, title) => `<button data-dbg="${act}" title="${esc(title)}${k(id) ? ` (${esc(k(id))})` : ""}">${label}</button>`;
    const had = st.contains(document.activeElement) ? document.activeElement.dataset.dbg : null;
    st.innerHTML = `<span class="state">${ses.state === "paused" ? "● Paused" : ses.state === "starting" ? "● Starting" : "● Debugging"}</span>${where ? `<span class="seg">${esc(where)}</span>` : ""}`
      + (ses.state === "paused" ? btn("continue", "Continue", "debug.continue", "Continue") + btn("over", "Over", "debug.stepOver", "Step over") + btn("into", "Into", "debug.stepInto", "Step into") + btn("out", "Out", "debug.stepOut", "Step out") : btn("pause", "Pause", "debug.pause", "Pause"))
      + btn("stop", "Stop", "debug.stop", "Stop debugging");
    if (had) st.querySelector(`[data-dbg="${had}"]`)?.focus();
  }
  $("stDebug").addEventListener("click", (ev) => { const b = ev.target.closest("[data-dbg]"); if (b) act(b.dataset.dbg); });
  function act(a) {
    ({ continue: cont, over: () => step("next"), into: () => step("stepIn"), out: () => step("stepOut"), pause, stop: () => stop(), restart, start: () => start() })[a]?.();
  }

  const varRow = (v, depth, key, i) => {
    const open = ses.open.has(key);
    const has = v.variablesReference > 0;
    return `<button class="node var" role="treeitem" tabindex="${i === 0 ? 0 : -1}" aria-level="${depth + 1}" ${has ? `aria-expanded="${open}"` : ""} data-vk="${esc(key)}" ${has ? `data-ref="${v.variablesReference}"` : ""} style="padding-left:${6 + depth * 14}px" title="${esc((v.type ? v.type + "\n" : "") + (v.value ?? ""))}"><span class="chev${open ? " open" : ""}" style="${has ? "" : "visibility:hidden"}"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="lbl" style="flex:0 1 auto"><b>${esc(v.name)}</b></span><span class="val">${esc(String(v.value ?? "").replace(/\s+/g, " "))}</span></button>`;
  };
  function varsHtml(ref, depth, prefix, counter) {
    const list = ses.vars.get(ref);
    if (!list) return `<div class="hint" style="padding-left:${26 + depth * 14}px">Loading…</div>`;
    if (!list.length) return `<div class="hint" style="padding-left:${26 + depth * 14}px">Nothing here.</div>`;
    return list.map((v) => {
      const key = prefix + "/" + v.name;
      let h = varRow(v, depth, key, counter.n++);
      if (v.variablesReference > 0 && ses.open.has(key)) h += varsHtml(v.variablesReference, depth + 1, key, counter);
      return h;
    }).join("");
  }
  function renderView() {
    const box = $("debug");
    if (!box || app.sideView !== "debug") return;
    const fk = box.contains(document.activeElement) ? (document.activeElement.dataset.vk || document.activeElement.dataset.fi || document.activeElement.dataset.bpk || document.activeElement.dataset.wi || document.activeElement.id || document.activeElement.dataset.dbg) : null;
    const k = (id) => app.keymap.label(id);
    const kind = app.taskKind();
    const counter = { n: 0 };
    let h = "";
    if (!ses) {
      h += `<div class="dbg-tools"><button class="btn primary" data-dbg="start" id="dbgStart">Start debugging${k("debug.start") ? ` <kbd>${esc(k("debug.start"))}</kbd>` : ""}</button></div>
        <p class="dbg-state">${kind ? `Builds ${esc(app.base(app.S.ctx?.dir || S.root || ""))} and runs it under the ${kind === "rust" ? "Rust (codelldb)" : "C# (netcoredbg)"} debugger${kind === "godot" ? ", inside Godot" : ""}. Set breakpoints with ${esc(k("debug.toggleBreakpoint") || "F9")} or by clicking left of the line numbers.` : "Open a file from a Rust, C# or Godot project to debug it."}</p>`;
    } else {
      const f = ses.frames[ses.frame];
      h += `<div class="dbg-tools">${ses.state === "paused"
        ? `<button class="btn primary" data-dbg="continue">Continue <kbd>${esc(k("debug.continue"))}</kbd></button><button class="btn" data-dbg="over" title="Step over (${esc(k("debug.stepOver"))})">Over</button><button class="btn" data-dbg="into" title="Step into (${esc(k("debug.stepInto"))})">Into</button><button class="btn" data-dbg="out" title="Step out (${esc(k("debug.stepOut"))})">Out</button>`
        : `<button class="btn" data-dbg="pause" title="Pause (${esc(k("debug.pause"))})">Pause</button>`}<button class="btn" data-dbg="restart" title="Restart (${esc(k("debug.restart"))})">Restart</button><button class="btn" data-dbg="stop" title="Stop (${esc(k("debug.stop"))})">Stop</button></div>
        <p class="dbg-state">${ses.state === "paused" ? `Paused${ses.reason ? ` on ${esc(ses.reason)}` : ""}${f ? ` in <b>${esc(f.name)}</b>${f.path ? ` · ${esc(app.base(f.path))}:${f.line}` : ""}` : ""}${ses.description && ses.reason === "exception" ? `<br><span class="e">${esc(ses.description)}</span>` : ""}` : ses.state === "starting" ? "Starting…" : "Running. Breakpoints pause it."}</p>`;
      if (ses.state === "paused") {
        h += `<div class="sec"><h3>Variables</h3><div class="rows" role="tree" id="dbgVars">${ses.scopes.map((sc) => {
          const key = "s:" + sc.name;
          const open = ses.open.has(key);
          return `<button class="node folder" role="treeitem" tabindex="${counter.n++ === 0 ? 0 : -1}" aria-expanded="${open}" data-vk="${esc(key)}" data-ref="${sc.variablesReference}" style="padding-left:6px"><span class="chev${open ? " open" : ""}"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="lbl">${esc(sc.name)}</span></button>` + (open ? varsHtml(sc.variablesReference, 1, key, counter) : "");
        }).join("") || '<p class="hint" style="padding:2px 14px">No variables here.</p>'}</div></div>`;
        h += `<div class="sec"><h3>Watch<span class="sp"></span></h3><div class="rows" role="tree">${(ses.watch || []).map((w, i) => `<button class="node var" role="treeitem" tabindex="-1" data-wi="${i}" style="padding-left:12px" title="${esc(w.error || w.value || "")}"><span class="lbl" style="flex:0 1 auto"><b>${esc(w.expr)}</b></span><span class="val"${w.error ? ' style="color:var(--seal)"' : ""}>${esc(w.error ? "can't evaluate" : String(w.value).replace(/\s+/g, " "))}</span></button>`).join("")}</div>
          <div style="padding:2px 12px 4px"><input id="watchIn" class="kfilter" style="margin:2px 0;width:100%" placeholder="Add an expression to watch, then Enter" spellcheck="false"></div></div>`;
        h += `<div class="sec"><h3>Call stack</h3><div class="rows" role="tree">${ses.frames.map((fr, i) => `<button class="node frame${i === ses.frame ? " cur" : ""}" role="treeitem" tabindex="-1" data-fi="${i}" style="padding-left:12px;--tc:var(--t-${fr.path ? dotOf(fr.path) : "other"})" title="${esc(fr.name)}">${fr.path ? app.fileIcon(fr.path) : '<span class="dot"></span>'}<span class="lbl" style="flex:0 1 auto;${fr.path && app.isUnder(fr.path, S.root) ? "" : "color:var(--faint)"}">${esc(fr.name)}</span><span class="sub">${fr.path ? esc(app.base(fr.path)) + ":" + fr.line : ""}</span></button>`).join("")}</div></div>`;
      }
    }
    const bps = [...model.entries()].flatMap(([p, list]) => list.map((b) => ({ p, ...b }))).sort((a, b) => app.rel(a.p).localeCompare(app.rel(b.p)) || a.line - b.line);
    h += `<div class="sec"><h3>Breakpoints <span>${bps.length || ""}</span><span class="sp"></span>${bps.length ? '<button class="btn plain" data-dbg-rm-all style="padding:0 6px;font-size:11.5px;text-transform:none">Remove all</button>' : ""}</h3><div class="rows" role="tree">${bps.map((b) => `<button class="node bp" role="treeitem" tabindex="-1" data-bpk="${esc(b.p)}|${b.line}" style="padding-left:12px" title="${esc(app.rel(b.p))}:${b.line} · Space turns it on or off, Delete removes it"><span class="cm-bp${!b.enabled ? " off" : b.verified === false ? " bad" : ""}" style="margin:0 8px 0 2px;flex:none"></span><span class="lbl" style="flex:0 1 auto">${esc(app.base(b.p))}</span><span class="sub">line ${b.line}</span></button>`).join("") || `<p class="hint" style="padding:2px 14px">None yet. ${esc(k("debug.toggleBreakpoint") || "F9")} sets one on the cursor's line.</p>`}</div></div>`;
    box.innerHTML = h;
    // Exactly one stop per section for Tab; arrows move inside.
    for (const tree of box.querySelectorAll('[role="tree"]')) { const first = tree.querySelector(".node"); if (first && !tree.querySelector('.node[tabindex="0"]')) first.tabIndex = 0; }
    if (fk) {
      const el = box.querySelector(`[data-vk="${CSS.escape(fk)}"], [data-fi="${CSS.escape(fk)}"], [data-bpk="${CSS.escape(fk)}"], [data-wi="${CSS.escape(fk)}"], #${CSS.escape(fk)}, [data-dbg="${CSS.escape(fk)}"]`);
      if (el) { el.closest('[role="tree"]')?.querySelectorAll(".node").forEach((n) => (n.tabIndex = n === el ? 0 : -1)); el.focus({ preventScroll: true }); }
    }
  }
  async function toggleVar(el, force) {
    const key = el.dataset.vk, ref = +el.dataset.ref;
    if (!ref) return;
    const open = force ?? !ses.open.has(key);
    if (open) { ses.open.add(key); renderView(); await loadVars(ref); }
    else ses.open.delete(key);
    renderView();
  }
  $("debug").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-dbg-rm-all]")) { removeAll(); return; }
    const b = ev.target.closest("[data-dbg]");
    if (b) { act(b.dataset.dbg); return; }
    const v = ev.target.closest("[data-vk]");
    if (v && ses) { toggleVar(v); return; }
    const f = ev.target.closest("[data-fi]");
    if (f && ses) { selectFrame(+f.dataset.fi, true); return; }
    const bp = ev.target.closest("[data-bpk]");
    if (bp) { const [p, l] = splitBp(bp.dataset.bpk); app.openFile(p, { line: l - 1, character: 0 }); }
  });
  const splitBp = (s) => { const i = s.lastIndexOf("|"); return [s.slice(0, i), +s.slice(i + 1)]; };
  $("debug").addEventListener("keydown", async (ev) => {
    const k = app.keyString(ev);
    if (ev.target.id === "watchIn") {
      if (k === "Enter" && ev.target.value.trim()) { ev.preventDefault(); watches().push(ev.target.value.trim()); app.prefs.watchesChanged = true; app.savePrefs(); await evalWatches(); renderView(); $("watchIn")?.focus(); }
      if (k === "Esc") { ev.preventDefault(); app.focusZone("editor"); }
      return;
    }
    const el = ev.target.closest(".node");
    if (!el) { if (k === "Esc") { ev.preventDefault(); app.focusZone("editor"); } return; }
    const tree = el.closest('[role="tree"]');
    const nodes = [...tree.querySelectorAll(".node")], i = nodes.indexOf(el);
    const go = (n) => { if (!n) return; nodes.forEach((x) => (x.tabIndex = x === n ? 0 : -1)); n.focus(); n.scrollIntoView({ block: "nearest" }); };
    let handled = true;
    if (k === "Down") go(nodes[i + 1]);
    else if (k === "Up") go(nodes[i - 1]);
    else if (k === "Home") go(nodes[0]);
    else if (k === "End") go(nodes[nodes.length - 1]);
    else if (k === "Esc") app.focusZone("editor");
    else if (el.dataset.vk) {
      const open = ses?.open.has(el.dataset.vk);
      if (k === "Right") { if (el.dataset.ref && !open) toggleVar(el, true); else go(nodes[i + 1]); }
      else if (k === "Left") {
        if (open) toggleVar(el, false);
        else { const parentKey = el.dataset.vk.slice(0, el.dataset.vk.lastIndexOf("/")); const up = nodes.find((n) => n.dataset.vk === parentKey); if (up) go(up); }
      } else if (k === "Enter" || k === "Space") toggleVar(el);
      else if (k === "Ctrl+C") app.copy(el.title.split("\n").pop());
      else handled = false;
    } else if (el.dataset.fi) {
      if (k === "Enter" || k === "Space") selectFrame(+el.dataset.fi, k === "Enter");
      else handled = false;
    } else if (el.dataset.wi) {
      if (k === "Delete") { watches().splice(+el.dataset.wi, 1); app.prefs.watchesChanged = true; app.savePrefs(); if (ses) await evalWatches(); renderView(); }
      else handled = false;
    } else if (el.dataset.bpk) {
      const [p, l] = splitBp(el.dataset.bpk);
      if (k === "Enter") app.openFile(p, { line: l - 1, character: 0 });
      else if (k === "Space") setEnabled(p, l, !(model.get(p) || []).find((b) => b.line === l)?.enabled);
      else if (k === "Delete") toggle(p, l);
      else handled = false;
    } else handled = false;
    if (handled) { ev.preventDefault(); ev.stopPropagation(); }
  });
  app.sideViews.debug.render = renderView;
  app.sideViews.debug.focus = () => {
    renderView();
    const box = $("debug");
    (box.querySelector('#dbgVars .node[tabindex="0"]') || box.querySelector(".dbg-tools button") || box.querySelector(".node"))?.focus();
  };

  // ---------- keys ----------
  const C = app.command;
  C("debug.start", "Start debugging", "Shift+F9", () => start());
  C("debug.toggleBreakpoint", "Toggle breakpoint", "F9", toggleAtCursor);
  C("debug.continue", "Continue (while paused)", [], cont);
  C("debug.stepOver", "Step over", "F10", () => step("next"));
  C("debug.stepInto", "Step into", "F11", () => step("stepIn"));
  C("debug.stepOut", "Step out", "Shift+F11", () => step("stepOut"));
  C("debug.pause", "Pause", "Pause", pause);
  C("debug.stop", "Stop debugging", [], () => stop());
  C("debug.restart", "Restart debugging", "Ctrl+Shift+F5", restart);
  C("debug.view", "Debug view", "Ctrl+Shift+D", () => app.showSideView("debug", true));
  C("debug.console", "Debug console", [], () => app.focusPanel("dconsole"));
  C("debug.removeBreakpoints", "Remove all breakpoints", [], removeAll);

  loadModel();
  return {
    start, runnable, install, adapterPath, stop,
    get active() { return !!ses; },
    get paused() { return can("paused"); },
    cont,
  };
}
