import "./style.css";
if (import.meta.env.VITE_DEBUG) import("./debug.js");
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { on as listen, winLabel } from "./win.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EditorState, Text, ChangeSet, Compartment, StateEffect, StateField, RangeSetBuilder, Annotation, Transaction } from "@codemirror/state";
import {
  EditorView, keymap as cmKeymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightActiveLine, hoverTooltip, showTooltip, Decoration, WidgetType,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxHighlighting, HighlightStyle, indentUnit, StreamLanguage } from "@codemirror/language";
import { lintGutter, setDiagnostics, lintKeymap } from "@codemirror/lint";
import { rustLanguage } from "@codemirror/lang-rust";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { tags as t, highlightCode } from "@lezer/highlight";
import { Lsp, norm, uriToPath, pathToUri, toOffset, toPos, severity, unsnippet, completionType } from "./lsp.js";
import { ansiToHtml, esc } from "./ansi.js";
import { LANGS, langOf, dotOf } from "./langs.js";
import { Keymap, keyString } from "./keys.js";
import { settings, DEFAULTS, loadSettings, setSetting, initSettings, settingsHtml, wireSettings, isRecording, refreshSettingsTools } from "./settings.js";
import { APP_NAME } from "./app.js";
import { bracketColors, indentGuides, stickyScroll } from "./editorx.js";
import { initTerminal } from "./terminal.js";
import { initNav } from "./nav.js";
import { initDeps } from "./deps.js";
import { initSnippets } from "./snippets.js";
import { initGit } from "./git.js";
import { initDebugger } from "./debugger.js";

// ---------- prefs (window layout & sessions; settings live in settings.json) ----------
// Same key the Ledger build from the Rust course chat used, so recent folders carry over.
const PREF_KEY = "ledger-prefs-v1";
const prefs = { recent: [], sideW: 270, panelH: 230, collapsed: false, sessions: {}, last: null };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || localStorage.getItem("ferrous-prefs-v1") || "{}")); } catch {}
delete prefs.theme; delete prefs.hints; // these moved to settings.json
const forgotten = new Set(); // recent folders that no longer open
// Several windows share these, so merge with what's stored rather than overwrite:
// each window only owns its own folder's session.
const savePrefs = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    const mine = typeof S !== "undefined" && S.root ? S.root : null;
    const sessions = { ...(stored.sessions || {}) };
    if (mine && prefs.sessions[mine]) sessions[mine] = prefs.sessions[mine];
    const recent = [...new Set([...(prefs.recent || []), ...(stored.recent || [])])].filter((r) => !forgotten.has(r)).slice(0, 8);
    for (const k of Object.keys(sessions)) if (!recent.includes(k)) delete sessions[k];
    const breakpoints = { ...(stored.breakpoints || {}) };
    if (mine && prefs.breakpoints?.[mine]) breakpoints[mine] = prefs.breakpoints[mine];
    for (const k of Object.keys(breakpoints)) if (!recent.includes(k)) delete breakpoints[k];
    const watches = prefs.watchesChanged ? prefs.watches : stored.watches || prefs.watches;
    delete prefs.watchesChanged;
    Object.assign(prefs, { sessions, recent, breakpoints, watches });
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {}
};

const SETTINGS_TAB = "@settings";
const S = {
  root: null,
  proj: { rust: false, dotnet: false, godot: false, sln: null, csproj: null },
  kids: new Map(), open: new Set(),
  sel: null, selDir: false, // explorer cursor
  tabs: [], active: null, closed: [],
  bufs: new Map(), diags: new Map(), files: null,
  ctx: null, // the project the open file belongs to
  run: 0, runSeq: 0, stopped: 0, running: false, runStart: 0, runLabel: "", runDir: null, runInput: false, queue: [], onDone: null, lastRun: null,
  panel: false, ptab: "output",
};
const nav = { back: [], fwd: [] };

const $ = (id) => document.getElementById(id);
let view = null;
const isPage = (k) => typeof k === "string" && k.startsWith("@");
const isVirtual = (p) => /^[a-z]+:/i.test(p) && !/^[A-Za-z]:\//.test(p); // csharp:/metadata/…

// ---------- paths ----------
const base = (p) => norm(p).split("/").pop();
const parent = (p) => { const s = norm(p); const i = s.lastIndexOf("/"); return i <= 0 ? s.slice(0, i + 1) || "/" : s.slice(0, i); };
const join = (a, b) => norm(a).replace(/\/$/, "") + "/" + norm(b).replace(/^\//, "");
const isUnder = (p, root) => !!root && !!p && (p === root || p.toLowerCase().startsWith(root.toLowerCase() + "/"));
const rel = (p) => (S.root && isUnder(p, S.root) ? p.slice(S.root.length + 1) : p);
const isAbs = (p) => /^(\/|[A-Za-z]:\/)/.test(norm(p));
const TOOLCHAIN = /\/(\.rustup|\.cargo\/registry|\.cargo\/git|\.nuget|rustlib|dotnet\/packs|dotnet\/shared)\//i;

// ---------- small ui helpers ----------
function toast(m, ms = 2600) { const el = $("toast"); el.textContent = m; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), ms); }
let uiQueued = false;
function scheduleUi() {
  if (uiQueued) return;
  uiQueued = true;
  requestAnimationFrame(() => { uiQueued = false; renderTabs(); renderTree(); renderProblems(); });
}
let sessT = null;
function saveSession() {
  clearTimeout(sessT);
  sessT = setTimeout(() => {
    if (!S.root) return;
    prefs.sessions[S.root] = { tabs: S.tabs.filter((k) => !isVirtual(k)), active: S.active, open: [...S.open] };
    for (const k of Object.keys(prefs.sessions)) if (!prefs.recent.includes(k)) delete prefs.sessions[k];
    savePrefs();
  }, 300);
}

// ---------- editor look ----------
const hl = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--syn-kw)" },
  { tag: t.controlKeyword, color: "var(--syn-ctl)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--syn-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.standard(t.variableName)], color: "var(--syn-fn)" },
  { tag: t.macroName, color: "var(--syn-macro)" },
  { tag: [t.string, t.special(t.string), t.character, t.regexp], color: "var(--syn-str)" },
  { tag: [t.number, t.bool], color: "var(--syn-num)" },
  { tag: t.atom, color: "var(--syn-const)" },
  { tag: [t.lineComment, t.blockComment, t.comment, t.docComment], color: "var(--syn-com)", fontStyle: "italic" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "var(--syn-attr)" },
  { tag: t.labelName, color: "var(--syn-life)" },
  { tag: [t.self, t.special(t.variableName)], color: "var(--syn-self)" },
  { tag: t.constant(t.variableName), color: "var(--syn-const)" },
  { tag: [t.punctuation, t.operator, t.bracket, t.separator, t.derefOperator], color: "var(--syn-punct)" },
  { tag: t.tagName, color: "var(--syn-kw)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--syn-type)" },
  { tag: t.heading, fontWeight: "600", color: "var(--ink)" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.invalid, color: "var(--seal)" },
]);

const squiggle = (c) => ({ backgroundImage: "none", textDecoration: `underline wavy ${c}`, textDecorationSkipInk: "none", textUnderlineOffset: "3px" });
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--code-size)", color: "var(--ink)", backgroundColor: "var(--bg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--code-font)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--accent)", padding: "6px 0 40vh" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 18px" },
  ".cm-activeLine": { backgroundColor: "var(--line-hl)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--line-hl)", color: "var(--muted)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--select) !important" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--mark) 55%, transparent)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--hover)", outline: "1px solid var(--line)" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--faint)", padding: "0 4px" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--hover)", border: "none", color: "var(--muted)", padding: "0 6px" },
  ".cm-tooltip": { backgroundColor: "var(--bg)", border: "1px solid var(--line)", borderRadius: "8px", boxShadow: "var(--shadow)", color: "var(--ink)", overflow: "hidden" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--code-font)", fontSize: "12.5px", maxHeight: "18em", minWidth: "260px" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "2px 10px 2px 4px !important", lineHeight: "1.6" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--select)", color: "var(--ink)" },
  ".cm-completionDetail": { color: "var(--faint)", fontStyle: "normal", marginLeft: "12px" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent)", fontWeight: "500" },
  ".cm-completionIcon": { opacity: ".55", width: "1.1em", paddingRight: ".4em" },
  ".cm-completionInfo": { padding: "0" },
  ".cm-diagnostic": { padding: "6px 10px", fontFamily: "var(--sans)", fontSize: "13px", whiteSpace: "pre-wrap", maxWidth: "640px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--seal)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warn)" },
  ".cm-diagnostic-info, .cm-diagnostic-hint": { borderLeft: "3px solid var(--info)" },
  ".cm-diagnosticSource": { color: "var(--faint)", fontSize: "12px" },
  ".cm-lintRange-error": squiggle("var(--seal)"),
  ".cm-lintRange-warning": squiggle("var(--warn)"),
  ".cm-lintRange-info": squiggle("var(--info)"),
  ".cm-lintRange-hint": { backgroundImage: "none", opacity: ".6" },
  ".cm-gutter-lint": { width: "auto" },
  ".cm-gutter-lint .cm-gutterElement": { padding: "0 0 0 6px", display: "flex", alignItems: "center" },
  ".cm-lint-marker": { width: "10px", height: "10px" },
  ".cm-panels": { backgroundColor: "var(--side)", color: "var(--ink)", fontFamily: "var(--sans)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-search": { fontSize: "13px", padding: "6px 10px" },
  ".cm-search label": { color: "var(--muted)" },
  ".cm-textfield": { background: "var(--bg)", border: "1px solid var(--line)", borderRadius: "4px", padding: "3px 6px" },
  ".cm-button": { backgroundImage: "none", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: "4px", padding: "2px 10px" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--mark) 70%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--mark)", outline: "1px solid var(--warn)" },
});

// Markdown for hover cards and docs. Rust and C# code blocks are highlighted.
const csParser = StreamLanguage.define(csharp).parser;
const FENCE = { "": rustLanguage.parser, rust: rustLanguage.parser, csharp: csParser, cs: csParser, "c#": csParser };
function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[`?([^\]`]+)`?\]/g, "<code>$1</code>");
}
function renderMd(md, fallbackLang = "") {
  const el = document.createElement("div");
  el.className = "hv";
  const s = typeof md === "string" ? md : md?.value || "";
  const parts = s.split(/```([\w#]*)\n?([\s\S]*?)```/);
  for (let i = 0; i < parts.length; i += 3) {
    const text = parts[i];
    if (text && text.trim()) {
      for (const para of text.trim().split(/\n\s*\n/)) {
        if (/^-{3,}$/.test(para.trim())) { el.append(document.createElement("hr")); continue; }
        const p = document.createElement("p");
        p.innerHTML = inlineMd(para);
        el.append(p);
      }
    }
    if (i + 2 < parts.length) {
      const pre = document.createElement("pre");
      const code = parts[i + 2].replace(/\n$/, "");
      const parser = FENCE[(parts[i + 1] || fallbackLang).toLowerCase()];
      if (parser) {
        highlightCode(code, parser.parse(code), hl,
          (txt, cls) => { const sp = document.createElement("span"); if (cls) sp.className = cls; sp.textContent = txt; pre.append(sp); },
          () => pre.append("\n"));
      } else pre.textContent = code;
      el.append(pre);
    }
  }
  return el;
}

// A tooltip the keyboard can summon: info at the cursor, problem messages on F8.
const setInfo = StateEffect.define();
const infoField = StateField.define({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setInfo)) return e.value;
    return v && (tr.docChanged || tr.selection) ? null : v;
  },
  provide: (f) => showTooltip.from(f),
});
function showInfoAt(pos, dom) {
  view.dispatch({ effects: setInfo.of({ pos, above: true, create: () => ({ dom }) }) });
}
const closeInfo = (v) => { if (!v.state.field(infoField, false)) return false; v.dispatch({ effects: setInfo.of(null) }); return true; };

// ---------- language servers ----------
const servers = {};
const readyHooks = []; // called when a language server becomes ready
const lspHandlers = {
  diagnostics(path, list) {
    path = norm(path);
    const shown = list.filter((d) => (d.severity || 1) <= 4);
    if (shown.length) S.diags.set(path, shown); else S.diags.delete(path);
    applyDiags(path);
    scheduleUi();
  },
  status: (srv) => {
    renderServer();
    if (srv.state.text?.startsWith("ready")) { for (const [p, b] of S.bufs) if (serverOf(b) === srv) scheduleHints(p, 50); for (const f of readyHooks) f(srv); }
  },
  refreshHints: (srv) => { for (const [p, b] of S.bufs) if (serverOf(b) === srv) scheduleHints(p, 50); },
  message: (m) => toast(m, 5000),
  applyEdit: (we) => applyWorkspaceEdit(we).then(() => true),
};
servers.rust = new Lsp("rust", "rust-analyzer", lspHandlers);
servers.csharp = new Lsp("csharp", "C#", lspHandlers);

const splitArgs = (s) => (String(s || "").match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ""));
function serverSpec(id) {
  if (id === "rust") {
    // A folder with no Cargo.toml of its own (a course folder holding one
    // project per lesson, say) gets each project in it handed over by name.
    const linked = S.proj.rust ? [] : projectDirs().filter((d) => S.files.includes(join(d, "Cargo.toml"))).map((d) => join(d, "Cargo.toml"));
    return {
    exe: settings.rustAnalyzer || "rust-analyzer", args: [],
    initOptions: {
      checkOnSave: true, check: { command: settings.rustCheck || "check" }, cargo: { buildScripts: { enable: true } }, procMacro: { enable: true },
      inlayHints: { typeHints: { enable: true }, parameterHints: { enable: true }, chainingHints: { enable: true }, closingBraceHints: { enable: false } },
      ...(linked.length ? { linkedProjects: linked } : {}),
    },
    missing: "rust-analyzer isn't installed. Open Settings (Ctrl+P) and use the install button, or run: rustup component add rust-analyzer rust-src",
  };
  }
  return {
    exe: settings.csharpServer || "csharp-ls", args: splitArgs(settings.csharpArgs), initOptions: {},
    missing: "The C# language server isn't installed. Open Settings (Ctrl+P) and use the install button, or run: dotnet tool install --global csharp-ls",
  };
}
const serverOf = (b) => (b && LANGS[b.lang].server && !b.virtual ? servers[LANGS[b.lang].server] : null);
const started = (srv) => !!S.root && srv.root === S.root && srv.gen > 0;
function startServer(id) {
  if (!S.root) return null;
  const srv = servers[id], root = S.root;
  // Several callers ask at once while a folder opens; they all share one start.
  if (srv.starting && srv.startingRoot === root) return srv.starting;
  srv.startingRoot = root;
  srv.starting = (async () => {
    await loadFiles();
    if (S.root !== root) return;
    if (await srv.start(root, serverSpec(id))) {
      for (const [p, b] of S.bufs) if (LANGS[b.lang].server === id && !b.virtual && !b.ro) { b.sent = b.state.doc; srv.open(p, b.state.doc.toString(), LANGS[b.lang].languageId); }
    }
  })().finally(() => { if (srv.startingRoot === root) srv.starting = null; });
  return srv.starting;
}
function ensureServer(lang) {
  const id = LANGS[lang].server;
  if (id && S.root && !started(servers[id]) && !servers[id].starting) startServer(id);
}

function syncDoc(path, doc) {
  const b = S.bufs.get(path), srv = serverOf(b);
  if (!srv || b.ro) return;
  doc = doc || b.state.doc;
  clearTimeout(b.ct);
  if (b.sent !== doc) { b.sent = doc; srv.change(path, doc.toString(), LANGS[b.lang].languageId); }
}

function applyDiags(path) {
  const b = S.bufs.get(path);
  if (!b) return;
  const doc = b.state.doc;
  const list = (S.diags.get(path) || []).map((d) => {
    let from = toOffset(doc, d.range.start), to = toOffset(doc, d.range.end);
    if (to < from) [from, to] = [to, from];
    const code = d.code == null ? "" : typeof d.code === "object" ? d.code.value : d.code;
    return { from, to, severity: severity(d.severity || 1), message: d.message, source: [d.source, code].filter(Boolean).join(" ") || undefined };
  });
  dispatchBuf(path, (st) => setDiagnostics(st, list));
}

function completionSource(path) {
  return async (ctx) => {
    const b = S.bufs.get(path), srv = serverOf(b);
    const word = ctx.matchBefore(/\w*$/);
    const prev = ctx.state.sliceDoc(Math.max(0, ctx.pos - 2), ctx.pos);
    const trig = word.from === word.to && (/\.$/.test(prev) ? "." : /::$/.test(prev) ? ":" : null);
    if (!ctx.explicit && !trig && word.from === word.to) return null;
    if (!srv) return null;
    syncDoc(path, ctx.state.doc);
    const res = await srv.request("textDocument/completion", {
      ...srv.at(path, ctx.state.doc, ctx.pos),
      context: trig ? { triggerKind: 2, triggerCharacter: trig } : { triggerKind: 1 },
    });
    if (!res || ctx.aborted) return null;
    const items = (Array.isArray(res) ? res : res.items || []).slice()
      .sort((a, b2) => (a.sortText || a.label).localeCompare(b2.sortText || b2.label)).slice(0, 300);
    return {
      from: word.from,
      options: items.map((it, i) => ({
        label: it.filterText || it.label,
        displayLabel: it.label + (it.labelDetails?.detail || ""),
        detail: it.labelDetails?.description || it.detail || "",
        type: completionType(it.kind),
        boost: Math.max(-99, 60 - i),
        apply: (v, _c, from, to) => applyCompletion(v, it, from, to),
        info: it.documentation ? () => renderMd(it.documentation, LANGS[b.lang].languageId) : undefined,
      })),
    };
  };
}

function applyCompletion(v, it, from, to) {
  const doc = v.state.doc;
  let text = it.insertText || it.label, rFrom = from, rTo = to;
  const te = it.textEdit;
  if (te) {
    const range = te.range || te.replace || te.insert;
    text = te.newText;
    rFrom = Math.min(from, toOffset(doc, range.start));
    rTo = Math.max(to, toOffset(doc, range.end));
  }
  const { text: plainText, cursor } = it.insertTextFormat === 2 ? unsnippet(text) : { text, cursor: text.length };
  const main = { from: rFrom, to: rTo, insert: plainText };
  const extra = (it.additionalTextEdits || []).map((e) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText }));
  let cs;
  try { cs = v.state.changes([main, ...extra]); } catch { cs = v.state.changes([main]); }
  v.dispatch({ changes: cs, selection: { anchor: cs.mapPos(rFrom, -1) + cursor }, scrollIntoView: true, userEvent: "input.complete" });
}

function hoverMarkdown(r) {
  if (!r || !r.contents) return "";
  const block = (x) => (typeof x === "string" ? x : "```" + (x.language || "") + "\n" + x.value + "\n```");
  const c = r.contents;
  return (Array.isArray(c) ? c.map(block).join("\n\n") : c.kind ? c.value : block(c)) || "";
}
const hoverSource = (path) => async (v, pos) => {
  const b = S.bufs.get(path), srv = serverOf(b);
  if (!srv) return null;
  syncDoc(path, v.state.doc);
  const r = await srv.request("textDocument/hover", srv.at(path, v.state.doc, pos));
  const md = hoverMarkdown(r);
  if (!md.trim()) return null;
  let from = pos, to = pos;
  if (r.range) { from = toOffset(v.state.doc, r.range.start); to = toOffset(v.state.doc, r.range.end); }
  return { pos: from, end: to, above: true, create: () => ({ dom: renderMd(md, LANGS[b.lang].languageId) }) };
};

function needServer(b, what) {
  const srv = serverOf(b);
  if (!srv) { toast(`${what} isn't available for ${b.virtual ? "this" : LANGS[b.lang].name} file.`); return null; }
  if (!srv.alive) { toast(srv.state.detail || `${srv.label} isn't running.`, 5000); return null; }
  return srv;
}

async function goToDefinition(path = S.active, pos) {
  const b = S.bufs.get(path);
  if (!b) return;
  const srv = needServer(b, "Go to definition");
  if (!srv) return;
  pos ??= view.state.selection.main.head;
  syncDoc(path, b.state.doc);
  const r = await srv.request("textDocument/definition", srv.at(path, b.state.doc, pos));
  const loc = Array.isArray(r) ? r[0] : r;
  if (!loc) { toast("No definition found."); return; }
  const uri = loc.targetUri || loc.uri;
  await openFile(uriToPath(uri), (loc.targetSelectionRange || loc.range).start, { uri, server: srv });
}

async function formatBuffer(path) {
  const b = S.bufs.get(path), srv = serverOf(b);
  if (!b || b.ro || !srv?.alive) return false;
  syncDoc(path, b.state.doc);
  const edits = await srv.request("textDocument/formatting", { textDocument: { uri: pathToUri(path) }, options: { tabSize: settings.tabSize, insertSpaces: true } });
  if (!edits || !edits.length) return !!edits;
  const doc = b.state.doc;
  dispatchBuf(path, { changes: edits.map((e) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText })), userEvent: "format" });
  return true;
}
async function formatActive() {
  const b = S.bufs.get(S.active);
  if (!b || b.ro) return;
  if (!needServer(b, "Formatting")) return;
  if (!(await formatBuffer(S.active))) toast("Couldn't format. Fix syntax errors first.");
}

async function renameSymbol() {
  const path = S.active, b = S.bufs.get(path);
  if (!b || b.ro) return;
  const srv = needServer(b, "Rename");
  if (!srv) return;
  const pos = view.state.selection.main.head;
  const w = view.state.wordAt(pos);
  const cur = w ? view.state.sliceDoc(w.from, w.to) : "";
  const name = await promptText("Rename symbol", cur);
  if (!name || name === cur) return;
  syncDoc(path, view.state.doc);
  const we = await srv.request("textDocument/rename", { ...srv.at(path, view.state.doc, pos), newName: name });
  if (!we) { toast("Can't rename that."); return; }
  const n = await applyWorkspaceEdit(we);
  toast(`Renamed in ${n} file${n === 1 ? "" : "s"}. Unsaved files are marked.`);
}

const notAfter = (a, b) => a.line < b.line || (a.line === b.line && a.character <= b.character);
async function codeActions() {
  const path = S.active, b = S.bufs.get(path);
  if (!b || b.ro) return;
  const srv = needServer(b, "Quick fixes");
  if (!srv) return;
  syncDoc(path, view.state.doc);
  const sel = view.state.selection.main, doc = view.state.doc;
  const range = { start: toPos(doc, sel.from), end: toPos(doc, sel.to) };
  const diagnostics = (S.diags.get(path) || []).filter((d) => notAfter(d.range.start, range.end) && notAfter(range.start, d.range.end));
  const res = await srv.request("textDocument/codeAction", { textDocument: { uri: pathToUri(path) }, range, context: { diagnostics, triggerKind: 1 } });
  const list = (res || []).filter((a) => !a.disabled);
  if (!list.length) { toast("No quick fixes or refactors here."); return; }
  const i = await choose("Quick fixes and refactors", list.map((a) => a.title), true);
  if (i == null) return;
  let a = list[i];
  if (typeof a.command === "string") { await srv.request("workspace/executeCommand", { command: a.command, arguments: a.arguments }); return; }
  if (!a.edit && srv.caps?.codeActionProvider?.resolveProvider) a = (await srv.request("codeAction/resolve", a)) || a;
  if (a.edit) await applyWorkspaceEdit(a.edit);
  if (a.command) await srv.request("workspace/executeCommand", { command: a.command.command, arguments: a.command.arguments });
}

async function showInfo() {
  const path = S.active, b = S.bufs.get(path);
  if (!b) return;
  const pos = view.state.selection.main.head, doc = view.state.doc;
  const parts = [];
  for (const d of S.diags.get(path) || []) {
    const from = toOffset(doc, d.range.start), to = toOffset(doc, d.range.end);
    if (pos >= from && pos <= Math.max(to, from + 1)) parts.push(`**${severity(d.severity || 1)}:** ${d.message}`);
  }
  const srv = serverOf(b);
  if (srv?.alive) {
    syncDoc(path, doc);
    const md = hoverMarkdown(await srv.request("textDocument/hover", srv.at(path, doc, pos)));
    if (md.trim()) parts.push(md);
  }
  if (!parts.length) { toast("Nothing to show at the cursor."); return; }
  if (S.active === path) showInfoAt(pos, renderMd(parts.join("\n\n---\n\n"), LANGS[b.lang].languageId));
}

async function applyWorkspaceEdit(we) {
  const byFile = new Map();
  for (const [uri, edits] of Object.entries(we.changes || {})) byFile.set(norm(uriToPath(uri)), edits);
  for (const dc of we.documentChanges || []) {
    if (dc.kind === "rename") { try { await invoke("rename_path", { from: uriToPath(dc.oldUri), to: uriToPath(dc.newUri) }); } catch (e) { toast(String(e)); } continue; }
    if (dc.kind) continue;
    byFile.set(norm(uriToPath(dc.textDocument.uri)), dc.edits);
  }
  for (const [path, edits] of byFile) {
    const b = S.bufs.get(path);
    if (b) {
      const doc = b.state.doc;
      dispatchBuf(path, { changes: edits.map((e) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText })) });
    } else {
      try {
        let raw = await invoke("read_file", { path });
        const bom = raw.startsWith("\uFEFF");
        if (bom) raw = raw.slice(1);
        const doc = Text.of(raw.split(/\r?\n/));
        const cs = ChangeSet.of(edits.map((e) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText })), doc.length);
        let out = cs.apply(doc).toString();
        if (raw.includes("\r\n")) out = out.replace(/\n/g, "\r\n");
        await invoke("write_file", { path, contents: (bom ? "\uFEFF" : "") + out });
      } catch (e) { toast(`Couldn't edit ${base(path)}: ${e}`); }
    }
  }
  scheduleUi();
  return byFile.size;
}

// ---------- inlay hints (grey types and parameter names from the server) ----------
const setHints = StateEffect.define();
const hintField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setHints)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
class HintWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-inlay"; s.textContent = this.text; s.setAttribute("aria-hidden", "true"); return s; }
  ignoreEvent() { return true; }
}
const hintTimers = new Map();
function scheduleHints(path, ms = 500) {
  clearTimeout(hintTimers.get(path));
  hintTimers.set(path, setTimeout(() => refreshHints(path), ms));
}
function putHints(path, deco) {
  const b = S.bufs.get(path);
  if (!b) return;
  dispatchBuf(path, { effects: setHints.of(deco) });
}
async function refreshHints(path) {
  const b = S.bufs.get(path), srv = serverOf(b);
  if (!b || !srv) return;
  if (!settings.inlayHints) { putHints(path, Decoration.none); return; }
  if (!srv.alive || !srv.caps?.inlayHintProvider) return;
  syncDoc(path);
  const doc = b.state.doc;
  const r = await srv.request("textDocument/inlayHint", { textDocument: { uri: pathToUri(path) }, range: { start: { line: 0, character: 0 }, end: toPos(doc, doc.length) } });
  const cur = S.bufs.get(path);
  if (!cur || cur.state.doc !== doc || !Array.isArray(r)) return; // edited meanwhile; a newer request follows
  const items = r.map((h) => {
    const label = typeof h.label === "string" ? h.label : (h.label || []).map((p) => p.value).join("");
    return { at: toOffset(doc, h.position), text: (h.paddingLeft ? " " : "") + label + (h.paddingRight ? " " : "") };
  }).sort((a, b2) => a.at - b2.at);
  const builder = new RangeSetBuilder();
  for (const it of items) builder.add(it.at, it.at, Decoration.widget({ widget: new HintWidget(it.text), side: 1 }));
  putHints(path, builder.finish());
}
function toggleHints() {
  setSetting("inlayHints", !settings.inlayHints);
  if (S.active === SETTINGS_TAB) renderSettingsPage(true);
  toast(settings.inlayHints ? "Type hints on." : "Type hints off.");
}

// ---------- buffers ----------
const cfg = new Compartment();
// Optional extras (bracket colours, guides, sticky scroll, and what other
// modules add: breakpoints, git change bars, lenses…) live in their own
// compartment so settings can switch them without reopening files.
const xcfg = new Compartment();
const extraExt = [];
let sticky = null;
const xExt = (path, b) => [
  settings.bracketColors ? bracketColors : [],
  settings.indentGuides ? indentGuides : [],
  settings.stickyScroll ? (sticky ||= stickyScroll(hl)) : [],
  ...extraExt.map((f) => f(path, b)),
];
function reconfigureExtras() {
  for (const [p, b] of S.bufs) dispatchBuf(p, { effects: xcfg.reconfigure(xExt(p, b)) });
}
const cfgExt = () => [EditorState.tabSize.of(settings.tabSize), indentUnit.of(" ".repeat(settings.tabSize)), settings.wordWrap ? EditorView.lineWrapping : []];

function extensionsFor(path, b) {
  const L = LANGS[b.lang], hasServer = !!L.server && !b.virtual;
  return [
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(hl), bracketMatching(), closeBrackets(),
    rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
    cfg.of(cfgExt()), infoField, xcfg.of(xExt(path, b)),
    autocompletion({
      override: [...(hasServer ? [completionSource(path)] : L.complete ? [L.complete] : []), ...(snippets ? [snippets.source(b.lang, L.languageId)] : [])],
      activateOnTypingDelay: 60, maxRenderedOptions: 80,
    }),
    lintGutter(),
    hasServer ? [
      hintField,
      hoverTooltip(hoverSource(path), { hoverTime: 350 }),
      EditorView.domEventHandlers({
        mousedown(e, v) {
          if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          e.preventDefault();
          goToDefinition(path, pos);
          return true;
        },
      }),
    ] : [],
    cmKeymap.of([
      { key: "Escape", run: closeInfo },
      ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab,
    ]),
    L.ext(), theme,
    b.ro ? EditorState.readOnly.of(true) : [],
    EditorView.updateListener.of((u) => onUpdate(path, u)),
  ];
}

// Edits can happen in either pane; when both show the same file, the second one
// has its own state (its own cursor and undo) and edits are copied across.
const fromOtherPane = Annotation.define();
function onUpdate(path, u) {
  const b = S.bufs.get(path);
  if (!b) return;
  const canon = u.startState === b.state;
  if (canon) b.state = u.state;
  else if (u.startState === b.mirror) b.mirror = u.state;
  else return;
  if (u.docChanged && !u.transactions.some((tr) => tr.annotation(fromOtherPane))) {
    const other = canon ? b.mirror : b.state;
    const ov = other && paneShowing(other, path)?.view;
    if (ov) ov.dispatch({ changes: u.changes, annotations: [fromOtherPane.of(true), Transaction.addToHistory.of(false)] });
  }
  if (u.view === view && (u.selectionSet || u.docChanged || u.focusChanged)) renderPos();
  if (!canon) return;
  if (u.docChanged) {
    const was = b.dirty;
    b.dirty = !u.state.doc.eq(b.saved);
    if (was !== b.dirty) scheduleUi();
    if (serverOf(b)) { clearTimeout(b.ct); b.ct = setTimeout(() => syncDoc(path), 150); scheduleHints(path, 700); }
    if (settings.autoSave === "delay" && b.dirty) { clearTimeout(b.at); b.at = setTimeout(() => save(path), 1000); }
    bufChanged(path, b);
  }
}

/** Applies a change or effect to a buffer wherever it is: in a pane, or in the background.
 *  `spec` may be a function of the state (diagnostics are built per state). */
function dispatchBuf(path, spec) {
  const b = S.bufs.get(path);
  if (!b) return;
  const mk = (st) => (typeof spec === "function" ? spec(st) : spec);
  const s1 = mk(b.state);
  const v1 = paneShowing(b.state, path)?.view;
  if (v1) v1.dispatch(s1); // onUpdate keeps b.state current and copies edits to the other pane
  else {
    const tr = b.state.update(s1);
    b.state = tr.state;
    if (tr.docChanged) {
      b.dirty = !b.state.doc.eq(b.saved);
      if (serverOf(b)) { clearTimeout(b.ct); b.ct = setTimeout(() => syncDoc(path), 150); scheduleHints(path, 700); }
      bufChanged(path, b);
      scheduleUi();
    }
  }
  if (b.mirror) {
    const s2 = mk(b.mirror);
    if (s2.effects) paneShowing(b.mirror, path)?.view.dispatch({ effects: s2.effects });
  }
}
// Other parts (git change bars, breakpoints) listen for edits here.
const bufListeners = [];
function bufChanged(path, b) { for (const f of bufListeners) f(path, b); }

function makeBuffer(path, text, opts = {}) {
  const b = { lang: opts.lang || langOf(path), dirty: false, virtual: !!opts.virtual, label: opts.label };
  b.bom = text.startsWith("\uFEFF");
  if (b.bom) text = text.slice(1);
  b.eol = text.includes("\r\n") ? "\r\n" : "\n";
  b.ro = !!opts.virtual || (!isUnder(path, S.root) && TOOLCHAIN.test(path));
  b.saved = Text.of(text.split(/\r?\n/));
  b.state = EditorState.create({ doc: b.saved, extensions: extensionsFor(path, b) });
  S.bufs.set(path, b);
  const srv = serverOf(b);
  if (srv && !b.ro) { b.sent = b.saved; ensureServer(b.lang); srv.open(path, b.saved.toString(), LANGS[b.lang].languageId); scheduleHints(path, 300); }
  if (S.diags.has(path)) applyDiags(path);
  return b;
}

/** at: {line, character} (0-based) or {offset}. opts: quiet, background, noNav, keepFocus, uri, server */
async function openFile(path, at, opts = {}) {
  path = norm(path);
  if (opts.uri && /^csharp:/i.test(opts.uri)) return openMetadata(opts.uri, at, opts.server);
  if (!S.bufs.has(path)) {
    let text;
    try { text = await invoke("read_file", { path }); }
    catch (e) { if (!opts.quiet) toast(`Can't open ${base(path)}: ${e}`); return false; }
    if (!S.bufs.has(path)) { const b = makeBuffer(path, text); statOf(path).then((m) => { b.mtime = m; }); }
  }
  addTab(path);
  if (!opts.background) activate(path, at, opts);
  else renderTabs();
  return true;
}

// csharp-ls serves decompiled framework sources under csharp:/metadata/… URIs.
async function openMetadata(uri, at, srv) {
  if (!S.bufs.has(uri)) {
    const r = await srv?.request("csharp/metadata", { textDocument: { uri } });
    if (!r?.source) { toast("Couldn't load the source for that definition."); return false; }
    makeBuffer(uri, r.source, { virtual: true, lang: "csharp", label: (r.symbolName || "metadata").split(".").pop() + ".cs" });
  }
  addTab(uri);
  activate(uri, at);
  return true;
}

function addTab(key) {
  if (S.tabs.includes(key)) return;
  const i = S.tabs.indexOf(S.active);
  S.tabs.splice(i < 0 ? S.tabs.length : i + 1, 0, key);
  saveSession();
}

function here() {
  if (!S.active) return null;
  if (!S.bufs.has(S.active)) return { path: S.active };
  return { path: S.active, off: view.state.selection.main.head };
}
function pushNav() {
  const h = here();
  if (!h) return;
  const top = nav.back[nav.back.length - 1];
  if (top && top.path === h.path && top.off === h.off) return;
  nav.back.push(h);
  if (nav.back.length > 100) nav.back.shift();
  nav.fwd = [];
}
async function goNav(dir) {
  const from = dir < 0 ? nav.back : nav.fwd, to = dir < 0 ? nav.fwd : nav.back;
  while (from.length) {
    const loc = from.pop();
    if (!S.tabs.includes(loc.path) && !isPage(loc.path)) {
      if (isVirtual(loc.path) || !(await openFile(loc.path, null, { background: true, quiet: true }))) continue;
    }
    const h = here();
    if (h) to.push(h);
    activate(loc.path, loc.off != null ? { offset: loc.off } : null, { noNav: true });
    return;
  }
}

// ---------- panes (split editor) ----------
// Two panes side by side; the focused one is `view` / S.active. Pages
// (settings, welcome, diffs) only show in the left pane.
const panes = [
  { el: $("pane0"), host: $("editor"), view: null, key: null, scroll: new Map() },
  { el: $("pane1"), host: $("editor2"), view: null, key: null, scroll: new Map() },
];
let fp = 0, split = false;
// A pane counts only if it really shows that file (a pane hidden behind a page doesn't).
const paneShowing = (st, path) => panes.find((p) => p.view && p.view.state === st && (path == null || p.key === path) && (p === panes[0] || split));
const EMPTY = EditorState.create({});
const otherPane = () => panes[1 - fp];

/** Shows `key` in pane `pi` without moving focus or the rest of the UI. */
function showIn(pi, key) {
  const P = panes[pi];
  if (P.key && P.key !== key) leavePane(P);
  P.key = key;
  const b = S.bufs.get(key);
  if (!P.view) return;
  if (!b) { if (P.view.state !== EMPTY) P.view.setState(EMPTY); return; } // a page, or nothing: let go of the file
  const other = panes[1 - pi];
  const both = split && other.key === key;
  if (P.view.state === b.state || (b.mirror && P.view.state === b.mirror)) return;
  if (both && other.view?.state === b.state) {
    b.mirror = EditorState.create({ doc: b.state.doc, selection: b.state.selection, extensions: extensionsFor(key, b) });
    P.view.setState(b.mirror);
    copyDecorations(key);
  } else if (both && b.mirror && other.view?.state === b.mirror) {
    P.view.setState(b.state);
  } else {
    b.mirror = null;
    P.view.setState(b.state);
  }
  const top = P.scroll.get(key) || 0;
  requestAnimationFrame(() => { if (P.key === key && P.view) P.view.scrollDOM.scrollTop = top; });
}
function leavePane(P) {
  const b = S.bufs.get(P.key);
  if (!b || !P.view) return;
  if (P.view.state === b.state || P.view.state === b.mirror) P.scroll.set(P.key, P.view.scrollDOM.scrollTop);
  if (b.mirror && P.view.state === b.mirror) b.mirror = null;
  else if (b.mirror && P.view.state === b.state) { b.state = b.mirror; b.mirror = null; }
}
/** A second state for the same file needs the first one's markings. */
function copyDecorations(path) {
  const b = S.bufs.get(path);
  if (!b?.mirror) return;
  applyDiags(path);
  const h = b.state.field(hintField, false);
  if (h) paneShowing(b.mirror, path)?.view.dispatch({ effects: setHints.of(h) });
  for (const f of decorationCopiers) f(path, b);
}
const decorationCopiers = [];

function setFocusPane(i) {
  if (i === fp || (i === 1 && !split)) return;
  fp = i;
  view = panes[i].view;
  S.active = panes[i].key;
  for (const P of panes) P.el.classList.toggle("focused", P === panes[fp]);
  renderTabs(); renderCrumbs(); renderPos(); renderStatus(); renderPaneHeads();
  updateCtx();
  for (const f of focusListeners) f();
  for (const f of activeHooks) f(S.active);
}
const focusListeners = [];
panes.forEach((P, i) => P.el.addEventListener("focusin", () => setFocusPane(i)));
panes.forEach((P, i) => P.el.addEventListener("mousedown", () => setFocusPane(i)));

function openSplit() {
  if (split) { // already split: go to the other side
    const o = otherPane();
    if (S.bufs.has(o.key)) o.view.focus(); else focusZone("editor");
    return;
  }
  const key = S.bufs.has(S.active) ? S.active : S.tabs.find((k) => S.bufs.has(k));
  if (!key) { toast("Open a file to split the editor."); return; }
  split = true;
  $("pane1").hidden = false;
  $("paneSplit").hidden = false;
  $("panes").classList.add("split");
  if (!panes[1].view) panes[1].view = new EditorView({ parent: $("editor2") });
  showIn(1, key);
  setFocusPane(1);
  renderPaneHeads();
  panes[1].view.focus();
}
function closeSplit() {
  if (!split) return;
  leavePane(panes[1]);
  panes[1].key = null;
  panes[1].view?.setState(EditorState.create({}));
  split = false;
  $("pane1").hidden = true;
  $("paneSplit").hidden = true;
  $("panes").classList.remove("split");
  if (fp === 1) setFocusPane(0);
  panes[0].el.classList.remove("focused");
  renderTabs(); renderPaneHeads();
  focusZone("editor");
}
function renderPaneHeads() {
  panes.forEach((P, i) => {
    const h = P.el.querySelector(".phead");
    h.hidden = !split;
    if (!split) return;
    const k = P.key;
    const b = S.bufs.get(k);
    h.innerHTML = `<span class="dot" style="--tc:var(--t-${k ? (isPage(k) ? "cfg" : dotOf(k)) : "other"})"></span><span>${k ? esc(tabLabel(k)) : ""}${b?.dirty ? " ●" : ""}</span>${i === 1 ? `<button class="ibtn" data-unsplit title="Close split (${esc(keymap.label("editor.unsplit"))})" aria-label="Close split"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>` : ""}`;
  });
}
$("pane1").addEventListener("click", (ev) => { if (ev.target.closest("[data-unsplit]")) closeSplit(); });

function activate(key, at, opts = {}) {
  if (split && fp === 1 && (isPage(key) || !key)) setFocusPane(0); // pages live on the left
  const jumping = key !== S.active || !!at;
  if (jumping && !opts.noNav && S.active) pushNav();
  const cur = S.bufs.get(S.active);
  if (cur && S.active !== key && settings.autoSave === "focus" && cur.dirty) save(S.active);
  S.active = key;
  if (key && !S.tabs.includes(key)) addTab(key);
  const b = S.bufs.get(key);
  showIn(fp, key);
  renderMain();
  if (b && at) {
    const off = Math.min(at.offset ?? toOffset(view.state.doc, at), view.state.doc.length);
    view.dispatch({ selection: { anchor: off }, effects: EditorView.scrollIntoView(off, { y: "center" }) });
  }
  if (b && !opts.keepFocus) view.contentDOM.focus({ preventScroll: true });
  if (b && !b.virtual) ensureServer(b.lang);
  if (b) scheduleHints(key, 100);
  updateCtx();
  saveSession();
  for (const f of activeHooks) f(key);
}
const activeHooks = [];

async function save(path = S.active) {
  const b = S.bufs.get(path);
  if (!b || b.ro) return true;
  if (settings.formatOnSave && serverOf(b)?.alive && b.dirty) await formatBuffer(path);
  if (!b.dirty) { syncDoc(path); return true; }
  if (!b.virtual && b.mtime != null) {
    const now = await statOf(path);
    if (now != null && now !== b.mtime) {
      const c = await choose(`${base(path)} was changed on disk by another program since you opened it.`, ["Overwrite it with mine", "Compare first", "Cancel"]);
      if (c === "Compare first") { compareWithDisk(path); return false; }
      if (c !== "Overwrite it with mine") return false;
    }
  }
  const doc = b.state.doc;
  let text = doc.toString();
  if (b.eol === "\r\n") text = text.replace(/\n/g, "\r\n");
  if (b.bom) text = "\uFEFF" + text;
  try { await invoke("write_file", { path, contents: text }); }
  catch (e) { toast(`Couldn't save ${base(path)}: ${e}`); return false; }
  b.saved = doc;
  b.dirty = !b.state.doc.eq(doc);
  b.diskChanged = null;
  b.mtime = await statOf(path);
  const srv = serverOf(b);
  if (srv) { syncDoc(path); srv.saved(path); scheduleHints(path, 400); }
  if (settingsFile && path.toLowerCase() === settingsFile.toLowerCase()) reloadSettingsFromFile();
  for (const f of saveHooks) f(path, b);
  scheduleUi();
  return true;
}
const saveHooks = [];
async function saveAll() {
  let ok = true;
  for (const [p, b] of S.bufs) if (b.dirty) ok = (await save(p)) && ok;
  return ok;
}
const dirtyPaths = (paths = [...S.bufs.keys()]) => paths.filter((p) => S.bufs.get(p)?.dirty);

function dropBuffer(path) {
  const b = S.bufs.get(path), srv = serverOf(b);
  if (b) { clearTimeout(b.ct); clearTimeout(b.at); }
  if (srv && !b.ro) srv.close(path);
  S.bufs.delete(path);
}
async function closeTab(key, force) {
  if (!key) return false;
  const b = S.bufs.get(key);
  if (b?.dirty && !force) {
    const c = await choose(`Save changes to ${base(key)} before closing?`, ["Save", "Don't save", "Cancel"]);
    if (!c || c === "Cancel") return false;
    if (c === "Save" && !(await save(key))) return false;
  }
  const i = S.tabs.indexOf(key);
  if (i >= 0) S.tabs.splice(i, 1);
  if (!isPage(key) && !isVirtual(key)) { S.closed.push(key); if (S.closed.length > 30) S.closed.shift(); }
  pageOf(key)?.close?.(key);
  const next = S.tabs[Math.min(i, S.tabs.length - 1)];
  // The other pane first: it closes if nothing else can go there.
  const o = otherPane();
  if (split && o.key === key) {
    const alt = S.tabs.filter((k2) => S.bufs.has(k2))[Math.min(i, S.tabs.length - 1)] || S.tabs.find((k2) => S.bufs.has(k2));
    if (o === panes[1] && !alt) closeSplit();
    else if (alt) showIn(panes.indexOf(o), alt);
    else { leavePane(o); o.key = null; }
    renderPaneHeads();
  }
  if (S.active === key) {
    leavePane(panes[fp]);
    panes[fp].key = null;
    S.active = null;
    if (next) activate(next, null, { noNav: true });
    else if (split && fp === 1) closeSplit();
    else { renderMain(); focusZone("editor"); }
  } else renderTabs();
  dropBuffer(key);
  saveSession();
  return true;
}
async function closeAll() {
  const d = dirtyPaths();
  if (d.length) {
    const c = await choose(`Save changes to ${d.length === 1 ? base(d[0]) : d.length + " files"}?`, ["Save all", "Don't save", "Cancel"]);
    if (!c || c === "Cancel") return false;
    if (c === "Save all" && !(await saveAll())) return false;
  }
  closeSplit();
  for (const p of [...S.bufs.keys()]) dropBuffer(p);
  S.tabs = [];
  S.active = null;
  panes[0].key = null;
  nav.back = []; nav.fwd = [];
  renderMain();
  return true;
}
function cycleTab(d) {
  if (S.tabs.length < 2) return;
  const i = S.tabs.indexOf(S.active);
  activate(S.tabs[(i + d + S.tabs.length) % S.tabs.length], null, { noNav: true });
}
function tabAt(n) { const k = n === 9 ? S.tabs[S.tabs.length - 1] : S.tabs[n - 1]; if (k) activate(k, null, { noNav: true }); }
async function reopenClosed() {
  while (S.closed.length) { const p = S.closed.pop(); if (await openFile(p, null, { quiet: true })) return; }
  toast("No closed tabs to reopen.");
}

// Pick up changes made on disk by other tools (cargo fmt, git, Godot). Files
// you haven't edited reload quietly; edited ones get a bar asking what to do.
const statOf = async (p) => (await invoke("file_stats", { paths: [p] }).catch(() => [null]))[0];
let reloading = false;
async function reloadClean() {
  if (reloading) return;
  reloading = true;
  let changed = false;
  try {
    const paths = [...S.bufs.keys()].filter((p) => !S.bufs.get(p).virtual && isAbs(p));
    const stats = await invoke("file_stats", { paths }).catch(() => paths.map(() => undefined));
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i], cur = S.bufs.get(path), m = stats[i];
      if (!cur || m === undefined || cur.mtime === undefined) continue;
      if (m === cur.mtime) continue;
      if (m === null) { // deleted
        if (cur.diskChanged !== "deleted") { cur.diskChanged = "deleted"; changed = true; }
        continue;
      }
      if (cur.dirty) {
        if (cur.diskChanged !== "changed") { cur.diskChanged = "changed"; changed = true; }
        continue;
      }
      await reloadFromDisk(path);
      changed = true;
    }
  } finally { reloading = false; if (changed) { scheduleUi(); renderDiskBars(); } }
}
async function reloadFromDisk(path) {
  let text;
  try { text = await invoke("read_file", { path }); } catch { return; }
  const cur = S.bufs.get(path);
  if (!cur) return;
  cur.mtime = await statOf(path);
  const bom = text.startsWith("\uFEFF");
  if (bom) text = text.slice(1);
  cur.bom = bom;
  cur.eol = text.includes("\r\n") ? "\r\n" : "\n";
  text = text.replace(/\r\n/g, "\n");
  cur.diskChanged = null;
  const old = cur.state.doc.toString();
  if (text !== old) {
    cur.saved = Text.of(text.split("\n"));
    // Replace only the part that differs, so breakpoints, folds and the cursor elsewhere stay put.
    let a = 0;
    while (a < old.length && a < text.length && old[a] === text[a]) a++;
    let z = 0;
    while (z < old.length - a && z < text.length - a && old[old.length - 1 - z] === text[text.length - 1 - z]) z++;
    dispatchBuf(path, { changes: { from: a, to: old.length - z, insert: text.slice(a, text.length - z) } });
  }
  cur.saved = cur.state.doc;
  cur.dirty = false;
  syncDoc(path);
  renderDiskBars();
  scheduleUi();
}
async function compareWithDisk(path) {
  let disk = "";
  try { disk = (await invoke("read_file", { path })).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"); } catch {}
  const b = S.bufs.get(path);
  if (!b) return;
  app.openDiff?.({ path, left: disk, right: b.state.doc.toString(), leftLabel: "On disk", rightLabel: "Yours (not saved)", title: base(path) + " · disk ↔ yours" });
}
function renderDiskBars() {
  for (const P of panes) {
    const bar = P.el.querySelector(".cm-changedbar");
    const b = S.bufs.get(P.key);
    const why = b?.diskChanged;
    bar.hidden = !why || (P === panes[1] && !split);
    if (bar.hidden) continue;
    bar.innerHTML = why === "deleted"
      ? `<span><b>${esc(base(P.key))}</b> was deleted or moved on disk. Save to write it back.</span><span class="sp"></span><button class="btn" data-disk="close">Close tab</button><button class="btn" data-disk="keep">Keep it open</button>`
      : `<span><b>${esc(base(P.key))}</b> was changed on disk, and you have unsaved edits.</span><span class="sp"></span><button class="btn" data-disk="compare">Compare</button><button class="btn" data-disk="reload">Use the disk version</button><button class="btn" data-disk="keep">Keep mine</button>`;
    bar.dataset.path = P.key;
  }
}
for (const P of panes) P.el.querySelector(".cm-changedbar").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-disk]");
  if (!btn) return;
  const path = ev.currentTarget.dataset.path, b = S.bufs.get(path);
  if (!b) return;
  const act = btn.dataset.disk;
  if (act === "compare") compareWithDisk(path);
  if (act === "reload") await reloadFromDisk(path);
  if (act === "close") await closeTab(path, true);
  if (act === "keep") { b.diskChanged = null; if (b.mtime !== undefined) b.mtime = await statOf(path); if (b.mtime === null) b.mtime = undefined; renderDiskBars(); }
});

// ---------- problems navigation (F8) ----------
function allProblems() {
  const out = [];
  for (const [p, l] of S.diags) for (const d of l) if ((d.severity || 1) <= 2) out.push({ path: p, d });
  return out.sort((a, b) => rel(a.path).localeCompare(rel(b.path)) || a.d.range.start.line - b.d.range.start.line || a.d.range.start.character - b.d.range.start.character);
}
async function nextProblem(dir) {
  const list = allProblems();
  if (!list.length) { toast("No problems."); return; }
  const cur = S.bufs.has(S.active) ? { path: S.active, pos: toPos(view.state.doc, view.state.selection.main.head) } : null;
  const cmp = (x) => {
    if (!cur) return 1;
    const s = x.d.range.start;
    return rel(x.path).localeCompare(rel(cur.path)) || s.line - cur.pos.line || s.character - cur.pos.character;
  };
  const target = dir > 0 ? list.find((x) => cmp(x) > 0) || list[0] : [...list].reverse().find((x) => cmp(x) < 0) || list[list.length - 1];
  await openFile(target.path, target.d.range.start);
  if (S.active === target.path) showInfoAt(view.state.selection.main.head, renderMd(`**${severity(target.d.severity || 1)}:** ${target.d.message}`));
}

// ---------- explorer ----------
const CHEV = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FOLDER = '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.2c0-.6.4-1 1-1h3.4l1.4 1.5h5.6c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const DIMMED = new Set(["target", "bin", "obj", ".godot", ".import", "node_modules", ".vs", ".idea"]);

async function loadDir(p) {
  try {
    const list = await invoke("list_dir", { path: p });
    S.kids.set(p, list.map((e) => ({ name: e.name, path: norm(e.path), dir: e.is_dir })));
    return true;
  } catch {
    S.kids.delete(p);
    S.open.delete(p);
    return false;
  }
}
async function toggleDir(p, force) {
  const open = force ?? !S.open.has(p);
  if (open) { S.open.add(p); if (!S.kids.has(p)) { renderTree(); await loadDir(p); } }
  else S.open.delete(p);
  renderTree();
  saveSession();
}
async function refreshTree() {
  if (!S.root) return;
  await Promise.all([S.root, ...S.open].map(loadDir));
  S.files = null;
  detectProject();
  renderTree();
  await loadFiles(true);
  updateCtx();
}
async function revealInTree(path) {
  let d = parent(path);
  const chain = [];
  while (isUnder(d, S.root) && d !== S.root) { chain.unshift(d); d = parent(d); }
  for (const c of chain) { S.open.add(c); if (!S.kids.has(c)) await loadDir(c); }
  renderTree();
}

function counts(list) {
  let e = 0, w = 0;
  for (const x of list || []) { if ((x.severity || 1) === 1) e++; else if (x.severity === 2) w++; }
  return { e, w };
}
function dirCounts(d) {
  let e = 0, w = 0;
  for (const [p, l] of S.diags) if (p.startsWith(d + "/")) { const c = counts(l); e += c.e; w += c.w; }
  return { e, w };
}
const cntHtml = ({ e, w }, dirty) => (e ? `<span class="cnt e">${e}</span>` : w ? `<span class="cnt w">${w}</span>` : dirty ? `<span class="cnt" aria-label="unsaved">●</span>` : "");

function nodeHtml(n, depth) {
  const pad = 4 + depth * 14;
  const cur = S.sel === n.path;
  const common = `role="treeitem" aria-level="${depth + 1}" tabindex="${cur ? 0 : -1}" aria-selected="${S.active === n.path}"`;
  if (n.dir) {
    const open = S.open.has(n.path);
    const c = dirCounts(n.path);
    const gd = app.treeDecor?.(n.path, true);
    let h = `<button class="node folder${DIMMED.has(n.name) ? " dim" : ""}${c.e ? " err" : c.w ? " warn" : ""}${cur ? " sel" : ""}${gd && !c.e && !c.w ? " " + gd.cls : ""}" ${common} style="padding-left:${pad}px" data-dir="${esc(n.path)}" aria-expanded="${open}"><span class="chev${open ? " open" : ""}">${CHEV}</span><span class="ico">${ICON_FOLDER}</span><span class="lbl">${esc(n.name)}</span>${open ? "" : cntHtml(c)}</button>`;
    if (open) {
      const kids = S.kids.get(n.path);
      h += `<div role="group">` + (kids ? (kids.length ? kids.map((k) => nodeHtml(k, depth + 1)).join("") : `<div class="hint" style="padding:2px 0 4px ${pad + 32}px">Empty</div>`) : `<div class="hint" style="padding:2px 0 4px ${pad + 32}px">Loading…</div>`) + `</div>`;
    }
    return h;
  }
  const c = counts(S.diags.get(n.path));
  const gd = app.treeDecor?.(n.path, false);
  return `<button class="node${S.active === n.path ? " active" : ""}${c.e ? " err" : c.w ? " warn" : ""}${cur ? " sel" : ""}${gd && !c.e && !c.w ? " " + gd.cls : ""}" ${common} style="padding-left:${pad + 16}px;--tc:var(--t-${dotOf(n.path)})" data-file="${esc(n.path)}" title="${esc(rel(n.path))}"><span class="dot"></span><span class="lbl">${esc(n.name)}</span>${cntHtml(c, S.bufs.get(n.path)?.dirty)}${gd?.badge || ""}</button>`;
}

function renderTree() {
  const tree = $("tree");
  const hadFocus = tree.contains(document.activeElement);
  const top = tree.scrollTop;
  if (!S.root) {
    tree.innerHTML = `<div class="hint" style="padding:6px 8px;display:grid;gap:10px;white-space:normal"><span>No folder open.</span><div class="bar"><button class="btn primary" data-act="open">Open folder</button><button class="btn" data-act="new-project">New project</button></div></div>`;
    return;
  }
  const q = $("treeFilter").value.trim().toLowerCase();
  if (q) {
    if (!S.files) { tree.innerHTML = '<p class="hint" style="padding:6px 8px">Searching…</p>'; loadFiles().then(renderTree); return; }
    const hits = S.files.filter((p) => rel(p).toLowerCase().includes(q)).slice(0, 300);
    if (!hits.includes(S.sel)) S.sel = hits[0] || null;
    tree.innerHTML = hits.map((p) => {
      const r = rel(p), dir = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "";
      return `<button class="node${S.active === p ? " active" : ""}${S.sel === p ? " sel" : ""}" role="treeitem" aria-level="1" tabindex="${S.sel === p ? 0 : -1}" style="padding-left:4px;--tc:var(--t-${dotOf(p)})" data-file="${esc(p)}" title="${esc(r)}"><span class="dot"></span><span class="lbl" style="flex:0 1 auto">${esc(base(p))}</span><span class="sub">${esc(dir)}</span></button>`;
    }).join("") || '<p class="hint" style="padding:6px 8px">No files match.</p>';
  } else {
    const kids = S.kids.get(S.root);
    tree.innerHTML = kids ? kids.map((k) => nodeHtml(k, 0)).join("") || '<p class="hint" style="padding:6px 8px">Empty folder.</p>' : '<p class="hint" style="padding:6px 8px">Loading…</p>';
    tree.scrollTop = top;
  }
  // Exactly one node is reachable with Tab (roving focus).
  if (!tree.querySelector('.node[tabindex="0"]')) tree.querySelector(".node")?.setAttribute("tabindex", "0");
  if (hadFocus) {
    const n = tree.querySelector('.node[tabindex="0"]');
    if (n) { n.focus({ preventScroll: true }); n.scrollIntoView({ block: "nearest" }); }
  }
}

let filesJob = null;
async function loadFiles(force) {
  if (!S.root) return [];
  if (S.files && !force) return S.files;
  const root = S.root;
  if (!filesJob || filesJob.root !== root || force) {
    const job = (async () => {
      let list = [];
      try { list = (await invoke("list_files", { root })).map(norm); } catch {}
      if (S.root === root) S.files = list;
      return list;
    })().finally(() => { if (filesJob === job) filesJob = null; });
    job.root = root;
    filesJob = job;
  }
  return filesJob;
}

function nodePath(el) { return el?.dataset.dir || el?.dataset.file || null; }
function moveCursor(el) {
  if (!el) return;
  S.sel = nodePath(el);
  S.selDir = !!el.dataset.dir;
  $("tree").querySelectorAll(".node").forEach((n) => { n.tabIndex = n === el ? 0 : -1; n.classList.toggle("sel", n === el); });
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest" });
}
const typeAhead = { s: "", t: 0 };
$("tree").addEventListener("keydown", (ev) => {
  const el = ev.target.closest(".node");
  if (!el) return;
  const nodes = [...$("tree").querySelectorAll(".node")];
  const i = nodes.indexOf(el), p = nodePath(el), isDir = !!el.dataset.dir;
  const k = keyString(ev);
  let handled = true;
  if (k === "Down") moveCursor(nodes[i + 1]);
  else if (k === "Up") moveCursor(nodes[i - 1]);
  else if (k === "Home") moveCursor(nodes[0]);
  else if (k === "End") moveCursor(nodes[nodes.length - 1]);
  else if (k === "PageDown") moveCursor(nodes[Math.min(nodes.length - 1, i + 15)]);
  else if (k === "PageUp") moveCursor(nodes[Math.max(0, i - 15)]);
  else if (k === "Right") { if (isDir && !S.open.has(p)) toggleDir(p, true); else if (isDir) moveCursor(nodes[i + 1]); }
  else if (k === "Left") {
    if (isDir && S.open.has(p)) toggleDir(p, false);
    else { const up = nodes.find((n) => n.dataset.dir === parent(p)); if (up) moveCursor(up); }
  }
  else if (k === "Enter") { if (isDir) toggleDir(p); else openFile(p); }
  else if (k === "Space") { if (isDir) toggleDir(p); else openFile(p, null, { keepFocus: true }); }
  else if (k === "Delete") deletePath(p);
  else if (k === "Shift+F10" || k === "ContextMenu") { const r = el.getBoundingClientRect(); treeMenu(p, isDir, r.left + 24, r.bottom); }
  else if (k === "Esc") focusZone("editor");
  else if (ev.key.length === 1 && /[\w.\-]/.test(ev.key) && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    const now = Date.now();
    typeAhead.s = (now - typeAhead.t < 700 ? typeAhead.s : "") + ev.key.toLowerCase();
    typeAhead.t = now;
    const order = [...nodes.slice(i + (typeAhead.s.length === 1 ? 1 : 0)), ...nodes.slice(0, i + 1)];
    const hit = order.find((n) => n.querySelector(".lbl").textContent.toLowerCase().startsWith(typeAhead.s));
    if (hit) moveCursor(hit);
  } else handled = false;
  if (handled) { ev.preventDefault(); ev.stopPropagation(); }
});
$("treeFilter").oninput = renderTree;
$("treeFilter").addEventListener("keydown", (ev) => {
  const k = keyString(ev);
  if (k === "Down") { ev.preventDefault(); moveCursor($("tree").querySelector('.node[tabindex="0"]') || $("tree").querySelector(".node")); }
  if (k === "Enter") { ev.preventDefault(); const n = $("tree").querySelector(".node.sel") || $("tree").querySelector(".node"); if (n?.dataset.file) openFile(n.dataset.file); }
  if (k === "Esc") { ev.preventDefault(); if ($("treeFilter").value) { $("treeFilter").value = ""; renderTree(); } else focusZone("editor"); }
});
$("tree").addEventListener("click", (ev) => {
  const a = ev.target.closest("[data-act]");
  if (a) { a.dataset.act === "open" ? openFolder() : newProject(); return; }
  const d = ev.target.closest("[data-dir]");
  if (d) { S.sel = d.dataset.dir; S.selDir = true; toggleDir(d.dataset.dir); return; }
  const f = ev.target.closest("[data-file]");
  if (f) { S.sel = f.dataset.file; S.selDir = false; openFile(f.dataset.file); }
});
$("tree").addEventListener("contextmenu", (ev) => {
  if (!S.root) return;
  ev.preventDefault();
  const d = ev.target.closest("[data-dir]"), f = ev.target.closest("[data-file]");
  const p = d?.dataset.dir || f?.dataset.file;
  if (p) { S.sel = p; S.selDir = !!d; renderTree(); }
  treeMenu(p, !!d, ev.clientX, ev.clientY);
});
function treeMenu(p, isDir, x, y) {
  const dirOf = isDir ? p : p ? parent(p) : S.root;
  const items = [
    { label: "New file…", key: "file.new", run: () => newFile(dirOf) },
    { label: "New folder…", key: "file.newFolder", run: () => newFolder(dirOf) },
  ];
  if (p && !isDir) items.unshift({ label: "Open", hint: "Enter", run: () => openFile(p) }, "-");
  if (p) items.push("-", { label: "Rename…", hint: "F2", run: () => renamePath(p) }, { label: "Move to Recycle Bin", hint: "Delete", danger: true, run: () => deletePath(p) }, "-",
    { label: "Copy path", run: () => copy(p) }, { label: "Copy relative path", run: () => copy(rel(p)) });
  else items.push("-", { label: "Refresh", run: refreshTree });
  showMenu(x, y, items);
}
const copy = (s) => navigator.clipboard?.writeText(s).then(() => toast("Copied"), () => toast("Couldn't copy"));
const folderLabel = (dir) => (dir === S.root ? base(S.root) : base(S.root) + "/" + rel(dir));
const targetDir = () => {
  const p = S.sel || (isUnder(S.active, S.root) ? S.active : null);
  if (!p) return S.root;
  return p === S.sel && S.selDir ? p : parent(p);
};

$("bNewFile").onclick = () => S.root ? newFile(targetDir()) : openFolder();
$("bNewFolder").onclick = () => S.root ? newFolder(targetDir()) : openFolder();
$("bRefresh").onclick = () => { refreshTree(); reloadClean(); };
$("bCollapse").onclick = () => { S.open.clear(); renderTree(); saveSession(); };

const validName = (n) => n && !/(^|\/)\.\.?(\/|$)/.test(n) && !/[<>:"|?*\\]/.test(n);
async function newFile(dir = targetDir()) {
  if (!S.root) return openFolder();
  const name = (await promptText(`New file in ${folderLabel(dir)}`, "", "Player.cs, main.rs, or a path like utils/mod.rs"))?.trim();
  if (!name) return;
  if (!validName(name)) { toast("That isn't a usable file name."); return; }
  const path = join(dir, name);
  try { await invoke("create_file", { path }); } catch (e) { toast(String(e)); return; }
  // A new .cs file starts as a class named after the file (a Godot node in Godot projects).
  const cls = base(name).replace(/\.cs$/i, "");
  if (/\.cs$/i.test(name) && /^[A-Za-z_]\w*$/.test(cls)) {
    const P = (await projectFor(path)) || S.proj;
    const ns = P.godot || !P.csproj ? "" : base(P.csproj).replace(/\.csproj$/i, "").replace(/[^\w.]/g, "_");
    const body = P.godot
      ? `using Godot;\n\npublic partial class ${cls} : Node\n{\n    public override void _Ready()\n    {\n    }\n\n    public override void _Process(double delta)\n    {\n    }\n}\n`
      : `${ns ? `namespace ${ns};\n\n` : ""}public class ${cls}\n{\n}\n`;
    try { await invoke("write_file", { path, contents: body }); } catch {}
  }
  if (/\.gdshader$/i.test(name)) {
    try { await invoke("write_file", { path, contents: "shader_type canvas_item;\n\nvoid fragment() {\n\tCOLOR = texture(TEXTURE, UV);\n}\n" }); } catch {}
  }
  await revealInTree(path);
  await refreshTree();
  S.sel = path; S.selDir = false;
  openFile(path);
}
async function newFolder(dir = targetDir()) {
  if (!S.root) return openFolder();
  const name = (await promptText(`New folder in ${folderLabel(dir)}`, ""))?.trim();
  if (!name) return;
  if (!validName(name)) { toast("That isn't a usable folder name."); return; }
  const path = join(dir, name);
  try { await invoke("create_dir", { path }); } catch (e) { toast(String(e)); return; }
  await revealInTree(join(path, "x"));
  S.open.add(path);
  S.sel = path; S.selDir = true;
  await refreshTree();
}
async function renamePath(p) {
  if (!p) return;
  const name = (await promptText(`Rename ${base(p)}`, base(p)))?.trim();
  if (!name || name === base(p)) return;
  if (!validName(name) || name.includes("/")) { toast("That isn't a usable name."); return; }
  const to = join(parent(p), name);
  try { await invoke("rename_path", { from: p, to }); } catch (e) { toast(String(e)); return; }
  const remap = (x) => (x === p ? to : x.startsWith(p + "/") ? to + x.slice(p.length) : x);
  for (const [k, b] of [...S.bufs]) {
    const nk = remap(k);
    if (nk === k) continue;
    const srv = serverOf(b);
    if (srv) srv.close(k);
    S.bufs.delete(k);
    b.mirror = null;
    b.lang = langOf(nk);
    b.state = EditorState.create({ doc: b.state.doc, selection: b.state.selection, extensions: extensionsFor(nk, b) });
    S.bufs.set(nk, b);
    const srv2 = serverOf(b);
    if (srv2) { b.sent = b.state.doc; srv2.open(nk, b.state.doc.toString(), LANGS[b.lang].languageId); }
  }
  S.tabs = S.tabs.map(remap);
  S.open = new Set([...S.open].map(remap));
  for (const P of panes) if (P.key && remap(P.key) !== P.key) { const nk = remap(P.key); S.bufs.get(nk) && (S.bufs.get(nk).mirror = null); P.key = nk; }
  panes.forEach((P, i) => { const b = S.bufs.get(P.key); if (b && P.view && P.view.state !== b.state && P.view.state !== b.mirror) { const k = P.key; P.key = null; showIn(i, k); } });
  if (S.sel) S.sel = remap(S.sel);
  const keep = $("tree").contains(document.activeElement);
  const act = S.active && remap(S.active);
  if (act) { S.active = null; activate(act, null, { noNav: true, keepFocus: keep }); }
  await refreshTree();
  if (keep) focusTree();
}
async function deletePath(p) {
  if (!p) return;
  const c = await choose(`Move ${base(p)} to the Recycle Bin?`, ["Move to Recycle Bin", "Cancel"]);
  if (c !== "Move to Recycle Bin") return;
  const nodes = [...$("tree").querySelectorAll(".node")];
  const i = nodes.findIndex((n) => nodePath(n) === p);
  try { await invoke("delete_path", { path: p }); } catch (e) { toast(String(e)); return; }
  for (const k of [...S.tabs]) if (k === p || k.startsWith(p + "/")) await closeTab(k, true);
  for (const k of [...S.diags.keys()]) if (k === p || k.startsWith(p + "/")) S.diags.delete(k);
  S.sel = nodePath(nodes[i + 1]) || nodePath(nodes[i - 1]) || null;
  await refreshTree();
  renderProblems();
  focusTree();
}

// ---------- tabs, crumbs, pages ----------
const pageOf = (k) => (isPage(k) ? pages.find((pg) => pg.match(k)) : null);
function tabLabel(k) {
  if (k === SETTINGS_TAB) return "Settings";
  if (pageOf(k)) return pageOf(k).label(k);
  const b = S.bufs.get(k);
  if (b?.label) return b.label;
  const n = base(k);
  const same = S.tabs.filter((x) => x !== k && base(x) === n && !isPage(x));
  if (!same.length) return n;
  // Name the nearest folder that tells them apart: greet/src/main.rs → "main.rs · greet".
  const segs = (p) => norm(p).split("/").slice(0, -1).reverse();
  const mine = segs(k);
  const i = mine.findIndex((seg, j) => same.every((o) => segs(o)[j] !== seg));
  return `${n} · ${mine[i >= 0 ? i : 0]}`;
}
function renderTabs() {
  const hadFocus = $("tabs").contains(document.activeElement) ? document.activeElement.dataset.tab : null;
  $("tabs").innerHTML = S.tabs.map((p, i) => {
    const b = S.bufs.get(p), c = counts(S.diags.get(p)), on = p === S.active;
    const dot = p === SETTINGS_TAB ? "cfg" : b?.virtual ? "cs" : pageOf(p) ? pageOf(p).dot : dotOf(p);
    const there = split && otherPane().key === p;
    return `<div class="tab${on ? " on" : ""}${there ? " there" : ""}${b?.dirty ? " dirty" : ""}" role="tab" aria-selected="${on}" style="--tc:var(--t-${dot})" data-tab="${esc(p)}" title="${esc(isPage(p) || b?.virtual ? tabLabel(p) : rel(p))}${there ? "  ·  open in the other pane" : ""}${i < 8 ? `  ·  Ctrl ${i + 1}` : ""}" tabindex="${on ? 0 : -1}"><span class="dot"></span><span class="tl${c.e ? " e" : c.w ? " w" : ""}">${esc(tabLabel(p))}</span>${b?.ro ? '<span class="ro">read-only</span>' : ""}<span class="x" data-close="${esc(p)}" role="button" aria-label="Close ${esc(tabLabel(p))}"><span>×</span></span></div>`;
  }).join("");
  $("tabs").querySelector(".tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (hadFocus) $("tabs").querySelector(`[data-tab="${CSS.escape(hadFocus)}"]`)?.focus();
}
$("tabs").addEventListener("click", (ev) => {
  const x = ev.target.closest("[data-close]");
  if (x) { ev.stopPropagation(); closeTab(x.dataset.close); return; }
  const t2 = ev.target.closest("[data-tab]");
  if (t2) activate(t2.dataset.tab);
});
$("tabs").addEventListener("auxclick", (ev) => { const t2 = ev.target.closest("[data-tab]"); if (t2 && ev.button === 1) closeTab(t2.dataset.tab); });
$("tabs").addEventListener("keydown", (ev) => {
  const t2 = ev.target.closest("[data-tab]");
  if (!t2) return;
  const tabs = [...$("tabs").querySelectorAll(".tab")], i = tabs.indexOf(t2), k = keyString(ev);
  const go = (el) => { if (!el) return; tabs.forEach((x) => (x.tabIndex = x === el ? 0 : -1)); el.focus(); };
  if (k === "Right") go(tabs[i + 1]);
  else if (k === "Left") go(tabs[i - 1]);
  else if (k === "Home") go(tabs[0]);
  else if (k === "End") go(tabs[tabs.length - 1]);
  else if (k === "Enter" || k === "Space") activate(t2.dataset.tab);
  else if (k === "Delete") closeTab(t2.dataset.tab).then(() => $("tabs").querySelector(".tab.on")?.focus());
  else if (k === "Esc") focusZone("editor");
  else return;
  ev.preventDefault();
});

function renderCrumbs() {
  const p = S.active;
  if (!p || isPage(p)) { $("crumbs").innerHTML = ""; return; }
  const b = S.bufs.get(p);
  const parts = b?.virtual ? ["metadata", tabLabel(p)] : isUnder(p, S.root) ? [base(S.root), ...rel(p).split("/")] : p.split("/").filter(Boolean).slice(-4);
  $("crumbs").innerHTML = parts.map((s, i) => (i === parts.length - 1 ? `<b>${esc(s)}</b>` : esc(s))).join(" <span>›</span> ");
}

function renderWelcome() {
  const w = $("welcome");
  const recent = prefs.recent.filter((r) => r !== S.root);
  const k = (id) => keymap.label(id);
  const hadFocus = w.contains(document.activeElement);
  w.innerHTML = `<div class="wi">
    <h1>${S.root ? esc(base(S.root)) : esc(APP_NAME)}</h1>
    <p class="lede">${S.root ? `Pick a file from the explorer, or press ${k("file.goto")} to jump to one.` : "An editor for Rust, C# and Godot."}</p>
    <div class="bar">${S.root
      ? `<button class="btn primary" data-w="find">Go to file <kbd>${k("file.goto")}</kbd></button>${taskKind() ? `<button class="btn" data-w="run">${esc(taskLabel("run"))} <kbd>${k("task.run")}</kbd></button>` : ""}<button class="btn" data-w="open">Open another folder</button>`
      : `<button class="btn primary" data-w="open">Open folder <kbd>${k("folder.open")}</kbd></button><button class="btn" data-w="new">New project</button>`}
      <button class="btn" data-w="settings">Settings <kbd>${k("settings.open")}</kbd></button></div>
    ${recent.length ? `<section><h2>Recent <span class="hint" style="font-weight:400">· Ctrl Enter opens in a new window</span></h2><div class="list" role="list">${recent.map((r, i) => `<div class="li" role="button" tabindex="${i ? -1 : 0}" data-recent="${esc(r)}" style="--tc:var(--t-rs)"><span class="dot"></span><span class="t">${esc(base(r))}</span><span class="m">${esc(parent(r))}</span></div>`).join("")}</div></section>` : ""}
    <section><h2>Getting around</h2><div class="keys">${[
      ["settings.open", "Settings"], ["file.goto", "Go to file"], ["palette", "All commands and their keys"], ["focus.next", "Move between explorer, editor, panel and status bar"],
      ["focus.explorer", "Explorer: arrows, Enter, F2 rename, Delete"], ["task.run", "Run, or Play in Godot projects"], ["task.build", "Build"], ["problems.next", "Next problem"],
      ["editor.definition", "Go to definition"], ["editor.references", "Find all references"], ["editor.info", "Show info at the cursor"], ["editor.actions", "Quick fixes"], ["nav.back", "Go back"],
      ["debug.toggleBreakpoint", "Breakpoint on this line"], ["debug.start", "Start debugging"], ["terminal.toggle", "Terminal"], ["git.view", "Source control (Git)"], ["outline.show", "Outline of this file"], ["editor.split", "Split the editor"], ["window.new", "New window"],
    ].map(([id, d]) => `<kbd>${k(id) || "none"}</kbd><span>${d}</span>`).join("")}</div></section>
  </div>`;
  if (hadFocus) w.querySelector("button")?.focus();
}
$("welcome").addEventListener("click", (ev) => {
  const r = ev.target.closest("[data-recent]");
  if (r) { ev.ctrlKey || ev.shiftKey ? openFolderInNewWindow(r.dataset.recent) : openFolder(r.dataset.recent); return; }
  const b = ev.target.closest("[data-w]");
  if (!b) return;
  ({ open: () => openFolder(), new: newProject, find: () => openPalette("files"), run: () => runAction("run"), settings: openSettings })[b.dataset.w]();
});
$("welcome").addEventListener("keydown", (ev) => {
  const r = ev.target.closest("[data-recent]");
  if (!r) return;
  const all = [...$("welcome").querySelectorAll("[data-recent]")], i = all.indexOf(r), k = keyString(ev);
  if (k === "Enter" || k === "Space") { ev.preventDefault(); openFolder(r.dataset.recent); }
  if (k === "Ctrl+Enter" || k === "Shift+Enter") { ev.preventDefault(); openFolderInNewWindow(r.dataset.recent); }
  if (k === "Down" || k === "Up") { ev.preventDefault(); const n = all[i + (k === "Down" ? 1 : -1)]; if (n) { all.forEach((x) => (x.tabIndex = x === n ? 0 : -1)); n.focus(); } }
});

function renderSettingsPage(keepFocus) {
  const el = $("settings");
  const a = document.activeElement;
  const fid = keepFocus && el.contains(a) ? (a.id ? "#" + CSS.escape(a.id) : a.dataset.rec ? `[data-rec="${CSS.escape(a.dataset.rec)}"]` : a.dataset.act ? `[data-act="${CSS.escape(a.dataset.act)}"]` : a.dataset.copy ? `[data-copy="${CSS.escape(a.dataset.copy)}"]` : null) : null;
  const top = el.scrollTop;
  el.innerHTML = settingsHtml();
  el.scrollTop = top;
  if (fid) el.querySelector(fid)?.focus({ preventScroll: true });
}
function openSettings() {
  const first = S.active !== SETTINGS_TAB;
  activate(SETTINGS_TAB);
  refreshSettingsTools().then(() => { if (S.active === SETTINGS_TAB) renderSettingsPage(true); });
  if (first) requestAnimationFrame(() => $("settings").querySelector("select, input, button")?.focus());
}

function renderMain() {
  const left = panes[0].key;
  const page = left === SETTINGS_TAB;
  $("editor").hidden = !S.bufs.has(left);
  $("welcome").hidden = !!left;
  $("settings").hidden = !page;
  for (const pg of pages) pg.el.hidden = !(left && pg.match(left));
  if (page) renderSettingsPage(true);
  for (const pg of pages) if (left && pg.match(left)) pg.render(left);
  if (!left) renderWelcome();
  renderTabs(); renderCrumbs(); renderTree(); renderPos(); renderStatus(); renderPaneHeads(); renderDiskBars();
}
/** Other kinds of tab page (diffs): { el, match(key), render(key), label(key), dot } */
const pages = [];

// ---------- status bar ----------
function renderPos() {
  const b = S.bufs.get(S.active);
  if (!b || !view) { $("stPos").textContent = ""; $("stLang").textContent = ""; renderServer(); return; }
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const n = Math.abs(sel.to - sel.from);
  $("stPos").textContent = `Ln ${line.number}, Col ${sel.head - line.from + 1}${n ? ` (${n} selected)` : ""}`;
  $("stLang").textContent = LANGS[b.lang].name + (b.eol === "\r\n" ? " · CRLF" : "") + (b.bom ? " · BOM" : "");
  renderServer();
}
function renderServer() {
  const el = $("stServer");
  const b = S.bufs.get(S.active);
  let srv = serverOf(b);
  if (!srv || !started(srv)) srv = [servers.csharp, servers.rust].find((s) => started(s) && s.state.text && (S.ctx ? (s.id === "rust" ? S.ctx.rust : S.ctx.dotnet) : true)) || null;
  if (!srv || !srv.state.text) { el.textContent = ""; el.hidden = true; return; }
  el.hidden = false;
  const s = srv.state;
  el.textContent = `${srv.label}: ${s.text}`;
  el.className = (s.busy ? "spin" : "") + (s.bad ? " e" : "");
  el.title = s.detail || srv.label;
  el.dataset.server = srv.id;
}
$("stServer").onclick = () => {
  const srv = servers[$("stServer").dataset.server];
  if (!srv) return;
  if (srv.state.detail) toast(srv.state.detail, 8000);
  if (srv.state.bad) startServer(srv.id);
};

// ---------- projects & tasks ----------
// S.proj describes the opened folder itself; S.ctx is the project the open
// file belongs to. They differ when one folder (a course folder, say) holds
// several projects. Run, Build and Test always use S.ctx.
function detectProject() {
  const kids = S.kids.get(S.root) || [];
  const names = kids.filter((k) => !k.dir).map((k) => k.name);
  const pick = (re) => { const n = names.filter((x) => re.test(x)); return n.length ? join(S.root, n[0]) : null; };
  S.proj = { dir: S.root, rust: names.includes("Cargo.toml"), godot: names.includes("project.godot"), sln: pick(/\.slnx?$/i), csproj: pick(/\.csproj$/i) };
  S.proj.dotnet = !!(S.proj.sln || S.proj.csproj);
}
const MARKER = (b) => b === "Cargo.toml" || b === "project.godot" || /\.(csproj|slnx?)$/i.test(b);
/** Folders under the root that hold a project, outermost first. */
function projectDirs() {
  const dirs = [...new Set((S.files || []).filter((f) => MARKER(base(f))).map(parent))].sort((a, b) => a.length - b.length);
  return dirs.filter((d, i) => !dirs.slice(0, i).some((o) => isUnder(d, o) && o !== d));
}
const hasAny = (re) => (S.files || []).some((f) => re.test(base(f)));
async function projectFor(path) {
  if (!S.root) return null;
  const at = (p) => invoke("project_at", { path: p, root: S.root }).catch(() => null);
  let p = path && isUnder(path, S.root) ? await at(path) : null;
  if (!p) p = await at(S.root);
  if (!p) { const all = projectDirs(); if (all.length === 1) p = await at(all[0]); }
  if (!p) return null;
  p.dir = norm(p.dir);
  p.sln = p.sln && norm(p.sln);
  p.csproj = p.csproj && norm(p.csproj);
  p.dotnet = !!(p.sln || p.csproj);
  return p;
}
let ctxSeq = 0;
async function updateCtx() {
  const seq = ++ctxSeq;
  const from = S.bufs.has(S.active) && !S.bufs.get(S.active).virtual ? S.active : S.selDir ? S.sel : S.sel ? parent(S.sel) : null;
  const p = await projectFor(from);
  if (seq !== ctxSeq) return S.ctx;
  S.ctx = p;
  renderStatus();
  if (!S.active) renderWelcome();
  return p;
}
function taskKind(P = S.ctx) {
  if (!P) return null;
  if (P.godot) return "godot";
  if (P.rust && P.dotnet) return S.bufs.get(S.active)?.lang === "csharp" ? "dotnet" : "rust";
  if (P.dotnet) return "dotnet";
  if (P.rust) return "rust";
  return null;
}
// Each action is a list of steps; a step runs only if the one before succeeded.
// `input: true` marks steps that run the user's program, which get the Input box.
function taskSteps(action, P = S.ctx) {
  const kind = taskKind(P);
  if (!kind) return null;
  const cwd = P.dir;
  const dotTarget = P.sln || P.csproj;
  const dotBuild = { label: "dotnet build", program: "dotnet", args: ["build", ...(dotTarget ? [dotTarget] : []), "-nologo", "-clp:NoSummary"], cwd };
  const cargo = (sub, input) => ({ label: "cargo " + sub, program: "cargo", args: [sub], cwd, input });
  const godotPlay = (scene) => ({ label: scene ? "Play " + base(scene) : "Play", program: settings.godot, args: ["--path", cwd, ...(scene ? [scene] : [])], cwd, godot: true });
  const scene = S.active && /\.tscn$/i.test(S.active) && isUnder(S.active, cwd) ? "res://" + norm(S.active).slice(cwd.length + 1) : null;
  const T = {
    rust: { run: [cargo("run", true)], build: [cargo("build")], check: [cargo("check")], test: [cargo("test", true)], lint: [cargo("clippy")] },
    dotnet: {
      run: [{ label: "dotnet run", program: "dotnet", args: ["run", ...(P.csproj ? ["--project", P.csproj] : [])], cwd, input: true }],
      build: [dotBuild], check: [dotBuild],
      test: [{ label: "dotnet test", program: "dotnet", args: ["test", ...(dotTarget ? [dotTarget] : []), "-nologo"], cwd, input: true }],
    },
    godot: {
      run: [...(P.dotnet ? [dotBuild] : []), godotPlay()],
      scene: scene ? [...(P.dotnet ? [dotBuild] : []), godotPlay(scene)] : null,
      build: P.dotnet ? [dotBuild] : null, check: P.dotnet ? [dotBuild] : null,
    },
  };
  return T[kind][action] || null;
}
function taskLabel(action) {
  return { run: taskKind() === "godot" ? "Play" : "Run", build: "Build", check: "Check", test: "Test", lint: "Clippy", scene: "Play scene", debug: "Debug" }[action];
}
async function runAction(action) {
  if (!S.root) { toast("Open a folder first."); return; }
  const P = await updateCtx();
  const steps = taskSteps(action, P);
  if (!steps) {
    if (!P) toast(projectDirs().length > 1 ? "Open a file from the project you want. This folder holds several projects." : "No Cargo.toml, .csproj, .sln or project.godot here.", 5000);
    else if (action === "scene") toast("Open a .tscn scene file to play it.");
    else toast(`${taskLabel(action)} isn't available for this project.`);
    return;
  }
  if (steps.some((s) => s.godot && !s.program)) {
    toast("Set the Godot program in Settings first.", 4000);
    openSettings();
    requestAnimationFrame(() => { const f = $("sGodotPath"); f?.focus(); f?.scrollIntoView({ block: "center" }); });
    return;
  }
  startSteps(steps);
}
async function startSteps(steps, onDone, onFail) {
  if (!S.root) { toast("Open a folder first."); return; }
  await saveAll();
  showPanel("output");
  S.queue = steps.slice(1);
  S.onDone = onDone || null;
  S.onFail = onFail || null;
  startStep(steps[0]);
}
async function startStep(step) {
  const cwd = step.cwd || S.ctx?.dir || S.root;
  S.running = true;
  S.runStart = performance.now();
  S.runLabel = step.label;
  S.runDir = cwd;
  S.runInput = !!step.input;
  const show = (a) => (a === cwd ? "." : isAbs(a) && isUnder(norm(a), cwd) ? norm(a).slice(cwd.length + 1) : a);
  const shown = `${step.godot ? base(norm(step.program)) : step.program} ${step.args.map(show).join(" ")}`;
  appendOut(`<span class="cmd">$ ${esc(shown)}${cwd !== S.root ? `   <span class="where">in ${esc(rel(cwd))}</span>` : ""}</span>`);
  renderStatus();
  const run = ++S.runSeq;
  S.run = run; // set before starting, so events from an older run are ignored
  try { await invoke("run_task", { run, root: cwd, program: step.program, args: step.args }); }
  catch (e) { S.running = false; S.runInput = false; S.queue = []; appendOut(`<span class="done bad">${esc(String(e))}</span>`); renderStatus(); const f = S.onFail; S.onFail = S.onDone = null; f?.(); }
}
listen("task-line", (e) => { if (e.payload.run === S.run) appendOut(ansiToHtml(e.payload.text)); });
listen("task-done", (e) => {
  if (e.payload.run !== S.run) return;
  const code = e.payload.run === S.stopped ? null : e.payload.code, secs = ((performance.now() - S.runStart) / 1000).toFixed(1);
  appendOut(`<span class="done ${code === 0 ? "ok" : "bad"}">${code === 0 ? "Finished" : code == null ? "Stopped" : "Exited with code " + code} · ${secs}s</span>\n`);
  if (code === 0 && S.queue.length) { startStep(S.queue.shift()); return; }
  const hadInputFocus = $("stdinForm").contains(document.activeElement);
  S.running = false;
  S.runInput = false;
  S.queue = [];
  S.lastRun = { code, secs, label: S.runLabel };
  renderStatus();
  if (hadInputFocus) $("out").focus();
  if (/^cargo fmt|^dotnet format/.test(S.runLabel)) reloadClean();
  const cb = S.onDone, fail = S.onFail;
  S.onDone = S.onFail = null;
  if (cb && code === 0) cb();
  else fail?.();
});
function stopTask() { S.queue = []; if (S.running) S.stopped = S.run; invoke("task_stop"); }

// The Input box: lines typed here go to the running program (read_line, Console.ReadLine).
$("stdinForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const inp = $("stdinIn"), text = inp.value;
  appendOut(`<span class="in">› ${esc(text)}</span>`); // before sending, so it shows above the reply
  inp.value = "";
  try { await invoke("task_input", { text }); }
  catch (e) { toast(String(e)); }
});
function endInput() {
  if (!S.running) return;
  invoke("task_input_end").catch(() => {});
  appendOut(`<span class="in">› (end of input)</span>`);
  S.runInput = false;
  renderStatus();
  $("out").focus();
}
$("bEndInput").onclick = endInput;
function focusInput() {
  if (!S.running || !S.runInput) { toast("Nothing is running that reads input."); return; }
  showPanel("output");
  $("stdinIn").focus();
}

function renderStatus() {
  const kind = taskKind();
  const k = (id) => (keymap.label(id) ? ` (${keymap.label(id)})` : "");
  const acts = !kind ? [] : kind === "rust" ? ["run", "debug", "check", "test", "lint"] : kind === "dotnet" ? ["run", "debug", "build", "test"] : ["run", "debug", "scene", "build"].filter((a) => a === "debug" ? S.ctx?.dotnet : taskSteps(a));
  const id = { run: "task.run", build: "task.build", check: "task.check", test: "task.test", lint: "task.lint", scene: "task.scene", debug: "debug.start" };
  const hadFocus = $("stTasks").contains(document.activeElement) ? document.activeElement.dataset.task : null;
  $("stTasks").innerHTML = acts.map((a, i) => `<button data-task="${a}" class="${i === 0 ? "go" : ""}" title="${esc(taskLabel(a) + k(id[a]))}">${i === 0 ? '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1.2l7 3.8-7 3.8z" fill="currentColor"/></svg>' : ""}${esc(taskLabel(a))}</button>`).join("");
  if (hadFocus) $("stTasks").querySelector(`[data-task="${hadFocus}"]`)?.focus();
  $("stStop").hidden = !S.running;
  $("stStop").title = "Stop" + k("task.stop");
  const showIn = S.running && S.runInput && S.ptab === "output";
  if ($("stdinForm").hidden === showIn) $("stdinForm").hidden = !showIn;
  $("stdinIn").title = "Type a line for the program and press Enter" + k("program.input");
  const multi = S.ctx && S.ctx.dir !== S.root;
  $("stProj").hidden = !multi;
  if (multi) { $("stProj").textContent = base(S.ctx.dir); $("stProj").title = `Run, Build and Test use ${rel(S.ctx.dir)}, the project of the open file`; }
  const el = $("stTask");
  if (S.running) { el.className = "seg spin"; el.textContent = S.runLabel; }
  else {
    el.className = "seg";
    const r = S.lastRun;
    el.innerHTML = r ? `<span class="${r.code === 0 ? "" : "e"}">${r.code === 0 ? "✓" : "✕"} ${esc(r.label)} · ${r.secs}s</span>` : "";
  }
  $("stSearch").innerHTML = `Go to file <kbd>${esc(keymap.label("file.goto"))}</kbd>`;
  $("stSettings").title = "Settings" + k("settings.open");
  $("stToggle").title = "Toggle explorer" + k("view.explorer");
}
$("stTasks").addEventListener("click", (ev) => { const b = ev.target.closest("[data-task]"); if (b) (b.dataset.task === "debug" ? debug?.start() : runAction(b.dataset.task)); });
$("stStop").onclick = stopTask;
$("stToggle").onclick = () => toggleExplorer();
$("stSearch").onclick = () => openPalette("files");
$("stProblems").onclick = () => showPanel("problems", true);
$("stSettings").onclick = () => openSettings();
// Arrow keys move along the status bar like a toolbar.
$("statusbar").addEventListener("keydown", (ev) => {
  const k = keyString(ev);
  if (k === "Esc") { ev.preventDefault(); focusZone("editor"); return; }
  if (!["Left", "Right", "Home", "End"].includes(k)) return;
  const items = [...$("statusbar").querySelectorAll("button")].filter((b) => !b.hidden && b.offsetParent);
  const i = items.indexOf(document.activeElement);
  const n = k === "Home" ? items[0] : k === "End" ? items[items.length - 1] : items[i + (k === "Right" ? 1 : -1)];
  if (n) { ev.preventDefault(); n.focus(); }
});

function toggleExplorer(force) {
  prefs.collapsed = force != null ? !force : !prefs.collapsed;
  $("app").classList.toggle("collapsed", prefs.collapsed);
  savePrefs();
}

// ---------- appearance from settings ----------
function applyTheme() {
  if (settings.theme === "light" || settings.theme === "dark") document.documentElement.dataset.theme = settings.theme;
  else delete document.documentElement.dataset.theme;
}
function applyFonts() {
  const r = document.documentElement.style;
  r.setProperty("--code-size", settings.fontSize + "px");
  r.setProperty("--code-font", settings.fontFamily ? `"${String(settings.fontFamily).replace(/"/g, "")}", var(--mono)` : "var(--mono)");
  r.setProperty("--ui-size", settings.uiSize + "px");
  view?.requestMeasure();
}
function reconfigureAll() {
  for (const p of S.bufs.keys()) dispatchBuf(p, { effects: cfg.reconfigure(cfgExt()) });
}
function applySetting(key) {
  if (key === "theme") applyTheme();
  if (["fontSize", "fontFamily", "uiSize"].includes(key)) applyFonts();
  if (key === "tabSize" || key === "wordWrap") reconfigureAll();
  if (key === "inlayHints") for (const p of S.bufs.keys()) refreshHints(p);
  if (key === "keys") { keymap.setOverrides(settings.keys); renderStatus(); }
  if ((key === "rustAnalyzer" || key === "rustCheck") && started(servers.rust)) startServer("rust");
  if ((key === "csharpServer" || key === "csharpArgs") && started(servers.csharp)) startServer("csharp");
  if (key === "godot") renderStatus();
  if (["bracketColors", "indentGuides", "stickyScroll", "codeLens", "gitGutter", "dependencyHints"].includes(key)) reconfigureExtras();
  if (key === "statusBar") applyStatusBar();
  if (["theme", "fontSize", "fontFamily"].includes(key)) requestAnimationFrame(() => term?.restyle());
  for (const f of settingHooks) f(key);
}
const settingHooks = [];
function applyStatusBar() {
  $("app").classList.toggle("status-top", settings.statusBar === "top");
}
function zoom(d) {
  setSetting("fontSize", d === 0 ? DEFAULTS.fontSize : Math.max(9, Math.min(32, settings.fontSize + d)));
  if (S.active === SETTINGS_TAB) renderSettingsPage(true);
  toast(`Editor text size ${settings.fontSize}`);
}
function toggleTheme() {
  const dark = settings.theme === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : settings.theme === "dark";
  setSetting("theme", dark ? "light" : "dark");
  if (S.active === SETTINGS_TAB) renderSettingsPage(true);
}

// ---------- panel: output & problems ----------
function showPanel(tab, toggle) {
  if (toggle && S.panel && S.ptab === tab) { S.panel = false; renderPanel(); focusZone("editor"); return; }
  S.panel = true;
  if (tab) S.ptab = tab;
  renderPanel();
}
function togglePanel() { S.panel = !S.panel; renderPanel(); if (!S.panel) focusZone("editor"); }
// Each panel tab: its button, what it shows, and where focus goes.
const panelTabs = {
  output: { btn: "ptOutput", els: ["out"], focus: () => $("out").focus() },
  problems: { btn: "ptProblems", els: ["problems"], focus: () => ($("problems").querySelector('.prob[tabindex="0"]') || $("problems")).focus() },
  refs: { btn: "ptRefs", els: ["refs"], focus: () => ($("refs").querySelector('.prob[tabindex="0"]') || $("refs")).focus() },
  terminal: { btn: "ptTerminal", els: ["terms", "termTabs", "bNewTerm", "bKillTerm"] },
  dconsole: { btn: "ptDconsole", els: ["dcon"], focus: () => $("dconIn").focus() },
};
function renderPanel() {
  $("panel").hidden = !S.panel;
  for (const [k, t] of Object.entries(panelTabs)) {
    $(t.btn).setAttribute("aria-pressed", S.ptab === k);
    for (const id of t.els) $(id).hidden = S.ptab !== k;
  }
  $("stdinForm").hidden = !(S.ptab === "output" && S.running && S.runInput);
  $("bClearOut").hidden = !["output", "dconsole"].includes(S.ptab);
  if (S.ptab === "output") $("out").scrollTop = $("out").scrollHeight;
  if (S.panel) panelTabs[S.ptab].shown?.();
}
function focusPanel(tab) {
  showPanel(tab || S.ptab);
  requestAnimationFrame(() => panelTabs[S.ptab].focus?.());
}
function openOutLink(a) {
  const f = norm(a.dataset.file);
  let target = isAbs(f) ? f : null;
  if (!target) {
    // Try the run's folder, then the folders above it (Cargo workspaces print paths from the workspace root).
    const tries = [];
    for (let d = S.runDir || S.root; d && isUnder(d, S.root); d = parent(d)) { tries.push(join(d, f)); if (d === S.root) break; }
    target = tries.find((t) => (S.files || []).includes(t)) || tries[0] || join(S.root, f);
  }
  openFile(target, { line: Math.max(0, +a.dataset.line - 1), character: Math.max(0, +a.dataset.col - 1) });
}
$("panel").addEventListener("click", (ev) => {
  const pt = ev.target.closest("[data-ptab]");
  if (pt) { S.ptab = pt.dataset.ptab; renderPanel(); panelTabs[S.ptab].focus?.(); return; }
  const a = ev.target.closest("a[data-file]");
  if (a) { openOutLink(a); return; }
  const p = ev.target.closest("[data-pp]");
  if (p) openFile(p.dataset.pp, { line: +p.dataset.l, character: +p.dataset.c });
});
$("panel").addEventListener("keydown", (ev) => {
  if (ev.target.closest(".terms")) return; // the shell gets every key, Esc included
  const k = keyString(ev);
  if (k === "Esc") { ev.preventDefault(); focusZone("editor"); return; }
  const a = ev.target.closest("a[data-file]");
  if (a && k === "Enter") { ev.preventDefault(); openOutLink(a); return; }
  const p = ev.target.closest(".prob");
  if (p) {
    const all = [...p.closest(".problems").querySelectorAll(".prob")], i = all.indexOf(p);
    const go = (el) => { if (!el) return; all.forEach((x) => (x.tabIndex = x === el ? 0 : -1)); el.focus(); el.scrollIntoView({ block: "nearest" }); };
    if (k === "Down") go(all[i + 1]);
    else if (k === "Up") go(all[i - 1]);
    else if (k === "Home") go(all[0]);
    else if (k === "End") go(all[all.length - 1]);
    else if (k === "Enter") openFile(p.dataset.pp, { line: +p.dataset.l, character: +p.dataset.c });
    else if (k === "Space") openFile(p.dataset.pp, { line: +p.dataset.l, character: +p.dataset.c }, { keepFocus: true });
    else return;
    ev.preventDefault();
  }
});
$("bClearOut").onclick = () => { $(S.ptab === "dconsole" ? "dconOut" : "out").innerHTML = ""; };
$("bClosePanel").onclick = () => { S.panel = false; renderPanel(); };

const OUT_MAX = 5000;
function appendOut(html) {
  const out = $("out");
  const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const d = document.createElement("div");
  d.innerHTML = html;
  out.append(d);
  while (out.childElementCount > OUT_MAX) out.firstElementChild.remove();
  if (atEnd) out.scrollTop = out.scrollHeight;
}

function renderProblems() {
  const box = $("problems");
  const focused = box.contains(document.activeElement) ? document.activeElement : null;
  const fkey = focused?.dataset?.pp ? `${focused.dataset.pp}|${focused.dataset.l}|${focused.dataset.c}` : null;
  const files = [...S.diags.entries()].map(([p, l]) => [p, l.filter((d) => (d.severity || 1) <= 3)]).filter(([, l]) => l.length)
    .sort((a, b) => counts(b[1]).e - counts(a[1]).e || rel(a[0]).localeCompare(rel(b[0])));
  let E = 0, W = 0, first = true;
  box.innerHTML = files.map(([p, l]) => {
    const c = counts(l); E += c.e; W += c.w;
    const rows = l.slice().sort((a, b) => (a.severity || 1) - (b.severity || 1) || a.range.start.line - b.range.start.line);
    return `<h3>${esc(rel(p))} <span>${l.length}</span></h3>` + rows.map((d) => {
      const sv = severity(d.severity || 1);
      const h = `<div class="prob" role="button" tabindex="${first ? 0 : -1}" data-pp="${esc(p)}" data-l="${d.range.start.line}" data-c="${d.range.start.character}"><span class="sv ${sv}">${sv[0].toUpperCase()}</span><span class="ms">${esc(d.message)}</span><span class="at">${d.range.start.line + 1}:${d.range.start.character + 1}</span></div>`;
      first = false;
      return h;
    }).join("");
  }).join("") || `<p class="empty" style="padding:8px 6px">${Object.values(servers).some((s) => s.alive) ? "No problems." : "Problems appear here once a language server is running."}</p>`;
  if (focused) {
    const all = [...box.querySelectorAll(".prob")];
    const el = all.find((x) => `${x.dataset.pp}|${x.dataset.l}|${x.dataset.c}` === fkey) || all[0];
    if (el) { all.forEach((x) => (x.tabIndex = x === el ? 0 : -1)); el.focus({ preventScroll: true }); }
    else box.focus();
  }
  $("stProblems").innerHTML = `<span class="${E ? "e" : ""}">${E} error${E === 1 ? "" : "s"}</span><span class="${W ? "w" : ""}">${W} warning${W === 1 ? "" : "s"}</span>`;
}

// ---------- focus areas (F6) ----------
const ZONES = ["explorer", "editor", "editor2", "panel", "status"];
function currentZone() {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  if (a.closest(".side")) return "explorer";
  if (a.closest("#panel")) return "panel";
  if (a.closest("#statusbar")) return "status";
  if (a.closest("#pane1")) return "editor2";
  if (a.closest(".main")) return "editor";
  return null;
}
function focusZone(z) {
  if (z === "editor2") { if (split) panes[1].view.focus(); return; }
  if (z === "editor" && split && fp === 1 && S.bufs.has(panes[1].key) && currentZone() !== "editor2") { panes[1].view.focus(); return; }
  if (z === "explorer") showSideView(sideView, true);
  else if (z === "editor") {
    if (split && fp === 1) setFocusPane(0);
    const left = panes[0].key;
    if (S.bufs.has(left)) panes[0].view.contentDOM.focus({ preventScroll: true });
    else if (left === SETTINGS_TAB) $("settings").querySelector("select, input, button")?.focus();
    else if (pageOf(left)) pageOf(left).focus?.(left);
    else $("welcome").querySelector("button, [tabindex='0']")?.focus();
  } else if (z === "panel") focusPanel();
  else if (z === "status") ($("stTasks").querySelector("button") || $("stSearch")).focus();
}
function cycleZone(d) {
  const zones = ZONES.filter((z) => (z !== "panel" || S.panel) && (z !== "editor2" || split));
  const cur = currentZone();
  const i = cur ? zones.indexOf(cur) : -1;
  focusZone(zones[(i + d + zones.length) % zones.length]);
}
function focusTree() {
  if (!S.root) { $("tree").querySelector("button")?.focus(); return; }
  if (!S.sel && S.active && isUnder(S.active, S.root)) S.sel = S.active;
  renderTree();
  const n = $("tree").querySelector('.node[tabindex="0"]') || $("tree").querySelector(".node");
  if (n) moveCursor(n); else $("treeFilter").focus();
}

// ---------- side bar views: files, outline, git, debug ----------
let sideView = ["files", "outline", "git", "debug"].includes(prefs.sideView) ? prefs.sideView : "files";
const sideViews = {
  files: { btn: "vbFiles", el: "vFiles", focus: focusTree, render: renderTree },
  outline: { btn: "vbOutline", el: "vOutline" },
  git: { btn: "vbGit", el: "vGit" },
  debug: { btn: "vbDebug", el: "vDebug" },
};
function showSideView(name, focus) {
  if (prefs.collapsed) toggleExplorer(true);
  sideView = name;
  prefs.sideView = name;
  savePrefs();
  for (const [k, v] of Object.entries(sideViews)) {
    $(v.el).hidden = k !== name;
    $(v.btn).setAttribute("aria-selected", k === name);
    $(v.btn).tabIndex = k === name ? 0 : -1;
  }
  sideViews[name].render?.();
  if (focus) sideViews[name].focus?.();
}
$("views").addEventListener("click", (ev) => { const b = ev.target.closest("[data-view]"); if (b) showSideView(b.dataset.view, true); });
$("views").addEventListener("keydown", (ev) => {
  const k = keyString(ev), names = Object.keys(sideViews), i = names.indexOf(sideView);
  if (k === "Left" || k === "Right") { ev.preventDefault(); const n = names[(i + (k === "Right" ? 1 : -1) + names.length) % names.length]; showSideView(n); $(sideViews[n].btn).focus(); }
  else if (k === "Down" || k === "Enter") { ev.preventDefault(); sideViews[sideView].focus?.(); }
  else if (k === "Esc") { ev.preventDefault(); focusZone("editor"); }
});

async function revealActiveInExplorer() {
  if (!S.active || !isUnder(S.active, S.root)) return showSideView("files", true);
  $("treeFilter").value = "";
  await revealInTree(S.active);
  S.sel = S.active; S.selDir = false;
  showSideView("files", true);
}

// ---------- palette, prompts, choices ----------
// Extra palette prefixes from other modules: { prefix, hint, draw(query, redraw) → { list, html }, pick(item) }
const palModes = [];
const pal = { mode: "files", list: [], sel: 0, resolve: null, prevFocus: null, searchT: null, searchQ: null, wantIndex: false };
function openPalette(mode, init = "", head = "") {
  if (!$("palOv").hidden) finishPalette(null);
  if (view) closeInfo(view);
  pal.mode = mode; pal.sel = 0; pal.list = []; pal.searchQ = null; pal.prevFocus = document.activeElement;
  $("palOv").hidden = false;
  $("palHead").textContent = head || (mode === "text" ? "Search in files" : "");
  const inp = $("palIn");
  inp.hidden = mode === "choose";
  inp.value = init;
  inp.placeholder = mode === "text" ? "Text to find…" : mode === "files" ? "File name   ·   > commands   ·   : line   ·   @ symbol here   ·   # symbol anywhere" : "";
  if (mode === "files") loadFiles().then(() => { if (pal.mode === "files" && !$("palOv").hidden) drawPalette(); });
  drawPalette();
  if (mode === "choose") $("palRes").querySelector(".li")?.focus(); else { inp.focus(); inp.setSelectionRange(init.length, init.length); }
}
function finishPalette(value) {
  $("palOv").hidden = true;
  const r = pal.resolve;
  pal.resolve = null;
  if (r) r(value);
  if (pal.prevFocus?.focus && document.contains(pal.prevFocus)) pal.prevFocus.focus({ preventScroll: true });
}
function promptText(head, init = "", placeholder = "") {
  return new Promise((resolve) => {
    openPalette("prompt", init, head);
    $("palIn").placeholder = placeholder;
    $("palIn").select();
    pal.resolve = resolve;
  });
}
/** Resolves to the chosen label (or its index with wantIndex), or null. */
function choose(head, options, wantIndex = false) {
  return new Promise((resolve) => {
    pal.options = options;
    pal.wantIndex = wantIndex;
    openPalette("choose", "", head);
    pal.resolve = resolve;
  });
}

function fuzzy(q, s) {
  q = q.replace(/\s+/g, ""); // "greet main" finds greet/src/main.rs
  const sl = s.toLowerCase();
  let qi = 0, score = 0, last = -2;
  for (let i = 0; i < sl.length && qi < q.length; i++) {
    if (sl[i] === q[qi]) { score += (i === last + 1 ? 5 : 1) + (i === 0 || "/_-.".includes(sl[i - 1]) ? 3 : 0); last = i; qi++; }
  }
  if (qi < q.length) return -1;
  const b = base(s).toLowerCase();
  if (b.startsWith(q)) score += 30; else if (b.includes(q)) score += 18;
  return score - s.length * 0.02;
}
function hlText(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? esc(text) : esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
}
const row = (i, dot, title, meta, extra, code) =>
  `<div class="li" role="option" tabindex="-1" data-pi="${i}" aria-selected="${i === pal.sel}" style="--tc:var(--t-${dot})"><span class="dot"></span><span class="t">${title}</span><span class="m">${meta}</span>${extra ? `<span class="x${code ? " code" : ""}">${extra}</span>` : ""}</div>`;

function drawPalette() {
  const v = $("palIn").value, res = $("palRes");
  let html = "";
  if (pal.mode === "prompt") { res.innerHTML = ""; return; }
  if (pal.mode === "choose") {
    pal.list = pal.options.map((o, i) => ({ choice: o, i }));
    html = pal.options.map((o, i) => row(i, i === 0 ? "rs" : "other", esc(o), i < 9 ? `<kbd>${i + 1}</kbd>` : "", "")).join("");
  } else if (pal.mode === "text") {
    const q = v;
    if (q !== pal.searchQ) {
      pal.searchQ = q;
      clearTimeout(pal.searchT);
      pal.searchT = null;
      pal.list = [];
      if (q.trim().length > 1 && S.root) pal.searchT = setTimeout(async () => {
        let hits = [];
        try { hits = await invoke("search_text", { root: S.root, query: q, caseSensitive: false }); } catch {}
        pal.searchT = null;
        if (pal.mode !== "text" || $("palIn").value !== q) return;
        pal.list = hits.map((h) => ({ path: norm(h.path), line: h.line, col: h.col, text: h.text }));
        pal.sel = 0;
        drawPalette();
      }, 160);
    }
    html = pal.list.map((h, i) => row(i, dotOf(h.path), esc(rel(h.path)) + `<span style="color:var(--faint)">:${h.line + 1}</span>`, "", hlText(h.text.trim(), q.trim()), true)).join("")
      || (q.trim().length > 1 ? `<p class="empty" style="padding:8px 10px">${pal.searchT ? "Searching…" : "No matches."}</p>` : "");
    if (pal.list.length >= 500) html += '<p class="empty" style="padding:6px 10px">Showing the first 500 matches.</p>';
  } else if (pal.mode === "files" && palModes.some((m) => v.startsWith(m.prefix))) {
    const m = palModes.find((x) => v.startsWith(x.prefix));
    const r = m.draw(v.slice(m.prefix.length), () => { if (pal.mode === "files" && $("palIn").value === v) drawPalette(); }, row);
    pal.list = r.list.map((it) => ({ ...it, mode: m }));
    html = r.html;
  } else if (v.startsWith(">")) {
    const q = v.slice(1).trim().toLowerCase();
    pal.list = keymap.list().filter((c) => !c.hidden && (!q || q.split(/\s+/).every((w) => c.title.toLowerCase().includes(w)))).map((c) => ({ cmd: c }));
    html = pal.list.map((c, i) => row(i, "cfg", hlText(c.cmd.title, q), keymap.label(c.cmd.id) ? `<kbd>${esc(keymap.label(c.cmd.id))}</kbd>` : "", "")).join("") || '<p class="empty" style="padding:8px 10px">No matching command.</p>';
  } else if (v.startsWith(":")) {
    const [l, c] = v.slice(1).split(/[:,]/).map((x) => parseInt(x, 10));
    const has = S.bufs.has(S.active);
    const total = has ? view.state.doc.lines : 0;
    pal.list = has && l > 0 ? [{ goto: { line: Math.min(l, total) - 1, character: (c || 1) - 1 } }] : [];
    html = has ? (pal.list.length ? row(0, dotOf(S.active), `Go to line ${Math.min(l, total)}${c ? `, column ${c}` : ""}`, "", "") : `<p class="empty" style="padding:8px 10px">Type a line number, 1 to ${total}.</p>`) : '<p class="empty" style="padding:8px 10px">Open a file first.</p>';
  } else {
    const q = v.trim().toLowerCase().replace(/\\/g, "/");
    const files = S.files || [];
    let list;
    if (!q) {
      const recent = [...S.tabs].reverse().filter((p) => p !== S.active && !isPage(p) && !isVirtual(p));
      list = [...recent, ...files.filter((p) => !recent.includes(p) && p !== S.active)].slice(0, 80);
    } else {
      const last = q.split(/\s+/).pop();
      list = files.map((p) => [p, fuzzy(q, rel(p)) + (q.includes(" ") && base(p).toLowerCase().startsWith(last) ? 25 : 0)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([p]) => p);
    }
    pal.list = list.map((p) => ({ path: p }));
    html = pal.list.map((f, i) => { const r = rel(f.path), d = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : ""; return row(i, dotOf(f.path), hlText(base(f.path), q.split(/\s+/).pop()), esc(d), ""); }).join("")
      || `<p class="empty" style="padding:8px 10px">${S.root ? (S.files ? "No files match." : "Loading files…") : "Open a folder first."}</p>`;
  }
  pal.sel = Math.min(pal.sel, Math.max(0, pal.list.length - 1));
  res.innerHTML = html;
}
function pick(i) {
  if (pal.mode === "prompt") { finishPalette($("palIn").value); return; }
  const it = pal.list[i];
  if (!it) return;
  if (pal.mode === "choose") { finishPalette(pal.wantIndex ? it.i : it.choice); return; }
  finishPalette(null);
  if (it.mode) it.mode.pick(it);
  else if (it.cmd) it.cmd.run();
  else if (it.goto) activate(S.active, it.goto);
  else if (it.path) openFile(it.path, it.line != null ? { line: it.line, character: it.col } : null);
}
$("palIn").oninput = () => { pal.sel = 0; drawPalette(); };
$("palOv").addEventListener("keydown", (ev) => {
  const k = keyString(ev);
  if (k === "Esc") { ev.preventDefault(); finishPalette(null); return; }
  if (pal.mode === "choose" && /^[1-9]$/.test(k) && +k <= pal.list.length) { ev.preventDefault(); pick(+k - 1); return; }
  if (k === "Down" || k === "Up" || (pal.mode === "choose" && (k === "Tab" || k === "Shift+Tab"))) {
    ev.preventDefault();
    const d = k === "Up" || k === "Shift+Tab" ? -1 : 1;
    pal.sel = Math.max(0, Math.min(pal.list.length - 1, pal.sel + d));
    $("palRes").querySelectorAll(".li").forEach((el, i) => el.setAttribute("aria-selected", i === pal.sel));
    const cur = $("palRes").querySelector('[aria-selected="true"]');
    cur?.scrollIntoView({ block: "nearest" });
    if (pal.mode === "choose") cur?.focus();
  }
  if (k === "Enter") { ev.preventDefault(); pick(pal.sel); }
});
$("palRes").addEventListener("click", (ev) => { const r = ev.target.closest("[data-pi]"); if (r) pick(+r.dataset.pi); });
$("palOv").addEventListener("mousedown", (ev) => { if (ev.target === $("palOv")) finishPalette(null); });

// ---------- context menu ----------
let menuPrevFocus = null;
function showMenu(x, y, items) {
  const m = $("menu");
  menuPrevFocus = document.activeElement;
  m.innerHTML = items.map((it, i) => (it === "-" ? "<hr>" : `<button role="menuitem" data-mi="${i}" class="${it.danger ? "danger" : ""}"><span>${esc(it.label)}</span><kbd>${esc(it.hint || (it.key ? keymap.label(it.key) : ""))}</kbd></button>`)).join("");
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + "px";
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + "px";
  m.onclick = (ev) => { const b = ev.target.closest("[data-mi]"); if (!b) return; hideMenu(); items[+b.dataset.mi].run(); };
  m.querySelector("button")?.focus();
}
function hideMenu(restore) { $("menu").hidden = true; if (restore && menuPrevFocus && document.contains(menuPrevFocus)) menuPrevFocus.focus(); }
document.addEventListener("mousedown", (ev) => { if (!$("menu").hidden && !ev.target.closest("#menu")) hideMenu(); });
$("menu").addEventListener("keydown", (ev) => {
  const bs = [...$("menu").querySelectorAll("button")], i = bs.indexOf(document.activeElement), k = keyString(ev);
  if (k === "Down" || k === "Up") { ev.preventDefault(); bs[(i + (k === "Down" ? 1 : -1) + bs.length) % bs.length].focus(); }
  if (k === "Home" || k === "End") { ev.preventDefault(); bs[k === "Home" ? 0 : bs.length - 1].focus(); }
  if (k === "Esc" || k === "Tab" || k === "Shift+Tab") { ev.preventDefault(); hideMenu(true); }
});

// ---------- commands & keys ----------
const keymap = new Keymap();
const C = (id, title, keys, run, opts) => keymap.add(id, title, keys, run, opts);
const inTree = () => $("tree").contains(document.activeElement) && S.sel;
C("settings.open", "Open settings", "Ctrl+P", openSettings);
C("file.goto", "Go to file", "Ctrl+E", () => openPalette("files"));
C("palette", "Show all commands", ["Ctrl+Shift+P", "F1"], () => openPalette("files", ">"));
C("search.files", "Search in files", "Ctrl+Shift+F", () => {
  const sel = S.bufs.has(S.active) ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to).split("\n")[0] : "";
  openPalette("text", sel);
});
C("editor.gotoLine", "Go to line", "Ctrl+G", () => openPalette("files", ":"));
C("task.run", "Run / Play (Continue while debugging)", "F5", () => (debug?.paused ? debug.cont() : runAction("run")));
C("task.stop", "Stop (the debugger, or the running task)", "Shift+F5", () => (debug?.active ? debug.stop() : stopTask()));
C("task.build", "Build", "Ctrl+Shift+B", () => runAction("build"));
C("task.test", "Run tests", "Ctrl+Alt+T", () => runAction("test"));
C("task.check", "Check (Rust)", "Ctrl+Alt+C", () => runAction("check"));
C("task.lint", "Clippy (Rust)", [], () => runAction("lint"));
C("task.scene", "Play current scene (Godot)", "Ctrl+F5", () => runAction("scene"));
C("task.custom", "Run a command…", [], async () => {
  const s = (await promptText("Command to run in the project folder", taskKind() === "rust" ? "cargo run -- " : "dotnet ", "for example: cargo run -- input.txt"))?.trim();
  if (!s) return;
  const [program, ...args] = splitArgs(s);
  startSteps([{ label: s, program, args }]);
});
C("editor.definition", "Go to definition", "F12", () => goToDefinition());
C("editor.rename", "Rename (symbol, or file in the explorer)", "F2", () => (inTree() ? renamePath(S.sel) : renameSymbol()));
C("editor.format", "Format document", "Shift+Alt+F", formatActive);
C("editor.info", "Show info at cursor", "Ctrl+K", showInfo);
C("editor.actions", "Quick fixes and refactors", "Ctrl+.", codeActions);
C("problems.next", "Next problem", "F8", () => nextProblem(1));
C("problems.prev", "Previous problem", "Shift+F8", () => nextProblem(-1));
C("nav.back", "Go back", "Alt+Left", () => goNav(-1));
C("nav.forward", "Go forward", "Alt+Right", () => goNav(1));
C("tab.next", "Next tab", ["Ctrl+Tab", "Ctrl+PageDown"], () => cycleTab(1));
C("tab.prev", "Previous tab", ["Ctrl+Shift+Tab", "Ctrl+PageUp"], () => cycleTab(-1));
for (let n = 1; n <= 9; n++) C(`tab.${n}`, n === 9 ? "Go to last tab" : `Go to tab ${n}`, `Ctrl+${n}`, () => tabAt(n));
C("tab.close", "Close tab", "Ctrl+W", () => closeTab(S.active));
C("tab.reopen", "Reopen closed tab", "Ctrl+Shift+T", reopenClosed);
C("file.save", "Save", "Ctrl+S", () => save());
C("file.saveAll", "Save all", "Ctrl+Alt+S", saveAll);
C("file.new", "New file", "Ctrl+N", () => newFile());
C("file.newFolder", "New folder", "Ctrl+Alt+N", () => newFolder());
C("folder.open", "Open folder", "Ctrl+O", () => openFolder());
C("folder.close", "Close folder", [], () => closeFolder());
C("window.new", "New window", "Ctrl+Shift+N", () => invoke("new_window", { folder: null }).catch((e) => toast(String(e))));
C("folder.openNewWindow", "Open folder in new window", [], () => openFolderInNewWindow());
C("window.close", "Close window", "Ctrl+Shift+W", () => getCurrentWindow().close());
C("project.new", "New project", [], () => newProject());
C("focus.explorer", "Show files", "Ctrl+Shift+E", () => showSideView("files", true));
C("focus.side", "Focus side bar", [], () => focusZone("explorer"));
C("focus.reveal", "Show current file in explorer", "Ctrl+Shift+R", revealActiveInExplorer);
C("focus.next", "Next area (explorer, editor, panel, status bar)", "F6", () => cycleZone(1));
C("focus.prev", "Previous area", "Shift+F6", () => cycleZone(-1));
C("panel.toggle", "Toggle panel", "Ctrl+J", togglePanel);
C("panel.focus", "Focus panel", [], () => (currentZone() === "panel" ? focusZone("editor") : focusPanel()));
C("editor.split", "Split editor (or switch side)", "Ctrl+\\", openSplit);
C("editor.unsplit", "Close split", "Ctrl+Shift+\\", closeSplit);
C("panel.problems", "Show problems", "Ctrl+Shift+M", () => focusPanel("problems"));
C("panel.output", "Show output", "Ctrl+Shift+U", () => focusPanel("output"));
C("view.explorer", "Toggle explorer", "Ctrl+B", () => toggleExplorer());
C("view.zoomIn", "Bigger editor text", ["Ctrl+Plus", "Ctrl+=", "Ctrl+Shift+Plus"], () => zoom(1));
C("view.zoomOut", "Smaller editor text", "Ctrl+-", () => zoom(-1));
C("view.zoomReset", "Reset editor text size", "Ctrl+0", () => zoom(0));
C("view.theme", "Toggle light / dark", [], toggleTheme);
C("lsp.restart", "Restart language servers", [], () => { if (hasAny(/^Cargo\.toml$/) || started(servers.rust)) startServer("rust"); if (hasAny(/\.(csproj|slnx?)$/i) || started(servers.csharp)) startServer("csharp"); });
C("hints.toggle", "Toggle type hints", [], toggleHints);
C("program.input", "Type input for the running program", "Ctrl+I", focusInput);
C("program.endInput", "End the running program's input", [], endInput);
C("file.reload", "Reload files from disk", [], () => { reloadClean(); refreshTree(); });

// Keys that would otherwise reload the window or do browser things inside the app.
const BLOCKED = new Set(["Ctrl+R", "Ctrl+Shift+R", "F5", "Ctrl+F5", "Ctrl+Shift+I", "Ctrl+U", "Ctrl+Shift+J", "Alt+Left", "Alt+Right", "F10", "F11", "Shift+F10", "Ctrl+Shift+F5", "Shift+F11", "Ctrl+H"]);
const TERM_PASS = new Set(["Ctrl+P", "Ctrl+T", "Ctrl+J", "Ctrl+B"]);

document.addEventListener("keydown", (e) => {
  if (isRecording()) return;
  if (!$("palOv").hidden || !$("menu").hidden) return;
  const k = keyString(e);
  if (!k) return;
  const id = keymap.lookup(k);
  // In a terminal, plain Ctrl+letter and Alt keys belong to the shell (Ctrl+C,
  // Ctrl+R, Ctrl+W…), except a few app keys you'd expect to always work.
  if (e.target.closest?.(".terms") && !/F\d|^Ctrl\+Shift\+|^Ctrl\+Alt\+|^Ctrl\+(Tab|PageUp|PageDown|`|\d|Plus|-|=)$/.test(k) && !TERM_PASS.has(k)) return;
  if (id) {
    const inField = e.target.closest?.("input, textarea, select") && !e.target.closest(".cm-editor");
    // While typing in a text field, only Ctrl/Alt and function-key shortcuts fire.
    if (inField && !/^(Ctrl|Alt)\+|^(Shift\+)?F\d/.test(k)) return;
    e.preventDefault();
    e.stopPropagation();
    keymap.cmds.get(id).run();
    return;
  }
  if (BLOCKED.has(k)) e.preventDefault();
}, true);
// Links to websites open in the normal browser.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href^='http']");
  if (!a) return;
  e.preventDefault();
  openUrl(a.href).catch(() => toast("Couldn't open the browser."));
});
document.addEventListener("contextmenu", (e) => { if (!e.target.closest(".cm-editor, input, textarea, .out")) e.preventDefault(); });

// ---------- resizing ----------
function drag(handle, onMove) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    const move = (ev) => onMove(ev);
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); document.body.style.userSelect = ""; savePrefs(); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}
const applySizes = () => {
  document.documentElement.style.setProperty("--side-w", prefs.sideW + "px");
  document.documentElement.style.setProperty("--panel-h", prefs.panelH + "px");
  document.documentElement.style.setProperty("--split-w", (prefs.splitPct || 50) + "%");
};
drag($("sideSplit"), (e) => { prefs.sideW = Math.max(170, Math.min(600, e.clientX)); applySizes(); });
drag($("panelSplit"), (e) => { prefs.panelH = Math.max(80, Math.min(innerHeight - 160, innerHeight - (settings.statusBar === "top" ? 0 : 28) - e.clientY)); applySizes(); });
drag($("paneSplit"), (e) => {
  const r = $("panes").getBoundingClientRect();
  prefs.splitPct = Math.max(15, Math.min(85, ((e.clientX - r.left) / r.width) * 100));
  applySizes();
});

// ---------- folders ----------
// One folder change at a time (boot restore and a launch from Godot can overlap).
let folderQueue = Promise.resolve();
function openFolder(path) {
  const job = folderQueue.then(() => openFolderNow(path));
  folderQueue = job.catch(() => {});
  return job;
}
async function openFolderNow(path) {
  if (!path) {
    const p = await openDialog({ directory: true, multiple: false, title: "Open folder" });
    if (!p) return false;
    path = p;
  }
  path = norm(path).replace(/(.)\/$/, "$1");
  if (S.root === path) return true;
  if (S.root && !(await closeAll())) return false;
  try { await invoke("list_dir", { path }); }
  catch (e) {
    toast(`Can't open ${base(path)}: ${e}`, 5000);
    prefs.recent = prefs.recent.filter((r) => r !== path);
    forgotten.add(path);
    if (prefs.last === path) prefs.last = null;
    savePrefs(); renderMain();
    return false;
  }
  await Promise.all(Object.values(servers).map((s) => (s.gen ? s.stop() : null)));
  for (const s of Object.values(servers)) s.root = null;
  Object.assign(S, { root: path, sel: null, selDir: false, files: null, closed: [] });
  S.kids.clear(); S.open.clear(); S.diags.clear();
  prefs.recent = [path, ...prefs.recent.filter((r) => r !== path)].slice(0, 8);
  prefs.last = path;
  savePrefs();
  $("rootName").textContent = base(path).toUpperCase();
  getCurrentWindow().setTitle(`${base(path)} · ${APP_NAME}`).catch(() => {});
  invoke("set_window_root", { root: path }).catch(() => {});
  for (const f of folderHooks) f(path);
  const sess = prefs.sessions[path];
  await loadDir(path);
  detectProject();
  if (sess) for (const d of sess.open || []) S.open.add(d);
  else if (S.kids.get(path)?.some((k) => k.dir && k.name === "src")) S.open.add(join(path, "src"));
  await Promise.all([...S.open].map(loadDir));
  renderMain();
  renderProblems();
  S.ctx = null;
  loadFiles().then(() => {
    if (S.root !== path) return;
    if (S.proj.rust || hasAny(/^Cargo\.toml$/)) startServer("rust");
    if (S.proj.dotnet || hasAny(/\.(csproj|slnx?)$/i)) startServer("csharp");
    updateCtx();
  });
  // Restoring tabs is async; if something else opened a file meanwhile (say,
  // Godot sending one), leave that file in front.
  if (sess?.tabs?.length) {
    for (const t2 of sess.tabs) {
      if (S.root !== path) break;
      if (t2 === SETTINGS_TAB) addTab(t2);
      else await openFile(t2, null, { quiet: true, background: true });
    }
    const act = sess.active && S.tabs.includes(sess.active) ? sess.active : S.tabs[0];
    if (act && !S.active && S.root === path) activate(act, null, { noNav: true });
  } else {
    for (const c of ["src/main.rs", "src/lib.rs", "Program.cs", "Cargo.toml", "project.godot"]) {
      if (S.active || S.root !== path) break;
      if (await openFile(join(path, c), null, { quiet: true, noNav: true })) break;
    }
  }
  return true;
}
const folderHooks = [];
async function openFolderInNewWindow(path) {
  if (!path) {
    path = await openDialog({ directory: true, multiple: false, title: "Open folder in a new window" });
    if (!path) return;
  }
  try { await invoke("new_window", { folder: norm(path) }); } catch (e) { toast("Couldn't open a window: " + e); }
}
async function closeFolder() {
  if (!S.root || !(await closeAll())) return;
  await Promise.all(Object.values(servers).map((s) => s.stop()));
  invoke("task_stop").catch(() => {});
  S.root = null; S.kids.clear(); S.open.clear(); S.diags.clear(); S.files = null;
  S.proj = { rust: false, dotnet: false, godot: false, sln: null, csproj: null };
  S.ctx = null;
  prefs.last = null; savePrefs();
  $("rootName").textContent = "EXPLORER";
  getCurrentWindow().setTitle(APP_NAME).catch(() => {});
  invoke("set_window_root", { root: null }).catch(() => {});
  for (const f of folderHooks) f(null);
  renderMain(); renderProblems();
}
async function newProject() {
  const kinds = ["Rust program", "Rust library", "C# console app", "C# class library"];
  const i = await choose("What kind of project?", kinds, true);
  if (i == null) return;
  const kind = ["rust", "rust-lib", "console", "classlib"][i];
  // With a folder open (a course folder, say), new projects go inside it by default.
  let dir = null;
  if (S.root) {
    const where = await choose("Where should it go?", [`Inside ${base(S.root)}`, "Somewhere else…"], true);
    if (where == null) return;
    if (where === 0) dir = S.root;
  }
  dir ??= await openDialog({ directory: true, multiple: false, title: "Where should the project go?" });
  if (!dir) return;
  const name = (await promptText(`New ${kinds[i]} in ${base(norm(dir))}`, "", "project name, like hello_world"))?.trim();
  if (!name) return;
  if (!/^[A-Za-z][\w-]*$/.test(name)) { toast("Use letters, numbers, - and _ only, starting with a letter."); return; }
  try {
    const p = norm(await invoke("new_project", { parent: dir, name, kind }));
    if (S.root && isUnder(p, S.root)) {
      // Keep the folder open and add the project to it.
      const main = kind === "rust" ? "src/main.rs" : kind === "rust-lib" ? "src/lib.rs" : kind === "console" ? "Program.cs" : "Class1.cs";
      await revealInTree(join(p, main));
      S.open.add(p);
      await refreshTree();
      startServer(kind.startsWith("rust") ? "rust" : "csharp");
      await openFile(join(p, main), null, { quiet: true });
      revealInTree(join(p, main));
      toast(`Created ${name}. Run, Build and Test use the project of the file you have open.`, 4000);
    } else await openFolder(p);
  } catch (e) { toast(String(e), 6000); }
}

// ---------- launch arguments (and Godot) ----------
// Ledger.exe [folder] [--goto|-g file[:line[:col]]]   ·   Ledger.exe file[:line[:col]]
// --goto counts lines from 1 (Godot's GDScript setting); --goto0 from 0 (Godot's C# setting, which sends -1 for "no line").
async function handleArgs({ argv, cwd }) {
  let project = null, gotoArg = null, zero = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--goto" || a === "-g" || a === "--goto0") { zero = a === "--goto0"; gotoArg = argv[++i] || null; continue; }
    if (a.startsWith("-")) continue;
    if (!project) project = a; else if (!gotoArg) gotoArg = a;
  }
  let file = null, line = 0, col = 0;
  // Returns 1-based line/col, 0 meaning "not given".
  const splitLoc = (s) => {
    const m = /^(.*?)(?::(-?\d+))?(?::(-?\d+))?$/.exec(s);
    const n = (x) => (x == null ? 0 : Math.max(0, +x + (zero ? 1 : 0)));
    return [m[1], n(m[2]), n(m[3])];
  };
  if (gotoArg) [file, line, col] = splitLoc(gotoArg);
  if (project) {
    let r = await invoke("resolve_path", { path: project, cwd }).catch(() => null);
    if (!r && !gotoArg) { const [f, l, c] = splitLoc(project); r = await invoke("resolve_path", { path: f, cwd }).catch(() => null); if (r) { line = l; col = c; } }
    if (r && r[1] === "file" && !file) { file = r[0]; project = null; }
    else project = r ? r[0] : null;
  }
  if (file) {
    const r = await invoke("resolve_path", { path: file, cwd }).catch(() => null);
    file = r ? norm(r[0]) : null;
  }
  if (file && !project && !isUnder(file, S.root)) project = await invoke("find_project_root", { file }).catch(() => null);
  if (project && !isUnder(norm(project), S.root)) { if (!(await openFolder(project))) return false; }
  if (file) {
    await openFile(file, line > 0 ? { line: line - 1, character: Math.max(0, col - 1) } : null);
    revealInTree(file);
  }
  return !!(project || file);
}
// Launches that arrive while the app is still starting wait for it.
let booted = false;
const pendingArgs = [];
listen("open-args", (e) => (booted ? handleArgs(e.payload) : pendingArgs.push(e.payload)));

// ---------- the context other modules work through ----------
const app = {
  $, S, settings, prefs, savePrefs, panelTabs, keymap, servers, LANGS,
  get view() { return view; }, get split() { return split; }, panes,
  command: (...a) => C(...a), toast, choose, promptText, copy,
  showPanel, focusPanel, focusZone, currentZone, showSideView, sideViews, get sideView() { return sideView; },
  openFile, activate, addTab, save, saveAll, startSteps, appendOut, renderTabs, renderMain, renderStatus, scheduleUi,
  dispatchBuf, serverOf, needServer, syncDoc, renderMd, hl, norm, rel, base, parent, join, isUnder, isAbs, esc, splitArgs,
  pages, palModes, extraExt, folderHooks, editorTheme: theme, renderTreeSoon: scheduleUi, showMenu, reloadClean, refreshTree, activeHooks, saveHooks, readyHooks, applyWorkspaceEdit, closeInfo, setInfo: showInfoAt, bufListeners, decorationCopiers, focusListeners, settingHooks, statusItems: [],
  cwd: () => S.ctx?.dir || S.root || "",
  updateCtx, taskKind, projectFor, projectDirs, invoke, keyString, openFolder, closeFolder,
  run: (id) => keymap.cmds.get(id)?.run(),
  openPaletteWith: (prefix) => openPalette("files", prefix),
  get fp() { return fp; },
};
let term = null, snippets = null, debug = null, navx = null;
if (import.meta.env.VITE_DEBUG) window.__app = app;

// ---------- boot ----------
let settingsFile = null;
async function reloadSettingsFromFile(quiet) {
  try {
    const before = JSON.stringify(settings);
    const prev = JSON.parse(before);
    await loadSettings(true);
    if (quiet && JSON.stringify(settings) === before) return;
    for (const k of Object.keys(DEFAULTS)) if (JSON.stringify(prev[k]) !== JSON.stringify(settings[k])) applySetting(k);
    if (S.active === SETTINGS_TAB) renderSettingsPage(true);
    if (!quiet) { toast("Settings reloaded from settings.json"); emit("settings-changed", { from: winLabel }).catch(() => {}); }
  } catch (e) { if (!quiet) toast("settings.json has a mistake in it: " + e, 6000); }
}
// Another window changed a setting.
listen("settings-changed", (e) => { if (e.payload?.from !== winLabel) reloadSettingsFromFile(true); });
async function boot() {
  await loadSettings();
  settingsFile = norm(await invoke("settings_path").catch(() => "")) || null;
  initSettings({
    keymap, apply: applySetting, toast, choose, appName: APP_NAME,
    runTask: (program, args, label, done) => startSteps([{ label, program, args }], done),
    restartServer: (id) => (S.root ? startServer(id) : toast("Open a folder first.")),
    stopServer: (id) => servers[id].stop(),
    openFile: (p) => openFile(norm(p)),
    saved: () => emit("settings-changed", { from: winLabel }).catch(() => {}),
    editSnippets: () => snippets?.edit(),
    installDebugger: (kind) => debug?.install(kind),
    debuggerFor: async (kind) => debug?.adapterPath(kind),
  });
  wireSettings($("settings"), (keep) => { if (S.active === SETTINGS_TAB) renderSettingsPage(keep); });
  keymap.setOverrides(settings.keys);
  applyTheme();
  applyFonts();
  applySizes();
  applyStatusBar();
  $("app").classList.toggle("collapsed", !!prefs.collapsed);
  showSideView(sideView);
  term = initTerminal(app);
  navx = initNav(app);
  initDeps(app);
  snippets = initSnippets(app, () => settingsFile);
  initGit(app);
  debug = app.debug = initDebugger(app);
  view = panes[0].view = new EditorView({ parent: $("editor") });
  panes[0].el.classList.add("focused");
  renderMain();
  renderPanel();
  renderProblems();

  let focusT = null;
  window.addEventListener("focus", () => { clearTimeout(focusT); focusT = setTimeout(() => { reloadClean(); if (S.root) refreshTree(); }, 150); });
  setInterval(() => { if (document.hasFocus()) reloadClean(); }, 3000);
  window.addEventListener("blur", () => { if (settings.autoSave === "focus") saveAll(); });

  try {
    getCurrentWindow().onCloseRequested(async (ev) => {
      if (!dirtyPaths().length) return;
      ev.preventDefault();
      const c = await choose("You have unsaved changes.", ["Save all and quit", "Quit without saving", "Cancel"]);
      if (c === "Cancel" || !c) return;
      if (c === "Save all and quit" && !(await saveAll())) return;
      for (const b of S.bufs.values()) b.dirty = false;
      getCurrentWindow().destroy();
    });
  } catch {}

  const args = await invoke("startup_args").catch(() => null);
  const used = args && args.argv.length ? await handleArgs(args) : false;
  if (!used && prefs.last && winLabel === "main") await openFolder(prefs.last);
  booted = true;
  for (const a of pendingArgs.splice(0)) await handleArgs(a);
  if (!S.active) focusZone("editor");
}
boot();
