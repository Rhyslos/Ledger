// Getting around code: find all references, the outline view, symbol search
// (@ in this file, # anywhere), parameter hints while typing a call, and the
// ▶ Run / Debug links above tests and main functions.
import { invoke } from "@tauri-apps/api/core";
import { StateField, StateEffect, RangeSetBuilder, Prec } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, showTooltip, keymap } from "@codemirror/view";
import { norm, uriToPath, pathToUri, toOffset, toPos } from "./lsp.js";
import { dotOf } from "./langs.js";

const KINDS = { 1: "file", 2: "mod", 3: "ns", 4: "pkg", 5: "class", 6: "fn", 7: "prop", 8: "field", 9: "new", 10: "enum", 11: "trait", 12: "fn", 13: "let", 14: "const", 15: "str", 16: "num", 17: "bool", 18: "arr", 19: "obj", 20: "key", 21: "null", 22: "case", 23: "struct", 24: "event", 25: "op", 26: "T", 101: "h1", 102: "h2", 103: "h3", 104: "h4", 105: "h5", 106: "h6" }; // 10x: Markdown headings
const kindLabel = (k) => KINDS[k] || "";

export function initNav(app) {
  const { $, S, esc, rel, base } = app;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- find all references (Shift+F12) ----------
  async function findReferences() {
    const path = S.active, b = S.bufs.get(path);
    if (!b) return;
    const srv = app.needServer(b, "Find references");
    if (!srv) return;
    const v = app.view, pos = v.state.selection.main.head;
    const w = v.state.wordAt(pos);
    const name = w ? v.state.sliceDoc(w.from, w.to) : "";
    app.syncDoc(path, v.state.doc);
    const res = await srv.request("textDocument/references", { ...srv.at(path, v.state.doc, pos), context: { includeDeclaration: true } });
    if (!res || !res.length) { app.toast(name ? `No references to ${name} found.` : "No references found."); return; }
    const byFile = new Map();
    for (const loc of res) {
      const p = norm(uriToPath(loc.uri));
      if (!byFile.has(p)) byFile.set(p, []);
      byFile.get(p).push(loc.range);
    }
    // Show each hit's line of code.
    const texts = new Map();
    await Promise.all([...byFile.keys()].map(async (p) => {
      const ob = S.bufs.get(p);
      if (ob) { texts.set(p, ob.state.doc.toString().split("\n")); return; }
      try { texts.set(p, (await invoke("read_file", { path: p })).replace(/^﻿/, "").split(/\r?\n/)); } catch { texts.set(p, []); }
    }));
    const files = [...byFile.entries()].sort((a, c) => (a[0] === path ? -1 : c[0] === path ? 1 : rel(a[0]).localeCompare(rel(c[0]))));
    let first = true;
    $("refs").innerHTML = `<p class="empty" style="padding:6px 6px 2px">${res.length} reference${res.length === 1 ? "" : "s"} to <code>${esc(name)}</code> in ${files.length} file${files.length === 1 ? "" : "s"}</p>` +
      files.map(([p, ranges]) => {
        ranges.sort((a, c) => a.start.line - c.start.line || a.start.character - c.start.character);
        const lines = texts.get(p) || [];
        return `<h3>${esc(rel(p))} <span>${ranges.length}</span></h3>` + ranges.map((r) => {
          const t = lines[r.start.line] || "";
          const s = r.start.character, e = r.start.line === r.end.line ? r.end.character : t.length;
          const trim = t.length - t.trimStart().length;
          const html = esc(t.slice(trim, s)) + "<mark>" + esc(t.slice(s, e)) + "</mark>" + esc(t.slice(e).trimEnd());
          const row = `<div class="prob" role="button" tabindex="${first ? 0 : -1}" data-pp="${esc(p)}" data-l="${r.start.line}" data-c="${r.start.character}"><span class="sv" style="color:var(--t-${dotOf(p)})">●</span><span class="ms code" style="font:12.5px var(--mono)">${html}</span><span class="at">${r.start.line + 1}:${r.start.character + 1}</span></div>`;
          first = false;
          return row;
        }).join("");
      }).join("");
    app.focusPanel("refs");
  }

  // ---------- document symbols: outline view and @ in the palette ----------
  const sym = { path: null, doc: null, list: [], flat: [], loading: null };
  function normalize(res) {
    if (!Array.isArray(res)) return [];
    const isDoc = res.length && res[0].selectionRange;
    if (isDoc) {
      const walk = (s, depth, parentName) => ({ name: s.name, detail: s.detail || "", kind: s.kind, depth, container: parentName, range: s.range, sel: s.selectionRange.start, children: (s.children || []).map((c) => walk(c, depth + 1, s.name)) });
      return res.map((s) => walk(s, 0, ""));
    }
    return res.map((s) => ({ name: s.name, detail: "", kind: s.kind, depth: 0, container: s.containerName || "", range: s.location.range, sel: s.location.range.start, children: [] }))
      .sort((a, c) => a.range.start.line - c.range.start.line);
  }
  const flatten = (list) => list.flatMap((s) => [s, ...flatten(s.children)]);
  // Markdown's outline is its headings (# and underlined ones), nested by level; no server needed.
  function mdHeadings(doc) {
    const out = [], stack = [];
    let fence = null;
    for (let n = 1; n <= doc.lines; n++) {
      const t = doc.line(n).text;
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(t);
      if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
      if (fence) continue;
      let m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t), level, name;
      if (m) { level = m[1].length; name = m[2]; }
      else if (n > 1 && /^\s{0,3}(=+|-+)\s*$/.test(t) && doc.line(n - 1).text.trim() && !/^\s*([-*+]|\d+\.)\s/.test(doc.line(n - 1).text)) { level = t.trim()[0] === "=" ? 1 : 2; name = doc.line(n - 1).text.trim(); }
      if (!level || !name) continue;
      const line = m ? n - 1 : n - 2;
      const s = { name: name.replace(/[*_`]/g, ""), detail: "", kind: 100 + level, depth: 0, container: "", range: { start: { line, character: 0 }, end: { line, character: 0 } }, sel: { line, character: 0 }, children: [], level };
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const up = stack[stack.length - 1];
      s.depth = up ? up.depth + 1 : 0;
      s.container = up?.name || "";
      (up ? up.children : out).push(s);
      stack.push(s);
    }
    // Each heading's section runs to the next heading at its level or above.
    const all = flatten(out), last = Math.max(0, doc.lines - 1);
    all.forEach((h, i) => { const next = all.slice(i + 1).find((x) => x.level <= h.level); h.range.end = { line: next ? Math.max(h.range.start.line, next.range.start.line - 1) : last, character: 1e9 }; });
    return out;
  }
  async function loadSymbols(force) {
    const path = S.active, b = S.bufs.get(path);
    if (b && b.lang === "markdown") {
      if (force || sym.path !== path || sym.doc !== b.state.doc) { const list = mdHeadings(b.state.doc); Object.assign(sym, { path, doc: b.state.doc, list, flat: flatten(list), none: null }); }
      return sym;
    }
    const srv = b && app.serverOf(b);
    // No server: remember that for this text, so the @ list doesn't ask again on every redraw.
    if (!b || !srv?.alive) { Object.assign(sym, { path, doc: b ? b.state.doc : null, list: [], flat: [], none: !srv ? "nolang" : "noserver" }); return sym; }
    if (!force && sym.path === path && sym.doc === b.state.doc) return sym;
    if (sym.loading && sym.loadingFor === path) return sym.loading;
    sym.loadingFor = path;
    sym.loading = (async () => {
      app.syncDoc(path);
      const doc = b.state.doc;
      const res = await srv.request("textDocument/documentSymbol", { textDocument: { uri: pathToUri(path) } });
      if (S.active !== path) return sym;
      sym.path = path; sym.doc = doc; sym.none = res ? null : "none";
      sym.list = normalize(res);
      sym.flat = flatten(sym.list);
      return sym;
    })().finally(() => { sym.loading = null; });
    return sym.loading;
  }

  let outlineT = null;
  function scheduleOutline(ms = 600) {
    clearTimeout(outlineT);
    outlineT = setTimeout(() => { if (app.sideView === "outline") refreshOutline(); }, ms);
  }
  async function refreshOutline() {
    await loadSymbols();
    renderOutline();
  }
  function hereSymbol() {
    const v = app.view, b = S.bufs.get(S.active);
    if (!b || sym.path !== S.active) return null;
    const pos = toPos(v.state.doc, v.state.selection.main.head);
    const inside = (r) => (r.start.line < pos.line || (r.start.line === pos.line && r.start.character <= pos.character)) && (r.end.line > pos.line || (r.end.line === pos.line && r.end.character >= pos.character));
    let best = null;
    for (const s of sym.flat) if (inside(s.range) && (!best || s.depth >= best.depth)) best = s;
    return best;
  }
  function renderOutline() {
    const box = $("outline");
    const hadFocus = box.contains(document.activeElement) ? document.activeElement.dataset.i : null;
    $("outlineName").textContent = S.bufs.has(S.active) ? "OUTLINE · " + app.base(S.active).toUpperCase() : "OUTLINE";
    if (!S.bufs.has(S.active)) { box.innerHTML = '<p class="hint" style="padding:6px 8px">Open a file to see what\'s in it.</p>'; return; }
    if (sym.path !== S.active) { box.innerHTML = '<p class="hint" style="padding:6px 8px">Loading…</p>'; return; }
    if (!sym.flat.length) {
      box.innerHTML = `<p class="hint" style="padding:6px 8px;white-space:normal">${sym.none === "nolang" ? "No outline for this kind of file." : sym.none === "noserver" ? "The language server isn't running yet." : "Nothing to list in this file."}</p>`;
      return;
    }
    const q = $("outlineFilter").value.trim().toLowerCase();
    const here = hereSymbol();
    const shown = q ? sym.flat.filter((s) => s.name.toLowerCase().includes(q)) : sym.flat;
    box.innerHTML = shown.map((s) => {
      const i = sym.flat.indexOf(s);
      return `<button class="node${s === here ? " here" : ""}" role="treeitem" aria-level="${s.depth + 1}" tabindex="-1" data-i="${i}" style="padding-left:${6 + (q ? 0 : s.depth) * 14}px" title="${esc(s.detail || s.name)}"><span class="kind">${kindLabel(s.kind)}</span><span class="lbl">${esc(s.name)}</span>${s.detail && s.detail.length < 60 ? `<span class="sub">${esc(s.detail)}</span>` : q && s.container ? `<span class="sub">${esc(s.container)}</span>` : ""}</button>`;
    }).join("") || '<p class="hint" style="padding:6px 8px">No symbols match.</p>';
    const cur = (hadFocus != null && box.querySelector(`[data-i="${hadFocus}"]`)) || box.querySelector(".here") || box.querySelector(".node");
    if (cur) { cur.tabIndex = 0; if (hadFocus != null) cur.focus({ preventScroll: true }); cur.scrollIntoView({ block: "nearest" }); }
  }
  function goSymbol(s, keepFocus) {
    app.activate(S.active, s.sel, { keepFocus });
  }
  $("outline").addEventListener("click", (ev) => { const n = ev.target.closest("[data-i]"); if (n) goSymbol(sym.flat[+n.dataset.i]); });
  $("outline").addEventListener("keydown", (ev) => {
    const el = ev.target.closest(".node");
    if (!el) return;
    const nodes = [...$("outline").querySelectorAll(".node")], i = nodes.indexOf(el), k = app.keyString(ev);
    const go = (n) => { if (!n) return; nodes.forEach((x) => (x.tabIndex = x === n ? 0 : -1)); n.focus(); n.scrollIntoView({ block: "nearest" }); };
    if (k === "Down") go(nodes[i + 1]);
    else if (k === "Up") { if (i === 0) $("outlineFilter").focus(); else go(nodes[i - 1]); }
    else if (k === "Home") go(nodes[0]);
    else if (k === "End") go(nodes[nodes.length - 1]);
    else if (k === "PageDown") go(nodes[Math.min(nodes.length - 1, i + 15)]);
    else if (k === "PageUp") go(nodes[Math.max(0, i - 15)]);
    else if (k === "Enter") goSymbol(sym.flat[+el.dataset.i]);
    else if (k === "Space") goSymbol(sym.flat[+el.dataset.i], true);
    else if (k === "Esc") app.focusZone("editor");
    else if (ev.key.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) { const f = $("outlineFilter"); f.focus(); f.value += ev.key; renderOutline(); }
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  });
  $("outlineFilter").oninput = renderOutline;
  $("outlineFilter").addEventListener("keydown", (ev) => {
    const k = app.keyString(ev);
    if (k === "Down" || k === "Enter") { ev.preventDefault(); const n = $("outline").querySelector(".node"); if (k === "Enter" && n) goSymbol(sym.flat[+n.dataset.i]); else if (n) { n.tabIndex = 0; n.focus(); } }
    if (k === "Esc") { ev.preventDefault(); if (ev.target.value) { ev.target.value = ""; renderOutline(); } else app.focusZone("editor"); }
  });
  app.sideViews.outline.render = () => refreshOutline();
  app.sideViews.outline.focus = async () => {
    await refreshOutline();
    const n = $("outline").querySelector(".here") || $("outline").querySelector(".node");
    if (n) { $("outline").querySelectorAll(".node").forEach((x) => (x.tabIndex = x === n ? 0 : -1)); n.focus(); } else $("outlineFilter").focus();
  };
  app.activeHooks.push(() => { if (app.sideView === "outline") refreshOutline(); });
  app.bufListeners.push((path) => { if (path === S.active) scheduleOutline(800); });
  app.readyHooks.push(() => { if (app.sideView === "outline") refreshOutline(); });
  let hereT = null;
  const outlineCursor = EditorView.updateListener.of((u) => {
    if (!u.selectionSet || u.view !== app.view || app.sideView !== "outline") return;
    clearTimeout(hereT);
    hereT = setTimeout(() => {
      const h = hereSymbol(), box = $("outline");
      if (box.contains(document.activeElement)) return;
      box.querySelectorAll(".node.here").forEach((n) => n.classList.remove("here"));
      if (h) { const n = box.querySelector(`[data-i="${sym.flat.indexOf(h)}"]`); n?.classList.add("here"); n?.scrollIntoView({ block: "nearest" }); }
    }, 120);
  });

  // @ symbols in this file, # symbols anywhere
  app.palModes.push({
    prefix: "@",
    draw(q, redraw, row) {
      if (S.bufs.has(S.active) && (sym.path !== S.active || sym.doc !== S.bufs.get(S.active).state.doc) && !sym.loading) { loadSymbols().then((r) => { if (r?.doc) redraw(); }); }
      const b = S.bufs.get(S.active);
      if (!b) return { list: [], html: '<p class="empty" style="padding:8px 10px">Open a file first.</p>' };
      if (sym.path !== S.active) return { list: [], html: '<p class="empty" style="padding:8px 10px">Loading symbols…</p>' };
      q = q.trim().toLowerCase();
      const list = sym.flat.filter((s) => !q || s.name.toLowerCase().includes(q)).slice(0, 200);
      return {
        list: list.map((s) => ({ s })),
        html: list.map((s, i) => row(i, dotOf(S.active), esc("  ".repeat(q ? 0 : s.depth)) + `<span class="kind" style="color:var(--faint);font:600 10.5px var(--mono);margin-right:6px">${kindLabel(s.kind)}</span>` + esc(s.name), `${s.range.start.line + 1}`, s.detail && s.detail.length < 90 ? esc(s.detail) : "", true)).join("")
          || `<p class="empty" style="padding:8px 10px">${sym.none === "nolang" ? "No symbols for this kind of file." : sym.none === "noserver" ? "Symbols come from the language server, which isn't running for this file." : sym.flat.length ? "No symbols match." : "No symbols found."}</p>`,
      };
    },
    pick(it) { goSymbol(it.s); },
  });
  const ws = { q: null, list: [], t: null, busy: false };
  app.palModes.push({
    prefix: "#",
    draw(q, redraw, row) {
      q = q.trim();
      if (q !== ws.q) {
        ws.q = q;
        clearTimeout(ws.t);
        ws.busy = !!q;
        if (q) ws.t = setTimeout(async () => {
          const alive = Object.values(app.servers).filter((s) => s.alive);
          const all = (await Promise.all(alive.map((s) => s.request("workspace/symbol", { query: q })))).flat().filter(Boolean);
          if (ws.q !== q) return;
          ws.busy = false;
          ws.list = all.filter((s) => s.location?.uri).map((s) => ({ name: s.name, kind: s.kind, container: s.containerName || "", path: norm(uriToPath(s.location.uri)), at: s.location.range?.start || { line: 0, character: 0 } }))
            .sort((a, c) => (a.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1) - (c.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1) || a.name.length - c.name.length)
            .slice(0, 150);
          redraw();
        }, 180);
        else ws.list = [];
      }
      if (!Object.values(app.servers).some((s) => s.alive)) return { list: [], html: '<p class="empty" style="padding:8px 10px">Symbol search needs rust-analyzer or the C# server running.</p>' };
      return {
        list: ws.list.map((s) => ({ ws: s })),
        html: ws.list.map((s, i) => row(i, dotOf(s.path), `<span class="kind" style="color:var(--faint);font:600 10.5px var(--mono);margin-right:6px">${kindLabel(s.kind)}</span>` + esc(s.name), esc(rel(s.path)), s.container ? esc(s.container) : "", true)).join("")
          || `<p class="empty" style="padding:8px 10px">${!q ? "Type a name: a function, type, method…" : ws.busy ? "Searching…" : "Nothing found."}</p>`,
      };
    },
    pick(it) { app.openFile(it.ws.path, it.ws.at); },
  });

  // ---------- parameter hints while typing a call ----------
  const setSig = StateEffect.define();
  const sigField = StateField.define({
    create: () => null,
    update(v, tr) {
      for (const e of tr.effects) if (e.is(setSig)) return e.value;
      if (v && tr.docChanged) return { ...v, pos: tr.changes.mapPos(v.pos) };
      return v;
    },
    provide: (f) => showTooltip.from(f),
  });
  function sigDom(r) {
    const sigs = r.signatures || [];
    const si = Math.min(r.activeSignature || 0, sigs.length - 1);
    const s = sigs[si];
    const el = document.createElement("div");
    el.className = "cm-sig";
    const ap = s.activeParameter ?? r.activeParameter ?? 0;
    const p = (s.parameters || [])[ap];
    let label = esc(s.label);
    if (p) {
      let a = -1, e = -1;
      if (Array.isArray(p.label)) [a, e] = p.label;
      else { a = s.label.indexOf(p.label, s.label.indexOf("(") + 1); if (a < 0) a = s.label.indexOf(p.label); e = a + p.label.length; }
      if (a >= 0) label = esc(s.label.slice(0, a)) + "<b>" + esc(s.label.slice(a, e)) + "</b>" + esc(s.label.slice(e));
    }
    el.innerHTML = (sigs.length > 1 ? `<span style="color:var(--faint)">${si + 1}/${sigs.length}  </span>` : "") + label;
    const doc = p?.documentation || s.documentation;
    const text = typeof doc === "string" ? doc : doc?.value;
    if (text && text.trim()) { const d = document.createElement("div"); d.className = "doc"; d.textContent = text.trim().split("\n\n")[0].slice(0, 400); el.append(d); }
    return el;
  }
  let sigSeq = 0;
  async function requestSig(view, path, trigger, manual) {
    const b = S.bufs.get(path), srv = app.serverOf(b);
    if (!srv?.alive || !srv.caps?.signatureHelpProvider) { if (manual) app.toast("Parameter hints aren't available here."); return; }
    const seq = ++sigSeq;
    app.syncDoc(path, view.state.doc);
    const open = !!view.state.field(sigField, false);
    const pos = view.state.selection.main.head;
    const r = await srv.request("textDocument/signatureHelp", {
      ...srv.at(path, view.state.doc, pos),
      context: { triggerKind: manual ? 1 : trigger ? 2 : 3, triggerCharacter: trigger || undefined, isRetrigger: open },
    });
    if (seq !== sigSeq) return;
    if (!r || !r.signatures?.length) { if (view.state.field(sigField, false)) view.dispatch({ effects: setSig.of(null) }); if (manual) app.toast("No parameter hints here."); return; }
    const dom = sigDom(r);
    view.dispatch({ effects: setSig.of({ pos: view.state.selection.main.head, above: true, strictSide: false, create: () => ({ dom }) }) });
  }
  const closeSig = (v) => { if (!v.state.field(sigField, false)) return false; v.dispatch({ effects: setSig.of(null) }); return true; };
  const sigTriggers = (srv) => srv?.caps?.signatureHelpProvider?.triggerCharacters || ["(", ","];
  function sigExt(path) {
    let t = null;
    return [
      sigField,
      Prec.high(keymap.of([{ key: "Escape", run: closeSig }])),
      EditorView.updateListener.of((u) => {
        const open = !!u.state.field(sigField, false);
        let typed = null;
        if (u.docChanged) u.transactions.forEach((tr) => { if (tr.isUserEvent("input.type")) tr.changes.iterChanges((_a, _b, _c, _d, ins) => { const s = ins.toString(); if (s) typed = s.length === 2 && "([{".includes(s[0]) ? s[0] : s[s.length - 1]; }); });
        const srv = app.serverOf(S.bufs.get(path));
        if (typed === ")" && open) { closeSig(u.view); return; }
        if (typed && sigTriggers(srv).includes(typed)) { clearTimeout(t); t = setTimeout(() => requestSig(u.view, path, typed), 40); return; }
        if (open && (u.docChanged || u.selectionSet)) { clearTimeout(t); t = setTimeout(() => requestSig(u.view, path, null), 120); }
      }),
    ];
  }

  // ---------- ▶ Run / Debug above tests and main ----------
  const setLenses = StateEffect.define();
  class LensWidget extends WidgetType {
    constructor(items, indent) { super(); this.items = items; this.indent = indent; }
    eq(o) { return o.indent === this.indent && JSON.stringify(o.items.map((i) => i.title + i.hint)) === JSON.stringify(this.items.map((i) => i.title + i.hint)); }
    toDOM() {
      const d = document.createElement("div");
      d.className = "cm-lens";
      d.style.paddingLeft = this.indent + "ch";
      this.items.forEach((it, i) => {
        if (i) { const s = document.createElement("span"); s.textContent = "·"; d.append(s); }
        const a = document.createElement("a");
        a.textContent = it.title;
        a.title = it.hint || "";
        a.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); it.run(); };
        d.append(a);
      });
      return d;
    }
    ignoreEvent() { return true; }
  }
  const lensField = StateField.define({
    create: () => ({ deco: Decoration.none, list: [] }),
    update(v, tr) {
      for (const e of tr.effects) if (e.is(setLenses)) return e.value;
      if (!tr.docChanged) return v;
      return { deco: v.deco.map(tr.changes), list: v.list.map((l) => ({ ...l, pos: tr.changes.mapPos(l.pos) })) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
  const lensTimers = new Map();
  function scheduleLenses(path, ms = 1200) {
    clearTimeout(lensTimers.get(path));
    lensTimers.set(path, setTimeout(() => refreshLenses(path), ms));
  }
  async function computeLenses(path, b) {
    const doc = b.state.doc;
    if (b.lang === "rust") {
      const srv = app.serverOf(b);
      if (!srv?.alive) return null;
      app.syncDoc(path);
      const res = await srv.request("experimental/runnables", { textDocument: { uri: pathToUri(path) } });
      if (!Array.isArray(res)) return null;
      const out = [];
      for (const r of res) {
        if (r.kind !== "cargo" || !r.location || !r.args) continue;
        const sub = (r.args.cargoArgs || [])[0];
        const isTest = sub === "test", isRun = sub === "run";
        if (!isTest && !isRun) continue;
        const doctest = /^doctest/.test(r.label);
        const many = /^test-mod|^cargo test/.test(r.label) || !(r.args.executableArgs || []).includes("--exact");
        const items = [{ title: isRun ? "▶ Run" : many ? "▶ Run tests" : "▶ Run test", hint: r.label, run: () => runRunnable(r) }];
        if (!doctest) items.push({ title: "Debug", hint: "Debug " + r.label.replace(/^(test|run|test-mod) /, ""), run: () => app.debug?.runnable(r) });
        const line = r.location.targetRange.start.line;
        out.push({ pos: toOffset(doc, { line, character: 0 }), items, r });
      }
      return out;
    }
    if (b.lang === "csharp") {
      const out = [];
      let cls = "";
      for (let n = 1; n <= doc.lines; n++) {
        const t = doc.line(n).text;
        const c = /\bclass\s+(\w+)/.exec(t);
        if (c) cls = c[1];
        if (!/^\s*\[(Fact|Theory|Test|TestCase|TestMethod|DataTestMethod)\b/.test(t)) continue;
        let m = null;
        for (let k = n; k <= Math.min(doc.lines, n + 6) && !m; k++) m = /\b(?:void|Task)\s+(\w+)\s*\(/.exec(doc.line(k).text);
        if (!m) continue;
        const filter = `FullyQualifiedName~${cls ? cls + "." : ""}${m[1]}`;
        out.push({ pos: doc.line(n).from, items: [{ title: "▶ Run test", hint: "dotnet test --filter " + filter, run: () => runDotnetTest(path, filter, m[1]) }] });
        while (out.length > 1 && out[out.length - 2].pos === out[out.length - 1].pos) out.splice(out.length - 2, 1);
      }
      return out;
    }
    return [];
  }
  async function refreshLenses(path) {
    const b = S.bufs.get(path);
    if (!b || b.ro) return;
    if (!app.settings.codeLens) { app.dispatchBuf(path, { effects: setLenses.of({ deco: Decoration.none, list: [] }) }); return; }
    const doc = b.state.doc;
    const list = await computeLenses(path, b);
    const cur = S.bufs.get(path);
    if (!list || !cur || cur.state.doc !== doc) return;
    list.sort((a, c) => a.pos - c.pos);
    const builder = new RangeSetBuilder();
    for (const l of list) {
      const line = doc.lineAt(l.pos);
      const indent = line.text.length - line.text.trimStart().length;
      builder.add(line.from, line.from, Decoration.widget({ widget: new LensWidget(l.items, indent), block: true, side: -1 }));
    }
    app.dispatchBuf(path, { effects: setLenses.of({ deco: builder.finish(), list }) });
  }
  function runRunnable(r) {
    const a = r.args;
    const args = [...(a.cargoArgs || []), ...(a.cargoExtraArgs || [])];
    const exe = a.executableArgs || [];
    if (exe.length) args.push("--", ...exe);
    app.startSteps([{ label: r.label, program: a.overrideCargo || "cargo", args, cwd: norm(a.cwd || a.workspaceRoot || app.cwd()), input: true }]);
  }
  async function runDotnetTest(path, filter, name) {
    const P = await app.projectFor(path);
    const target = P?.csproj || P?.sln;
    app.startSteps([{ label: "test " + name, program: "dotnet", args: ["test", ...(target ? [target] : []), "--filter", filter, "-nologo"], cwd: P?.dir || app.cwd(), input: true }]);
  }
  /** The lens for the code at the cursor: the nearest one above it. */
  function lensAtCursor() {
    const v = app.view, b = S.bufs.get(S.active);
    if (!b) return null;
    const st = v.state.field(lensField, false);
    if (!st?.list.length) return null;
    const head = v.state.selection.main.head;
    const above = st.list.filter((l) => l.pos <= v.state.doc.lineAt(head).to);
    return above[above.length - 1] || st.list[0];
  }
  function runAtCursor(debug) {
    const l = lensAtCursor();
    if (!l) { app.toast(app.settings.codeLens ? "No test or main function here." : "Turn on Run and Debug links in Settings first."); return; }
    const it = debug ? l.items.find((i) => i.title === "Debug") : l.items[0];
    if (!it) { app.toast("That can't be debugged."); return; }
    it.run();
  }
  app.saveHooks.push((path) => scheduleLenses(path, 300));
  app.activeHooks.push((key) => { if (S.bufs.has(key)) scheduleLenses(key, 150); });
  app.readyHooks.push(() => { for (const p of S.bufs.keys()) scheduleLenses(p, 200); });
  app.bufListeners.push((path) => scheduleLenses(path, 1500));
  app.decorationCopiers.push((path, b) => {
    const v = b.state.field(lensField, false);
    if (v) app.panes.find((p) => p.view?.state === b.mirror)?.view.dispatch({ effects: setLenses.of(v) });
  });

  app.extraExt.push((path, b) => {
    const hasServer = !!app.LANGS[b.lang].server && !b.virtual;
    return [
      hasServer ? sigExt(path) : [],
      hasServer || b.lang === "markdown" ? outlineCursor : [], // Markdown: its headings
      (b.lang === "rust" || b.lang === "csharp") && app.settings.codeLens ? lensField : [],
    ];
  });

  const C = app.command;
  C("editor.references", "Find all references", "Shift+F12", findReferences);
  C("outline.show", "Outline (symbols in this file)", "Ctrl+Shift+O", () => app.showSideView("outline", true));
  C("symbol.file", "Go to symbol in file", [], () => app.openPaletteWith("@"));
  C("symbol.workspace", "Go to symbol anywhere", "Ctrl+Alt+O", () => app.openPaletteWith("#"));
  C("editor.signature", "Show parameter hints", "Ctrl+Shift+Space", () => { if (S.bufs.has(S.active)) requestSig(app.view, S.active, null, true); });
  C("test.runAtCursor", "Run the test (or main) at the cursor", "Ctrl+Shift+F10", () => runAtCursor(false));
  C("test.debugAtCursor", "Debug the test (or main) at the cursor", "Ctrl+Shift+F9", () => runAtCursor(true));

  return { findReferences, refreshOutline, refreshLenses, lensAtCursor };
}
