// More from the language servers: colours from what the server knows (semantic tokens: a type
// coloured as a type, a method as a method, wherever they are), the other uses of the symbol
// under the cursor, go to implementation and type definition, and call and type hierarchies.
// Language-neutral; C# (csharp-ls, Roslyn) is the main user, and the others work too.
import { StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import { uriToPath, pathToUri, toOffset, toPos } from "./lsp.js";

import { semanticClass, decodeTokens } from "./semantic.js";

const setSem = StateEffect.define();
const semField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setSem)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const setHl = StateEffect.define();
const hlField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    if (tr.docChanged) deco = Decoration.none; // stale the moment you type
    for (const e of tr.effects) if (e.is(setHl)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
const hlMark = { 1: Decoration.mark({ class: "cm-dochl" }), 2: Decoration.mark({ class: "cm-dochl" }), 3: Decoration.mark({ class: "cm-dochl cm-dochl-w" }) };

export const STANDARD_TYPES = ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"];
export const STANDARD_MODS = ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"];

export function initLspMore(app) {
  const { S, settings } = app;
  const wants = (b) => {
    const mode = settings.semanticColours ?? "csharp";
    return mode === "all" || (mode === "csharp" && b?.lang === "csharp");
  };

  // ----- semantic colours -----
  const timers = new Map(), asked = new Map();
  async function refreshSemantic(path) {
    const b = S.bufs.get(path), srv = app.serverOf(b);
    if (!b) return;
    if (!wants(b) || !srv?.alive || !srv.caps?.semanticTokensProvider) { app.dispatchBuf(path, { effects: setSem.of(Decoration.none) }); return; }
    const doc = b.state.doc;
    if (doc.length > 2_000_000 || asked.get(path) === doc) return;
    asked.set(path, doc);
    app.syncDoc(path);
    const prov = srv.caps.semanticTokensProvider;
    if (!prov.full) return;
    const r = await srv.request("textDocument/semanticTokens/full", { textDocument: { uri: pathToUri(path) } }, 15000);
    const cur = S.bufs.get(path);
    if (!cur || cur.state.doc !== doc || !Array.isArray(r?.data)) return; // typed meanwhile: a newer request follows
    const toks = decodeTokens(doc, r.data, prov.legend).sort((a, c) => a.from - c.from || a.to - c.to);
    const builder = new RangeSetBuilder();
    let last = -1;
    for (const t of toks) { if (t.from < last) continue; builder.add(t.from, t.to, Decoration.mark({ class: t.cls })); last = t.to; }
    app.dispatchBuf(path, { effects: setSem.of(builder.finish()) });
  }
  const soon = (path, ms = 350) => { clearTimeout(timers.get(path)); timers.set(path, setTimeout(() => refreshSemantic(path), ms)); };
  app.extraExt.push((path, b) => [semField, hlField, cursorWatch]);
  app.bufListeners.push((path) => soon(path, 450));
  app.activeHooks.push((key) => { if (S.bufs.has(key)) soon(key, 100); });
  app.readyHooks.push(() => { asked.clear(); for (const p of S.bufs.keys()) soon(p, 200); });
  app.settingHooks.push((k) => { if (k === "semanticColours") { asked.clear(); for (const p of S.bufs.keys()) soon(p, 30); } });
  app.lspHooks.semanticRefresh = () => { asked.clear(); for (const p of S.bufs.keys()) soon(p, 100); };
  app.decorationCopiers.push((path, b) => {
    const v = b.state.field(semField, false);
    if (v) app.panes.find((p) => p.view?.state === b.mirror)?.view.dispatch({ effects: setSem.of(v) });
  });

  // ----- other uses of the symbol under the cursor -----
  let hlTimer = 0, hlSeq = 0;
  const cursorWatch = EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged) return;
    clearTimeout(hlTimer);
    const v = u.view;
    hlTimer = setTimeout(() => highlightUses(v), 250);
  });
  async function highlightUses(v) {
    const path = S.active, b = S.bufs.get(path);
    if (!b || v !== app.view || settings.symbolHighlight === false) return;
    const srv = app.serverOf(b);
    const sel = v.state.selection.main;
    if (!srv?.alive || !srv.caps?.documentHighlightProvider || !sel.empty || !v.state.wordAt(sel.head)) { if (v.state.field(hlField, false)?.size) v.dispatch({ effects: setHl.of(Decoration.none) }); return; }
    const seq = ++hlSeq, doc = v.state.doc;
    app.syncDoc(path, doc);
    const r = await srv.request("textDocument/documentHighlight", srv.at(path, doc, sel.head), 5000);
    if (seq !== hlSeq || v.state.doc !== doc || !Array.isArray(r)) return;
    const marks = r.map((h) => ({ from: toOffset(doc, h.range.start), to: toOffset(doc, h.range.end), k: h.kind || 1 })).filter((x) => x.to > x.from).sort((a, c) => a.from - c.from);
    const builder = new RangeSetBuilder();
    let last = -1;
    for (const m of marks.length > 1 ? marks : []) { if (m.from < last) continue; builder.add(m.from, m.to, hlMark[m.k] || hlMark[1]); last = m.to; }
    v.dispatch({ effects: setHl.of(builder.finish()) });
  }

  // ----- go to implementation / type definition -----
  const at = () => {
    const path = S.active, b = S.bufs.get(path), v = app.view;
    if (!b || !v) return null;
    return { path, b, v, pos: v.state.selection.main.head };
  };
  async function goTo(method, what, cap) {
    const c = at();
    if (!c) return;
    const srv = app.needServer(c.b, what);
    if (!srv) return;
    if (!srv.caps?.[cap]) { app.toast(`${srv.label} can't do “${what}”.`); return; }
    app.syncDoc(c.path, c.v.state.doc);
    const r = await srv.request(method, srv.at(c.path, c.v.state.doc, c.pos));
    const list = (Array.isArray(r) ? r : r ? [r] : []).map((l) => ({ uri: l.targetUri || l.uri, range: l.targetSelectionRange || l.range }));
    if (!list.length) { app.toast(`No ${what.toLowerCase().replace(/^go to /, "")} found.`); return; }
    if (list.length === 1) { await app.openFile(uriToPath(list[0].uri), list[0].range.start, { uri: list[0].uri, server: srv }); return; }
    const w = c.v.state.wordAt(c.pos), name = w ? c.v.state.sliceDoc(w.from, w.to) : "";
    await app.showLocations(`${list.length} ${what === "Go to implementation" ? "implementations" : "places"} of <code>${app.esc(name)}</code>`, list.filter((l) => /^file:/.test(l.uri)));
  }

  // ----- call and type hierarchies -----
  const KIND = { 5: "class", 6: "method", 9: "constructor", 10: "enum", 11: "interface", 12: "function", 23: "struct" };
  async function hierarchy(kind, dir) {
    const c = at();
    if (!c) return;
    const call = kind === "call";
    const srv = app.needServer(c.b, call ? "Call hierarchy" : "Type hierarchy");
    if (!srv) return;
    if (!srv.caps?.[call ? "callHierarchyProvider" : "typeHierarchyProvider"]) { app.toast(`${srv.label} can't show ${call ? "callers" : "base and derived types"}.`); return; }
    app.syncDoc(c.path, c.v.state.doc);
    const items = await srv.request(call ? "textDocument/prepareCallHierarchy" : "textDocument/prepareTypeHierarchy", srv.at(c.path, c.v.state.doc, c.pos));
    const item = Array.isArray(items) ? items[0] : null;
    if (!item) { app.toast(call ? "Put the cursor on a method or function." : "Put the cursor on a type."); return; }
    const method = call ? (dir === "in" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls") : (dir === "in" ? "typeHierarchy/subtypes" : "typeHierarchy/supertypes");
    const r = (await srv.request(method, { item })) || [];
    let locs;
    if (call && dir === "in") locs = r.flatMap((x) => (x.fromRanges?.length ? x.fromRanges : [x.from.selectionRange]).map((range) => ({ uri: x.from.uri, range, note: x.from.name })));
    else if (call) locs = r.map((x) => ({ uri: x.to.uri, range: x.to.selectionRange, note: x.to.name }));
    else locs = r.map((x) => ({ uri: x.uri, range: x.selectionRange, note: `${KIND[x.kind] || ""} ${x.name}`.trim() }));
    locs = locs.filter((l) => /^file:/.test(l.uri));
    const label = call ? (dir === "in" ? `Callers of` : `What`) : dir === "in" ? "Types derived from" : "Base types of";
    if (!locs.length) { app.toast(call ? (dir === "in" ? `Nothing calls ${item.name} (in your code).` : `${item.name} doesn't call anything in your code.`) : dir === "in" ? `Nothing in your code derives from ${item.name}.` : `${item.name} has no base types in your code.`); return; }
    await app.showLocations(call && dir === "out" ? `What <code>${app.esc(item.name)}</code> calls: ${locs.length}` : `${label} <code>${app.esc(item.name)}</code>: ${locs.length}`, locs);
  }

  app.command("nav.implementation", "Go to implementation", "Ctrl+F12", () => goTo("textDocument/implementation", "Go to implementation", "implementationProvider"), { alias: "implementations overrides derived" });
  app.command("nav.typeDefinition", "Go to type definition", [], () => goTo("textDocument/typeDefinition", "Go to type definition", "typeDefinitionProvider"), { alias: "type of" });
  app.command("nav.callers", "Show callers (call hierarchy)", "Shift+Alt+H", () => hierarchy("call", "in"), { alias: "incoming calls who calls" });
  app.command("nav.callees", "Show what this calls (call hierarchy)", [], () => hierarchy("call", "out"), { alias: "outgoing calls" });
  app.command("nav.subtypes", "Show derived types (type hierarchy)", [], () => hierarchy("type", "in"), { alias: "subclasses implementations inheritors" });
  app.command("nav.supertypes", "Show base types (type hierarchy)", [], () => hierarchy("type", "out"), { alias: "superclass base class interfaces" });
}
