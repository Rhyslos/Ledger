// Tests panel for Rust, C# and Lust: finds the tests in the folder, runs all of them, one file or
// one test, and shows what passed and failed, with the failure message and where it happened.
// Results also show next to each test in the editor (✓, ✗), and clicking the mark runs that test.
//
//   Rust  #[test] functions; runs cargo test and reads its "test name ... ok" lines and panics.
//   C#    [Fact], [Theory], [Test], [TestCase], [TestMethod]; runs dotnet test with a TRX report.
//   Lust  any .lst or .lsc with a .out or .err next to it (what it should print, or the mistakes
//         it should report); runs lust test.
import { gutter, GutterMarker } from "@codemirror/view";
import { StateField, StateEffect, RangeSet } from "@codemirror/state";
import { on } from "./win.js";

export function initTests(app) {
  const { S, invoke, esc, toast, choose, norm, join, base, parent, isUnder } = app;
  const tests = new Map(); // id -> { id, kind, root, file, line, name, label, status, message, at, ms }
  let running = false, note = "", ran = false, stopped = false;
  let log = []; // the output of the run in progress, newest last (only the tail is kept)
  const el = document.getElementById("tests");

  // ---------- finding tests ----------
  // The nearest folder up with a Cargo.toml (or a .csproj) in it: the crate or project the file is in.
  const rootOf = (path, dirs) => {
    for (let d = parent(path); d && isUnder(d, S.root); d = parent(d)) {
      if (dirs.has(d)) return d;
      if (d === S.root) break;
    }
    return null;
  };

  function rustTests(path, text, root) {
    const r = norm(path).slice(root.length + 1);
    if (!/^(src|tests)\//.test(r) || /^src\/bin\//.test(r)) return [];
    let mods = r.startsWith("src/") ? r.slice(4).replace(/\.rs$/, "").split("/") : [];
    if (["lib", "main"].includes(mods[0]) && mods.length === 1) mods = [];
    if (mods.at(-1) === "mod") mods.pop();
    const out = [], stack = [];
    let depth = 0, pending = false, ignored = false;
    text.split("\n").forEach((raw, i) => {
      const line = raw.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
      const mod = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*\{/.exec(line);
      if (mod) stack.push({ name: mod[1], depth });
      if (/#\[(?:\w+::)*test\b|#\[rstest\b|#\[test_case\b/.test(line)) pending = true;
      if (/#\[ignore\b/.test(line)) ignored = true;
      const fn = pending && /\bfn\s+(\w+)/.exec(line);
      if (fn) {
        const name = [...mods, ...stack.map((s) => s.name), fn[1]].join("::");
        out.push({ name, label: fn[1], line: i, skip: ignored });
        pending = ignored = false;
      }
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; while (stack.length && depth <= stack.at(-1).depth) stack.pop(); }
      }
    });
    return out;
  }

  function csTests(text) {
    const out = [], classes = [];
    let ns = "", depth = 0, pending = false;
    text.split("\n").forEach((raw, i) => {
      const line = raw.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
      const n = /^\s*namespace\s+([\w.]+)/.exec(line);
      if (n) ns = n[1];
      const c = /\b(?:class|record)\s+(\w+)/.exec(line);
      if (c) classes.push({ name: c[1], depth });
      if (/\[\s*(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod)\b/.test(line)) pending = true;
      const m = pending && /\b(?:void|Task|ValueTask)\s+(\w+)\s*\(/.exec(line);
      if (m && classes.length) {
        out.push({ name: [ns, classes.map((k) => k.name).join("+"), m[1]].filter(Boolean).join("."), label: m[1], line: i });
        pending = false;
      }
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; while (classes.length && depth <= classes.at(-1).depth) classes.pop(); }
      }
    });
    return out;
  }

  /** Reads the folder's files for tests. Keeps the results of tests that are still there. */
  async function discover() {
    if (!S.root) return;
    await app.loadFiles();
    const files = S.files || [];
    const old = new Map(tests);
    tests.clear();
    // A known test keeps its last result, unless #[ignore] was added or removed since.
    const add = (t) => {
      const was = old.get(t.id), skip = t.status === "skip";
      const keep = was && (was.status === "skip") === skip;
      tests.set(t.id, keep ? { ...was, ...t, status: was.status, message: was.message, at: was.at, ms: was.ms } : { status: "idle", ...t, ...(skip ? { status: "skip" } : {}) });
    };
    const has = new Set(files.map(norm));
    // Lust: a program with what it should print (.out) or report (.err) next to it.
    for (const f of files) {
      if (!/\.ls[tc]$/i.test(f)) continue;
      const stem = f.replace(/\.ls[tc]$/i, "");
      if (has.has(norm(stem + ".out")) || has.has(norm(stem + ".err"))) add({ id: "lust:" + norm(f), kind: "lust", root: parent(f), file: norm(f), line: 0, name: base(f), label: base(f) });
    }
    const code = files.filter((f) => /\.(rs|cs)$/i.test(f) && !/[\\/](target|bin|obj|node_modules)[\\/]/.test(f));
    const crates = new Set(files.filter((f) => base(f) === "Cargo.toml").map(parent));
    const projects = new Set(files.filter((f) => /\.csproj$/i.test(f)).map(parent));
    for (let i = 0; i < Math.min(code.length, 3000); i += 40) {
      await Promise.all(code.slice(i, i + 40).map(async (f) => {
        const rs = /\.rs$/i.test(f);
        const root = rootOf(f, rs ? crates : projects);
        if (!root) return;
        let text;
        try { text = S.bufs.get(norm(f))?.state.doc.toString() ?? (await invoke("read_file", { path: f })); } catch { return; }
        if (rs ? !/#\[/.test(text) : !/\[\s*(Fact|Theory|Test|TestMethod)/.test(text)) return;
        for (const t of rs ? rustTests(f, text, norm(root)) : csTests(text)) {
          add({ id: (rs ? "rust:" : "cs:") + norm(root) + ":" + t.name, kind: rs ? "rust" : "cs", root: norm(root), file: norm(f), line: t.line, name: t.name, label: t.label, status: t.skip ? "skip" : "idle" });
        }
      }));
    }
    render();
    marksAll();
  }

  // ---------- running ----------
  // Streams each line to "test-out" while it runs, and can be ended with test_stop.
  const capture = async (cwd, program, args) => {
    if (stopped) throw new Error("stopped");
    const r = await invoke("run_test", { cwd, program, args });
    if (stopped) throw new Error("stopped");
    return r;
  };
  let logTimer = 0;
  on("test-out", (e) => {
    if (!running) return;
    log.push(e.payload);
    if (log.length > 300) log = log.slice(-200);
    if (!logTimer) logTimer = setTimeout(() => { logTimer = 0; showLog(); }, 80);
  });
  function showLog() {
    const pre = el?.querySelector(".tlog");
    if (!pre) return;
    const end = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = log.join("\n");
    if (end) pre.scrollTop = pre.scrollHeight;
  }
  function stop() {
    if (!running) return;
    stopped = true;
    invoke("test_stop").catch(() => {});
  }
  const set = (t, status, more = {}) => Object.assign(t, { status, message: "", at: null, ms: null }, more);

  async function runRust(root, list) {
    const all = list.length === [...tests.values()].filter((t) => t.kind === "rust" && t.root === root && t.status !== "skip").length;
    const r = await capture(root, "cargo", ["test", "--no-fail-fast", "--color", "never", ...(all ? [] : ["--", "--exact", ...list.map((t) => t.name)])]);
    const text = (r.out || "") + "\n" + (r.err || "");
    const byName = new Map(list.map((t) => [t.name, t]));
    for (const m of text.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)/gm)) {
      const t = byName.get(m[1]) || [...byName.values()].find((x) => x.name.endsWith("::" + m[1]) || x.label === m[1]);
      if (t) set(t, m[2] === "ok" ? "pass" : m[2] === "ignored" ? "skip" : "fail");
    }
    // ---- name stdout ----, then "panicked at src/lib.rs:12:23:" and the message.
    for (const m of text.matchAll(/^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- |^failures:$)/gm)) {
      const t = byName.get(m[1]) || [...byName.values()].find((x) => x.label === m[1].split("::").pop());
      if (!t) continue;
      const p = /panicked at (.+?):(\d+):(\d+):\n([\s\S]*?)(?:\nstack backtrace:|\nnote: |\n\n|$)/.exec(m[2]);
      t.message = (p ? p[4] : m[2]).trim();
      if (p) {
        // In a workspace the path is from the workspace's folder, not the crate's: use whichever exists.
        const tries = [join(root, p[1]), join(S.root, p[1])].map(norm);
        const file = tries.find((f) => (S.files || []).some((x) => norm(x) === f)) || (S.files || []).map(norm).find((f) => f.endsWith("/" + norm(p[1]))) || tries[0];
        t.at = { file, line: +p[2] - 1 };
      }
    }
    if (!/test result:/.test(text)) note = "The Rust tests didn't build:\n" + (r.err || r.out || "").split("\n").filter((l) => /error|-->|^\s*\|/.test(l)).slice(0, 14).join("\n");
  }

  async function runCs(root, list) {
    const proj = (S.files || []).find((f) => parent(f) === root && /\.csproj$/i.test(f));
    const dir = join(root, "obj/ledger-tests"); // one report, written over each run
    const all = list.length === [...tests.values()].filter((t) => t.kind === "cs" && t.root === root).length;
    const filter = all ? [] : ["--filter", list.map((t) => "FullyQualifiedName=" + t.name).join("|")];
    const r = await capture(root, "dotnet", ["test", proj || root, "--nologo", "--logger", "trx;LogFileName=ledger.trx", "--results-directory", dir, ...filter]);
    let trx = null;
    try {
      const entries = await invoke("list_dir", { path: dir });
      const f = entries.map((e) => e.path).find((p) => /ledger\.trx$/i.test(p));
      if (f) trx = new DOMParser().parseFromString(await invoke("read_file", { path: f }), "application/xml");
    } catch {}
    if (!trx) { note = "The C# tests didn't run:\n" + ((r.out || "") + (r.err || "")).split("\n").filter((l) => /error|failed/i.test(l)).slice(0, 14).join("\n"); return; }
    const defs = new Map();
    for (const u of trx.getElementsByTagName("UnitTest")) {
      const m = u.getElementsByTagName("TestMethod")[0];
      if (m) defs.set(u.getAttribute("id"), m.getAttribute("className") + "." + m.getAttribute("name"));
    }
    const byName = new Map(list.map((t) => [t.name, t]));
    for (const res of trx.getElementsByTagName("UnitTestResult")) {
      const full = defs.get(res.getAttribute("testId")) || res.getAttribute("testName");
      const t = byName.get(full) || byName.get(full.replace(/\(.*$/, ""));
      if (!t) continue;
      const outcome = res.getAttribute("outcome");
      const d = /(\d+):(\d+):([\d.]+)/.exec(res.getAttribute("duration") || "");
      const wasFail = t.status === "fail" && t.ranNow; // a theory's cases: one failing case fails the test
      set(t, outcome === "Passed" ? (wasFail ? "fail" : "pass") : outcome === "Failed" ? "fail" : "skip", { ms: d ? Math.round(((+d[1] * 60 + +d[2]) * 60 + +d[3]) * 1000) : null, ranNow: true });
      const info = res.getElementsByTagName("ErrorInfo")[0];
      if (info) {
        t.message = (info.getElementsByTagName("Message")[0]?.textContent || "").trim();
        const at = /in (.+?\.cs):line (\d+)/.exec(info.getElementsByTagName("StackTrace")[0]?.textContent || "");
        if (at) t.at = { file: norm(at[1]), line: +at[2] - 1 };
      }
    }
    for (const t of list) delete t.ranNow;
  }

  async function runLust(list) {
    const lust = app.settings.lust || "lust";
    const parse = (text, folder) => {
      const byFile = new Map(list.map((t) => [t.file, t]));
      for (const m of text.matchAll(/^  (ok|FAIL)  (.+)\n((?: {8}.*\n?)*)/gm)) {
        const t = byFile.get(norm(join(folder, m[2].trim())));
        if (!t) continue;
        set(t, m[1] === "ok" ? "pass" : "fail", { message: m[3].replace(/^ {8}\| ?/gm, "").replace(/^ {8}/gm, "").trimEnd() });
      }
    };
    if (list.length === 1) {
      const t = list[0], r = await capture(t.root, lust, ["test", t.file]);
      const text = (r.out || "") + (r.err || "");
      if (!/there's no folder called/.test(text)) { parse(text, t.root); return; }
      // An older lust tests folders only: run the test's folder.
      const r2 = await capture(t.root, lust, ["test", t.root]);
      parse((r2.out || "") + (r2.err || ""), t.root);
      return;
    }
    for (const folder of new Set(list.map((t) => t.root))) {
      const r = await capture(folder, lust, ["test", folder]);
      parse((r.out || "") + (r.err || ""), folder);
    }
  }

  async function run(list) {
    if (running) { toast("Tests are already running."); return; }
    if (!list.length) { toast(tests.size ? "No tests to run there." : "No Rust, C# or Lust tests found in this folder."); return; }
    if (!(await app.ensureTrusted("Running tests"))) return;
    running = true; stopped = false; note = ""; ran = true; log = [];
    await app.saveAll();
    for (const t of list) t.status = "running";
    app.showPanel("tests");
    render(); marksAll();
    try {
      const groups = new Map();
      for (const t of list) { const k = t.kind + "|" + (t.kind === "lust" ? "" : t.root); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
      for (const [k, g] of groups) {
        const kind = k.split("|")[0];
        try {
          if (kind === "rust") await runRust(g[0].root, g);
          else if (kind === "cs") await runCs(g[0].root, g);
          else await runLust(g);
        } catch (e) {
          if (stopped) break;
          note = `Couldn't run the ${kind === "cs" ? "C#" : kind === "rust" ? "Rust" : "Lust"} tests: ${e}`;
        }
        if (stopped) break;
      }
    } finally {
      for (const t of list) if (t.status === "running") t.status = "idle";
      if (stopped) note = "Stopped. Tests that hadn't finished are back to not run.";
      running = false; stopped = false;
      render(); marksAll();
    }
  }

  const all = () => [...tests.values()];
  const runAll = async () => { if (!tests.size) await discover(); return run(all().filter((t) => t.status !== "skip")); };
  const runFailed = () => run(all().filter((t) => t.status === "fail"));
  const runFile = async (path = S.active) => { if (!tests.size) await discover(); return run(all().filter((t) => t.file === norm(path || ""))); };

  // ---------- the panel ----------
  const ICON = { pass: "✓", fail: "✗", skip: "⊘", running: "◌", idle: "○" };
  function render() {
    if (!el) return;
    const list = all();
    const n = (s) => list.filter((t) => t.status === s).length;
    const groups = new Map();
    for (const t of list.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      if (!groups.has(t.file)) groups.set(t.file, []);
      groups.get(t.file).push(t);
    }
    el.innerHTML = `<div class="tbar">
        <button class="btn" data-ta="all" ${running ? "disabled" : ""}>Run all</button>
        <button class="btn" data-ta="failed" ${running || !n("fail") ? "disabled" : ""}>Run failed</button>
        <button class="btn" data-ta="file" ${running ? "disabled" : ""}>Run this file</button>
        <button class="btn" data-ta="find" ${running ? "disabled" : ""}>Find tests</button>
        ${running ? `<button class="btn" data-ta="stop" title="End the run and everything it started">Stop</button>` : ""}
        <span class="sp"></span>
        <span class="tsum">${running ? "Running…" : ran ? `<span class="t-pass">${n("pass")} passed</span> · <span class="t-fail">${n("fail")} failed</span>${n("skip") ? ` · ${n("skip")} skipped` : ""}` : `${list.length} test${list.length === 1 ? "" : "s"}`}</span>
      </div>
      ${note ? `<pre class="tnote">${esc(note)}</pre>` : ""}
      ${running ? `<pre class="tlog">${esc(log.join("\n"))}</pre>` : ""}
      ${list.length ? [...groups].map(([file, ts]) => `<div class="tfile" title="${esc(file)}">${app.fileIcon(file)}<span>${esc(app.rel(file))}</span></div>
        ${ts.map((t) => `<div class="trow t-${t.status}" data-tid="${esc(t.id)}" tabindex="-1" title="${esc(t.name)}"><span class="tico">${ICON[t.status]}</span><span class="tname">${esc(t.label)}</span>${t.ms != null ? `<span class="tms">${t.ms} ms</span>` : ""}<button class="ibtn" data-trun="${esc(t.id)}" title="Run this test" aria-label="Run ${esc(t.label)}">▶</button></div>
          ${t.status === "fail" && t.message ? `<pre class="tmsg" data-tid="${esc(t.id)}">${esc(t.message)}${t.at ? `\n<a data-at="${esc(t.id)}">${esc(app.rel(t.at.file))}:${t.at.line + 1}</a>` : ""}</pre>` : ""}`).join("")}`).join("")
        : `<p class="hint" style="padding:10px">No tests found yet. Rust: #[test] functions. C#: [Fact], [Test] or [TestMethod] in a test project. Lust: a program with a .out file next to it (what it should print), or a .err with the mistakes it should report. “Tests: create a test for this file” makes one.</p>`}`;
  }
  el?.addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-ta]")?.dataset.ta;
    if (a === "all") return runAll();
    if (a === "failed") return runFailed();
    if (a === "file") return runFile(S.active);
    if (a === "find") return discover();
    if (a === "stop") return stop();
    const r = ev.target.closest("[data-trun]");
    if (r) return run([tests.get(r.dataset.trun)].filter(Boolean));
    const at = ev.target.closest("[data-at]");
    if (at) { const t = tests.get(at.dataset.at); if (t?.at) app.openFile(t.at.file, { line: t.at.line, character: 0 }); return; }
    const row = ev.target.closest(".trow");
    if (row) { const t = tests.get(row.dataset.tid); if (t) app.openFile(t.file, { line: t.line, character: 0 }); }
  });
  app.panelTabs.tests = {
    btn: "ptTests", els: ["tests"],
    shown: () => { if (!tests.size && S.root) discover(); else render(); },
    focus: () => el?.querySelector(".trow, .btn")?.focus(),
  };

  // ---------- marks next to tests in the editor ----------
  class Mark extends GutterMarker {
    constructor(t) { super(); this.t = t; }
    eq(o) { return o.t.status === this.t.status && o.t.id === this.t.id; }
    toDOM() {
      const s = document.createElement("span");
      s.className = "tmark t-" + this.t.status;
      s.textContent = this.t.status === "idle" ? "▷" : ICON[this.t.status];
      s.title = { pass: "Passed", fail: "Failed: click to run it again", skip: "Skipped", running: "Running", idle: "Run this test" }[this.t.status];
      return s;
    }
  }
  const setMarks = StateEffect.define();
  const marksField = StateField.define({
    create: () => RangeSet.empty,
    update(v, tr) {
      v = v.map(tr.changes);
      for (const e of tr.effects) if (e.is(setMarks)) v = e.value(tr.state);
      return v;
    },
  });
  const build = (path) => (state) => RangeSet.of(all()
    .filter((t) => t.file === path && t.line < state.doc.lines)
    .map((t) => new Mark(t).range(state.doc.line(t.line + 1).from)), true);
  function marksAll() {
    for (const [path] of S.bufs) if (all().some((t) => t.file === path)) app.dispatchBuf(path, { effects: setMarks.of(build(path)) });
  }
  app.extraExt.push((path) => [
    marksField.init((state) => build(norm(path))(state)),
    gutter({
      class: "cm-tests",
      markers: (v) => v.state.field(marksField),
      domEventHandlers: {
        mousedown(v, line) {
          const t = all().find((x) => x.file === norm(path) && x.line < v.state.doc.lines && v.state.doc.line(x.line + 1).from === line.from);
          if (t && !running) { run([t]); return true; }
          return false;
        },
      },
    }),
  ]);
  // Saving a file finds its tests again (new ones, renamed ones, moved lines).
  let findT = null;
  app.saveHooks.push((path) => { if (/\.(rs|cs|lst|lsc|out|err)$/i.test(path) && tests.size) { clearTimeout(findT); findT = setTimeout(discover, 300); } });
  app.folderHooks.push(() => { tests.clear(); ran = false; note = ""; render(); });

  // ---------- making tests ----------
  async function createTest(path = S.active) {
    const b = S.bufs.get(path);
    if (!path || !b) { toast("Open the file you want a test for."); return; }
    if (/\.rs$/i.test(path)) return rustTest(path, b);
    if (/\.cs$/i.test(path)) return csTest(path, b);
    if (/\.ls[tc]$/i.test(path)) return lustTest(path);
    toast("Tests can be made for Rust, C# and Lust files.");
  }
  async function rustTest(path, b) {
    const text = b.state.doc.toString();
    const at = /#\[cfg\(test\)\]\s*\n\s*mod\s+\w+\s*\{/.exec(text);
    if (at) { app.openFile(path, { line: text.slice(0, at.index).split("\n").length, character: 0 }); toast("This file has a tests module already: add #[test] functions to it."); return; }
    const insert = `${text.endsWith("\n") ? "" : "\n"}\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn it_works() {\n        \n    }\n}\n`;
    app.dispatchBuf(path, { changes: { from: text.length, insert } });
    const line = (text + insert).split("\n").length - 4;
    app.openFile(path, { line, character: 8 });
  }
  async function csTest(path, b) {
    const text = b.state.doc.toString();
    const cls = /\b(?:class|record)\s+(\w+)/.exec(text)?.[1] || base(path).replace(/\.cs$/i, "");
    const srcNs = /^\s*namespace\s+([\w.]+)/m.exec(text)?.[1];
    const files = S.files || [];
    // A test project is a .csproj that references a test framework.
    let testProj = null, framework = "xunit";
    for (const f of files.filter((x) => /\.csproj$/i.test(x))) {
      const t = await invoke("read_file", { path: f }).catch(() => "");
      const fw = /xunit/i.test(t) ? "xunit" : /nunit/i.test(t) ? "nunit" : /MSTest/i.test(t) ? "mstest" : null;
      if (fw) { testProj = f; framework = fw; break; }
    }
    const make = async (proj) => {
      const ns = base(proj).replace(/\.csproj$/i, "");
      const file = join(parent(proj), cls + "Tests.cs");
      const using = { xunit: "using Xunit;", nunit: "using NUnit.Framework;", mstest: "using Microsoft.VisualStudio.TestTools.UnitTesting;" }[framework];
      const attrClass = framework === "mstest" ? "[TestClass]\n" : "";
      const attrTest = { xunit: "[Fact]", nunit: "[Test]", mstest: "[TestMethod]" }[framework];
      const body = `${using}\n${srcNs ? `using ${srcNs};\n` : ""}\nnamespace ${ns};\n\n${attrClass}public class ${cls}Tests\n{\n    ${attrTest}\n    public void Works()\n    {\n        \n    }\n}\n`;
      const exists = (await invoke("file_stats", { paths: [file] }).catch(() => [null]))[0] != null;
      if (!exists) await invoke("write_file", { path: file, contents: body });
      await app.refreshTree();
      await app.openFile(file, { line: exists ? 0 : 9, character: 8 });
      if (!exists) discover();
    };
    if (testProj) return make(testProj);
    const proj = files.find((f) => /\.csproj$/i.test(f) && isUnder(path, parent(f)));
    if (!proj) { toast("This file isn't in a C# project."); return; }
    const name = base(proj).replace(/\.csproj$/i, "") + ".Tests";
    const c = await choose(`There's no test project yet. Make ${name}, an xUnit project that can see ${base(proj)}?`, ["Make it", "Cancel"]);
    if (c !== "Make it") return;
    const where = parent(parent(proj)), testDir = join(where, name), testCsproj = join(testDir, name + ".csproj");
    const sln = files.find((f) => /\.slnx?$/i.test(f) && parent(f) === where);
    const steps = [
      { label: "dotnet new xunit", program: "dotnet", args: ["new", "xunit", "-o", name], cwd: where },
      { label: "dotnet add reference", program: "dotnet", args: ["add", testCsproj, "reference", proj], cwd: where },
      ...(sln ? [{ label: "dotnet sln add", program: "dotnet", args: ["sln", sln, "add", testCsproj], cwd: where }] : []),
    ];
    app.startSteps(steps.map((s) => ({ ...s, scaffold: true })), async () => { await app.refreshTree(); await app.loadFiles(true); framework = "xunit"; make(testCsproj); });
  }
  async function lustTest(path) {
    const lust = app.settings.lust || "lust";
    const stem = path.replace(/\.ls[tc]$/i, "");
    const r = await invoke("run_capture", { cwd: parent(path), program: lust, args: ["run", base(path)] }).catch((e) => ({ code: -1, out: "", err: String(e) }));
    if (r.code === -1) { toast("Couldn't run lust: " + r.err, 6000); return; }
    const mistakes = /mistakes?\. Nothing was run\./.test(r.err || r.out);
    let file, contents;
    if (mistakes) {
      const c = await choose("This program has mistakes. Make it a test that expects these mistakes (.err)?", ["Make it", "Cancel"]);
      if (c !== "Make it") return;
      file = stem + ".err";
      contents = (r.err || r.out).split("\n").filter((l) => /^\S+\.ls[tc]:\d+/.test(l)).join("\n") + "\n";
    } else {
      file = stem + ".out";
      contents = (r.out || "").replace(/\r\n/g, "\n").trimEnd() + "\n";
    }
    await invoke("write_file", { path: file, contents });
    await app.refreshTree();
    await app.openFile(file);
    toast(`Made ${base(file)} from what it ${mistakes ? "reported" : "printed"}. Check it's right: lust test compares against it.`, 7000);
    discover();
  }

  app.command("tests.all", "Tests: run all", [], runAll);
  app.command("tests.failed", "Tests: run the failed ones again", [], runFailed);
  app.command("tests.stop", "Tests: stop the run", [], stop);
  app.command("tests.file", "Tests: run the tests in this file", [], () => runFile());
  app.command("tests.create", "Tests: create a test for this file", [], () => createTest());
  app.command("tests.show", "Tests: show the Tests panel", [], () => app.showPanel("tests"));
  return { tests, discover, run, runAll, stop, createTest }; // for scripts that check it
}
