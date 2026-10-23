// Git: file status in the explorer, change bars next to the line numbers,
// a side-by-side diff page, and the Source control view (stage, commit, pull,
// push). Everything runs the real git program in the open folder.
import { EditorState, StateField, StateEffect, RangeSet, Text, Facet } from "@codemirror/state";
import { EditorView, gutter, GutterMarker, keymap, lineNumbers, highlightSpecialChars, drawSelection } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { MergeView, Chunk, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { langOf, dotOf, LANGS } from "./langs.js";

export function initGit(app) {
  const { $, S, esc, invoke } = app;
  const G = { root: null, ok: null, branch: "", oid: "", upstream: "", ahead: 0, behind: 0, files: new Map(), busy: "", missing: false, stashes: [], merging: false };
  const headCache = new Map(); // path -> Promise<string|null>

  const git = (args, cwd = G.root) => invoke("git", { cwd, args });
  const relTo = (p) => (G.root && p.toLowerCase().startsWith(G.root.toLowerCase() + "/") ? p.slice(G.root.length + 1) : p);

  // ---------- status ----------
  let statusJob = null;
  async function refresh() {
    if (statusJob) return statusJob;
    statusJob = (async () => {
      const root = S.root;
      if (!root) { Object.assign(G, { root: null, ok: null, files: new Map() }); render(); return; }
      if (G.forRoot !== root) {
        G.forRoot = root;
        headCache.clear();
        let r;
        G.blocked = "";
        try { r = await git(["rev-parse", "--show-toplevel"], root); }
        catch (e) {
          // Restricted mode: this repository's own settings would make git run programs.
          if (app.isUntrustedError?.(e)) { G.blocked = String(e).replace(/^untrusted:[^.]*\.\s*/, ""); G.forRoot = null; G.ok = false; G.root = null; render(); return; }
          G.missing = true; G.ok = false; G.root = null; render(); return;
        }
        G.missing = false;
        G.ok = r.code === 0;
        G.root = G.ok ? app.norm(r.out.trim()) : null;
        if (G.root && /^[a-z]:\//.test(G.root)) G.root = G.root[0].toUpperCase() + G.root.slice(1);
      }
      if (!G.ok) { G.files = new Map(); render(); return; }
      const r = await git(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]).catch(() => null);
      if (!r || r.code !== 0) { render(); return; }
      const files = new Map();
      const parts = r.out.split("\0");
      let oid = "";
      Object.assign(G, { branch: "", upstream: "", ahead: 0, behind: 0 });
      for (let i = 0; i < parts.length; i++) {
        const e = parts[i];
        if (!e) continue;
        if (e.startsWith("# branch.oid ")) oid = e.slice(13);
        else if (e.startsWith("# branch.head ")) G.branch = e.slice(14);
        else if (e.startsWith("# branch.upstream ")) G.upstream = e.slice(18);
        else if (e.startsWith("# branch.ab ")) { const m = /\+(\d+) -(\d+)/.exec(e); if (m) { G.ahead = +m[1]; G.behind = +m[2]; } }
        else if (e[0] === "1" || e[0] === "2" || e[0] === "u") {
          const f = e.split(" ");
          const xy = f[1];
          const path = f.slice(e[0] === "1" ? 8 : e[0] === "2" ? 9 : 10).join(" ");
          const orig = e[0] === "2" ? parts[++i] : null;
          files.set(G.root + "/" + path, { x: xy[0], y: xy[1], orig, conflict: e[0] === "u" });
        } else if (e[0] === "?") files.set(G.root + "/" + e.slice(2), { x: "?", y: "?" });
      }
      if (oid !== G.oid) { G.oid = oid; headCache.clear(); }
      G.files = files;
      // Folders holding a change, worked out once here rather than for every folder drawn.
      G.dirs = new Set();
      for (const k of files.keys()) for (let i = k.lastIndexOf("/"); i > 0; i = k.lastIndexOf("/", i - 1)) { const d = k.slice(0, i).toLowerCase(); if (G.dirs.has(d)) break; G.dirs.add(d); }
      liveDiffs();
      // Stashes, and whether a merge is waiting to be finished.
      const [sl, mh] = await Promise.all([
        git(["stash", "list", "--format=%gd%x1f%s%x1f%cr"]).catch(() => null),
        git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(() => null),
      ]);
      G.stashes = (sl?.code === 0 ? sl.out.split("\n").filter(Boolean) : []).map((l) => { const [ref, msg, when] = l.split("\x1f"); return { ref, msg, when }; });
      G.merging = mh?.code === 0;
      // Conflicted files, and whether each still has markers in it (open ones as they are now).
      G.conflicts = [];
      for (const [p, st] of files) if (st.conflict) G.conflicts.push({ path: p, left: await hasMarkers(p) });
      if (G.merging && !G.mergeMsgFor) {
        G.mergeMsgFor = oid;
        const r2 = await git(["rev-parse", "--git-path", "MERGE_MSG"]).catch(() => null);
        const f = r2?.code === 0 ? r2.out.trim() : "";
        const text = f ? await invoke("read_file", { path: /^([a-z]:)?[\\/]/i.test(f) ? f : G.root + "/" + f }).catch(() => "") : "";
        const msg = text.split(/\r?\n/).filter((l) => !l.startsWith("#")).join("\n").trim();
        if (msg && !G.draft && !$("commitMsg")?.value) G.draft = msg;
      }
      if (!G.merging) G.mergeMsgFor = null;
      render();
      for (const p of S.bufs.keys()) scheduleBars(p, 10);
    })().finally(() => { statusJob = null; });
    return statusJob;
  }
  /** One letter for a file: M modified, A added, D deleted, R renamed, U untracked, ! conflict. */
  function letter(st) {
    if (!st) return "";
    if (st.conflict) return "!";
    if (st.x === "?") return "U";
    const c = st.y !== "." ? st.y : st.x;
    return c === "." ? "" : c === "T" ? "M" : c;
  }
  const staged = (st) => st && !st.conflict && st.x !== "?" && st.x !== ".";
  const unstaged = (st) => st && (st.conflict || st.x === "?" || st.y !== ".");

  // Explorer colours and letters.
  app.treeDecor = (path, isDir) => {
    if (!G.ok || !G.files.size) return null;
    if (isDir) return G.dirs?.has(path.toLowerCase()) ? { cls: "g-dir", badge: "" } : null;
    const st = G.files.get(path);
    const l = letter(st);
    return l ? { cls: "g-" + (l === "!" ? "X" : l), badge: `<span class="gs ${l === "!" ? "X" : l}" title="${esc(describe(st))}">${l}</span>` } : null;
  };
  function describe(st) {
    if (!st) return "";
    if (st.conflict) return "Merge conflict: open it and pick a side above each conflict";
    if (st.x === "?") return "New, not in Git yet";
    const w = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed" };
    const parts = [];
    if (st.x !== ".") parts.push((w[st.x] || st.x) + ", staged");
    if (st.y !== ".") parts.push(w[st.y] || st.y);
    return parts.join(" · ");
  }

  async function hasMarkers(path) {
    // What's on disk is what a commit takes; an open file with unsaved edits counts as it is now.
    const b = S.bufs.get(path);
    const text = b?.dirty ? b.state.doc.toString() : await invoke("read_file", { path }).catch(() => "");
    return /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
  }

  // ---------- what a file looked like in the last commit ----------
  function headText(path) {
    if (!headCache.has(path)) {
      headCache.set(path, (async () => {
        if (!G.ok || !path.toLowerCase().startsWith(G.root.toLowerCase() + "/")) return undefined;
        const st = G.files.get(path);
        if (st && (st.x === "?" || st.x === "A")) return ""; // new file: every line is added
        const r = await git(["show", "HEAD:" + relTo(path)]).catch(() => null);
        if (!r) return undefined;
        if (r.code !== 0) return /does not exist|exists on disk, but not in|bad revision|unknown revision|invalid object/i.test(r.err) ? "" : undefined;
        return r.out.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
      })());
    }
    return headCache.get(path);
  }

  // ---------- change bars in the gutter ----------
  const setBars = StateEffect.define();
  class Bar extends GutterMarker {
    constructor(kind) { super(); this.kind = kind; }
    eq(o) { return o.kind === this.kind; }
    toDOM() { const s = document.createElement("span"); s.className = "cm-git-" + this.kind; s.title = { add: "Added since the last commit", mod: "Changed since the last commit", del: "Lines removed here" }[this.kind]; return s; }
  }
  const BARS = { add: new Bar("add"), mod: new Bar("mod"), del: new Bar("del") };
  const barField = StateField.define({
    create: () => ({ set: RangeSet.empty, chunks: [] }),
    update(v, tr) {
      for (const e of tr.effects) if (e.is(setBars)) return e.value;
      return tr.docChanged ? { set: v.set.map(tr.changes), chunks: v.chunks.map((c) => ({ ...c, from: tr.changes.mapPos(c.from), to: tr.changes.mapPos(c.to) })) } : v;
    },
  });
  const gitPath = Facet.define({ combine: (v) => v[0] || "" });
  const barGutter = [barField, gutter({
    class: "cm-gitgutter",
    markers: (v) => v.state.field(barField).set,
    domEventHandlers: {
      mousedown(view, line) {
        const path = view.state.facet(gitPath);
        if (!view.state.field(barField).chunks.some((c) => line.from >= c.from && line.from <= c.to)) return false;
        showDiff(path, view.state.doc.lineAt(line.from).number);
        return true;
      },
    },
  })];
  // Ticks on the overview ruler (marks.js) for each change.
  app.scrollMarks.push((st) => (st.field(barField, false)?.chunks || []).map((c) => ({ pos: c.from, kind: c.kind })));
  const barTimers = new Map();
  function scheduleBars(path, ms = 350) {
    clearTimeout(barTimers.get(path));
    barTimers.set(path, setTimeout(() => updateBars(path), ms));
  }
  async function updateBars(path) {
    const b = S.bufs.get(path);
    if (!b || b.virtual || !app.settings.gitGutter) return;
    const head = await headText(path);
    const cur = S.bufs.get(path);
    if (!cur) return;
    const doc = cur.state.doc;
    if (head === undefined) { app.dispatchBuf(path, { effects: setBars.of({ set: RangeSet.empty, chunks: [] }) }); return; }
    const chunks = doc.length > 2_000_000 ? [] : Chunk.build(Text.of(head.split("\n")), doc, { scanLimit: 2000, timeout: 200 });
    const marks = [], list = [];
    for (const c of chunks) {
      if (c.fromB === c.toB) {
        const at = Math.min(c.fromB, doc.length);
        marks.push(BARS.del.range(doc.lineAt(at).from));
        list.push({ from: doc.lineAt(at).from, to: doc.lineAt(at).from, a: [c.fromA, c.toA], kind: "del" });
        continue;
      }
      const kind = c.fromA === c.toA ? "add" : "mod";
      const end = Math.min(c.endB, doc.length);
      for (let pos = c.fromB; pos <= end;) {
        const line = doc.lineAt(pos);
        marks.push(BARS[kind].range(line.from));
        pos = line.to + 1;
      }
      list.push({ from: c.fromB, to: end, a: [c.fromA, c.toA], kind });
    }
    app.dispatchBuf(path, { effects: setBars.of({ set: RangeSet.of(marks, true), chunks: list, head }) });
  }
  function jumpChange(dir) {
    if (S.active?.startsWith("@diff:") && mv) { (dir > 0 ? goToNextChunk : goToPreviousChunk)(mv.b); mv.b.focus(); return; }
    const v = app.view, b = S.bufs.get(S.active);
    if (!b) return;
    const st = v.state.field(barField, false);
    if (!st?.chunks.length) { app.toast(G.ok ? "No changes since the last commit in this file." : "This folder isn't a Git repository."); return; }
    const line = v.state.doc.lineAt(v.state.selection.main.head);
    const list = st.chunks;
    const target = dir > 0 ? list.find((c) => c.from > line.to) || list[0] : [...list].reverse().find((c) => c.to < line.from) || list[list.length - 1];
    v.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
  }
  async function revertChange() {
    const v = app.view, path = S.active, b = S.bufs.get(path);
    if (!b || b.ro) return;
    const st = v.state.field(barField, false);
    const line = v.state.doc.lineAt(v.state.selection.main.head);
    const c = st?.chunks.find((x) => line.from >= x.from && line.from <= Math.max(x.to, x.from));
    if (!c || st.head == null) { app.toast("No change at the cursor."); return; }
    const old = st.head.slice(c.a[0], c.a[1]);
    let from = c.from, to = c.kind === "del" ? c.from : Math.min(v.state.doc.length, v.state.doc.lineAt(c.to).to + 1);
    let insert = old;
    if (to > v.state.doc.length) to = v.state.doc.length;
    if (c.kind !== "del" && to === v.state.doc.length && !old.endsWith("\n") && v.state.doc.sliceString(from, to).endsWith("\n") === false) insert = old.replace(/\n$/, "");
    app.dispatchBuf(path, { changes: { from, to, insert } });
    app.toast("Change undone. Save to keep it.");
  }

  // ---------- diff page ----------
  const diffs = new Map(); // "@diff:n" -> { title, left, right, leftLabel, rightLabel, path, line }
  let diffSeq = 0, mv = null, mvKey = null;
  function openDiff(d) {
    const existing = [...diffs.entries()].find(([, x]) => x.path === d.path && x.leftLabel === d.leftLabel && x.rightLabel === d.rightLabel);
    const key = existing ? existing[0] : "@diff:" + ++diffSeq;
    diffs.set(key, d);
    if (mvKey === key) mvKey = null; // redraw with the new text
    app.addTab(key, { preview: true });
    app.activate(key);
  }
  async function showDiff(path = S.active, line) {
    const b = S.bufs.get(path);
    if (!b) return;
    if (!G.ok) { app.toast("This folder isn't a Git repository."); return; }
    const head = await headText(path);
    if (head === undefined) { app.toast("Git doesn't know this file."); return; }
    openDiff({ path, left: head, right: b.state.doc.toString(), leftLabel: "Last commit", rightLabel: b.dirty ? "Yours (not saved)" : "Yours", title: app.base(path) + " · changes", line, live: true });
  }
  // A conflicted file opens as itself (with Keep yours / Keep theirs above each conflict); others show their changes.
  const openRow = (path) => (G.files.get(path)?.conflict ? app.openFile(path) : showDiffOf(path));
  // "Last commit ↔ yours" tabs follow commits, saves and switches.
  let liveT = 0;
  function liveDiffs() {
    clearTimeout(liveT);
    liveT = setTimeout(async () => {
      for (const [key, d] of diffs) {
        if (!d.live || !d.path) continue;
        const head = await headText(d.path);
        const b = S.bufs.get(d.path);
        let right = b ? b.state.doc.toString() : await invoke("read_file", { path: d.path }).catch(() => null);
        if (right == null) continue;
        right = right.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
        const left = head ?? "";
        if (left === d.left && right === d.right) continue;
        Object.assign(d, { left, right, rightLabel: b?.dirty ? "Yours (not saved)" : "Yours" });
        if (mvKey === key) { mvKey = null; if (S.active === key) renderDiff(key); }
      }
    }, 300);
  }
  app.saveHooks.push(() => liveDiffs());
  async function showDiffOf(path) {
    if (S.bufs.has(path)) return showDiff(path);
    const head = await headText(path);
    let cur = "";
    try { cur = (await invoke("read_file", { path })).replace(/^﻿/, "").replace(/\r\n/g, "\n"); } catch {}
    openDiff({ path, left: head ?? "", right: cur, leftLabel: "Last commit", rightLabel: "Yours", title: app.base(path) + " · changes", live: true });
  }
  const diffKeys = keymap.of([
    { key: "Alt-F5", run: goToNextChunk }, { key: "Shift-Alt-F5", run: goToPreviousChunk },
    { key: "F7", run: goToNextChunk }, { key: "Shift-F7", run: goToPreviousChunk },
  ]);
  function sideExt(path) {
    const L = LANGS[langOf(path)] || LANGS.text;
    return [lineNumbers(), highlightSpecialChars(), drawSelection(), syntaxHighlighting(app.hl), L.ext(), app.editorTheme, EditorState.readOnly.of(true), EditorView.editable.of(true), diffKeys,
      EditorView.contentAttributes.of({ "aria-readonly": "true" })];
  }
  function renderDiff(key) {
    const d = diffs.get(key);
    const el = $("diff");
    if (!d) { el.innerHTML = '<p class="empty" style="padding:20px">This comparison is no longer available.</p>'; return; }
    if (mvKey === key && el.querySelector(".cm-mergeView")) return;
    mv?.destroy();
    mvKey = key;
    // Nothing differs (just committed, or changed back): say so rather than show two empty sides.
    if (d.left === d.right) {
      mv = null;
      el.innerHTML = `<div class="diffhead"><b>${esc(d.title)}</b><span class="sp"></span>${S.root && d.path ? '<button class="btn" data-dact="open">Open file</button>' : ""}</div><p class="empty" style="padding:20px">${d.live ? "No changes since the last commit." : "These two are the same."}</p>`;
      return;
    }
    el.innerHTML = `<div class="diffhead"><b>${esc(d.title)}</b><span class="sp"></span><span class="hint">${esc(d.leftLabel)} ↔ ${esc(d.rightLabel)} · F7 / Shift F7 next and previous change</span><button class="btn" data-dact="prev">Previous</button><button class="btn" data-dact="next">Next</button>${(d.actions || []).map((a, i) => `<button class="btn primary" data-dact="x${i}">${esc(a.label)}</button>`).join("")}${S.root && d.path ? '<button class="btn" data-dact="open">Open file</button>' : ""}</div>${d.info ? `<details class="diffinfo" open><summary>${esc(d.info.head)}<button class="ibtn" data-dact="copySha" title="Copy the commit's id" aria-label="Copy the commit's id">⧉</button></summary>${d.info.body ? `<pre>${esc(d.info.body)}</pre>` : ""}${d.info.files.length > 1 ? `<div class="difffiles"><span class="hint">${d.info.files.length} files:</span> ${d.info.files.map((f, i) => `<button class="glink${f.on ? " on" : ""}" data-dact="f${i}"><span class="gs ${esc(f.st)}">${esc(f.st)}</span> ${esc(f.label)}</button>`).join("")}</div>` : ""}</details>` : ""}<div class="diffbody"></div>`;
    mv = new MergeView({
      a: { doc: d.left, extensions: sideExt(d.path) },
      b: { doc: d.right, extensions: sideExt(d.path) },
      parent: el.querySelector(".diffbody"),
      gutter: true, highlightChanges: !d.added, collapseUnchanged: { margin: 3, minSize: 6 },
    });
    requestAnimationFrame(() => {
      const v = mv.b;
      if (d.line) { const l = v.state.doc.line(Math.min(d.line, v.state.doc.lines)); v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) }); }
      else goToNextChunk(v);
      v.focus();
    });
  }
  $("diff").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-dact]");
    if (b?.dataset.dact === "open" && !mv) { const d = diffs.get(mvKey); if (d?.path) app.openFile(d.path); return; }
    if (!b || !mv) return;
    const a = b.dataset.dact;
    if (a === "next") { goToNextChunk(mv.b); mv.b.focus(); }
    if (a === "prev") { goToPreviousChunk(mv.b); mv.b.focus(); }
    if (/^x\d+$/.test(a)) { diffs.get(mvKey)?.actions?.[+a.slice(1)]?.run(); return; }
    if (/^f\d+$/.test(a)) { diffs.get(mvKey)?.info?.files[+a.slice(1)]?.run(); return; }
    if (a === "copySha") { ev.preventDefault(); app.copy(diffs.get(mvKey)?.info?.copy || ""); return; }
    if (a === "open") { const d = diffs.get(mvKey); const line = mv.b.state.doc.lineAt(mv.b.state.selection.main.head).number - 1; app.openFile(d.path, { line, character: 0 }); }
  });
  $("diff").addEventListener("keydown", (ev) => {
    if (app.keyString(ev) === "Enter" && mv && ev.target.closest(".cm-editor")) {
      const d = diffs.get(mvKey);
      if (!d?.path) return;
      ev.preventDefault();
      const line = mv.b.state.doc.lineAt(mv.b.state.selection.main.head).number - 1;
      app.openFile(d.path, { line, character: 0 });
    }
  });
  app.pages.push({
    el: $("diff"),
    match: (k) => k.startsWith("@diff:"),
    render: renderDiff,
    label: (k) => diffs.get(k)?.title || "Changes",
    dot: "cfg",
    focus: () => mv?.b.focus(),
    close: (k) => { diffs.delete(k); if (mvKey === k) { mv?.destroy(); mv = null; mvKey = null; } },
  });
  app.openDiff = openDiff;

  // ---------- source control view ----------
  let rowsSeq = 0;
  function render() {
    renderStatus();
    app.renderTreeSoon?.();
    if (app.sideView === "git") renderView();
  }
  function renderStatus() {
    const st = $("stBranch");
    if (!G.ok || !G.branch) { st.hidden = true; $("gitBadge").hidden = true; return; }
    st.hidden = false;
    st.innerHTML = `${esc(G.branch === "(detached)" ? G.oid.slice(0, 7) : G.branch)}${G.ahead ? ` ↑${G.ahead}` : ""}${G.behind ? ` ↓${G.behind}` : ""}${G.busy ? " · " + esc(G.busy) : ""}`;
    st.title = `Branch ${G.branch}${G.upstream ? `, tracking ${G.upstream}` : ", not pushed anywhere yet"}. ${G.files.size} changed file${G.files.size === 1 ? "" : "s"}. Click to switch branch.`;
    $("gitBadge").hidden = !G.files.size;
    $("gitBadge").title = `${G.files.size} changed`;
  }
  $("stBranch").onclick = () => switchBranch();
  $("stBranch").oncontextmenu = (e) => { e.preventDefault(); moreMenu(e.clientX, e.clientY - 200); };

  function fileRow(path, st, kind, i) {
    const r = app.rel(path), dir = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "";
    const l = kind === "staged" ? (st.x === "?" ? "U" : st.x) : letter(st);
    return `<button class="node g-${l === "!" ? "X" : l}" role="treeitem" tabindex="${i === 0 ? 0 : -1}" data-gp="${esc(path)}" data-gk="${kind}" style="padding-left:12px;--tc:var(--t-${dotOf(path)})" title="${esc(r)} · ${esc(describe(st))}">${app.fileIcon(path)}<span class="lbl" style="flex:0 1 auto">${esc(app.base(path))}</span><span class="sub" style="flex:1">${esc(dir)}</span><span class="gacts" aria-hidden="true"><span class="ga" data-grow="open" title="Open the file (Shift Enter)">↗</span>${kind === "staged" ? "" : '<span class="ga" data-grow="discard" title="Throw away the changes (Delete)">↶</span>'}<span class="ga" data-grow="stage" title="${kind === "staged" ? "Unstage" : "Stage"} (Space)">${kind === "staged" ? "−" : "+"}</span></span><span class="gs ${l === "!" ? "X" : l}">${l}</span></button>`;
  }
  function renderView() {
    const box = $("git");
    const focusKey = box.contains(document.activeElement) ? (document.activeElement.dataset.gp ? `${document.activeElement.dataset.gk}|${document.activeElement.dataset.gp}` : document.activeElement.id || document.activeElement.dataset.gact) : null;
    const msg = $("commitMsg")?.value || G.draft || "";
    if (!S.root) { box.innerHTML = '<p class="hint" style="padding:10px 14px">Open a folder first.</p>'; return; }
    if (G.missing) { box.innerHTML = `<div class="pad" style="padding:10px 14px;display:grid;gap:8px"><p class="hint" style="margin:0">Git isn't installed, or Ledger can't find it.</p><p class="hint" style="margin:0">Install it from <a href="https://git-scm.com/download/win" target="_blank">git-scm.com</a>, then reopen the folder.</p></div>`; return; }
    if (G.blocked) { box.innerHTML = `<div style="padding:10px 14px;display:grid;gap:8px"><p class="hint" style="margin:0">${esc(G.blocked)}</p><div class="bar"><button class="btn primary" data-gact="trust">Trust this folder</button></div></div>`; return; }
    if (G.ok === null) { box.innerHTML = '<p class="hint" style="padding:10px 14px">Checking…</p>'; return; }
    if (!G.ok) { box.innerHTML = `<div style="padding:10px 14px;display:grid;gap:8px"><p class="hint" style="margin:0">This folder isn't a Git repository.</p><div class="bar"><button class="btn primary" data-gact="init">Start a repository here</button></div></div>`; return; }
    const all = [...G.files.entries()].sort((a, b) => app.rel(a[0]).localeCompare(app.rel(b[0])));
    const st = all.filter(([, s]) => staged(s)), un = all.filter(([, s]) => unstaged(s));
    let i = 0;
    box.innerHTML = `
      ${G.merging || G.conflicts?.length ? mergeBanner() : ""}
      <div class="sec"><h3 style="text-transform:none;letter-spacing:0;font-size:12.5px"><button class="gbranch" data-gact="branch" id="gBranch" title="Switch branch, or make a new one">${esc(G.branch === "(detached)" ? G.oid.slice(0, 7) : G.branch)} ▾</button> <span>${G.upstream ? esc(G.upstream) : "not pushed yet"}${G.ahead ? ` · ${G.ahead} to push` : ""}${G.behind ? ` · ${G.behind} to pull` : ""}</span></h3>
        <div class="commit">
          <textarea id="commitMsg" placeholder="Commit message (Ctrl Enter commits)" spellcheck="true" aria-label="Commit message">${esc(msg)}</textarea>
          <div class="bar"><button class="btn primary" data-gact="commit" id="gCommit">${G.merging ? "Commit merge" : `Commit${st.length ? "" : un.length ? " all" : ""}`}</button><button class="btn" data-gact="pull" id="gPull">Pull</button><button class="btn" data-gact="push" id="gPush">Push</button><button class="btn plain" data-gact="more" id="gMore" title="Branches and stashes" aria-label="Branches and stashes">⋯</button><button class="btn plain" data-gact="refresh" id="gRefresh" title="Refresh">↻</button></div>
          ${G.busy ? `<div class="hint spin">${esc(G.busy)}…</div>` : G.merging ? `<div class="hint">${(G.conflicts || []).some((x) => x.left) ? "Resolve and stage each conflicted file, then Commit merge finishes the merge." : "Commit merge finishes the merge."}</div>` : !st.length && un.length ? '<div class="hint">Nothing is staged, so Commit all includes every change below.</div>' : ""}
        </div>
      </div>
      ${st.length ? `<div class="sec"><h3>Staged <span>${st.length}</span></h3><div class="rows" role="tree">${st.map(([p, s]) => fileRow(p, s, "staged", i++)).join("")}</div></div>` : ""}
      <div class="sec"><h3>Changes <span>${un.length}</span></h3><div class="rows" role="tree">${un.map(([p, s]) => fileRow(p, s, "changes", i++)).join("") || `<p class="hint" style="padding:2px 8px">${st.length ? "Nothing else changed." : "No changes since the last commit."}</p>`}</div></div>
      ${G.stashes.length ? `<div class="sec"><h3>Stashes <span>${G.stashes.length}</span></h3><div class="rows">${G.stashes.map((x) => `<button class="node gstash" data-gstash="${esc(x.ref)}" title="${esc(x.ref)} · ${esc(x.when)}. Click to pop, apply, look at or drop it."><span class="lbl">${esc(x.msg.replace(/^On [^:]+: /, ""))}</span><span class="sub">${esc(x.when)}</span></button>`).join("")}</div></div>` : ""}
      <p class="hint" style="padding:8px 14px">Enter shows the changes, Space stages or unstages, Delete throws a change away, Shift F10 for more.</p>`;
    if (focusKey) {
      const el = focusKey.includes("|") ? box.querySelector(`[data-gk="${CSS.escape(focusKey.split("|")[0])}"][data-gp="${CSS.escape(focusKey.slice(focusKey.indexOf("|") + 1))}"]`) || box.querySelector(".node") : box.querySelector("#" + CSS.escape(focusKey)) || box.querySelector(`[data-gact="${CSS.escape(focusKey)}"]`);
      if (el) { if (el.matches(".node")) box.querySelectorAll(".node").forEach((n) => (n.tabIndex = n === el ? 0 : -1)); el.focus({ preventScroll: true }); }
    }
  }
  function mergeBanner() {
    const c = G.conflicts || [], left = c.filter((x) => x.left), done = c.filter((x) => !x.left);
    const what = G.merging ? "<b>Merging.</b> " : "<b>Conflicts.</b> ";
    const text = left.length
      ? `${left.length} file${left.length === 1 ? " still has" : "s still have"} conflicts: open ${left.length === 1 ? "it" : "each"} and pick a side above every conflict, then save.`
      : done.length ? `Every conflict is resolved. Stage ${done.length === 1 ? "the file" : "the files"} to say so${G.merging ? ", then commit to finish the merge" : ""}.`
      : "No conflicts left: commit to finish the merge.";
    const list = c.map((x) => `<button class="glink" data-gopen="${esc(x.path)}" title="${esc(app.rel(x.path))}">${esc(app.base(x.path))}</button>${x.left ? "" : ' <span class="hint">resolved</span>'}`).join(" · ");
    return `<div class="gmerge">${what}${text}${list ? `<div>${list}</div>` : ""}<div class="bar">${done.length ? `<button class="btn primary" data-gact="stageResolved">Stage the resolved file${done.length === 1 ? "" : "s"}</button>` : ""}${G.merging ? '<button class="btn" data-gact="abortMerge">Abort the merge</button>' : ""}</div></div>`;
  }
  function focusView() {
    renderView();
    const box = $("git");
    (box.querySelector("#commitMsg") || box.querySelector("button"))?.focus();
  }
  app.sideViews.git.render = () => { renderView(); refresh(); };
  app.sideViews.git.focus = focusView;

  async function op(label, args, after, quiet) {
    if (G.busy) { app.toast(`Wait for ${G.busy.toLowerCase()} to finish.`); return null; }
    G.busy = label;
    render();
    let r;
    try { r = await git(args); }
    catch (e) { r = { code: -1, out: "", err: String(e) }; }
    G.busy = "";
    if (r.code !== 0 && !quiet) {
      const why = (r.err || r.out).trim();
      app.appendOut(`<span class="cmd">$ git ${esc(args.join(" "))}</span>`);
      app.appendOut(esc(why));
      app.toast(`${label} failed: ${why.split("\n").filter(Boolean).pop() || "see Output"}`, 7000);
    } else if (r.code === 0 && after) after(r);
    await refresh();
    return r;
  }
  async function commit() {
    const ta = $("commitMsg");
    const msg = (ta?.value ?? "").trim();
    await app.saveAll();
    await refresh();
    const any = [...G.files.values()];
    if (!any.length && !G.merging) { app.toast("Nothing to commit: no changes since the last commit."); return; }
    // A merge has its own message ("Merge branch 'x'") when you don't write one.
    if (!msg && !G.merging) { app.toast("Write a commit message first."); app.showSideView("git"); $("commitMsg")?.focus(); return; }
    // Never commit a file with conflict markers still in it.
    const left = (G.conflicts || []).filter((x) => x.left);
    const marked = [];
    const changed = [...G.files.entries()].filter(([, st]) => !st.conflict && st.x !== "?" && st.x !== "D" && st.y !== "D").slice(0, 300);
    for (const [p] of changed) if (await hasMarkers(p)) marked.push(p);
    if (left.length || marked.length) {
      const files = [...left.map((x) => x.path), ...marked];
      const c = await app.choose(`${files.map((p) => app.base(p)).slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""} still ${files.length === 1 ? "has" : "have"} conflict markers (<<<<<<< and >>>>>>>) in ${files.length === 1 ? "it" : "them"}.`, [`Open ${app.base(files[0])}`, "Commit anyway", "Cancel"]);
      if (c === "Commit anyway") { /* their call */ }
      else { if (c?.startsWith("Open")) app.openFile(files[0]); return; }
    }
    if (!any.some(staged)) {
      // Commit all: say so when that would add files Git doesn't track yet.
      const fresh = [...G.files.entries()].filter(([, s]) => s.x === "?").map(([p]) => p);
      let args = ["add", "-A"];
      if (fresh.length) {
        const c = await app.choose(`${fresh.length === 1 ? "1 file isn't" : fresh.length + " files aren't"} in Git yet (${fresh.slice(0, 3).map((p) => app.base(p)).join(", ")}${fresh.length > 3 ? "…" : ""}). Commit ${fresh.length === 1 ? "it" : "them"} too?`, ["Yes, add the new files too", "No, only the changed files", "Cancel"]);
        if (!c || c === "Cancel") return;
        if (c.startsWith("No")) args = ["add", "-u"];
      }
      const r = await op("Staging", args);
      if (!r || r.code !== 0) return;
    }
    const r = await op("Committing", msg ? ["commit", "-m", msg] : ["commit", "--no-edit"]);
    if (r?.code === 0) { G.draft = ""; if ($("commitMsg")) $("commitMsg").value = ""; app.toast("Committed: " + (msg.split("\n")[0] || "the merge")); renderView(); }
  }
  async function pull() {
    if (!G.upstream) {
      const rem = await git(["remote"]).catch(() => null);
      if (!(rem?.out || "").trim()) { app.toast("This repository has no remote to pull from. Add one first: git remote add origin <url> (in the terminal).", 8000); return; }
      if (!G.upstream) { app.toast(`${G.branch} doesn't track a branch on the remote yet, so there's nothing to pull. Push it first.`, 7000); return; }
    }
    await op("Pulling", ["pull", "--no-rebase"], (r) => app.toast((r.out.trim().split("\n").pop() || "Pulled.").slice(0, 160)));
    app.reloadClean?.();
  }
  async function push() {
    let args = ["push"];
    if (!G.upstream) {
      const rem = await git(["remote"]).catch(() => null);
      const remotes = (rem?.out || "").split("\n").filter(Boolean);
      if (!remotes.length) { app.toast("This repository has no remote to push to. Add one first: git remote add origin <url> (in the terminal).", 8000); return; }
      args = ["push", "-u", remotes.includes("origin") ? "origin" : remotes[0], "HEAD"];
    }
    await op("Pushing", args, () => app.toast("Pushed."));
  }
  async function stage(path, kind) {
    if (kind === "staged") await op("Unstaging", ["restore", "--staged", "--", relTo(path)]);
    else await op("Staging", ["add", "--", relTo(path)]);
  }
  async function discard(path) {
    const st = G.files.get(path);
    if (!st) return;
    const untracked = st.x === "?";
    const c = await app.choose(untracked ? `Delete ${app.base(path)}? It isn't in Git, so it can't be brought back.` : `Throw away your changes to ${app.base(path)}?`, ["Cancel", untracked ? "Delete the file" : "Throw away changes"]); // Enter keeps the work
    if (!c || c === "Cancel") return;
    if (untracked) await invoke("delete_path", { path }).catch((e) => app.toast(String(e)));
    else await op("Discarding", ["restore", "--staged", "--worktree", "--source=HEAD", "--", relTo(path)]);
    await app.reloadClean?.();
    app.refreshTree?.();
  }
  $("git").addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-gact]");
    if (a) {
      const act = a.dataset.gact;
      if (act === "commit") commit();
      if (act === "pull") pull();
      if (act === "push") push();
      if (act === "refresh") refresh();
      if (act === "trust") { app.askTrust?.(S.root, true).then((yes) => { if (yes) { G.forRoot = null; refresh(); } }); return; }
      if (act === "init") git(["init"], S.root).then(() => { G.forRoot = null; refresh(); });
      if (act === "branch") switchBranch();
      if (act === "more") { const r = a.getBoundingClientRect(); moreMenu(r.left, r.bottom + 2); }
      if (act === "abortMerge") abortMerge();
      if (act === "stageResolved") { const done = (G.conflicts || []).filter((x) => !x.left).map((x) => relTo(x.path)); if (done.length) op("Staging", ["add", "--", ...done]); }
      return;
    }
    const go = ev.target.closest("[data-gopen]");
    if (go) { app.openFile(go.dataset.gopen); return; }
    const sh = ev.target.closest("[data-gstash]");
    if (sh) { const r = sh.getBoundingClientRect(); stashMenu(sh.dataset.gstash, r.left + 24, r.bottom); return; }
    const n = ev.target.closest("[data-gp]");
    const ga = ev.target.closest("[data-grow]");
    if (n && ga) {
      const w = ga.dataset.grow;
      if (w === "open") app.openFile(n.dataset.gp);
      else if (w === "discard") discard(n.dataset.gp);
      else stage(n.dataset.gp, n.dataset.gk);
      return;
    }
    if (n) openRow(n.dataset.gp);
  });
  $("git").addEventListener("contextmenu", (ev) => {
    const sh = ev.target.closest("[data-gstash]");
    if (sh) { ev.preventDefault(); stashMenu(sh.dataset.gstash, ev.clientX, ev.clientY); return; }
    const n = ev.target.closest("[data-gp]");
    if (!n) return;
    ev.preventDefault();
    rowMenu(n, ev.clientX, ev.clientY);
  });
  function rowMenu(n, x, y) {
    const p = n.dataset.gp, k = n.dataset.gk;
    app.showMenu(x, y, [
      { label: "Show changes", hint: "Enter", run: () => showDiffOf(p) },
      { label: "Open file", hint: "Shift Enter", run: () => app.openFile(p) },
      "-",
      { label: k === "staged" ? "Unstage" : "Stage", hint: "Space", run: () => stage(p, k) },
      { label: "Throw away changes", hint: "Delete", danger: true, run: () => discard(p) },
    ]);
  }
  $("git").addEventListener("input", (ev) => { if (ev.target.id === "commitMsg") G.draft = ev.target.value; });
  $("git").addEventListener("keydown", (ev) => {
    const k = app.keyString(ev);
    if (ev.target.id === "commitMsg") {
      if (k === "Ctrl+Enter") { ev.preventDefault(); commit(); }
      if (k === "Esc") { ev.preventDefault(); app.focusZone("editor"); }
      if (k === "Down" && ev.target.selectionStart === ev.target.value.length) { const n = $("git").querySelector(".node"); if (n) { ev.preventDefault(); n.focus(); } }
      return;
    }
    const el = ev.target.closest(".node");
    if (!el) { if (k === "Esc") { ev.preventDefault(); app.focusZone("editor"); } return; }
    const nodes = [...$("git").querySelectorAll(".node")], i = nodes.indexOf(el);
    const go = (n) => { if (!n) return; nodes.forEach((x) => (x.tabIndex = x === n ? 0 : -1)); n.focus(); n.scrollIntoView({ block: "nearest" }); };
    // A stash row: Enter or Space pops it, Delete drops it, Shift F10 for the rest.
    if (el.dataset.gstash && !["Down", "Up", "Home", "End", "Esc"].includes(k)) {
      const ref = el.dataset.gstash;
      const rc = el.getBoundingClientRect();
      if (k === "Enter" || k === "Space" || k === "Shift+F10" || k === "ContextMenu") stashMenu(ref, rc.left + 24, rc.bottom);
      else if (k === "Delete") stashOp("drop", ref);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (k === "Down") go(nodes[i + 1]);
    else if (k === "Up") { if (i === 0) $("commitMsg")?.focus(); else go(nodes[i - 1]); }
    else if (k === "Home") go(nodes[0]);
    else if (k === "End") go(nodes[nodes.length - 1]);
    else if (k === "Enter") openRow(el.dataset.gp);
    else if (k === "Shift+Enter") app.openFile(el.dataset.gp);
    else if (k === "Space") stage(el.dataset.gp, el.dataset.gk);
    else if (k === "Delete") discard(el.dataset.gp);
    else if (k === "Shift+F10" || k === "ContextMenu") { const r = el.getBoundingClientRect(); rowMenu(el, r.left + 24, r.bottom); }
    else if (k === "Esc") app.focusZone("editor");
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  });

  // ---------- branches ----------
  async function refs() {
    const r = await git(["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(HEAD)%09%(committerdate:relative)%09%(upstream:short)", "refs/heads", "refs/remotes"]).catch(() => null);
    const local = [], remote = [];
    for (const l of (r?.code === 0 ? r.out.split("\n") : [])) {
      const [ref, head, when, up] = l.split("\t");
      if (!ref) continue;
      if (ref.startsWith("refs/heads/")) local.push({ name: ref.slice(11), current: head === "*", when, up });
      else if (!ref.endsWith("/HEAD")) remote.push({ name: ref.slice(13), when });
    }
    const names = new Set(local.map((b) => b.name));
    // A remote branch only needs its own row when there's no local branch of that name yet.
    return { local, remote: remote.filter((b) => !names.has(b.name.slice(b.name.indexOf("/") + 1))) };
  }
  async function afterSwitch() {
    headCache.clear();
    await refresh();
    await app.reloadClean?.();
    app.refreshTree?.();
  }
  async function switchTo(name) {
    await app.saveAll();
    let r = await op("Switching", ["switch", name], null, true);
    if (r && r.code !== 0 && /overwritten|commit your changes or stash/i.test(r.err)) {
      const c = await app.choose(`Your changes to some files would be lost by switching to ${name}.`, ["Stash them, then switch", "Cancel"]);
      if (c !== "Stash them, then switch") return;
      const s = await op("Stashing", ["stash", "push", "-u", "-m", `Before switching to ${name}`]);
      if (!s || s.code !== 0) return;
      r = await op("Switching", ["switch", name], null, true);
      if (r?.code === 0) app.toast(`On ${name}. Your changes are stashed: pop them back from Source control when you want them.`, 7000);
    }
    if (r && r.code !== 0) { app.toast("Couldn't switch: " + ((r.err || r.out).trim().split("\n").pop() || "see Output"), 7000); app.appendOut(esc((r.err || r.out).trim())); }
    else if (r) app.toast(`Switched to ${name}.`);
    await afterSwitch();
  }
  async function switchBranch() {
    if (!G.ok) { app.toast("This folder isn't a Git repository."); return; }
    const { local, remote } = await refs();
    const rows = [
      { label: "+ New branch from here…", run: () => newBranch() },
      ...local.map((b) => ({ label: `${b.name}${b.current ? "  (current)" : ""}  ·  ${b.when}${b.up ? "  ·  " + b.up : ""}`, run: () => (b.current ? app.toast(`Already on ${b.name}.`) : switchTo(b.name)) })),
      ...remote.map((b) => ({ label: `${b.name}  ·  ${b.when}  ·  remote`, run: () => switchTo(b.name.slice(b.name.indexOf("/") + 1)) })),
    ];
    // Typing a name that isn't a branch offers to make it (spaces become dashes).
    const i = await app.choose("Switch branch (type to find one, or a new name)", rows.map((x) => x.label), true, { filter: true, create: (t) => `+ Create branch "${t.replace(/\s+/g, "-")}" from here` });
    if (i?.create) newBranch(i.create.replace(/\s+/g, "-"));
    else if (i != null && i >= 0) rows[i].run();
  }
  async function newBranch(typed) {
    let name = typed || "", head = "New branch name (it starts from where you are now, and you switch to it)";
    if (typed && !/[\s~^:?*[\\]|\.\.|@\{|^[-/]|[/.]$|\.lock$/.test(typed)) return makeBranch(typed);
    // A name Git won't take asks again, with what you typed still there.
    for (;;) {
      name = (await app.promptText(head, name, "e.g. feature/my-change"))?.trim();
      if (!name) return;
      if (!/[\s~^:?*[\\]|\.\.|@\{|^[-/]|[/.]$|\.lock$/.test(name)) break;
      head = "That won't work as a branch name: no spaces, and none of ~ ^ : ? * [ \\ or two dots. Try again:";
    }
    return makeBranch(name);
  }
  async function makeBranch(name) {
    await app.saveAll();
    await op("Creating branch", ["switch", "-c", name], () => app.toast(`On the new branch ${name}. Your changes came along.`));
    await afterSwitch();
  }
  async function deleteBranch() {
    const { local } = await refs();
    const others = local.filter((b) => !b.current);
    if (!others.length) { app.toast("There's no other branch to delete."); return; }
    const i = await app.choose("Delete which branch?", others.map((b) => `${b.name}  ·  ${b.when}`), true, { filter: true });
    if (i == null || i < 0) return;
    const name = others[i].name;
    const r = await op("Deleting branch", ["branch", "-d", name], () => app.toast(`Deleted ${name}.`), true);
    if (r && r.code !== 0 && /not fully merged/i.test(r.err)) {
      const c = await app.choose(`${name} has commits that aren't in any other branch. Delete it anyway? Those commits will be lost.`, ["Delete it anyway", "Cancel"]);
      if (c === "Delete it anyway") await op("Deleting branch", ["branch", "-D", name], () => app.toast(`Deleted ${name}.`));
    } else if (r && r.code !== 0) app.toast("Couldn't delete: " + r.err.trim().split("\n").pop(), 7000);
  }
  async function mergeBranch() {
    const { local, remote } = await refs();
    const all = [...local.filter((b) => !b.current).map((b) => b.name), ...remote.map((b) => b.name)];
    if (!all.length) { app.toast("There's no other branch to merge."); return; }
    const i = await app.choose(`Merge which branch into ${G.branch}?`, all, true, { filter: true });
    if (i == null || i < 0) return;
    await app.saveAll();
    const r = await op("Merging", ["merge", "--no-edit", all[i]], (x) => app.toast((x.out.trim().split("\n").pop() || "Merged.").slice(0, 160)), true);
    if (r && r.code !== 0) {
      if (/conflict/i.test(r.out + r.err)) { app.toast("The merge has conflicts. They're marked in Source control: open each file and pick a side above every conflict.", 9000); app.showSideView("git"); }
      else app.toast("Couldn't merge: " + ((r.err || r.out).trim().split("\n").pop()), 7000);
    }
    await afterSwitch();
  }
  async function abortMerge() {
    const c = await app.choose("Abort the merge? Every file goes back to how it was before you merged.", ["Abort the merge", "Cancel"]);
    if (c !== "Abort the merge") return;
    await op("Aborting", ["merge", "--abort"], () => app.toast("Merge aborted."));
    await afterSwitch();
  }

  // ---------- stashes ----------
  async function stash() {
    if (!G.files.size) { app.toast("Nothing to stash: no changes since the last commit."); return; }
    const msg = await app.promptText("Stash your changes: a note to recognise them by", "", "e.g. half-done header");
    if (msg == null) return;
    await app.saveAll();
    await op("Stashing", ["stash", "push", "-u", ...(msg.trim() ? ["-m", msg.trim()] : [])], () => app.toast("Stashed. Pop it back from Source control."));
    await afterSwitch();
  }
  async function stashOp(kind, ref) {
    if (!ref) {
      if (!G.stashes.length) { app.toast("There are no stashes."); return; }
      const i = G.stashes.length === 1 ? 0 : await app.choose(kind === "drop" ? "Drop which stash?" : "Which stash?", G.stashes.map((x) => `${x.msg.replace(/^On [^:]+: /, "")}  ·  ${x.when}`), true, { filter: true });
      if (i == null || i < 0) return;
      ref = G.stashes[i].ref;
    }
    if (kind === "drop") {
      const c = await app.choose("Drop this stash? The changes in it are gone for good.", ["Drop it", "Cancel"]);
      if (c !== "Drop it") return;
    }
    await app.saveAll();
    const r = await op(kind === "pop" ? "Popping stash" : kind === "apply" ? "Applying stash" : "Dropping stash", ["stash", kind, ref], () => app.toast(kind === "drop" ? "Dropped." : "Your stashed changes are back."), true);
    if (r && r.code !== 0) {
      if (/conflict/i.test(r.out + r.err)) app.toast("Some stashed changes clash with yours: the conflicts are marked in those files. The stash is kept until you drop it.", 9000);
      else app.toast("Couldn't: " + ((r.err || r.out).trim().split("\n").pop()), 7000);
    }
    await afterSwitch();
  }
  async function showStash(ref) {
    const r = await git(["stash", "show", "-p", "--include-untracked", ref]).catch(() => null);
    if (!r || r.code !== 0) { app.toast("Couldn't read that stash."); return; }
    openDiff({ path: null, left: "", right: r.out, leftLabel: "", rightLabel: ref, title: ref + " · stashed changes" });
  }
  function stashMenu(ref, x, y) {
    app.showMenu(x, y, [
      { label: "Pop: bring the changes back and remove the stash", run: () => stashOp("pop", ref) },
      { label: "Apply: bring the changes back, keep the stash", run: () => stashOp("apply", ref) },
      { label: "Show what's in it", run: () => showStash(ref) },
      "-",
      { label: "Drop", danger: true, run: () => stashOp("drop", ref) },
    ]);
  }
  function moreMenu(x, y) {
    app.showMenu(x, y, [
      { label: "History (commits)", run: () => app.gitLog?.() },
      "-",
      { label: "Switch branch…", run: switchBranch },
      { label: "New branch…", run: () => newBranch() },
      { label: "Merge a branch into this one…", run: mergeBranch },
      { label: "Delete a branch…", run: deleteBranch },
      "-",
      { label: "Stash changes…", run: stash },
      ...(G.stashes.length ? [{ label: "Pop the latest stash", run: () => stashOp("pop", G.stashes[0].ref) }] : []),
      ...(G.merging ? ["-", { label: "Abort the merge", danger: true, run: abortMerge }] : []),
    ]);
  }

  // ---------- wiring ----------
  app.extraExt.push((path, b) => (app.settings.gitGutter && !b.virtual ? [gitPath.of(path), barGutter] : []));
  app.bufListeners.push((path) => scheduleBars(path));
  app.activeHooks.push((key) => { if (S.bufs.has(key)) scheduleBars(key, 50); });
  app.saveHooks.push(() => { clearTimeout(G.saveT); G.saveT = setTimeout(refresh, 400); });
  app.trustHooks?.push(() => { G.forRoot = null; headCache.clear(); refresh(); });
  app.folderHooks.push(() => { G.forRoot = null; G.ok = null; G.files = new Map(); G.oid = ""; headCache.clear(); refresh(); });
  app.decorationCopiers.push((path, b) => {
    const v = b.state.field(barField, false);
    if (v) app.panes.find((p) => p.view?.state === b.mirror)?.view.dispatch({ effects: setBars.of(v) });
  });
  app.settingHooks.push((k) => { if (k === "gitGutter") for (const p of S.bufs.keys()) scheduleBars(p, 20); });
  window.addEventListener("focus", () => setTimeout(refresh, 200));
  setInterval(() => { if (document.hasFocus() && S.root) refresh(); }, 6000);

  const C = app.command;
  C("git.view", "Source control", "Ctrl+Shift+G", () => app.showSideView("git", true));
  C("git.commit", "Git: commit", [], () => (app.sideView === "git" && $("commitMsg")?.value.trim() ? commit() : focusView()));
  C("git.pull", "Git: pull", [], pull);
  C("git.push", "Git: push", [], push);
  C("git.diff", "Git: show changes in this file", [], () => showDiff());
  C("git.nextChange", "Next change in this file", "Alt+F5", () => jumpChange(1));
  C("git.prevChange", "Previous change in this file", "Shift+Alt+F5", () => jumpChange(-1));
  C("diff.next", "Next change (in a comparison)", "F7", () => jumpChange(1));
  C("diff.prev", "Previous change (in a comparison)", "Shift+F7", () => jumpChange(-1));
  C("git.branch", "Git: switch branch", [], switchBranch);
  C("git.branchNew", "Git: new branch", [], () => newBranch());
  C("git.branchDelete", "Git: delete a branch", [], deleteBranch);
  C("git.merge", "Git: merge a branch into this one", [], mergeBranch);
  C("git.mergeAbort", "Git: abort the merge", [], () => (G.merging ? abortMerge() : app.toast("No merge in progress.")));
  C("git.stash", "Git: stash changes", [], stash);
  C("git.stashPop", "Git: pop a stash (apply it and remove it)", [], () => stashOp("pop"));
  C("git.stashApply", "Git: apply a stash (and keep it)", [], () => stashOp("apply"));
  C("git.stashDrop", "Git: drop a stash", [], () => stashOp("drop"));
  C("git.revertChange", "Undo the change at the cursor (back to the last commit)", [], revertChange);

  return { refresh, G, showDiff, git, relTo, headText, openDiff };
}
