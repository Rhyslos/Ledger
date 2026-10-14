// Newest-version hints for dependencies in Cargo.toml (crates.io) and .csproj
// files (nuget.org), shown at the end of each dependency line. Click a hint,
// or use "Update dependency to latest" on the line, to change the version.
import { invoke } from "@tauri-apps/api/core";
import { StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";

const cache = new Map(); // "crate:serde" -> Promise<string|null>
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= 6) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

const parse = (v) => {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(v.trim());
  return m ? [+m[1], m[2] == null ? null : +m[2], m[3] == null ? null : +m[3]] : null;
};
const cmp = (a, b) => { for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };
const stable = (v) => !/-/.test(v);

function crateIndexPath(name) {
  const n = name.toLowerCase();
  if (n.length <= 2) return `${n.length}/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}
function latestCrate(name) {
  const key = "crate:" + name.toLowerCase();
  if (!cache.has(key)) cache.set(key, limited(async () => {
    try {
      const text = await invoke("http_get", { url: "https://index.crates.io/" + crateIndexPath(name) });
      let best = null;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.yanked || !stable(j.vers)) continue;
        const p = parse(j.vers);
        if (p && (!best || cmp(p, best.p) > 0)) best = { v: j.vers, p };
      }
      return best?.v || null;
    } catch { cache.delete(key); return null; }
  }));
  return cache.get(key);
}
function latestNuget(id) {
  const key = "nuget:" + id.toLowerCase();
  if (!cache.has(key)) cache.set(key, limited(async () => {
    try {
      const j = JSON.parse(await invoke("http_get", { url: `https://api.nuget.org/v3-flatcontainer/${id.toLowerCase()}/index.json` }));
      const vs = (j.versions || []).filter(stable);
      return vs[vs.length - 1] || null;
    } catch { cache.delete(key); return null; }
  }));
  return cache.get(key);
}

/** Does Cargo's default (caret) requirement `req` accept `latest`? */
function caretOk(req, latest) {
  const r = parse(req.replace(/^\^/, "")), l = parse(latest);
  if (!r || !l) return null;
  if (cmp(l, r) < 0) return true;
  if (r[0] > 0) return l[0] === r[0];
  if (r[1] == null) return l[0] === 0;
  if (r[1] > 0) return l[0] === 0 && l[1] === r[1];
  if (r[2] == null) return l[0] === 0 && l[1] === 0;
  return l[0] === 0 && l[1] === 0 && l[2] === r[2];
}

/** Dependency lines in the file: { line, name, from, to (of the version text), version, source } */
export function findDeps(doc, kind) {
  const out = [];
  if (kind === "cargo") {
    let inDeps = false, table = null;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n), t = line.text;
      const sec = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(t);
      if (sec) {
        const name = sec[1].trim();
        inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(name);
        const tm = /(?:^|\.)(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(name);
        table = tm ? tm[1] : null;
        continue;
      }
      if (table) {
        const m = /^\s*version\s*=\s*"([^"]*)"/.exec(t);
        if (m) { const i = t.indexOf('"', t.indexOf("=")) + 1; out.push({ line: n, name: table, from: line.from + i, to: line.from + i + m[1].length, version: m[1], source: "crate" }); }
        continue;
      }
      if (!inDeps) continue;
      let m = /^\s*([\w-]+)\s*=\s*"([^"]*)"/.exec(t);
      if (m) { const i = t.indexOf('"') + 1; out.push({ line: n, name: m[1], from: line.from + i, to: line.from + i + m[2].length, version: m[2], source: "crate" }); continue; }
      m = /^\s*([\w-]+)\s*=\s*\{(.*)\}/.exec(t);
      if (m) {
        if (/\b(path|git|workspace)\s*=/.test(m[2]) && !/\bversion\s*=/.test(m[2])) continue;
        const pkg = /\bpackage\s*=\s*"([^"]+)"/.exec(m[2]);
        const vm = /\bversion\s*=\s*"([^"]*)"/.exec(t);
        if (!vm) continue;
        const i = vm.index + vm[0].indexOf('"') + 1;
        out.push({ line: n, name: pkg ? pkg[1] : m[1], from: line.from + i, to: line.from + i + vm[1].length, version: vm[1], source: "crate" });
      }
    }
  } else {
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n), t = line.text;
      const m = /<PackageReference\b[^>]*\bInclude\s*=\s*"([^"]+)"[^>]*\bVersion\s*=\s*"([^"]*)"/i.exec(t) || /<PackageVersion\b[^>]*\bInclude\s*=\s*"([^"]+)"[^>]*\bVersion\s*=\s*"([^"]*)"/i.exec(t);
      if (!m) continue;
      const vi = t.search(/\bVersion\s*=\s*"/i);
      const i = t.indexOf('"', vi) + 1;
      out.push({ line: n, name: m[1], from: line.from + i, to: line.from + i + m[2].length, version: m[2], source: "nuget" });
    }
  }
  return out;
}

const setDeps = StateEffect.define();
class DepWidget extends WidgetType {
  constructor(d, latest, onUpdate, path) { super(); this.d = d; this.latest = latest; this.onUpdate = onUpdate; this.path = path; }
  eq(o) { return o.latest === this.latest && o.d.version === this.d.version && o.d.name === this.d.name && o.path === this.path; }
  toDOM() {
    const s = document.createElement("span");
    const { version, source } = this.d;
    let ok;
    if (source === "crate") ok = /^[\^~=<>*]/.test(version) && !/^\^/.test(version) ? null : caretOk(version, this.latest);
    else ok = version === this.latest || (parse(version) && parse(this.latest) && cmp(parse(version), parse(this.latest)) >= 0);
    const old = source === "crate" ? ok === false : !ok;
    s.className = "cm-dep" + (old ? " old" : "");
    s.textContent = ok ? `✓ ${this.latest}` : `latest ${this.latest}`;
    s.title = ok ? `${this.d.name}: your version already allows the newest, ${this.latest}.` : old ? `${this.d.name}: newest is ${this.latest}. Click to use it.` : `${this.d.name}: newest is ${this.latest}.`;
    if (old) s.onmousedown = (e) => { e.preventDefault(); this.onUpdate(this.path, this.d.name, this.d.line); };
    return s;
  }
  ignoreEvent() { return true; }
}
const depField = StateField.define({
  create: () => ({ deco: Decoration.none, list: [] }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setDeps)) return e.value;
    return tr.docChanged ? { deco: v.deco.map(tr.changes), list: v.list.map((d) => ({ ...d, from: tr.changes.mapPos(d.from, -1), to: tr.changes.mapPos(d.to, 1), line: tr.state.doc.lineAt(tr.changes.mapPos(d.from)).number })) } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export function initDeps(app) {
  const { S } = app;
  const kindOf = (path) => (/(^|\/)Cargo\.toml$/i.test(path) ? "cargo" : /\.(csproj|fsproj|props)$/i.test(path) ? "nuget" : null);
  // Where the version is right now (it may have moved since the hint was drawn).
  function update(path, name, line) {
    const b = S.bufs.get(path);
    const list = b?.state.field(depField, false)?.list || [];
    const d = list.find((x) => x.name === name && x.line === line) || list.find((x) => x.name === name);
    if (!d) return;
    app.dispatchBuf(path, { changes: { from: d.from, to: d.to, insert: d.latest } });
    app.toast(`${d.name} set to ${d.latest}. Save to use it.`);
  }
  const timers = new Map();
  function schedule(path, ms = 700) {
    clearTimeout(timers.get(path));
    timers.set(path, setTimeout(() => refresh(path), ms));
  }
  async function refresh(path) {
    const b = S.bufs.get(path), kind = kindOf(path);
    if (!b || !kind) return;
    if (!app.settings.dependencyHints) { app.dispatchBuf(path, { effects: setDeps.of({ deco: Decoration.none, list: [] }) }); return; }
    const doc = b.state.doc;
    const deps = findDeps(doc, kind);
    const latest = await Promise.all(deps.map((d) => (d.source === "crate" ? latestCrate(d.name) : latestNuget(d.name))));
    const cur = S.bufs.get(path);
    if (!cur || cur.state.doc !== doc) return;
    const builder = new RangeSetBuilder();
    const list = [];
    deps.forEach((d, i) => {
      if (!latest[i]) return;
      list.push({ ...d, latest: latest[i] });
      builder.add(doc.line(d.line).to, doc.line(d.line).to, Decoration.widget({ widget: new DepWidget(d, latest[i], update, path), side: 1 }));
    });
    app.dispatchBuf(path, { effects: setDeps.of({ deco: builder.finish(), list }) });
  }
  app.extraExt.push((path) => (kindOf(path) && app.settings.dependencyHints ? depField : []));
  app.activeHooks.push((key) => { if (kindOf(key || "")) schedule(key, 100); });
  app.bufListeners.push((path) => { if (kindOf(path)) schedule(path); });
  app.settingHooks.push((k) => { if (k === "dependencyHints") for (const p of S.bufs.keys()) if (kindOf(p)) schedule(p, 50); });
  app.decorationCopiers.push((path, b) => {
    const v = b.state.field(depField, false);
    if (v) app.panes.find((p) => p.view?.state === b.mirror)?.view.dispatch({ effects: setDeps.of(v) });
  });
  app.command("deps.update", "Update dependency on this line to latest", [], () => {
    const b = S.bufs.get(S.active);
    const v = b && app.view.state.field(depField, false);
    if (!v) { app.toast("Open Cargo.toml or a .csproj file first."); return; }
    const n = app.view.state.doc.lineAt(app.view.state.selection.main.head).number;
    const d = v.list.find((x) => x.line === n);
    if (!d) { app.toast("No dependency with a known newest version on this line."); return; }
    if (d.version === d.latest) { app.toast(`${d.name} is already ${d.latest}.`); return; }
    update(S.active, d.name, d.line);
  });
}
