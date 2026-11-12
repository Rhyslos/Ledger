// Red Thread: everywhere a piece of code is used, and everywhere those places are used, as columns
// side by side. Put the cursor on anything (a variable, a function, a class, a method) and press
// Shift+Alt+F12. The first column is its definition and every place that uses it, grouped by file,
// each with the function or class it sits in. Pick one and a column slides in to the right: that
// function's code, with the use marked, and everywhere *it* is used. Keep pulling the thread; a
// red line joins each pick to where it leads. Double-click (or Ctrl+Enter) opens a place in the
// editor. Nothing is saved: close the tab and the thread is gone.
//
// The language servers answer (references, document symbols, type hierarchy), so a use is a real
// use, not another thing with the same name. With no server for the language, the uses are text
// matches of the name, and say so.
import { Text } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";
import { uriToPath, pathToUri, toOffset, norm } from "./lsp.js";
import { langOf, dotOf } from "./langs.js";
import { flatSymbols, enclosing, symbolAt, isImport, inRange, KIND } from "./threadsyms.js";

const KEY = "@thread:";
const MAX_USES = 400; // past this, the first 400 (a column of thousands helps nobody)
const MAX_CODE = 60; // lines of code shown at the top of a column

export function initThread(app) {
  const { S, esc, base, rel } = app;
  const el = document.getElementById("threadpage");
  // The one thread: { id, cols: [column], opened: Map(path -> server), docs, syms, srv }
  let T = null;

  // ----- reading files and asking the server -----
  async function docOf(path) {
    if (T.docs.has(path)) return T.docs.get(path);
    const b = S.bufs.get(path);
    let doc;
    if (b) doc = b.state.doc;
    else {
      try { doc = Text.of((await invoke("read_file", { path })).replace(/^﻿/, "").split(/\r?\n/)); }
      catch { doc = Text.of([""]); }
    }
    T.docs.set(path, doc);
    return doc;
  }
  const serverFor = (path) => {
    const id = app.LANGS[langOf(path)]?.server;
    const srv = id && app.servers[id];
    return srv?.alive && !srv.state?.bad ? srv : null; // one that failed to start can't answer
  };
  /** The server has to have the file open to answer about it (TypeScript's does); open it quietly. */
  async function ready(srv, path) {
    const doc = await docOf(path);
    const b = S.bufs.get(path);
    if (b) app.syncDoc(path);
    else if (!T.opened.has(path)) { srv.open(path, doc.toString(), app.LANGS[langOf(path)].languageId); T.opened.set(path, srv); }
    return doc;
  }
  async function symbolsOf(srv, path) {
    if (T.syms.has(path)) return T.syms.get(path);
    const p = (async () => {
      if (!srv?.caps?.documentSymbolProvider) return [];
      await ready(srv, path);
      try { return flatSymbols(await srv.request("textDocument/documentSymbol", { textDocument: { uri: pathToUri(path) } }, 15000)); } catch { return []; }
    })();
    T.syms.set(path, p);
    return p;
  }

  /** Every use of the symbol at path:pos (not its own declaration), each with what it sits in. */
  async function usesOf(srv, path, pos, sym) {
    const doc = await ready(srv, path);
    const at = { textDocument: { uri: pathToUri(path) }, position: pos };
    let refs = [];
    try { refs = (await srv.request("textDocument/references", { ...at, context: { includeDeclaration: false } }, 60000)) || []; } catch {}
    refs = refs.filter((r) => /^file:/.test(r.uri)).map((r) => ({ path: norm(uriToPath(r.uri)), range: r.range }));
    // Not the name itself (some servers include the declaration anyway).
    refs = refs.filter((r) => !(r.path === path && sym && inRange(sym.sel, r.range.start)));
    // Classes and interfaces: what extends or implements them is a use too.
    const extra = [];
    if (sym && [5, 11, 23].includes(sym.kind) && srv.caps?.typeHierarchyProvider) {
      try {
        const items = await srv.request("textDocument/prepareTypeHierarchy", at);
        if (items?.[0]) {
          const subs = (await srv.request("typeHierarchy/subtypes", { item: items[0] })) || [];
          for (const t of subs) if (/^file:/.test(t.uri)) extra.push({ path: norm(uriToPath(t.uri)), range: t.selectionRange, sub: { name: t.name, kind: t.kind, range: t.range, sel: t.selectionRange } });
        }
      } catch {}
    }
    void doc;
    // Imports name it without using it: counted, not listed.
    const kept = [];
    let imports = 0;
    for (const r of refs) {
      const d = await docOf(r.path);
      if (isImport(d.line(Math.min(d.lines, r.range.start.line + 1)).text)) imports++;
      else kept.push(r);
    }
    refs = kept;
    const all = [...extra, ...refs];
    const more = all.length > MAX_USES ? all.length - MAX_USES : 0;
    const list = all.slice(0, MAX_USES);
    await Promise.all(list.map(async (u) => {
      const d = await docOf(u.path);
      u.text = d.line(Math.min(d.lines, u.range.start.line + 1)).text;
      const fsrv = serverFor(u.path) || srv;
      u.encl = u.sub || enclosing(await symbolsOf(fsrv, u.path), u.range.start);
      u.how = u.sub ? (sym.kind === 11 ? "implements it" : "extends it") : null;
    }));
    return { list, more, imports };
  }

  /** No language server: whole-word matches of the name in the folder's files. */
  async function textUses(name, path, line) {
    let hits = [];
    try { hits = await invoke("search_text", { root: S.root, query: name, caseSensitive: true }); } catch {}
    const word = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`);
    const list = [];
    for (const h of hits) {
      const p = norm(h.path);
      if (p === path && h.line - 1 === line) continue;
      if (!word.test(h.text)) continue;
      const col = Math.max(0, h.text.search(word) + (/^[\w$]/.test(h.text.slice(h.text.search(word))) ? 0 : 1));
      list.push({ path: p, range: { start: { line: h.line - 1, character: col }, end: { line: h.line - 1, character: col + name.length } }, text: h.text, encl: null });
    }
    return { list: list.slice(0, MAX_USES), more: Math.max(0, list.length - MAX_USES) };
  }

  // ----- columns -----
  /** A column for a symbol: its code and its uses. `focus`: the line to mark in the code. */
  async function column({ path, name, sym, pos, focus }) {
    const srv = serverFor(path);
    const col = { path, name, sym, focus, loading: true, uses: [], more: 0, text: !srv };
    if (srv) Object.assign(col, await usesOf(srv, path, pos, sym));
    else Object.assign(col, await textUses(name, path, focus ?? pos.line));
    col.uses = col.list || col.uses;
    delete col.list;
    col.loading = false;
    return col;
  }

  async function start() {
    const path = S.active, b = S.bufs.get(path), v = app.view;
    if (!b || b.virtual || !v) { app.toast("Put the cursor on something in a file first: a variable, a function, a class or a method."); return; }
    const head = v.state.selection.main.head, w = v.state.wordAt(head);
    if (!w) { app.toast("Put the cursor on a name: a variable, a function, a class or a method."); return; }
    const name = v.state.sliceDoc(w.from, w.to);
    // Read everything from the editor before the thread's tab takes its place.
    const doc0 = v.state.doc, line0 = doc0.lineAt(head);
    const lp = { line: line0.number - 1, character: head - line0.from };
    closeThread();
    T = { id: Date.now(), cols: [], opened: new Map(), docs: new Map(), syms: new Map(), name };
    const me = T;
    app.addTab(KEY + "thread");
    app.activate(KEY + "thread");
    draw();
    let at = { path, pos: lp };
    const srv = serverFor(path);
    // Start from the definition, wherever the cursor is.
    if (srv) {
      app.syncDoc(path, doc0);
      try {
        const r = await srv.request("textDocument/definition", { textDocument: { uri: pathToUri(path) }, position: lp });
        const d = (Array.isArray(r) ? r : r ? [r] : []).map((l) => ({ uri: l.targetUri || l.uri, range: l.targetSelectionRange || l.range })).find((l) => /^file:/.test(l.uri));
        if (d) at = { path: norm(uriToPath(d.uri)), pos: d.range.start };
      } catch {}
    }
    if (T !== me) return;
    const dsrv = serverFor(at.path);
    const syms = dsrv ? await symbolsOf(dsrv, at.path) : [];
    const sym = symbolAt(syms, at.pos);
    const first = await column({ path: at.path, name: sym?.name || name, sym, pos: sym ? sym.sel.start : at.pos, focus: at.pos.line });
    if (T !== me) return;
    first.origin = true;
    T.cols = [first];
    draw();
    focusEntry(0, 0);
  }

  /** Follow use i of column k: the column for what it's inside, replacing any further right. */
  async function follow(k, i) {
    const me = T, col = T?.cols[k], u = col?.uses[i];
    if (!u) return;
    col.pick = i;
    T.cols = T.cols.slice(0, k + 1);
    const next = { path: u.path, name: u.encl?.name || base(u.path), sym: u.encl, focus: u.range.start.line, loading: true, uses: [], leaf: !u.encl };
    T.cols.push(next);
    draw();
    scrollToEnd();
    if (!u.encl) { next.loading = false; draw(); return; }
    const got = await column({ path: u.path, name: u.encl.name, sym: u.encl, pos: u.encl.sel.start, focus: u.range.start.line });
    if (T !== me || T.cols[k + 1] !== next) return;
    T.cols[k + 1] = got;
    draw();
    scrollToEnd();
  }

  // ----- drawing -----
  const kindName = (s) => (s ? KIND[s.kind] || "" : "");
  function codeHtml(col) {
    return `<div class="rt-code" data-col-code><div class="rt-nums"></div><pre><code></code></pre><i class="rt-mark" hidden></i></div>`;
  }
  async function fillCode(node, col) {
    const doc = await docOf(col.path);
    let a, z;
    if (col.sym) { a = col.sym.range.start.line; z = col.sym.range.end.line; }
    else { a = Math.max(0, (col.focus ?? 0) - 6); z = (col.focus ?? 0) + 6; }
    z = Math.min(z, doc.lines - 1);
    // A long function: the part around the marked line.
    if (z - a + 1 > MAX_CODE) {
      const f = col.focus ?? a;
      a = f - a > MAX_CODE - 10 ? Math.max(a, f - 20) : a;
      z = Math.min(z, a + MAX_CODE - 1);
    }
    const lines = [];
    for (let n = a; n <= z; n++) lines.push(doc.line(n + 1).text);
    const dedent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 99);
    const code = lines.map((l) => l.slice(Math.min(dedent, l.length - l.trimStart().length))).join("\n");
    const c = node.querySelector("code");
    c.textContent = code;
    app.highlightInto?.(c, code, langOf(col.path));
    node.querySelector(".rt-nums").textContent = lines.map((_, i) => a + i + 1).join("\n");
    const mark = node.querySelector(".rt-mark");
    if (col.focus != null && col.focus >= a && col.focus <= z && !col.origin) { mark.hidden = false; mark.style.top = `calc(${col.focus - a} * var(--rt-lh) + 8px)`; }
    else if (col.origin && col.focus != null && col.focus >= a && col.focus <= z) { mark.hidden = false; mark.classList.add("origin"); mark.style.top = `calc(${col.focus - a} * var(--rt-lh) + 8px)`; }
    requestAnimationFrame(drawLines);
  }

  function useHtml(u, k, i, pick) {
    const t = u.text || "", s = u.range.start.character, e = u.range.start.line === u.range.end.line ? u.range.end.character : t.length;
    const trim = t.length - t.trimStart().length;
    const line = esc(t.slice(trim, Math.max(trim, s))) + "<mark>" + esc(t.slice(s, e)) + "</mark>" + esc(t.slice(e).trimEnd());
    const inside = u.how ? `<b class="rt-in">${esc(u.encl.name)}</b> <span class="rt-kind">${esc(u.how)}</span>`
      : u.encl ? `<b class="rt-in">${esc(u.encl.name)}</b> <span class="rt-kind">${esc(kindName(u.encl))}</span>`
      : `<span class="rt-kind">top level</span>`;
    return `<button class="rt-use${pick ? " picked" : ""}" data-k="${k}" data-i="${i}" tabindex="-1" title="Click to follow · double-click to open it">
      <span class="rt-where">${inside}<span class="rt-at">${u.range.start.line + 1}</span></span>
      <code class="rt-line">${line}</code></button>`;
  }
  function colHtml(col, k) {
    const groups = new Map();
    col.uses.forEach((u, i) => { if (!groups.has(u.path)) groups.set(u.path, []); groups.get(u.path).push([u, i]); });
    const files = [...groups.entries()];
    const where = app.isUnder(col.path, S.root) ? rel(col.path) : col.path;
    const head = `<header class="rt-head"><span class="rt-dot" style="--tc:var(--t-${dotOf(col.path)})"></span><div><b>${esc(col.name)}</b> <span class="rt-kind">${esc(kindName(col.sym))}</span><div class="rt-file" title="${esc(col.path)}">${esc(where)}${col.sym ? `:${col.sym.sel.start.line + 1}` : ""}</div></div>
      <button class="ibtn rt-open" data-open="${k}" title="Open in the editor" aria-label="Open in the editor">↗</button></header>`;
    let body;
    if (col.loading) body = `<p class="rt-note">Finding where it's used…</p>`;
    else if (col.leaf) body = `<p class="rt-note">This is at the top level of ${esc(base(col.path))}, not inside a function or class, so the thread ends here.</p>`;
    else if (!col.uses.length) body = `<p class="rt-note">${col.text ? "No other matches of the name." : `Nothing else uses ${esc(col.name)}${col.imports ? ` (only ${col.imports === 1 ? "an import" : col.imports + " imports"})` : ""}.`}</p>`;
    else body = `<p class="rt-count">${col.text ? "Text matches" : "Used"} ${col.uses.length === 1 ? "once" : col.uses.length + " times"} in ${files.length} file${files.length === 1 ? "" : "s"}${col.more ? ` (and ${col.more} more not shown)` : ""}${col.imports ? `, not counting ${col.imports} import${col.imports === 1 ? "" : "s"}` : ""}</p>` +
      files.map(([p, list]) => `<h4 title="${esc(p)}">${esc(app.isUnder(p, S.root) ? rel(p) : p)} <span>${list.length}</span></h4>` + list.map(([u, i]) => useHtml(u, k, i, col.pick === i)).join("")).join("");
    const textNote = col.text && !col.loading ? `<p class="rt-warn">No language server for ${esc(app.LANGS[langOf(col.path)]?.name || "these")} files is running, so these are places with the same name, which may include other things called ${esc(col.name)}.</p>` : "";
    return `<section class="rt-col${col.origin ? " origin" : ""}" data-k="${k}" aria-label="${esc(col.name)}">${head}${codeHtml(col)}${textNote}<div class="rt-uses" role="listbox" aria-label="Where ${esc(col.name)} is used">${body}</div></section>`;
  }
  function draw() {
    if (!T) { el.innerHTML = `<div class="rt-empty"><p>Put the cursor on a variable, a function, a class or a method and press <kbd>Shift Alt F12</kbd> to follow where it's used.</p></div>`; return; }
    const left = el.querySelector(".rt-board")?.scrollLeft || 0;
    const ups = [...el.querySelectorAll(".rt-uses")].map((u) => u.scrollTop);
    el.innerHTML = `<div class="rt-view">
      <div class="img-bar"><b>Red Thread</b><span class="img-info">${T.cols.length ? esc(T.cols.map((c) => c.name).join("  →  ")) : esc(T.name)}</span><span class="sp"></span>
        <span class="img-info">Click a use to follow it · double-click to open it · ← → between columns</span></div>
      <div class="rt-board" tabindex="-1"><div class="rt-row">${T.cols.length ? T.cols.map(colHtml).join("") : `<section class="rt-col"><p class="rt-note">Finding ${esc(T.name)}…</p></section>`}<svg class="rt-svg" aria-hidden="true"></svg></div></div>
    </div>`;
    const board = el.querySelector(".rt-board");
    board.scrollLeft = left;
    el.querySelectorAll(".rt-uses").forEach((u, i) => { u.scrollTop = ups[i] || 0; u.addEventListener("scroll", () => requestAnimationFrame(drawLines), { passive: true }); });
    board.addEventListener("scroll", () => requestAnimationFrame(drawLines), { passive: true });
    T.cols.forEach((col, k) => { if (!col.loading || col.sym || col.focus != null) fillCode(el.querySelectorAll(".rt-col")[k], col); });
    requestAnimationFrame(drawLines);
  }
  function scrollToEnd() {
    const board = el.querySelector(".rt-board");
    if (board) requestAnimationFrame(() => board.scrollTo({ left: board.scrollWidth, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
  }

  /** The red thread: from each picked use to the marked line in the column it leads to. */
  function drawLines() {
    const row = el.querySelector(".rt-row"), svg = el.querySelector(".rt-svg");
    if (!row || !svg || !T) return;
    const R = row.getBoundingClientRect();
    svg.setAttribute("width", row.scrollWidth);
    svg.setAttribute("height", row.clientHeight);
    let paths = "";
    const cols = el.querySelectorAll(".rt-col");
    T.cols.forEach((col, k) => {
      if (col.pick == null || !cols[k + 1]) return;
      const from = cols[k].querySelector(`.rt-use[data-i="${col.pick}"]`), to = cols[k + 1].querySelector(".rt-mark:not([hidden])") || cols[k + 1].querySelector(".rt-head");
      if (!from || !to) return;
      const list = cols[k].querySelector(".rt-uses").getBoundingClientRect();
      const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
      const x1 = a.right - R.left, y1 = Math.min(list.bottom - 4, Math.max(list.top + 4, a.top + a.height / 2)) - R.top;
      const x2 = b.left - R.left + 2, y2 = b.top + b.height / 2 - R.top;
      const mid = (x1 + x2) / 2;
      paths += `<path d="M${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}"/><circle cx="${x1}" cy="${y1}" r="3"/><circle cx="${x2}" cy="${y2}" r="3"/>`;
    });
    svg.innerHTML = paths;
  }

  // ----- getting around -----
  function focusEntry(k, i) {
    const n = el.querySelector(`.rt-use[data-k="${k}"][data-i="${i}"]`) || el.querySelector(`.rt-col[data-k="${k}"] .rt-use`);
    if (!n) { el.querySelector(".rt-board")?.focus({ preventScroll: true }); return; }
    el.querySelectorAll(".rt-use").forEach((x) => (x.tabIndex = -1));
    n.tabIndex = 0;
    n.focus({ preventScroll: true });
    n.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  async function openAt(path, range) {
    await app.openFile(path, range?.start || null);
  }
  el.addEventListener("click", (ev) => {
    const o = ev.target.closest("[data-open]");
    if (o) { const col = T?.cols[+o.dataset.open]; if (col) openAt(col.path, col.sym ? col.sym.sel : { start: { line: col.focus ?? 0, character: 0 } }); return; }
    const u = ev.target.closest(".rt-use");
    if (!u || ev.detail > 1) return;
    const k = +u.dataset.k, i = +u.dataset.i;
    follow(k, i).then(() => focusEntry(k, i));
  });
  el.addEventListener("dblclick", (ev) => {
    const u = ev.target.closest(".rt-use");
    if (!u) return;
    const use = T?.cols[+u.dataset.k]?.uses[+u.dataset.i];
    if (use) openAt(use.path, use.range);
  });
  el.addEventListener("keydown", (ev) => {
    const u = ev.target.closest?.(".rt-use");
    if (!u || !T) return;
    const k = +u.dataset.k, i = +u.dataset.i, col = T.cols[k];
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      const all = [...el.querySelectorAll(`.rt-use[data-k="${k}"]`)];
      const at = all.indexOf(u) + (ev.key === "ArrowDown" ? 1 : -1);
      if (all[at]) focusEntry(k, +all[at].dataset.i);
    } else if (ev.key === "ArrowRight" || (ev.key === "Enter" && !ev.ctrlKey)) {
      if (col.pick === i && T.cols[k + 1] && ev.key === "ArrowRight") focusEntry(k + 1, T.cols[k + 1].pick ?? 0);
      else follow(k, i).then(() => focusEntry(k + 1, 0));
    } else if (ev.key === "ArrowLeft") {
      if (k > 0) focusEntry(k - 1, T.cols[k - 1].pick ?? 0);
    } else if (ev.key === "Enter" && ev.ctrlKey) {
      openAt(col.uses[i].path, col.uses[i].range);
    } else return;
    ev.preventDefault();
  });
  new ResizeObserver(() => requestAnimationFrame(drawLines)).observe(el);

  function closeThread() {
    if (!T) return;
    // Files opened only to ask about them: closed again, unless they're open in a tab now.
    for (const [p, srv] of T.opened) if (!S.bufs.has(p)) { try { srv.close(p); } catch {} }
    T = null;
  }

  app.pages.push({
    el,
    match: (k) => k.startsWith(KEY),
    render: () => { if (!el.firstChild || !el.querySelector(".rt-view")) draw(); else requestAnimationFrame(drawLines); },
    label: () => (T ? `Red Thread: ${T.cols[0]?.name || T.name}` : "Red Thread"),
    dot: "rs",
    focus: () => { const k = T?.cols.length ? T.cols.length - 1 : 0; focusEntry(k, T?.cols[k]?.pick ?? 0); },
    close: () => { closeThread(); el.innerHTML = ""; },
  });
  // A restored session can't bring a thread back (nothing is saved): it opens empty.
  app.openers.push((path) => (String(path).startsWith(KEY) ? (app.addTab(KEY + "thread"), app.activate(KEY + "thread"), draw(), true) : null));
  app.command("nav.redThread", "Red Thread: follow everywhere this is used", "Shift+Alt+F12", start, { alias: "usages uses references callers who uses trace follow thread" });
}
