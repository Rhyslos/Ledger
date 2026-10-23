// Merge conflicts and blame, on top of git.js.
//
// Conflicts: in a file with <<<<<<< ======= >>>>>>> markers, each conflict gets a bar above it with
// "Keep yours", "Keep theirs", "Keep both" and "Compare", and the two sides are tinted. Alt F7 and
// Shift Alt F7 go to the next and previous conflict.
//
// Blame: the line the cursor is on shows, faintly at its end, who last changed it and when, with the
// commit's message (Settings › Git, or "Git: blame on/off"). Clicking it shows what that commit
// changed in the file. It follows your unsaved edits: lines you've changed say so.
import { ViewPlugin, Decoration, WidgetType, EditorView } from "@codemirror/view";
import { StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";

// ---------- conflicts ----------
const START = /^<{7}(?: |$)/, BASE = /^\|{7}(?: |$)/, MID = /^={7}$/, END = /^>{7}(?: |$)/;

/** Every conflict in the document: line numbers of the markers and the text of each side. */
export function findConflicts(doc) {
  const out = [];
  if (doc.length > 5_000_000) return out;
  let any = false;
  for (const it = doc.iterLines(); !it.next().done; ) if (it.value.startsWith("<<<<<<<")) { any = true; break; }
  if (!any) return out;
  let cur = null;
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (START.test(text)) cur = { start: n, ours: text.slice(8).trim() };
    else if (cur && BASE.test(text) && !cur.mid) cur.base = n;
    else if (cur && MID.test(text)) cur.mid = n;
    else if (cur && cur.mid && END.test(text)) { cur.end = n; cur.theirs = text.slice(8).trim(); out.push(cur); cur = null; }
  }
  return out;
}
const sideText = (doc, from, to) => (to >= from ? doc.sliceString(doc.line(from).from, doc.line(to).to) + "\n" : "");
/** The text that replaces conflict `c` when keeping `which` (ours, theirs, both). */
export function resolution(doc, c, which) {
  const ours = sideText(doc, c.start + 1, (c.base || c.mid) - 1);
  const theirs = sideText(doc, c.mid + 1, c.end - 1);
  return which === "ours" ? ours : which === "theirs" ? theirs : ours + theirs;
}
function resolve(view, c, which) {
  const doc = view.state.doc, from = doc.line(c.start).from;
  const endLine = doc.line(c.end);
  const to = endLine.to < doc.length ? endLine.to + 1 : endLine.to;
  let insert = resolution(doc, c, which);
  if (to === doc.length && !doc.sliceString(endLine.to, to)) insert = insert.replace(/\n$/, "");
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from }, userEvent: "input.conflict" });
  view.focus();
}

class ConflictBar extends WidgetType {
  constructor(c, onCompare) { super(); this.c = c; this.onCompare = onCompare; }
  eq(o) { return o.c.start === this.c.start && o.c.end === this.c.end && o.c.ours === this.c.ours && o.c.theirs === this.c.theirs; }
  toDOM(view) {
    const d = document.createElement("div");
    d.className = "cm-conflict-bar";
    const label = (s, fallback) => (s && s !== "HEAD" ? s : fallback);
    // Built with the DOM: the branch names come from the file, so they never go through innerHTML.
    const what = document.createElement("span");
    what.className = "cm-conflict-what";
    what.textContent = "Conflict";
    d.append(what);
    for (const [k, text, title] of [
      ["ours", "Keep yours", `Keep the lines from ${label(this.c.ours, "your branch")}`],
      ["theirs", "Keep theirs", `Keep the lines from ${label(this.c.theirs, "the other branch")}`],
      ["both", "Keep both", "Keep both, yours first"],
      ["compare", "Compare", "See the two sides next to each other"],
    ]) {
      const b = document.createElement("button");
      b.dataset.k = k;
      b.textContent = text;
      b.title = title;
      d.append(b);
    }
    d.addEventListener("mousedown", (e) => {
      const k = e.target.closest("button")?.dataset.k;
      if (!k) return;
      e.preventDefault();
      const now = findConflicts(view.state.doc).find((x) => x.start === view.state.doc.lineAt(view.posAtDOM(d)).number) || this.c;
      if (k === "compare") this.onCompare(view, now); else resolve(view, now, k);
    });
    return d;
  }
  ignoreEvent() { return true; }
}
const conflictLine = {
  marker: Decoration.line({ class: "cm-conflict-marker" }),
  ours: Decoration.line({ class: "cm-conflict-ours" }),
  theirs: Decoration.line({ class: "cm-conflict-theirs" }),
  base: Decoration.line({ class: "cm-conflict-base" }),
};
function conflictDecos(state, onCompare) {
  const doc = state.doc;
  const list = findConflicts(doc);
  if (!list.length) return Decoration.none;
  const b = new RangeSetBuilder();
  for (const c of list) {
    b.add(doc.line(c.start).from, doc.line(c.start).from, Decoration.widget({ widget: new ConflictBar(c, onCompare), side: -1, block: true }));
    for (let n = c.start; n <= c.end; n++) {
      const kind = n === c.start || n === c.mid || n === c.end || n === c.base ? "marker" : n < (c.base || c.mid) ? "ours" : n < c.mid ? "base" : "theirs";
      b.add(doc.line(n).from, doc.line(n).from, conflictLine[kind]);
    }
  }
  return b.finish();
}
// Block widgets have to come from a state field, not a view plugin.
const conflictField = (onCompare) => StateField.define({
  create: (st) => conflictDecos(st, onCompare),
  update(v, tr) {
    if (!tr.docChanged) return v;
    // Most files have no conflicts: only look again when the file has some, or the edit
    // touched a line that looks like a marker (a paste, a merge reloading the file).
    if (v.size) return conflictDecos(tr.state, onCompare);
    let marker = false;
    tr.changes.iterChangedRanges((fa, ta, fb, tb) => {
      if (marker) return;
      const doc = tr.state.doc, last = doc.lineAt(Math.min(tb, doc.length)).number;
      for (let n = doc.lineAt(fb).number; n <= last && n - doc.lineAt(fb).number < 50000; n++) if (/^(<{7}|>{7}|={7})/.test(doc.line(n).text)) { marker = true; return; }
    });
    return marker ? conflictDecos(tr.state, onCompare) : v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- blame ----------
const setBlame = StateEffect.define();
const blameField = StateField.define({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return e.value;
    return tr.docChanged ? null : v; // stale until it's asked again
  },
});
export function parseBlame(out) {
  const commits = new Map(), lines = [];
  const rows = out.split("\n");
  let cur = null;
  for (const row of rows) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(row);
    if (h) {
      cur = commits.get(h[1]) || { sha: h[1] };
      commits.set(h[1], cur);
      lines[+h[2]] = cur;
      continue;
    }
    if (!cur || row.startsWith("\t")) continue;
    const sp = row.indexOf(" ");
    const k = sp < 0 ? row : row.slice(0, sp), v = sp < 0 ? "" : row.slice(sp + 1);
    if (k === "author") cur.author = v;
    else if (k === "author-time") cur.time = +v * 1000;
    else if (k === "summary") cur.summary = v;
    else if (k === "author-mail") cur.mail = v;
  }
  return lines;
}
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  const u = [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [n, w] of u) if (s >= n) { const k = Math.floor(s / n); return `${k} ${w}${k === 1 ? "" : "s"} ago`; }
  return "just now";
}
class BlameNote extends WidgetType {
  constructor(info, onClick) { super(); this.info = info; this.onClick = onClick; }
  eq(o) { return o.info === this.info; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-blame";
    const i = this.info;
    const none = /^0+$/.test(i.sha);
    s.textContent = none ? "You · not committed yet" : `${i.author || "?"}, ${ago(i.time)} · ${i.summary || ""}`;
    s.title = none ? "This line has changed since the last commit." : `${i.sha.slice(0, 8)} · ${i.author} ${i.mail || ""}\n${new Date(i.time).toLocaleString()}\n\n${i.summary || ""}\n\nClick to see what this commit changed in the file.`;
    if (!none) s.addEventListener("mousedown", (e) => { e.preventDefault(); this.onClick(i); });
    return s;
  }
  ignoreEvent() { return true; }
}
const blamePlugin = (onClick) => ViewPlugin.fromClass(class {
  constructor(v) { this.decorations = this.build(v); }
  update(u) { if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(setBlame)))) this.decorations = this.build(u.view); }
  build(v) {
    const data = v.state.field(blameField, false);
    if (!data || v.state.selection.ranges.length > 1) return Decoration.none;
    const line = v.state.doc.lineAt(v.state.selection.main.head);
    const info = data[line.number];
    if (!info) return Decoration.none;
    return Decoration.set([Decoration.widget({ widget: new BlameNote(info, onClick), side: 1 }).range(line.to)]);
  }
}, { decorations: (v) => v.decorations });

export function initGitMore(app, gitApi) {
  const { S, settings, invoke } = app;
  const { G, relTo } = gitApi;

  // ----- conflicts -----
  function compare(view, c) {
    const path = S.active, doc = view.state.doc;
    app.openDiff?.({
      path, title: app.base(path) + " · conflict",
      left: resolution(doc, c, "ours"), right: resolution(doc, c, "theirs"),
      leftLabel: c.ours && c.ours !== "HEAD" ? c.ours : "Yours", rightLabel: c.theirs || "Theirs",
    });
  }
  const field = conflictField(compare);
  app.extraExt.push(() => field);
  function jump(dir) {
    const v = app.view;
    if (!v || !S.bufs.has(S.active)) return;
    const list = findConflicts(v.state.doc);
    if (!list.length) { app.toast("No conflicts in this file."); return; }
    const cur = v.state.doc.lineAt(v.state.selection.main.head).number;
    const c = dir > 0 ? list.find((x) => x.start > cur) || list[0] : [...list].reverse().find((x) => x.start < cur) || list[list.length - 1];
    const pos = v.state.doc.line(c.start).from;
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    v.focus();
  }
  function atCursor(which) {
    const v = app.view;
    if (!v) return;
    const n = v.state.doc.lineAt(v.state.selection.main.head).number;
    const c = findConflicts(v.state.doc).find((x) => n >= x.start && n <= x.end);
    if (!c) { app.toast("The cursor isn't in a conflict."); return; }
    resolve(v, c, which);
  }
  app.saveHooks.push((path, b) => {
    const st = G.files.get(path);
    if (st?.conflict && !findConflicts(b.state.doc).length) app.toast(`No conflicts left in ${app.base(path)}. Stage it in Source control to mark it resolved.`, 6000);
  });
  app.command("conflict.next", "Merge conflict: next", ["Alt+F7"], () => jump(1));
  app.command("conflict.prev", "Merge conflict: previous", ["Shift+Alt+F7"], () => jump(-1));
  app.command("conflict.ours", "Merge conflict: keep yours", [], () => atCursor("ours"));
  app.command("conflict.theirs", "Merge conflict: keep theirs", [], () => atCursor("theirs"));
  app.command("conflict.both", "Merge conflict: keep both", [], () => atCursor("both"));

  // ----- blame -----
  const pending = new Map(); // path -> timer
  const asked = new Map(); // path -> doc it was asked for
  const running = new Map(); // path -> true while git blame runs; "again" if asked meanwhile
  async function blame(path) {
    if (running.has(path)) { running.set(path, "again"); return; }
    running.set(path, true);
    try { await blameNow(path); }
    finally { const again = running.get(path) === "again"; running.delete(path); if (again) soon(path, 300); }
  }
  async function blameNow(path) {
    const b = S.bufs.get(path);
    if (!b || b.virtual || !G.ok || !settings.gitBlame || !path.toLowerCase().startsWith((G.root || "\0").toLowerCase() + "/")) return;
    const st = G.files.get(path);
    if (st && (st.x === "?" || st.x === "A")) return; // not in any commit yet
    const doc = b.state.doc;
    if (asked.get(path) === doc || doc.length > 2_000_000) return;
    asked.set(path, doc);
    const r = await invoke("run_capture", { cwd: G.root, program: "git", args: ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "blame", "--porcelain", "--contents", "-", "--", relTo(path)], input: (b.bom ? "\uFEFF" : "") + (b.eol === "\r\n" ? doc.toString().replace(/\n/g, "\r\n") : doc.toString()) }).catch(() => null);
    const now = S.bufs.get(path);
    if (!r || r.code !== 0 || !now || now.state.doc !== doc) return;
    app.dispatchBuf(path, { effects: setBlame.of(parseBlame(r.out)) });
  }
  const soon = (path, ms) => { clearTimeout(pending.get(path)); pending.set(path, setTimeout(() => blame(path), ms)); };
  async function showCommit(info) {
    const path = S.active, rel = relTo(path);
    const get = async (rev) => { const r = await gitApi.git(["show", `${rev}:${rel}`]).catch(() => null); return r?.code === 0 ? r.out.replace(/\r\n/g, "\n") : ""; };
    const [before, after] = await Promise.all([get(info.sha + "^"), get(info.sha)]);
    app.openDiff?.({ path, title: `${app.base(path)} · ${info.sha.slice(0, 7)}`, left: before, right: after, leftLabel: "Before " + info.sha.slice(0, 7), rightLabel: `${info.sha.slice(0, 7)} · ${info.summary || ""}` });
  }
  const plugin = blamePlugin(showCommit);
  app.extraExt.push((path, b) => (settings.gitBlame && !b.virtual ? [blameField, plugin] : []));
  app.bufListeners.push((path) => soon(path, 1200));
  app.activeHooks.push((key) => { if (S.bufs.has(key)) soon(key, 200); });
  app.saveHooks.push((path) => soon(path, 600));
  app.settingHooks.push((k) => { if (k === "gitBlame") { asked.clear(); for (const p of S.bufs.keys()) soon(p, 50); } });
  app.decorationCopiers.push((path, b) => {
    const v = b.state.field(blameField, false);
    if (v) app.panes.find((p) => p.view?.state === b.mirror)?.view.dispatch({ effects: setBlame.of(v) });
  });
  app.command("git.blame", "Git: blame on/off (who last changed the line, at its end)", [], () => {
    app.setSetting("gitBlame", !settings.gitBlame);
    app.toast(settings.gitBlame ? "Blame on: the cursor's line shows who last changed it." : "Blame off.");
  });
}
