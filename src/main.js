import "./style.css";
if (import.meta.env.VITE_DEBUG) import("./debug.js");
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { on as listen, winLabel } from "./win.js";
import { initUpdate } from "./update.js";
import { initDb, DB_EXT } from "./db.js";
import { initImages, IMG_EXT } from "./image.js";
import { initMarkdown } from "./md.js";
import { initTests } from "./tests.js";
import { initColours } from "./colour.js";
import { diff } from "@codemirror/merge";
import { initPrettier } from "./prettier.js";
import { initEmmet, emmetSource } from "./emmet.js";
import { initMarks } from "./marks.js";
import { initTodo } from "./todo.js";
import { initCsv } from "./csv.js";
import { initHex } from "./hex.js";
import { initHistory } from "./history.js";
import { iconHtml } from "./icons.js";
import { VITE, createSteps, withTailwindPlugin, CSS_FILES, FIRST_FILES } from "./scaffold.js";
import { initTailwind, tailwindSource, tailwindChanged, tailwindWarm, inClassList } from "./tailwind.js";
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
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, completeFromList } from "@codemirror/autocomplete";
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxHighlighting, HighlightStyle, indentUnit, StreamLanguage } from "@codemirror/language";
import { lintGutter, setDiagnostics, lintKeymap } from "@codemirror/lint";
import { rustLanguage } from "@codemirror/lang-rust";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { tags as t, highlightCode } from "@lezer/highlight";
import { Lsp, norm, uriToPath, pathToUri, toOffset, toPos, severity, unsnippet, completionType } from "./lsp.js";
import { ansiToHtml, esc } from "./ansi.js";
import { LANGS, langOf, dotOf } from "./langs.js";
import { Keymap, keyString } from "./keys.js";
import { settings, DEFAULTS, loadSettings, setSetting, initSettings, settingsHtml, wireSettings, isRecording, refreshSettingsTools, openInBrowser, INSTALLS, INSTALL_FOR, installTool } from "./settings.js";
import { APP_NAME } from "./app.js";
import { bracketColors, indentGuides, stickyScroll } from "./editorx.js";
import { followBottom } from "./follow.js";
import { smoothScrolling } from "./smooth.js";
import { initTerminal } from "./terminal.js";
import { initNav } from "./nav.js";
import { initDeps } from "./deps.js";
import { initSnippets } from "./snippets.js";
import { initGit } from "./git.js";
import { initGitMore } from "./gitmore.js";
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
    const trust = { ...(stored.trust || {}), ...(prefs.trust || {}) }; // every window's answers
    const bookmarks = { ...(stored.bookmarks || {}), ...(prefs.bookmarks || {}) };
    for (const k of Object.keys(bookmarks)) if (!recent.includes(k) && k !== mine) delete bookmarks[k];
    Object.assign(prefs, { sessions, recent, breakpoints, watches, trust, bookmarks });
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch (e) {
    // Full storage would quietly drop sessions and trust answers: say so once.
    if (!savePrefs.warned && /quota/i.test(String(e?.name || e))) { savePrefs.warned = true; setTimeout(() => toast("Ledger couldn't save its window state (sessions, folder trust): the browser storage is full.", 8000), 0); }
  }
};

const SETTINGS_TAB = "@settings";
const S = {
  root: null,
  preview: null, pinned: new Set(), // the explorer's preview tab, and pinned tabs
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
// File icons by type (Settings › Appearance › File icons), or the coloured dots.
const fileIcons = () => settings.fileIcons !== false;
const mark = (path) => (fileIcons() && path ? iconHtml(path) : '<span class="dot"></span>');
const isVirtual = (p) => /^[a-z]+:/i.test(p) && !/^[A-Za-z]:\//.test(p); // csharp:/metadata/…

// ---------- paths ----------
const base = (p) => norm(p).split("/").pop();
const parent = (p) => { const s = norm(p); const i = s.lastIndexOf("/"); return i <= 0 ? s.slice(0, i + 1) || "/" : s.slice(0, i); };
const join = (a, b) => norm(a).replace(/\/$/, "") + "/" + norm(b).replace(/^\//, "");
// A drive root keeps its slash ("C:/"), so it's trimmed before adding one.
const isUnder = (p, root) => !!root && !!p && (p === root || p.toLowerCase().startsWith(root.toLowerCase().replace(/\/$/, "") + "/"));
const rel = (p) => (S.root && isUnder(p, S.root) ? p.slice(S.root.replace(/\/$/, "").length + 1) : p);
const isAbs = (p) => /^(\/|[A-Za-z]:\/)/.test(norm(p));
const TOOLCHAIN = /\/(\.rustup|\.cargo\/registry|\.cargo\/git|\.nuget|rustlib|dotnet\/packs|dotnet\/shared)\//i;

// ---------- small ui helpers ----------
/** Calls every hook in a list; one that throws is logged and the rest still run (a broken
 *  module mustn't stop a save, a tab switch or a folder opening). Async hooks are awaited by no one. */
function each(list, ...args) {
  for (const f of list) {
    try { const r = f(...args); if (r && typeof r.catch === "function") r.catch((e) => console.error("hook", e)); }
    catch (e) { console.error("hook", e); }
  }
}
function toast(m, ms = 2600) { const el = $("toast"); el.textContent = m; el.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => { el.classList.remove("on"); el.textContent = ""; }, ms); }
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
    prefs.sessions[S.root] = { tabs: S.tabs.filter((k) => !isVirtual(k)), active: S.active, open: [...S.open], pinned: [...S.pinned].filter((k) => S.tabs.includes(k)) };
    for (const k of Object.keys(prefs.sessions)) if (!prefs.recent.includes(k)) delete prefs.sessions[k];
    savePrefs();
  }, 300);
}

// ---------- editor look ----------
// "cm-selecting" on the editor while any text is selected (see .cm-activeLine in the theme).
const selectingClass = EditorView.editorAttributes.compute(["selection"], (st) => (st.selection.ranges.some((r) => !r.empty) ? { class: "cm-selecting" } : {}));

const hl = HighlightStyle.define([
  { tag: [t.keyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--syn-kw)", fontWeight: "var(--syn-kw-weight)" },
  { tag: t.modifier, color: "var(--syn-mod)" },
  { tag: t.controlKeyword, color: "var(--syn-ctl)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-class)" },
  { tag: t.standard(t.typeName), color: "var(--syn-type)" },
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
  // The current line's background sits above the selection, so it steps aside while text is selected.
  "&.cm-selecting .cm-activeLine": { backgroundColor: "transparent" },
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
/** Colours a code block (Markdown preview) like the editor. False if the language isn't known. */
function highlightInto(el, code, lang) {
  const parser = FENCE[lang];
  if (!parser) return false;
  el.textContent = "";
  highlightCode(code, parser.parse(code), hl,
    (txt, cls) => { const sp = document.createElement("span"); if (cls) sp.className = cls; sp.textContent = txt; el.append(sp); },
    () => el.append("\n"));
  return true;
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
    if (srv.state.text?.startsWith("ready")) { for (const [p, b] of S.bufs) if (serverOf(b) === srv) scheduleHints(p, 50); each(readyHooks, srv); }
  },
  refreshHints: (srv) => { for (const [p, b] of S.bufs) if (serverOf(b) === srv) scheduleHints(p, 50); },
  message: (m) => toast(m, 5000),
  applyEdit: (we) => applyWorkspaceEdit(we).then(() => true),
};
servers.rust = new Lsp("rust", "rust-analyzer", lspHandlers);
servers.csharp = new Lsp("csharp", "C#", lspHandlers);
servers.web = new Lsp("web", "TypeScript", lspHandlers);
servers.css = new Lsp("css", "CSS", lspHandlers);
servers.html = new Lsp("html", "HTML", lspHandlers);
servers.json = new Lsp("json", "JSON", lspHandlers);
servers.lua = new Lsp("lua", "Lua", lspHandlers);

// The completions a language brings itself (HTML tags and attributes, CSS
// properties, JS keywords and local names), used when no server is running.
async function langDataSource(ctx) {
  for (const s of ctx.state.languageDataAt("autocomplete", ctx.pos)) {
    const r = await (typeof s === "function" ? s(ctx) : completeFromList(s)(ctx));
    if (r) return r;
  }
  return null;
}
initTailwind({
  run: (dir, args) => invoke("run_capture", { cwd: dir, program: "node", args }).then((r) => (r.code === 0 ? r.out : "")),
  dir: () => (trusted() && S.ctx?.node ? S.ctx.dir : null), // reading Tailwind's config runs the project's code
  cacheGet: (key) => invoke("cache_get", { key }),
  cacheSet: (key, value) => invoke("cache_set", { key, value }).catch(() => {}),
});

const splitArgs = (s) => (String(s || "").match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ""));
function serverSpec(id) {
  if (id === "rust") {
    // A folder with no Cargo.toml of its own (a course folder holding one
    // project per lesson, say) gets each project in it handed over by name.
    const linked = S.proj.rust ? [] : projectDirs().filter((d) => S.files.includes(join(d, "Cargo.toml"))).map((d) => join(d, "Cargo.toml"));
    return {
    exe: settings.rustAnalyzer || "rust-analyzer", args: [],
    initOptions: {
      // Build scripts and proc macros are the project's own code: only in folders you trust.
      checkOnSave: true, check: { command: settings.rustCheck || "check" }, cargo: { buildScripts: { enable: trusted() } }, procMacro: { enable: trusted() },
      inlayHints: { typeHints: { enable: true }, parameterHints: { enable: true }, chainingHints: { enable: true }, closingBraceHints: { enable: false } },
      ...(linked.length ? { linkedProjects: linked } : {}),
    },
    missing: "rust-analyzer isn't installed. Open Settings (Ctrl+P) and use the install button, or run: rustup component add rust-analyzer rust-src",
  };
  }
  const SCHEMA = (f, name) => ({ fileMatch: [].concat(f), url: "https://json.schemastore.org/" + name + ".json" });
// Schemas for common config files (SchemaStore), so they complete and get checked.
  const JSON_SCHEMAS = [
  SCHEMA("package.json", "package"), SCHEMA(["tsconfig.json", "tsconfig.*.json"], "tsconfig"), SCHEMA(["jsconfig.json", "jsconfig.*.json"], "jsconfig"),
  SCHEMA([".eslintrc", ".eslintrc.json"], "eslintrc"), SCHEMA([".prettierrc", ".prettierrc.json"], "prettierrc"), SCHEMA([".babelrc", "babel.config.json"], "babelrc"),
  SCHEMA("vercel.json", "vercel"), SCHEMA("turbo.json", "turbo"), SCHEMA(["deno.json", "deno.jsonc"], "deno"), SCHEMA("lerna.json", "lerna"),
  SCHEMA("composer.json", "composer"), SCHEMA("appsettings*.json", "appsettings"), SCHEMA("global.json", "global"), SCHEMA("launchSettings.json", "launchsettings"),
  SCHEMA(".luarc.json", "luarc"), SCHEMA(["manifest.json", "*.webmanifest"], "web-manifest-combined"), SCHEMA("components.json", "shadcn-ui"),
];
  if (id === "json") return {
    exe: "vscode-json-language-server", args: ["--stdio"], initOptions: { provideFormatter: true },
    settings: { json: { validate: { enable: true }, format: { enable: true }, schemas: JSON_SCHEMAS } },
    missing: "The JSON language server isn't installed. Open Settings (Ctrl+P) › Languages and install the web language servers.",
  };
  if (id === "lua") return {
    exe: settings.luaServer || "lua-language-server", args: [],
    settings: { Lua: { runtime: { version: settings.luaVersion || "Lua 5.4" }, telemetry: { enable: false }, workspace: { checkThirdParty: false }, hint: { enable: true } } },
    missing: "The Lua language server isn't installed. Open Settings (Ctrl+P) › Languages and install it.",
  };
  if (id === "css" || id === "html") {
    // Tailwind's @theme, @apply, @tailwind… aren't plain CSS; the server shouldn't call them mistakes.
    const lint = { unknownAtRules: "ignore" };
    return {
      exe: `vscode-${id}-language-server`, args: ["--stdio"],
      initOptions: { provideFormatter: true, embeddedLanguages: { css: true, javascript: true } },
      settings: { css: { lint }, scss: { lint }, less: { lint }, html: { suggest: { html5: true }, validate: { scripts: true, styles: true } } },
      missing: "The HTML and CSS language servers aren't installed. Open Settings (Ctrl+P) › Languages and install them.",
    };
  }
  if (id === "web") return {
    exe: "typescript-language-server", args: ["--stdio"],
    // In a restricted folder the server uses the computer's own TypeScript, not the project's
    // node_modules/typescript (which is the project's code).
    initOptions: { ...(!trusted() && globalTs ? { tsserver: { path: globalTs } } : {}), preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true, includeCompletionsForImportStatements: true, includeInlayParameterNameHints: "literals", includeInlayFunctionLikeReturnTypeHints: false } },
    missing: "The JavaScript and TypeScript language server isn't installed. Open Settings (Ctrl+P) › Languages and install it.",
  };
  return {
    exe: settings.csharpServer || "csharp-ls", args: splitArgs(settings.csharpArgs), initOptions: {},
    missing: "The C# language server isn't installed. Open Settings (Ctrl+P) and use the install button, or run: dotnet tool install --global csharp-ls",
  };
}
const serverOf = (b) => (b && LANGS[b.lang].server && !b.virtual ? servers[LANGS[b.lang].server] : null);
// Running for this folder: alive, not just asked to start (a missing server stays not-started, so
// the editor's own completions take over and the next file open tries again).
const started = (srv) => !!S.root && srv.root === S.root && srv.gen > 0 && !!srv.alive;
// Servers that load the project itself; in a restricted folder they wait for trust.
const NEEDS_TRUST = new Set(["rust", "csharp", "lua"]);
let globalTs = null;
invoke("global_tsserver").then((p) => { globalTs = p ? norm(p) : null; }, () => {});
function startServer(id) {
  if (!S.root) return null;
  const srv = servers[id], root = S.root;
  if ((NEEDS_TRUST.has(id) || (id === "web" && !globalTs)) && !trusted()) {
    srv.setStatus("restricted", false, false, `${srv.label} ${id === "web" ? "would load the project's own TypeScript" : "loads the project's own code"}, so it only runs in folders you trust. Click Restricted in the status bar to trust this folder.`);
    return null;
  }
  // Several callers ask at once while a folder opens; they all share one start.
  if (srv.starting && srv.startingRoot === root) return srv.starting;
  srv.startingRoot = root;
  srv.starting = (async () => {
    await loadFiles();
    if (S.root !== root) return;
    if (await srv.start(root, serverSpec(id))) {
      for (const [p, b] of S.bufs) if (LANGS[b.lang].server === id && !b.virtual && !b.ro) { b.sent = b.state.doc; b.pend = null; srv.open(p, b.state.doc.toString(), LANGS[b.lang].languageId); }
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
  if (b.sent === doc) return;
  // The edits since the last sync, when they lead from what the server has to this text.
  let edits = null;
  if (b.pend && b.sent && doc === b.state.doc && b.pend.length === b.sent.length && b.pend.newLength === doc.length) {
    edits = [];
    const old = b.sent;
    b.pend.iterChanges((fa, ta, fb, tb, ins) => edits.push({ range: { start: toPos(old, fa), end: toPos(old, ta) }, text: ins.toString() }));
    edits.reverse(); // last first, so each range is still where it was in the old text
  }
  b.sent = doc; b.pend = null;
  srv.change(path, () => doc.toString(), LANGS[b.lang].languageId, edits);
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
    if (!ctx.explicit && inClassList(ctx)) return null; // Tailwind answers inside class lists
    syncDoc(path, ctx.state.doc);
    const res = await srv.request("textDocument/completion", {
      ...srv.at(path, ctx.state.doc, ctx.pos),
      context: trig ? { triggerKind: 2, triggerCharacter: trig } : { triggerKind: 1 },
    });
    if (!res || ctx.aborted) return null;
    // Big lists (TypeScript sends thousands): keep what can match the typed word, sort cheaply, and let
    // the editor narrow this list as you type instead of asking the server on every key.
    const typed = ctx.state.sliceDoc(word.from, ctx.pos).toLowerCase();
    const key = (it) => (it.filterText || it.label).toLowerCase();
    let items = Array.isArray(res) ? res : res.items || [];
    if (typed) items = items.filter((it) => key(it).startsWith(typed[0]));
    let reuse = !res.isIncomplete;
    if (items.length > 1500) { items = items.filter((it) => key(it).startsWith(typed)); reuse = false; }
    items = items.map((it) => [it.sortText || it.label, it]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).slice(0, 1500).map((p) => p[1]);
    return {
      from: word.from,
      validFor: reuse ? (text) => /^\w*$/.test(text) && text.toLowerCase().startsWith(typed) : undefined,
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

// Formatters that aren't a language server (Prettier for web files): (path, buffer) -> an async
// function from the text to the formatted text (null when it couldn't), or null for files it skips.
const formatters = [];
const formatterFor = (path, b) => (b && !b.ro ? formatters.map((f) => f(path, b)).find(Boolean) : null);
/** The changes from `a` to `b` as small edits, so the cursor, bookmarks and folds stay where they were. */
function smallChanges(a, b) {
  return diff(a, b, { scanLimit: 5000, timeout: 300 }).map((c) => ({ from: c.fromA, to: c.toA, insert: b.slice(c.fromB, c.toB) }));
}
async function formatBuffer(path) {
  const b = S.bufs.get(path), srv = serverOf(b);
  const fmt = formatterFor(path, b);
  if (fmt) {
    const before = b.state.doc.toString();
    const out = await fmt(before);
    if (out == null) return false;
    const now = S.bufs.get(path);
    if (!now || now.state.doc.toString() !== before) return true; // edited meanwhile: leave it
    if (out !== before) dispatchBuf(path, { changes: smallChanges(before, out.replace(/\r\n/g, "\n")), userEvent: "format" });
    return true;
  }
  if (!b || b.ro || !srv?.alive) return false;
  const doc = b.state.doc;
  syncDoc(path, doc);
  const edits = await srv.request("textDocument/formatting", { textDocument: { uri: pathToUri(path) }, options: { tabSize: indentOf(b).size, insertSpaces: !indentOf(b).tabs } });
  if (!edits || !edits.length) return !!edits;
  // Typed more while the server worked: its edits are for the old text, so leave it.
  if (S.bufs.get(path)?.state.doc !== doc) return true;
  dispatchBuf(path, { changes: edits.map((e) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText })), userEvent: "format" });
  return true;
}
async function formatActive() {
  const b = S.bufs.get(S.active);
  if (!b || b.ro) return;
  if (!formatterFor(S.active, b) && !needServer(b, "Formatting")) return;
  if (!(await formatBuffer(S.active)) && !formatterFor(S.active, b)) toast("Couldn't format. Fix syntax errors first.");
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
  const before = view.state.doc;
  syncDoc(path, before);
  const we = await srv.request("textDocument/rename", { ...srv.at(path, before, pos), newName: name });
  if (!we) { toast("Can't rename that."); return; }
  if (S.bufs.get(path)?.state.doc !== before) { toast("The file changed while the rename was worked out. Try again."); return; }
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
  if (S.bufs.get(path)?.state.doc !== doc) { toast("The file changed in the meantime. Try again."); return; }
  if (typeof a.command === "string") { await srv.request("workspace/executeCommand", { command: a.command, arguments: a.arguments }); return; }
  if (!a.edit && srv.caps?.codeActionProvider?.resolveProvider) a = (await srv.request("codeAction/resolve", a)) || a;
  if (a.edit && S.bufs.get(path)?.state.doc !== doc) { toast("The file changed in the meantime. Try again."); return; }
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
    if (dc.kind === "rename") {
      // Rust-analyzer renaming a module, say: the file moves, and so does its tab.
      const from = norm(uriToPath(dc.oldUri)), to = norm(uriToPath(dc.newUri));
      if (!(await closePagesUnder(from))) continue;
      try { await invoke("rename_path", { from, to }); await movedOnDisk(from, to); } catch (e) { toast(String(e)); }
      continue;
    }
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
        let { text: raw, encoding } = await invoke("read_text", { path });
        const bom = raw.startsWith("\uFEFF");
        if (bom) raw = raw.slice(1);
        const doc = Text.of(raw.split(/\r?\n/));
        const cs = ChangeSet.of(edits.map((e) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText })), doc.length);
        let out = cs.apply(doc).toString();
        if (raw.includes("\r\n")) out = out.replace(/\n/g, "\r\n");
        await invoke("write_file", { path, contents: (bom ? "\uFEFF" : "") + out, encoding });
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
  settings.stickyScroll ? (sticky ||= stickyScroll()) : [],
  ...extraExt.map((f) => f(path, b)),
];
function reconfigureExtras() {
  for (const [p, b] of S.bufs) dispatchBuf(p, { effects: xcfg.reconfigure(xExt(p, b)) });
}
// Indentation: what the file already uses (2 spaces, 4, tabs) when Settings › Editing › Detect
// indentation is on, otherwise the tab size setting. The status bar shows it; click to change it.
function detectIndent(text) {
  const deltas = new Map();
  let tabs = 0, spaced = 0, prev = 0;
  for (const line of text.split("\n", 3000)) {
    const m = /^([ \t]*)\S/.exec(line);
    if (!m) continue;
    const ws = m[1];
    if (ws.startsWith("\t")) { tabs++; continue; }
    if (/^ +$/.test(ws) || !ws) {
      const n = ws.length, d = n - prev;
      if (d > 0 && d <= 8) { spaced++; deltas.set(d, (deltas.get(d) || 0) + 1); }
      prev = n;
    }
  }
  if (tabs > spaced && tabs >= 2) return { tabs: true, size: settings.tabSize };
  // A block comment's " * " lines step by 1: not an indent.
  const best = [...deltas].filter(([d]) => d >= 2).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? { tabs: false, size: best[0] } : null;
}
const indentOf = (b) => (b?.indentSet || (settings.detectIndent !== false && b?.indent)) || { tabs: false, size: settings.tabSize };
const cfgExt = (b) => {
  const ind = indentOf(b);
  return [EditorState.tabSize.of(ind.tabs ? settings.tabSize : ind.size), indentUnit.of(ind.tabs ? "\t" : " ".repeat(ind.size)), settings.wordWrap ? EditorView.lineWrapping : []];
};
async function pickIndent() {
  const b = S.bufs.get(S.active);
  if (!b) return;
  const opts = [["Spaces: 2", { tabs: false, size: 2 }], ["Spaces: 4", { tabs: false, size: 4 }], ["Spaces: 8", { tabs: false, size: 8 }], ["Tabs", { tabs: true, size: settings.tabSize }], ["As the file does it (detect)", null]];
  const i = await choose(`Indentation in ${base(S.active)} (what Tab, Enter and formatting use)`, opts.map((o) => o[0]), true);
  if (i == null || i < 0) return;
  b.indentSet = opts[i][1];
  if (!b.indentSet) b.indent = detectIndent(b.state.doc.toString());
  dispatchBuf(S.active, { effects: cfg.reconfigure(cfgExt(b)) });
  renderPos();
}

function extensionsFor(path, b) {
  const L = LANGS[b.lang], hasServer = !!L.server && !b.virtual;
  return [
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(hl), bracketMatching(), closeBrackets(),
    rectangularSelection(), crosshairCursor(), highlightActiveLine(), selectingClass, highlightSelectionMatches(), search({ top: true }),
    cfg.of(cfgExt(b)), infoField, xcfg.of(xExt(path, b)),
    autocompletion({
      override: [
        ...(hasServer ? [completionSource(path), (ctx) => (started(serverOf(S.bufs.get(path))) ? null : langDataSource(ctx))] : L.complete ? [L.complete] : [langDataSource]),
        ...(L.tailwind ? [tailwindSource] : []),
        ...(emmetSource(b.lang) ? [((src) => (ctx) => (settings.emmet === false ? null : src(ctx)))(emmetSource(b.lang))] : []),
        ...(snippets ? [snippets.source(b.lang, L.languageId)] : []),
      ],
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
    L.ext(), L.extFor ? L.extFor(path) : [], theme,
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
    if (b.sent) b.pend = b.pend ? b.pend.compose(u.changes) : u.changes;
    const was = b.dirty;
    b.dirty = !u.state.doc.eq(b.saved);
    if (b.dirty && S.preview === path) keepTab(path);
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
      if (b.sent) b.pend = b.pend ? b.pend.compose(tr.changes) : tr.changes;
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
function bufChanged(path, b) { each(bufListeners, path, b); }

/** The line ending most lines use (a file with a few stray CRLFs stays LF), and whether it's mixed. */
function eolOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/\n/g) || []).length - crlf;
  return { eol: crlf > lf ? "\r\n" : "\n", mixedEol: crlf > 0 && lf > 0 };
}
const ENC_LABEL = { utf16le: "UTF-16 LE", utf16be: "UTF-16 BE", "utf16le-nobom": "UTF-16 LE, no BOM", "utf16be-nobom": "UTF-16 BE, no BOM", cp1252: "Windows-1252" };
function makeBuffer(path, text, opts = {}) {
  const b = { lang: opts.lang || langOf(path), dirty: false, virtual: !!opts.virtual, label: opts.label };
  b.bom = text.startsWith("\uFEFF");
  if (b.bom) text = text.slice(1);
  Object.assign(b, eolOf(text));
  b.ro = !!opts.virtual || (!isUnder(path, S.root) && TOOLCHAIN.test(path));
  b.saved = Text.of(text.split(/\r?\n/));
  b.indent = detectIndent(text.length > 2_000_000 ? text.slice(0, 200_000) : text);
  b.state = EditorState.create({ doc: b.saved, extensions: extensionsFor(path, b) });
  S.bufs.set(path, b);
  const srv = serverOf(b);
  if (srv && !b.ro) { b.sent = b.saved; b.pend = null; ensureServer(b.lang); srv.open(path, b.saved.toString(), LANGS[b.lang].languageId); scheduleHints(path, 300); }
  if (S.diags.has(path)) applyDiags(path);
  if (b.lang === "lust" && !b.virtual) setTimeout(() => lustCheck(path), 0);
  return b;
}

/** at: {line, character} (0-based) or {offset}. opts: quiet, background, noNav, keepFocus, uri, server */
// Pages other modules open from a key, like "@csv:" and "@hex:" (sessions restore them this way).
const openers = [];
async function openFile(path, at, opts = {}) {
  for (const o of openers) { const r = o(path, opts); if (r) return r; }
  // Databases open in their own tab (src/db.js); "@db:" is how a restored session names them.
  if (app.openDb && (DB_EXT.test(path) || String(path).startsWith("@db:"))) return app.openDb(String(path).replace(/^@db:/, ""), opts);
  // Images open in a viewer tab (src/image.js); "Edit code" on an SVG passes asText to get the text editor.
  if (app.openImage && !opts.asText && (IMG_EXT.test(path) || String(path).startsWith("@img:"))) {
    // Images take part in preview tabs too, so clicking through a folder of sprites reuses one tab.
    const img = String(path).replace(/^@img:/, ""), key = "@img:" + norm(img), prev = S.preview;
    const asPreview = opts.preview && settings.previewTabs !== false && !S.tabs.includes(key);
    const r = await app.openImage(img, opts);
    if (asPreview && S.tabs.includes(key)) {
      S.preview = key;
      if (prev && prev !== key && S.tabs.includes(prev) && !S.bufs.get(prev)?.dirty && !S.pinned.has(prev) && !pageOf(prev)?.confirmClose) await closeTab(prev, true);
      renderTabs();
    }
    return r;
  }
  path = norm(path);
  if (opts.uri && /^csharp:/i.test(opts.uri)) return openMetadata(opts.uri, at, opts.server);
  if (!S.bufs.has(path)) {
    let file;
    try { file = await invoke("read_text", { path }); }
    catch (e) {
      // Not text: show its bytes instead.
      if (/binary/i.test(String(e)) && app.openHex) return app.openHex(path, opts);
      // Too big to edit: the hex view reads up to 128 MB.
      if (/larger than 8 MB/i.test(String(e)) && app.openHex && !opts.quiet) {
        const c = await choose(`${base(path)} is over 8 MB, too big to edit in Ledger.`, ["Look at it in the hex view", "Cancel"]);
        return c?.startsWith("Look") ? app.openHex(path, opts) : false;
      }
      if (!opts.quiet) toast(`Can't open ${base(path)}: ${e}`);
      return false;
    }
    if (!S.bufs.has(path)) {
      const b = makeBuffer(path, file.text); b.enc = file.encoding; statOf(path).then((m) => { b.mtime = m; });
      // Guesses worth saying out loud, once, when the file opens.
      if (b.enc === "cp1252" && !opts.quiet) toast(`${base(path)} isn't valid UTF-8, so it opened as Windows-1252. If letters look wrong, it's in another encoding; "Convert this file to UTF-8" changes it.`, 8000);
      else if (b.mixedEol && !opts.quiet) toast(`${base(path)} mixes line endings; it will be saved with ${b.eol === "\r\n" ? "CRLF" : "LF"} throughout. "Change line endings" picks the other.`, 7000);
    }
  }
  const wasOpen = S.tabs.includes(path); // asked before addTab, which puts it in S.tabs
  addTab(path);
  const prevPreview = S.preview;
  const asPreview = opts.preview && settings.previewTabs !== false && !wasOpen;
  if (!opts.background) activate(path, at, opts);
  if (asPreview && S.tabs.includes(path)) {
    S.preview = path;
    // The file clicked before goes, unless it was edited, kept or pinned since.
    if (prevPreview && prevPreview !== path && S.tabs.includes(prevPreview) && !S.bufs.get(prevPreview)?.dirty && !S.pinned.has(prevPreview) && !pageOf(prevPreview)?.confirmClose) await closeTab(prevPreview, true);
    renderTabs();
  }
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
  each(decorationCopiers, path, b);
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
  each(focusListeners);
  each(activeHooks, S.active);
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
    h.innerHTML = `${k && !isPage(k) && !isVirtual(k) && fileIcons() ? iconHtml(k) : `<span class="dot" style="--tc:var(--t-${k ? (isPage(k) ? "cfg" : dotOf(k)) : "other"})"></span>`}<span>${k ? esc(tabLabel(k)) : ""}${b?.dirty ? " ●" : ""}</span>${i === 1 ? `<button class="ibtn" data-unsplit title="Close split (${esc(keymap.label("editor.unsplit"))})" aria-label="Close split"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>` : ""}`;
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
  each(activeHooks, key);
}
const activeHooks = [];
// Fetch a Tailwind project's classes in the background as soon as one of its files is in front.
let twWarmT = null;
activeHooks.push(() => { clearTimeout(twWarmT); twWarmT = setTimeout(tailwindWarm, 400); });

// One save at a time per file: auto-save, Ctrl S and save-all can overlap, and the second would
// see the first one's write as "changed on disk by another program".
async function save(path = S.active) {
  const b = S.bufs.get(path);
  while (b?.saving) await b.saving.catch(() => {});
  if (!b) return saveNow(path);
  const p = saveNow(path);
  b.saving = p;
  try { return await p; } finally { if (b.saving === p) b.saving = null; }
}
async function saveNow(path) {
  const b = S.bufs.get(path);
  if (!b || b.ro) return true;
  if (settings.formatOnSave && (formatterFor(path, b) || serverOf(b)?.alive) && b.dirty) await formatBuffer(path);
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
  try { await invoke("write_file", { path, contents: text, encoding: b.enc || "utf8" }); }
  catch (e) { toast(`Couldn't save ${base(path)}: ${e}`, 7000); return false; }
  b.saved = doc;
  b.dirty = !b.state.doc.eq(doc);
  b.diskChanged = null;
  b.mtime = await statOf(path);
  const srv = serverOf(b);
  if (srv) { syncDoc(path); srv.saved(path); scheduleHints(path, 400); }
  if (settingsFile && path.toLowerCase() === settingsFile.toLowerCase()) reloadSettingsFromFile();
  each(saveHooks, path, b);
  scheduleUi();
  return true;
}
const saveHooks = [];

// ---------- Lust: mistakes in the Problems list ----------
// After a .lst or .lsc file is saved (or opened), `lust check` runs quietly and its
// messages (entities/player.lst:3:5  missing ; …) become problems and squiggles.
const LUST_LINE = /^(.+?\.(?:lst|lsc|lust)):(\d+):(\d+)  (.*)$/;
const lustShown = new Set();
// A Lust project's folder is the nearest one up with a main.lst (or main.lsc) in it. Lust
// names files from there, and fetch paths start there, so lust runs from there too.
async function lustRoot(path) {
  const dirs = [];
  for (let d = parent(path), i = 0; i < 24; i++) {
    dirs.push(d);
    if (S.root && norm(d) === norm(S.root)) break;
    const up = parent(d);
    if (!up || up === d) break;
    d = up;
  }
  const paths = dirs.flatMap((d) => [join(d, "main.lst"), join(d, "main.lsc")]);
  const stats = await invoke("file_stats", { paths }).catch(() => []);
  const i = stats.findIndex((x) => x != null);
  return i < 0 ? parent(path) : dirs[Math.floor(i / 2)];
}
// Each Lust file's project folder, found when it's opened or saved, for Run and Build.
const lustRoots = new Map();
const lustRel = (root, path) => norm(path).slice(norm(root).replace(/\/$/, "").length + 1);
const lustSeqs = new Map(); // Lust project folder -> number of its newest check
async function lustCheck(path) {
  const dir = await lustRoot(path);
  const seq = (lustSeqs.get(dir) || 0) + 1;
  lustSeqs.set(dir, seq);
  lustRoots.set(norm(path), dir);
  let r;
  try { r = await invoke("run_capture", { cwd: dir, program: settings.lust || "lust", args: ["check", lustRel(dir, path)] }); }
  catch { return; } // lust isn't set up; Run says how to fix that
  if (seq !== lustSeqs.get(dir)) return; // a newer check of this project is on its way
  const found = new Map();
  for (const line of (r.out + "\n" + r.err).split(/\r?\n/)) {
    const m = LUST_LINE.exec(line);
    if (!m) continue;
    const file = norm(isAbs(m[1]) ? m[1] : join(dir, m[1]));
    const l = Math.max(0, +m[2] - 1), c = Math.max(0, +m[3] - 1);
    // Underline the word the message points at.
    let end = c + 1;
    const doc = S.bufs.get(file)?.state.doc;
    if (doc && l < doc.lines) {
      const text = doc.line(l + 1).text;
      while (end < text.length && /\w/.test(text[end]) && /\w/.test(text[c] || "")) end++;
    }
    if (!found.has(file)) found.set(file, []);
    found.get(file).push({ range: { start: { line: l, character: c }, end: { line: l, character: end } }, severity: 1, message: m[4], source: "lust" });
  }
  // Only this project's earlier problems are cleared; another Lust project's stay.
  for (const f of [...lustShown]) if (isUnder(f, dir) && !found.has(f)) { lspHandlers.diagnostics(f, []); lustShown.delete(f); }
  for (const [f, list] of found) { lustShown.add(f); lspHandlers.diagnostics(f, list); }
}
saveHooks.push((path, b) => { if (b.lang === "lust") lustCheck(path); if (/\.css$|tailwind\.config\./.test(path)) tailwindChanged(); });
// ---------- Live Server ----------
// Serves the open folder on localhost and reloads the page whenever a file in it is saved.
const live = { port: 0, root: null };
let updater = null;
function liveUrl() {
  const b = S.bufs.get(S.active);
  const rel = b && !b.virtual && b.lang === "html" && isUnder(S.active, live.root) ? norm(S.active).slice(norm(live.root).length).replace(/^\/+/, "") : "";
  return `http://localhost:${live.port}/` + rel.split("/").map(encodeURIComponent).join("/");
}
async function startLive() {
  if (!S.root) { toast("Open a folder first."); return; }
  try {
    live.port = await invoke("live_start", { root: S.root, port: +settings.livePort || 5500 });
    live.root = S.root;
  } catch (e) { toast("Live Server couldn't start: " + e, 5000); return; }
  renderStatus();
  openLive();
}
async function stopLive(quiet) {
  if (!live.port) return;
  await invoke("live_stop").catch(() => {});
  live.port = 0; live.root = null;
  renderStatus();
  if (!quiet) toast("Live Server stopped.");
}
function openLive() {
  if (!live.port) { startLive(); return; }
  openInBrowser(liveUrl()).catch((e) => toast("Couldn't open the browser: " + e, 5000));
}
saveHooks.push((path, b) => {
  if (live.port && isUnder(path, live.root)) invoke("live_reload", { css: b.lang === "css" }).catch(() => {});
});
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
  if (!force && pageOf(key)?.confirmClose && !(await pageOf(key).confirmClose(key))) return false;
  const b = S.bufs.get(key);
  if (b?.dirty && !force) {
    const c = await choose(`Save changes to ${base(key)} before closing?`, ["Save", "Don't save", "Cancel"]);
    if (!c || c === "Cancel") return false;
    if (c === "Save" && !(await save(key))) return false;
  }
  const i = S.tabs.indexOf(key);
  if (i >= 0) S.tabs.splice(i, 1);
  if (S.preview === key) S.preview = null;
  S.pinned.delete(key);
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
// ---------- preview and pinned tabs ----------
// A file clicked in the explorer opens in a preview tab (in italics) that the next click replaces,
// until it's edited, saved, double-clicked or pinned. Pinned tabs sit first and stay put.
function keepTab(key) {
  if (S.preview !== key) return;
  S.preview = null;
  renderTabs();
}
function togglePin(key = S.active) {
  if (!key || !S.tabs.includes(key)) return;
  keepTab(key);
  if (S.pinned.has(key)) S.pinned.delete(key);
  else {
    S.pinned.add(key);
    // Pinned tabs go first, in the order they were pinned.
    S.tabs.splice(S.tabs.indexOf(key), 1);
    S.tabs.splice(S.tabs.filter((k) => S.pinned.has(k)).length, 0, key);
  }
  saveSession();
  renderTabs();
}
/** Every tab with nothing unsaved goes; unsaved and pinned ones stay. */
async function closeSavedTabs() {
  for (const k of [...S.tabs]) {
    if (S.pinned.has(k) || S.bufs.get(k)?.dirty) continue;
    if (pageOf(k)?.confirmClose) { await closeTab(k); continue; } // asks if it has unsaved changes
    await closeTab(k, true);
  }
}
/** All tabs, pinned too; unsaved work is asked about first. */
async function closeAllTabs() {
  if (await closeAll()) { S.pinned.clear(); S.preview = null; saveSession(); renderTabs(); }
}
async function closeOthers(key) {
  for (const k of [...S.tabs]) if (k !== key && !S.pinned.has(k) && !(await closeTab(k))) return;
}

async function closeAll() {
  // Page tabs that can hold unsaved work (database edits, an open transaction) ask first.
  for (const k of S.tabs.filter((k2) => isPage(k2))) if (pageOf(k)?.confirmClose && !(await pageOf(k).confirmClose(k))) return false;
  const d = dirtyPaths();
  if (d.length) {
    const c = await choose(`Save changes to ${d.length === 1 ? base(d[0]) : d.length + " files"}?`, ["Save all", "Don't save", "Cancel"]);
    if (!c || c === "Cancel") return false;
    if (c === "Save all" && !(await saveAll())) return false;
  }
  closeSplit();
  for (const k of S.tabs.filter((k2) => isPage(k2))) pageOf(k)?.close?.(k);
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
      if (!cur || m === undefined || cur.mtime === undefined || cur.saving) continue;
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
  const startDoc = S.bufs.get(path)?.state.doc;
  let text, enc;
  try { ({ text, encoding: enc } = await invoke("read_text", { path })); } catch { return; }
  const mtime = await statOf(path);
  const cur = S.bufs.get(path);
  if (!cur) return;
  // Typed while the file was being read: keep the typing, and show the "changed on disk" bar instead.
  if (cur.state.doc !== startDoc) { cur.diskChanged = "changed"; renderDiskBars(); return; }
  cur.enc = enc;
  cur.mtime = mtime;
  const bom = text.startsWith("\uFEFF");
  if (bom) text = text.slice(1);
  cur.bom = bom;
  Object.assign(cur, eolOf(text));
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
  if (S.preview === path) keepTab(path);
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
// Errors and warnings per folder, added up once per tree drawing (not once per folder).
let dirAgg = new Map();
function aggregateDirs() {
  dirAgg = new Map();
  for (const [p, l] of S.diags) {
    const c = counts(l);
    if (!c.e && !c.w) continue;
    for (let d = parent(p); d && d.length >= (S.root || "").length; d = parent(d)) {
      const a = dirAgg.get(d) || { e: 0, w: 0 };
      a.e += c.e; a.w += c.w;
      dirAgg.set(d, a);
      if (d === S.root || parent(d) === d) break;
    }
  }
}
function dirCounts(d) { return dirAgg.get(d) || { e: 0, w: 0 }; }
const cntHtml = ({ e, w }, dirty) => (e ? `<span class="cnt e">${e}</span>` : w ? `<span class="cnt w">${w}</span>` : dirty ? `<span class="cnt" aria-label="unsaved">●</span>` : "");

function nodeHtml(n, depth) {
  const pad = 4 + depth * 14;
  const cur = S.sel === n.path;
  const common = `role="treeitem" aria-level="${depth + 1}" tabindex="${cur ? 0 : -1}" aria-selected="${S.active === n.path}"`;
  if (n.dir) {
    const open = S.open.has(n.path);
    const c = dirCounts(n.path);
    const gd = app.treeDecor?.(n.path, true);
    let h = `<button class="node folder${DIMMED.has(n.name) ? " dim" : ""}${c.e ? " err" : c.w ? " warn" : ""}${cur ? " sel" : ""}${gd && !c.e && !c.w ? " " + gd.cls : ""}" ${common} style="padding-left:${pad}px" data-dir="${esc(n.path)}" aria-expanded="${open}"><span class="chev${open ? " open" : ""}">${CHEV}</span>${fileIcons() ? iconHtml(n.path, true, open) : `<span class="ico">${ICON_FOLDER}</span>`}<span class="lbl">${esc(n.name)}</span>${open ? "" : cntHtml(c)}</button>`;
    if (open) {
      const kids = S.kids.get(n.path);
      h += `<div role="group">` + (kids ? (kids.length ? kids.map((k) => nodeHtml(k, depth + 1)).join("") : `<div class="hint" style="padding:2px 0 4px ${pad + 32}px">Empty</div>`) : `<div class="hint" style="padding:2px 0 4px ${pad + 32}px">Loading…</div>`) + `</div>`;
    }
    return h;
  }
  const c = counts(S.diags.get(n.path));
  const gd = app.treeDecor?.(n.path, false);
  return `<button class="node${S.active === n.path ? " active" : ""}${c.e ? " err" : c.w ? " warn" : ""}${cur ? " sel" : ""}${gd && !c.e && !c.w ? " " + gd.cls : ""}" ${common} style="padding-left:${pad + 16}px;--tc:var(--t-${dotOf(n.path)})" data-file="${esc(n.path)}" title="${esc(rel(n.path))}">${mark(n.path)}<span class="lbl">${esc(n.name)}</span>${cntHtml(c, S.bufs.get(n.path)?.dirty)}${gd?.badge || ""}</button>`;
}

function renderTree() {
  aggregateDirs();
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
      return `<button class="node${S.active === p ? " active" : ""}${S.sel === p ? " sel" : ""}" role="treeitem" aria-level="1" tabindex="${S.sel === p ? 0 : -1}" style="padding-left:4px;--tc:var(--t-${dotOf(p)})" data-file="${esc(p)}" title="${esc(r)}">${mark(p)}<span class="lbl" style="flex:0 1 auto">${esc(base(p))}</span><span class="sub">${esc(dir)}</span></button>`;
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
  else if (k === "Enter") { if (isDir) toggleDir(p); else openFile(p).then(() => keepTab(p)); }
  else if (k === "Space") { if (isDir) toggleDir(p); else openFile(p, null, { keepFocus: true, preview: true }); }
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
  if (f) {
    // Like VS Code: a click shows the file but keeps the keyboard in the explorer (Delete, F2, arrows);
    // a double-click moves into the editor.
    const p = f.dataset.file;
    S.sel = p; S.selDir = false;
    // The second click of a double-click: the row was redrawn in between, so no dblclick event
    // arrives; the click count says it. Keep the tab and go to the editor.
    if (ev.detail >= 2) { openFile(p).then((ok) => { if (ok && S.active === p) { keepTab(p); if (S.bufs.get(p)) view.focus(); } }); return; }
    openFile(p, null, { keepFocus: true, preview: true }).then(() => { const n = $("tree").querySelector(`[data-file="${CSS.escape(p)}"]`); if (n) moveCursor(n); });
  }
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
    { label: "New SQLite database…", run: () => app.newDb?.(dirOf) },
  ];
  if (p && !isDir) items.unshift({ label: "Open", hint: "Enter", run: () => openFile(p) },
    ...(/\.(csv|tsv|tab|psv)$/i.test(p) ? [{ label: "Open as a table", run: () => app.csvTable?.(p) }] : []),
    { label: "Open as hex", run: () => app.openHex?.(p) },
    { label: "Saved versions (local history)…", run: async () => { if (await openFile(p)) app.run("history.show"); } }, "-");
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
// Image and database tabs show a file by path: they close when it's renamed or deleted (an open
// database would also keep Windows from renaming it). False if a database tab's owner said Cancel.
async function closePagesUnder(p) {
  for (const k of S.tabs.filter((k2) => /^@(img|db):/.test(k2))) {
    const f = k.replace(/^@\w+:/, "");
    if ((f === p || f.startsWith(p + "/")) && !(await closeTab(k))) return false;
  }
  return true;
}
/** After a file or folder moved on disk (Ledger's rename, or a language server's): open tabs,
 *  pins, the preview tab, problems and the explorer follow it to its new path. */
async function movedOnDisk(p, to) {
  const remap = (x) => (x === p ? to : x.startsWith(p + "/") ? to + x.slice(p.length) : x);
  // Local history follows the file (for a folder, the files of it that are open).
  for (const k of new Set([p, ...S.bufs.keys()])) { const nk = remap(k); if (nk !== k) invoke("history_move", { from: k, to: nk }).catch(() => {}); }
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
    if (srv2) { b.sent = b.state.doc; b.pend = null; srv2.open(nk, b.state.doc.toString(), LANGS[b.lang].languageId); }
  }
  S.tabs = S.tabs.map(remap);
  S.open = new Set([...S.open].map(remap));
  S.pinned = new Set([...S.pinned].map(remap));
  if (S.preview) S.preview = remap(S.preview);
  S.diags = new Map([...S.diags].map(([k, v]) => [remap(k), v]));
  for (const P of panes) if (P.key && remap(P.key) !== P.key) { const nk = remap(P.key); S.bufs.get(nk) && (S.bufs.get(nk).mirror = null); P.key = nk; }
  panes.forEach((P, i) => { const b = S.bufs.get(P.key); if (b && P.view && P.view.state !== b.state && P.view.state !== b.mirror) { const k = P.key; P.key = null; showIn(i, k); } });
  if (S.sel) S.sel = remap(S.sel);
  const keep = $("tree").contains(document.activeElement);
  const act = S.active && remap(S.active);
  if (act) { S.active = null; activate(act, null, { noNav: true, keepFocus: keep }); }
  await refreshTree();
  if (keep) focusTree();
}
async function renamePath(p, newName) {
  if (!p) return;
  const name = newName ?? (await promptText(`Rename ${base(p)}`, base(p)))?.trim();
  if (!name || name === base(p)) return;
  if (!validName(name) || name.includes("/")) { toast("That isn't a usable name."); return; }
  const to = join(parent(p), name);
  if (!(await closePagesUnder(p))) return;
  try { await invoke("rename_path", { from: p, to }); } catch (e) { toast(String(e)); return; }
  await movedOnDisk(p, to);
}
async function deletePath(p) {
  if (!p) return;
  const c = await choose(`Move ${base(p)} to the Recycle Bin?`, ["Move to Recycle Bin", "Cancel"]);
  if (c !== "Move to Recycle Bin") return;
  const nodes = [...$("tree").querySelectorAll(".node")];
  const i = nodes.findIndex((n) => nodePath(n) === p);
  if (!(await closePagesUnder(p))) return;
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
    return `<div class="tab${on ? " on" : ""}${there ? " there" : ""}${b?.dirty ? " dirty" : ""}${p === S.preview ? " preview" : ""}${S.pinned.has(p) ? " pinned" : ""}" role="tab" aria-selected="${on}" style="--tc:var(--t-${dot})" data-tab="${esc(p)}" title="${esc(isPage(p) || b?.virtual ? tabLabel(p) : rel(p))}${there ? "  ·  open in the other pane" : ""}${i < 8 ? `  ·  Ctrl ${i + 1}` : ""}" tabindex="${on ? 0 : -1}">${isPage(p) || b?.virtual ? (/^@(csv|hex|img|db):/.test(p) && fileIcons() ? mark(p.replace(/^@[a-z]+:/, "")) : '<span class="dot pg"></span>') : mark(p)}<span class="tl${c.e ? " e" : c.w ? " w" : ""}">${esc(tabLabel(p))}</span>${b?.ro ? '<span class="ro">read-only</span>' : ""}<span class="x" data-close="${esc(p)}" role="button" aria-label="Close ${esc(tabLabel(p))}"><span>×</span></span></div>`;
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
// The mouse wheel scrolls the tab bar sideways when the tabs don't fit.
$("tabs").addEventListener("wheel", (ev) => { const t = $("tabs"); if (t.scrollWidth > t.clientWidth && Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) { t.scrollLeft += ev.deltaY; ev.preventDefault(); } }, { passive: false });
$("tabs").addEventListener("dblclick", (ev) => { const t2 = ev.target.closest("[data-tab]"); if (t2) keepTab(t2.dataset.tab); });
$("tabs").addEventListener("contextmenu", (ev) => {
  const t2 = ev.target.closest("[data-tab]");
  if (!t2) return;
  ev.preventDefault();
  const k = t2.dataset.tab, pinned = S.pinned.has(k);
  showMenu(ev.clientX, ev.clientY, [
    { label: pinned ? "Unpin tab" : "Pin tab", key: "tab.pin", run: () => togglePin(k) },
    ...(S.preview === k ? [{ label: "Keep open", run: () => keepTab(k) }] : []),
    "-",
    { label: "Close", key: "tab.close", run: () => closeTab(k) },
    { label: "Close others", run: () => closeOthers(k) },
    { label: "Close saved tabs", key: "tab.closeSaved", run: () => closeSavedTabs() },
    { label: "Close all tabs", key: "tab.closeAll", danger: true, run: () => closeAllTabs() },
  ]);
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
    <p class="lede">${S.root ? `Pick a file from the explorer, or press ${k("file.goto")} to jump to one.` : "An editor for Rust, C#, Godot and Lust."}</p>
    <div class="bar">${S.root
      ? `<button class="btn primary" data-w="find">Go to file <kbd>${k("file.goto")}</kbd></button>${taskKind() ? `<button class="btn" data-w="run">${esc(taskLabel("run"))} <kbd>${k("task.run")}</kbd></button>` : ""}<button class="btn" data-w="open">Open another folder</button>`
      : `<button class="btn primary" data-w="open">Open folder <kbd>${k("folder.open")}</kbd></button><button class="btn" data-w="new">New project</button>`}
      <button class="btn" data-w="settings">Settings <kbd>${k("settings.open")}</kbd></button></div>
    ${recent.length ? `<section><h2>Recent <span class="hint" style="font-weight:400">· Ctrl Enter opens in a new window</span></h2><div class="list" role="list">${recent.map((r, i) => `<div class="li" role="button" tabindex="${i ? -1 : 0}" data-recent="${esc(r)}" style="--tc:var(--t-rs)">${fileIcons() ? iconHtml(r, true) : '<span class="dot"></span>'}<span class="t">${esc(base(r))}</span><span class="m">${esc(parent(r))}</span></div>`).join("")}</div></section>` : ""}
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
  if (!b || !view) { $("stPos").textContent = ""; $("stLang").textContent = ""; $("stIndent").textContent = ""; renderServer(); return; }
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const n = Math.abs(sel.to - sel.from);
  $("stPos").textContent = `Ln ${line.number}, Col ${sel.head - line.from + 1}${n ? ` (${n} selected)` : ""}`;
  const ind = indentOf(b);
  $("stIndent").textContent = ind.tabs ? "Tabs" : `Spaces: ${ind.size}`;
  $("stLang").textContent = LANGS[b.lang].name + (b.eol === "\r\n" ? " · CRLF" : "") + (b.bom ? " · BOM" : "") + (ENC_LABEL[b.enc] ? " · " + ENC_LABEL[b.enc] : "");
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
$("stTrust").onclick = () => S.root && askTrust(S.root, true);
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
const MARKER = (b) => b === "Cargo.toml" || b === "project.godot" || b === "package.json" || /\.(csproj|slnx?)$/i.test(b);
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
  // A .lust file runs with lust, whatever project it sits in (or none).
  if (S.bufs.get(S.active)?.lang === "lust" && !S.bufs.get(S.active).virtual) return "lust";
  // A .lua file runs on its own with the lua interpreter.
  if (S.bufs.get(S.active)?.lang === "lua" && !S.bufs.get(S.active).virtual) return "lua";
  const b = S.bufs.get(S.active), lang = b && !b.virtual ? b.lang : null;
  const html = lang === "html";
  if (!P) return html ? "html" : lang === "javascript" || lang === "typescript" ? "nodefile" : null;
  if (P.godot) return "godot";
  // A web project, or a Tauri-style one with web files open: npm scripts win.
  if (P.node && (!(P.rust || P.dotnet) || WEB_LANGS.has(lang))) return "node";
  if (P.rust && P.dotnet) return S.bufs.get(S.active)?.lang === "csharp" ? "dotnet" : "rust";
  if (P.dotnet) return "dotnet";
  if (P.rust) return "rust";
  return html ? "html" : null;
}
const WEB_LANGS = new Set(["javascript", "jsx", "typescript", "tsx", "html", "css", "scss", "less"]);
// The script Run starts in an npm project: dev, then start, then serve.
const runScript = (P) => ["dev", "start", "serve"].find((n) => P.scripts?.includes(n));
// Each action is a list of steps; a step runs only if the one before succeeded.
// `input: true` marks steps that run the user's program, which get the Input box.
function taskSteps(action, P = S.ctx) {
  const kind = taskKind(P);
  if (!kind) return null;
  if (kind === "lust") {
    // Run from the project's folder (the one with main.lst), so Lust's messages
    // (entities/player.lst:3:5) link back to the right files.
    const file = S.active, prog = settings.lust || "lust", root = lustRoots.get(norm(file)) || parent(file);
    const step = (sub, input) => ({ label: "lust " + sub, program: prog, args: [sub, lustRel(root, file)], cwd: root, input, lust: true });
    const script = /\.lsc$/i.test(file);
    return { run: [step("run", true)], check: [step("check")], build: [step("build")], lua: [step("lua")], rust: script ? null : [step("rust")] }[action] || null;
  }
  const nodeFile = () => {
    const b = S.bufs.get(S.active);
    return b && !b.virtual && (b.lang === "javascript" || b.lang === "typescript") ? { label: "node " + base(S.active), program: "node", args: [base(S.active)], cwd: parent(S.active), input: true } : null;
  };
  if (kind === "lua") return action === "run" ? [{ label: "lua " + base(S.active), program: settings.lua || "lua", args: [base(S.active)], cwd: parent(S.active), input: true }] : null;
  if (kind === "nodefile") return action === "run" ? [nodeFile()] : null;
  if (kind === "node") {
    const pm = P.pm || "npm", has = (n) => P.scripts?.includes(n);
    const install = { label: pm + " install", program: pm, args: ["install"], cwd: P.dir };
    const script = (n, input) => [...(P.needs_install ? [install] : []), { label: `${pm} run ${n}`, program: pm, args: ["run", n], cwd: P.dir, input }];
    if (action === "install") return [install];
    if (action.startsWith("script:")) return script(action.slice(7), true);
    const lint = ["lint", "typecheck", "check"].find(has);
    const run = runScript(P);
    return {
      run: run ? script(run, true) : nodeFile() ? [nodeFile()] : null,
      build: has("build") ? script("build") : null,
      test: has("test") ? script("test", true) : null,
      check: lint ? script(lint) : null,
    }[action] || null;
  }
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
  return { run: taskKind() === "godot" ? "Play" : taskKind() === "html" ? "Open in browser" : "Run", build: "Build", check: taskKind() === "node" ? "Lint" : "Check", test: "Test", lint: "Clippy", scene: "Play scene", debug: "Debug", scripts: "Scripts…", lua: "Show the Lua", rust: "Show the Rust" }[action];
}
async function runAction(action) {
  if (!S.root) { toast("Open a folder first."); return; }
  const P = await updateCtx();
  // Lust 2 only reads .lst and .lsc; a Lust 1 file can become a .lst in one go.
  if (taskKind(P) === "lust" && /\.lust$/i.test(S.active || "")) {
    const to = S.active.replace(/\.lust$/i, ".lst");
    const c = await choose(`Lust 2 programs end in .lst. Rename ${base(S.active)} to ${base(to)}? (Lust 1 code may need changes too.)`, ["Rename", "Cancel"]);
    if (c !== "Rename") return;
    await saveAll();
    await renamePath(S.active, base(to)); // also moves the open tab over to the new name
    return;
  }
  if (action === "scripts") { pickScript(P); return; }
  if (action === "run" && (taskKind(P) === "html" || (taskKind(P) === "node" && !runScript(P) && S.bufs.get(S.active)?.lang === "html"))) {
    // Through Live Server (started if needed): Ledger doesn't hand file:// links to other programs.
    if (!isUnder(S.active, S.root)) { toast("Open this page's folder to view it in the browser."); return; }
    if (live.port && live.root === S.root) openInBrowser(liveUrl()).catch((e) => toast("Couldn't open the browser: " + e, 5000));
    else startLive();
    return;
  }
  const steps = taskSteps(action, P);
  if (!steps) {
    if (!P) toast(projectDirs().length > 1 ? "Open a file from the project you want. This folder holds several projects." : "No Cargo.toml, .csproj, .sln, project.godot or package.json here.", 5000);
    else if (taskKind(P) === "node") toast(action === "run" ? "package.json has no dev, start or serve script. Pick one from Scripts." : `package.json has no script for ${taskLabel(action)}.`, 5000);
    else if (action === "scene") toast("Open a .tscn scene file to play it.");
    else if (action === "rust" && /\.lsc$/i.test(S.active || "")) toast("LustScript turns into Lua, not Rust: use Show the Lua.");
    else if ((action === "lua" || action === "rust") && taskKind(P) !== "lust") toast("Open a Lust file (.lst or .lsc) first.");
    else toast(`${taskLabel(action)} isn't available for this project.`);
    return;
  }
  if (steps.some((s) => s.godot && !s.program)) {
    toast("Set the Godot program in Settings first.", 4000);
    openSettings();
    requestAnimationFrame(() => { const f = $("sGodotPath"); f?.focus(); f?.scrollIntoView({ block: "center" }); });
    return;
  }
  // "Show the Lua/Rust" only translates a Lust file; everything else runs the project's code.
  if (action !== "lua" && action !== "rust" && !(await ensureTrusted(taskLabel(action)))) return;
  if (!(await haveTools(steps, () => runAction(action)))) return;
  startSteps(steps);
}
// Before running: if a step needs a language that isn't installed, offer to install it and run again after.
async function haveTools(steps, retry) {
  for (const prog of new Set(steps.map((s) => s.program))) {
    const key = INSTALL_FOR[prog];
    if (!key || (await invoke("tool_info", { name: prog }).catch(() => null))) continue;
    const name = INSTALLS[key].name;
    const c = await choose(`${name} isn't installed, and this needs it.`, [`Install ${name}`, "Cancel"]);
    if (c === `Install ${name}`) installTool(key, (ok) => (ok ? retry() : toast(`${name} installed. If Run still can't find it, restart Ledger.`, 6000)));
    return false;
  }
  return true;
}
async function pickScript(P) {
  if (!P?.node) { toast("No package.json here."); return; }
  const pm = P.pm || "npm";
  const names = [...(P.scripts || []), pm + " install"];
  const i = await choose(`Run a script from package.json (${pm})`, names, true);
  if (i == null || i < 0) return;
  startSteps(taskSteps(i === names.length - 1 ? "install" : "script:" + names[i], P));
}
async function startSteps(steps, onDone, onFail) {
  // Steps with their own folder (creating a project, installing a language) also run with no folder open.
  if (!S.root && !steps.every((s) => s.cwd || !s.godot && settingsFile)) { toast("Open a folder first."); return; }
  await saveAll();
  showPanel("output");
  outFollow().reset(); // a new run always starts at the bottom
  S.queue = steps.slice(1);
  S.onDone = onDone || null;
  S.onFail = onFail || null;
  startStep(steps[0]);
}
async function startStep(step) {
  const cwd = step.cwd || S.ctx?.dir || S.root || parent(settingsFile);
  S.running = true;
  S.runStart = performance.now();
  S.runLabel = step.label;
  S.runDir = cwd;
  S.runInput = !!step.input;
  const show = (a) => (a === cwd ? "." : isAbs(a) && isUnder(norm(a), cwd) ? norm(a).slice(cwd.length + 1) : a);
  const shown = `${step.godot ? base(norm(step.program)) : step.program} ${step.args.map(show).join(" ")}`;
  appendOut(`<span class="cmd">$ ${esc(shown)}${cwd !== S.root ? `   <span class="where">in ${esc(S.root && isUnder(cwd, S.root) ? rel(cwd) : cwd)}</span>` : ""}</span>`);
  renderStatus();
  const run = ++S.runSeq;
  S.run = run; // set before starting, so events from an older run are ignored
  try { await invoke("run_task", { run, root: cwd, program: step.program, args: step.args, scaffold: !!step.scaffold }); }
  catch (e) {
    S.running = false; S.runInput = false;
    // A restricted folder: ask, and go on from this step if the answer is yes.
    if (isUntrustedError(e)) {
      renderStatus();
      if (await ensureTrusted(step.label || "This")) { S.running = true; startStep(step); return; }
      appendOut(`<span class="done bad">Not run: ${esc(base(S.root || ""))} is in restricted mode.</span>`);
      S.queue = []; const f = S.onFail; S.onFail = S.onDone = null; f?.();
      return;
    }
    S.queue = [];
    appendOut(`<span class="done bad">${esc(String(e))}</span>`);
    if (step.lust) appendOut(`<span class="done bad">Ledger couldn't start lust. Set where lust.exe is in Settings › Lust.</span>`);
    renderStatus(); const f = S.onFail; S.onFail = S.onDone = null; f?.();
  }
}
// A line can arrive in pieces: a program asking a question prints it without a line ending,
// so it's shown at once (partial) and the rest of the line replaces it when it comes.
const partialOut = {};
// When you answer a question, the question stays as it was (with your answer next to it), and the
// start of the line it began is left off what comes next: answered[stream] is that start.
const answered = {};
let pieceRun = null;
// Output arrives in batches (see pump in lib.rs); the panel scrolls once per batch, not per line.
let outQuiet = false;
listen("task-lines", (e) => {
  if (e.payload.run !== S.run) return;
  outQuiet = true;
  try { for (const l of e.payload.lines) onLine({ ...l, run: e.payload.run }); } finally { outQuiet = false; }
  outFollow().changed();
});
function onLine(line) {
  const { run, stream, partial } = line;
  let text = line.text;
  if (run !== S.run) return;
  if (run !== pieceRun) { pieceRun = run; for (const k in partialOut) delete partialOut[k]; for (const k in answered) delete answered[k]; }
  if (answered[stream] != null) {
    if (text.startsWith(answered[stream])) text = text.slice(answered[stream].length);
    if (!partial) delete answered[stream];
    if (!text) return;
  }
  const open = partialOut[stream];
  if (open?.isConnected) {
    open.innerHTML = ansiToHtml(text);
    open.dataset.text = text;
    if (!partial) delete partialOut[stream];
    if (!outQuiet) outFollow().changed();
    return;
  }
  const d = appendOut(ansiToHtml(text));
  if (partial) { partialOut[stream] = d; d.dataset.text = text; } else delete partialOut[stream];
}
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
  const asking = partialOut.stdout?.isConnected ? partialOut.stdout : null;
  if (asking) {
    // A question is waiting on this line: the answer goes right after it, like in a terminal.
    asking.insertAdjacentHTML("beforeend", `<span class="in">${esc(text)}</span>`);
    outFollow().changed();
    answered.stdout = (answered.stdout ?? "") + asking.dataset.text;
    delete partialOut.stdout;
  } else appendOut(`<span class="in">› ${esc(text)}</span>`); // before sending, so it shows above the reply
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
  const tp = $("stTrust");
  if (tp) tp.hidden = !S.root || trusted() || !hasProjectCode();
  const kind = taskKind();
  const k = (id) => (keymap.label(id) ? ` (${keymap.label(id)})` : "");
  const acts = !kind ? [] : kind === "lust" ? ["run", "check", "build"] : kind === "html" || kind === "nodefile" || kind === "lua" ? ["run"] : kind === "node" ? ["run", "build", "test", "check", "scripts"].filter((a) => a === "scripts" || a === "run" || taskSteps(a)) : kind === "rust" ? ["run", "debug", "check", "test", "lint"] : kind === "dotnet" ? ["run", "debug", "build", "test"] : ["run", "debug", "scene", "build"].filter((a) => a === "debug" ? S.ctx?.dotnet : taskSteps(a));
  const id = { run: "task.run", build: "task.build", check: "task.check", test: "task.test", lint: "task.lint", scene: "task.scene", debug: "debug.start" };
  const hadFocus = $("stTasks").contains(document.activeElement) ? document.activeElement.dataset.task : null;
  $("stTasks").innerHTML = acts.map((a, i) => `<button data-task="${a}" class="${i === 0 ? "go" : ""}" title="${esc(taskLabel(a) + k(id[a]))}">${i === 0 ? '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1.2l7 3.8-7 3.8z" fill="currentColor"/></svg>' : ""}${esc(taskLabel(a))}</button>`).join("");
  if (hadFocus) $("stTasks").querySelector(`[data-task="${hadFocus}"]`)?.focus();
  $("stStop").hidden = !S.running;
  const lv = $("stLive");
  if (live.port && live.root !== S.root) stopLive(true); // another folder was opened in this window
  lv.hidden = !live.port && !(S.root && (hasAny(/\.html?$/i) || taskKind() === "html"));
  lv.classList.toggle("on", !!live.port);
  lv.textContent = live.port ? "Port " + live.port : "Go Live";
  lv.title = live.port ? `Live Server at localhost:${live.port}. Click to stop.` : "Serve this folder and reload the browser on save";
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
$("stIndent").addEventListener("click", pickIndent);
$("stTasks").addEventListener("click", (ev) => { const b = ev.target.closest("[data-task]"); if (b) (b.dataset.task === "debug" ? debug?.start() : runAction(b.dataset.task)); });
$("stStop").onclick = stopTask;
$("stLive").onclick = () => (live.port ? stopLive() : startLive());
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

// Zen mode: just the editor, full screen. The same key brings everything back.
let zen = null;
async function toggleZen() {
  const w = getCurrentWindow();
  if (!zen) {
    zen = { panel: S.panel, full: await w.isFullscreen().catch(() => false) };
    if (S.panel) { S.panel = false; renderPanel(); }
    $("app").classList.add("zen");
    if (!zen.full) w.setFullscreen(true).catch(() => {});
    toast(`Zen mode. ${keymap.label("view.zen") || "Toggle zen mode"} brings everything back.`);
  } else {
    $("app").classList.remove("zen");
    if (!zen.full) w.setFullscreen(false).catch(() => {});
    if (zen.panel && !S.panel) { S.panel = true; renderPanel(); }
    zen = null;
  }
  for (const p of panes) p.view?.requestMeasure();
  focusZone("editor");
}
function toggleExplorer(force) {
  prefs.collapsed = force != null ? !force : !prefs.collapsed;
  $("app").classList.toggle("collapsed", prefs.collapsed);
  savePrefs();
}

// ---------- appearance from settings ----------
function applyTheme() {
  if (settings.theme === "light" || settings.theme === "dark") document.documentElement.dataset.theme = settings.theme;
  else delete document.documentElement.dataset.theme;
  document.documentElement.dataset.code = settings.codeColours === "colourful" ? "colourful" : "quiet";
  document.documentElement.toggleAttribute("data-smooth-caret", !!settings.smoothCaret);
  document.documentElement.dataset.cursor = ["block", "underline"].includes(settings.cursorStyle) ? settings.cursorStyle : "line";
}
smoothScrolling(() => settings.smoothScroll && !matchMedia("(prefers-reduced-motion: reduce)").matches);
function applyFonts() {
  const r = document.documentElement.style;
  r.setProperty("--code-size", settings.fontSize + "px");
  r.setProperty("--code-font", settings.fontFamily ? `"${String(settings.fontFamily).replace(/"/g, "")}", var(--mono)` : "var(--mono)");
  if (settings.uiFont) r.setProperty("--sans", `"${String(settings.uiFont).replace(/"/g, "")}", "IBM Plex Sans", system-ui, "Segoe UI", sans-serif`);
  else r.removeProperty("--sans");
  r.setProperty("--ui-size", settings.uiSize + "px");
  view?.requestMeasure();
}
function reconfigureAll() {
  for (const [p, b] of S.bufs) dispatchBuf(p, { effects: cfg.reconfigure(cfgExt(b)) });
}
function applySetting(key) {
  if (key === "fileIcons") { renderTree(); renderTabs(); renderPaneHeads(); }
  if ((key === "luaVersion" || key === "luaServer") && started(servers.lua)) startServer("lua");
  if (key === "detectIndent") reconfigureAll();
  if (key === "theme" || key === "codeColours" || key === "smoothCaret" || key === "cursorStyle") applyTheme();
  if (["fontSize", "fontFamily", "uiFont", "uiSize"].includes(key)) applyFonts();
  if (key === "tabSize" || key === "wordWrap") reconfigureAll();
  if (key === "inlayHints") for (const p of S.bufs.keys()) refreshHints(p);
  if (key === "keys") { keymap.setOverrides(settings.keys); renderStatus(); }
  if ((key === "rustAnalyzer" || key === "rustCheck") && started(servers.rust)) startServer("rust");
  if ((key === "csharpServer" || key === "csharpArgs") && started(servers.csharp)) startServer("csharp");
  if (key === "godot") renderStatus();
  if (["bracketColors", "indentGuides", "stickyScroll", "colourSwatches", "emmet", "overviewRuler", "gitBlame", "codeLens", "gitGutter", "dependencyHints"].includes(key)) reconfigureExtras();
  if (key === "statusBar") applyStatusBar();
  if (["theme", "fontSize", "fontFamily"].includes(key)) requestAnimationFrame(() => term?.restyle());
  each(settingHooks, key);
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
  if (S.ptab === "output") outFollow().changed();
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
$("bClearOut").onclick = () => {
  if (S.ptab === "dconsole") { $("dconOut").innerHTML = ""; return; }
  $("out").innerHTML = "";
  outFollow().reset();
};
$("bClosePanel").onclick = () => { S.panel = false; renderPanel(); };

const OUT_MAX = 5000;
// The Output panel follows its last line until you scroll up (see follow.js).
let outFollowing = null;
function outFollow() { return (outFollowing ||= followBottom($("out"))); }
function appendOut(html) {
  const out = $("out");
  const d = document.createElement("div");
  d.innerHTML = html;
  out.append(d);
  while (out.childElementCount > OUT_MAX) out.firstElementChild.remove();
  if (!outQuiet) outFollow().changed();
  return d;
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
  if (!$("palOv").hidden) {
    // A question is waiting for an answer: Ctrl E or the command list don't replace it.
    if (pal.resolve && mode !== "choose" && mode !== "prompt") { $("palIn").hidden ? $("palRes").querySelector(".li")?.focus() : $("palIn").focus(); return; }
    finishPalette(null);
  }
  if (view) closeInfo(view);
  pal.mode = mode; pal.sel = 0; pal.list = []; pal.searchQ = null; pal.prevFocus = document.activeElement;
  $("palOv").hidden = false;
  $("palHead").textContent = head || (mode === "text" ? "Search in files" : "");
  // A question is read out with its options: the dialog is labelled by it.
  const box = $("palOv").firstElementChild;
  if ($("palHead").textContent) { box.setAttribute("aria-labelledby", "palHead"); box.removeAttribute("aria-label"); }
  else { box.removeAttribute("aria-labelledby"); box.setAttribute("aria-label", "Command palette"); }
  const inp = $("palIn");
  inp.hidden = mode === "choose" && !pal.filter;
  inp.value = init;
  inp.placeholder = mode === "choose" ? "Type to narrow the list" : mode === "text" ? "Text to find…" : mode === "files" ? "File name   ·   > commands   ·   : line   ·   @ symbol here   ·   # symbol anywhere" : "";
  if (mode === "files") loadFiles().then(() => { if (pal.mode === "files" && !$("palOv").hidden) drawPalette(); });
  drawPalette();
  if (mode === "choose" && !pal.filter) $("palRes").querySelector(".li")?.focus(); else { inp.focus(); inp.setSelectionRange(init.length, init.length); }
}
function finishPalette(value) {
  $("palOv").hidden = true;
  const r = pal.resolve;
  pal.resolve = null;
  if (r) r(value);
  if (pal.prevFocus?.focus && document.contains(pal.prevFocus)) pal.prevFocus.focus({ preventScroll: true });
}
// Questions take turns: one asked while another is open (a "changed on disk" from auto-save during
// "Save changes?", the trust question after a folder loads) waits for the first to be answered,
// instead of answering it with Cancel.
let dialogTurn = Promise.resolve();
function inTurn(open) {
  const p = dialogTurn.then(() => new Promise(open));
  dialogTurn = p.then(() => {}, () => {});
  return p;
}
function promptText(head, init = "", placeholder = "") {
  return inTurn((resolve) => {
    openPalette("prompt", init, head);
    $("palIn").placeholder = placeholder;
    $("palIn").select();
    pal.resolve = resolve;
  });
}
/** Resolves to the chosen label (or its index with wantIndex), or null. */
/** Pick one of `options`. Lists of names (branches, bookmarks) pass { filter: true } for a box to
 *  type in (so typing "b2" finds b2 instead of picking the second row); long lists get one anyway. */
function choose(head, options, wantIndex = false, opts = {}) {
  return inTurn((resolve) => {
    pal.options = options;
    pal.wantIndex = wantIndex;
    pal.filter = opts.filter ?? options.length > 8;
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
const fdot = (path) => ({ dot: dotOf(path), path }); // a palette row for a file: its icon
const row = (i, dot, title, meta, extra, code) =>
  `<div class="li" role="option" id="pal-opt-${i}" tabindex="-1" data-pi="${i}" aria-selected="${i === pal.sel}" style="--tc:var(--t-${dot.dot || dot})">${dot.path ? mark(dot.path) : '<span class="dot"></span>'}<span class="t">${title}</span><span class="m">${meta}</span>${extra ? `<span class="x${code ? " code" : ""}">${extra}</span>` : ""}</div>`;

function drawPalette() {
  const v = $("palIn").value, res = $("palRes");
  let html = "";
  if (pal.mode === "prompt") { res.innerHTML = ""; return; }
  if (pal.mode === "choose") {
    const q = pal.filter ? v.trim().toLowerCase() : "";
    pal.list = pal.options.map((o, i) => ({ choice: o, i, score: q ? fuzzy(q, o) : 0 })).filter((x) => x.score >= 0);
    if (q) pal.list.sort((a, b) => b.score - a.score);
    html = pal.list.map((o, j) => row(j, o.i === 0 ? "rs" : "other", q ? hlText(o.choice, q) : esc(o.choice), !pal.filter && j < 9 ? `<kbd>${j + 1}</kbd>` : "", "")).join("") || '<p class="empty" style="padding:8px 10px">Nothing matches.</p>';
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
    html = pal.list.map((h, i) => row(i, fdot(h.path), esc(rel(h.path)) + `<span style="color:var(--faint)">:${h.line + 1}</span>`, "", hlText(h.text.trim(), q.trim()), true)).join("")
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
    html = has ? (pal.list.length ? row(0, fdot(S.active), `Go to line ${Math.min(l, total)}${c ? `, column ${c}` : ""}`, "", "") : `<p class="empty" style="padding:8px 10px">Type a line number, 1 to ${total}.</p>`) : '<p class="empty" style="padding:8px 10px">Open a file first.</p>';
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
    html = pal.list.map((f, i) => { const r = rel(f.path), d = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : ""; return row(i, fdot(f.path), hlText(base(f.path), q.split(/\s+/).pop()), esc(d), ""); }).join("")
      || `<p class="empty" style="padding:8px 10px">${S.root ? (S.files ? "No files match." : "Loading files…") : "Open a folder first."}</p>`;
  }
  pal.sel = Math.min(pal.sel, Math.max(0, pal.list.length - 1));
  res.innerHTML = html;
  if (res.querySelector("#pal-opt-" + pal.sel)) $("palIn").setAttribute("aria-activedescendant", "pal-opt-" + pal.sel); else $("palIn").removeAttribute("aria-activedescendant");
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
  if (pal.mode === "choose" && !pal.filter && /^[1-9]$/.test(k) && +k <= pal.list.length) { ev.preventDefault(); pick(+k - 1); return; }
  if (k === "Down" || k === "Up" || (pal.mode === "choose" && (k === "Tab" || k === "Shift+Tab"))) {
    ev.preventDefault();
    const d = k === "Up" || k === "Shift+Tab" ? -1 : 1;
    pal.sel = Math.max(0, Math.min(pal.list.length - 1, pal.sel + d));
    $("palRes").querySelectorAll(".li").forEach((el, i) => el.setAttribute("aria-selected", i === pal.sel));
    $("palIn").setAttribute("aria-activedescendant", "pal-opt-" + pal.sel);
    const cur = $("palRes").querySelector('[aria-selected="true"]');
    cur?.scrollIntoView({ block: "nearest" });
    if (pal.mode === "choose" && !pal.filter) cur?.focus();
  }
  if (k === "Enter") { ev.preventDefault(); pick(pal.sel); }
});
$("palRes").addEventListener("click", (ev) => { const r = ev.target.closest("[data-pi]"); if (r) pick(+r.dataset.pi); });
$("palOv").addEventListener("mousedown", (ev) => { if (ev.target === $("palOv")) finishPalette(null); });
// While a dialog is open, focus stays in it: a page that finishes loading behind it (an image,
// a table) can't pull the keyboard away, which would leave Esc and the arrows going elsewhere.
document.addEventListener("focusin", (ev) => {
  const ov = $("palOv");
  if (ov.hidden || ov.contains(ev.target)) return;
  (($("palIn").hidden ? null : $("palIn")) || $("palRes").querySelector('.li[aria-selected="true"]') || $("palRes").querySelector(".li"))?.focus();
});

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
C("app.update", "Check for updates", [], () => updater?.check());
C("panel.dock", "Move the panel (terminal, output) to the right or the bottom", [], togglePanelDock);
C("lust.lua", "Lust: show the Lua this file turns into", [], () => runAction("lua"));
C("lust.rust", "Lust: show the Rust this file turns into (.lst)", [], () => runAction("rust"));
C("view.zen", "Toggle zen mode (just the editor, full screen)", "Ctrl+Alt+Z", toggleZen);
C("view.wrap", "Toggle word wrap (long lines wrap onto the next line)", "Alt+Z", () => { setSetting("wordWrap", !settings.wordWrap); toast(settings.wordWrap ? "Long lines wrap." : "Long lines run on; scroll sideways to see them."); });
C("tab.pin", "Pin or unpin this tab", [], () => togglePin());
C("tab.closeSaved", "Close saved tabs (unsaved and pinned stay)", [], () => closeSavedTabs());
C("tab.closeAll", "Close all tabs (asks about unsaved ones)", [], () => closeAllTabs());
C("trust.toggle", "Trust this folder, or go back to restricted mode", [], () => {
  if (!S.root) return;
  const yes = !trusted();
  setTrust(S.root, yes);
  toast(yes ? `${base(S.root)} is trusted: its code can run (Run, Build, Test, Debug, Rust, C# and Lua analysis).` : `${base(S.root)} is in restricted mode: none of its code runs.`, 5000);
});
C("file.eol", "Change line endings (CRLF or LF)", [], async () => {
  const b = S.bufs.get(S.active);
  if (!b || b.virtual || b.ro) return;
  const c = await choose(`Line endings for ${base(S.active)} (now ${b.eol === "\r\n" ? "CRLF, Windows" : "LF"})`, ["LF (Linux, macOS, most tools)", "CRLF (Windows)"]);
  if (!c) return;
  const eol = c.startsWith("CRLF") ? "\r\n" : "\n";
  if (eol === b.eol && !b.mixedEol) return;
  b.eol = eol; b.mixedEol = false; b.dirty = true;
  scheduleUi(); renderPos();
  toast(`Saving will write ${eol === "\r\n" ? "CRLF" : "LF"} line endings.`);
});
C("file.toUtf8", "Convert this file to UTF-8 (from UTF-16 or Windows-1252)", [], async () => {
  const b = S.bufs.get(S.active);
  if (!b || b.virtual) return;
  if (!b.enc || b.enc === "utf8") { toast("This file is UTF-8 already."); return; }
  const was = b.enc;
  b.enc = "utf8";
  let text = b.state.doc.toString();
  if (b.eol === "\r\n") text = text.replace(/\n/g, "\r\n");
  try { await invoke("write_file", { path: S.active, contents: (b.bom ? "\uFEFF" : "") + text, encoding: "utf8" }); b.mtime = await statOf(S.active); b.saved = b.state.doc; b.dirty = false; scheduleUi(); }
  catch (e) { b.enc = was; toast(`Couldn't convert it: ${e}`); return; }
  renderPos();
  toast(`${base(S.active)} is UTF-8 now (saved, with any edits you had).`);
});
C("live.toggle", "Live Server: start or stop", [], () => (live.port ? stopLive() : startLive()));
C("live.open", "Live Server: open this page in the browser", [], openLive);
C("task.scripts", "Run a package.json script…", [], () => runAction("scripts"));
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
  if (e.target.closest?.(".terms") && /^Ctrl\+Shift\+[CV]$/.test(k)) return; // the terminal's own copy and paste
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
// Links to websites open in the normal browser; local dev servers in the one picked in Settings.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href^='http']");
  if (!a) return;
  e.preventDefault();
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[:/]/.test(a.href);
  (local ? openInBrowser(a.href.replace("//0.0.0.0", "//localhost")) : openUrl(a.href)).catch(() => toast("Couldn't open the browser."));
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
  document.documentElement.style.setProperty("--panel-w", (prefs.panelW || 600) + "px");
  const right = prefs.panelDock === "right";
  document.querySelector(".main").classList.toggle("dock-right", right);
  const t = right ? "Move the panel to the bottom" : "Move the panel to the right";
  $("bDockPanel").title = t; $("bDockPanel").setAttribute("aria-label", t);
};
function togglePanelDock() {
  prefs.panelDock = prefs.panelDock === "right" ? "bottom" : "right";
  savePrefs();
  applySizes();
  if ($("panel").hidden) showPanel("terminal");
}
$("bDockPanel").onclick = togglePanelDock;
drag($("sideSplit"), (e) => { prefs.sideW = Math.max(170, Math.min(600, e.clientX)); applySizes(); });
drag($("panelSplit"), (e) => {
  if (prefs.panelDock === "right") {
    const r = document.querySelector(".main").getBoundingClientRect();
    prefs.panelW = Math.round(Math.max(240, Math.min(r.width - 300, r.right - e.clientX)));
    applySizes();
    return;
  }
  prefs.panelH = Math.max(80, Math.min(innerHeight - 160, innerHeight - (settings.statusBar === "top" ? 0 : 28) - e.clientY)); applySizes(); });
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
// ---------- folder trust (restricted mode) ----------
// A folder you haven't trusted can't make Ledger run its code: no Rust, C# or Lua analysis (they
// load the project), no Run, Build, Test or Debug, no project tools (its Tailwind, its Prettier),
// and Git without the repository's hooks. Editing, search, Git and the HTML, CSS, JSON and
// TypeScript help (with the computer's own TypeScript) work either way. The answer is kept per
// folder, and the backend (src-tauri/src/trust.rs) enforces it. Projects made in Ledger are trusted.
const trusted = () => !!S.root && (prefs.trust || {})[S.root] === true;
const trustHooks = [];
const hasProjectCode = () => hasAny(/^(package\.json|Cargo\.toml|project\.godot|\.luarc\.json|.*\.(csproj|sln|slnx|fsproj))$/i) || S.isRepo;
function setTrust(root, yes) {
  prefs.trust = { ...(prefs.trust || {}), [root]: yes };
  savePrefs();
  if (root !== S.root) return;
  invoke("set_window_trust", { trusted: yes }).catch(() => {});
  // Servers that waited for trust start now (TypeScript again, with the project's own TypeScript);
  // ones that load the project stop when trust is taken back.
  for (const id of ["rust", "csharp", "lua", "web"]) {
    const srv = servers[id];
    if (yes) {
      const was = srv.state?.text === "restricted";
      if (was) srv.setStatus("", false);
      if ((was || (id === "web" && started(srv))) && [...S.bufs.values()].some((b) => LANGS[b.lang].server === id)) startServer(id);
    } else if ((NEEDS_TRUST.has(id) || (id === "web" && !globalTs)) && (started(srv) || srv.starting)) { srv.stop(); srv.setStatus("restricted", false, false, ""); }
    else if (id === "web" && started(srv)) startServer(id); // back to the computer's TypeScript
  }
  if (yes) startProjectServers();
  for (const f of trustHooks) { try { f(yes); } catch (e) { console.error(e); } }
  if (yes) tailwindWarm();
  renderStatus();
}
async function askTrust(path, force) {
  if (!path || (!force && (prefs.trust || {})[path] !== undefined) || (!force && !hasProjectCode())) return trusted();
  const c = await choose(`Do you trust the code in ${base(path)}? Trusting lets Ledger run it: Run, Build, Test and Debug, Rust, C# and Lua analysis, and the project's own Tailwind and Prettier. Without trust the folder opens in restricted mode: you can read, edit, search and commit, but none of its code runs. Trust only folders whose code you'd run yourself.`, ["Trust it", "Stay in restricted mode"]);
  if (c === "Trust it" || c === "Stay in restricted mode") setTrust(path, c === "Trust it");
  return trusted();
}
/** Before running the project's code: asks for trust if needed. True when it may run. */
async function ensureTrusted(what) {
  if (!S.root || trusted()) return true;
  const c = await choose(`${what} runs this folder's code, and ${base(S.root)} isn't trusted yet. Trust it?`, ["Trust it", "Cancel"]);
  if (c !== "Trust it") return false;
  setTrust(S.root, true);
  return true;
}
const isUntrustedError = (e) => String(e).startsWith("untrusted");
function startProjectServers(path = S.root) {
  if (S.proj.rust || hasAny(/^Cargo\.toml$/)) startServer("rust");
  if (S.proj.dotnet || hasAny(/\.(csproj|slnx?)$/i)) startServer("csharp");
  warmServers(path);
}
// The other language servers start with the folder too, when it has their kind of file and the
// server is installed (no "not installed" warnings for folders that don't need one), so their
// warm-up is done before the first file opens.
function warmServers(root) {
  const want = [["web", /\.(m?[jt]sx?|cjs)$/i], ["html", /\.html?$/i], ["css", /\.(s?css|less)$/i], ["lua", /\.lua$/i], ["json", /\.json$/i]];
  for (const [id, re] of want) {
    if (started(servers[id]) || servers[id].starting || !hasAny(re)) continue;
    invoke("tool_info", { name: serverSpec(id).exe }).then((found) => {
      if (found && S.root === root && !started(servers[id]) && !servers[id].starting) startServer(id);
    }, () => {});
  }
}
async function openFolderNow(path) {
  if (!path) {
    const p = await openDialog({ directory: true, multiple: false, title: "Open folder" });
    if (!p) return false;
    path = p;
  }
  path = norm(path).replace(/(.)\/$/, "$1").replace(/^([A-Za-z]:)$/, "$1/"); // "C:" alone is the drive's current folder, not its root
  if (S.root === path) return true;
  if (await invoke("focus_window_with", { root: path }).catch(() => false)) { toast(`${base(path) || path} is already open in another window.`); return false; }
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
  invoke("set_window_root", { root: path, trusted: (prefs.trust || {})[path] === true }).catch(() => {});
  each(folderHooks, path);
  const sess = prefs.sessions[path];
  await loadDir(path);
  detectProject();
  if (sess) for (const d of sess.open || []) S.open.add(d);
  else if (S.kids.get(path)?.some((k) => k.dir && k.name === "src")) S.open.add(join(path, "src"));
  await Promise.all([...S.open].map(loadDir));
  renderMain();
  renderProblems();
  S.ctx = null;
  loadFiles().then(async () => {
    if (S.root !== path) return;
    S.isRepo = !!(await invoke("file_stats", { paths: [join(path, ".git")] }).catch(() => [null]))[0];
    if (S.root !== path) return;
    startProjectServers(path);
    updateCtx();
    renderStatus();
    askTrust(path);
  });
  // Restoring tabs is async; if something else opened a file meanwhile (say,
  // Godot sending one), leave that file in front.
  S.pinned = new Set(sess?.pinned || []);
  S.preview = null;
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
  stopLive(true);
  S.root = null; S.kids.clear(); S.open.clear(); S.diags.clear(); S.files = null;
  S.proj = { rust: false, dotnet: false, godot: false, sln: null, csproj: null };
  S.ctx = null;
  prefs.last = null; savePrefs();
  $("rootName").textContent = "EXPLORER";
  getCurrentWindow().setTitle(APP_NAME).catch(() => {});
  invoke("set_window_root", { root: null }).catch(() => {});
  each(folderHooks, null);
  renderMain(); renderProblems();
}
async function newProject() {
  const kinds = ["Web app with Vite (React, Vue, Svelte…)", "Next.js app", "Website (plain HTML, CSS and JS)", "Node.js program", "Lua program", "Lust program", "LustScript (.lsc, turns into Lua)", "Rust program", "Rust library", "C# console app", "C# class library"];
  const i = await choose("What kind of project?", kinds, true);
  if (i == null || i < 0) return;
  let kind = ["vite", "next", "web", "node", "lua", "lust", "lustscript", "rust", "rust-lib", "console", "classlib"][i];
  if (kind === "lust") {
    // Every Lust program can have a view; this only picks the starting point.
    const w = await choose("Start with a window?", ["Yes: a window, with a piece of it in ui/", "No: a plain program"], true);
    if (w == null || w < 0) return;
    if (w === 0) kind = "lust-app";
  }
  let web = null;
  if (kind === "vite" || kind === "next") {
    web = { kind };
    if (kind === "vite") {
      const f = await choose("Which framework?", VITE.map(([n]) => n), true);
      if (f == null || f < 0) return;
      web.template = VITE[f][1];
    }
    const l = await choose("Which language?", ["TypeScript", "JavaScript"], true);
    if (l == null || l < 0) return;
    web.ts = l === 0;
    const tw = await choose("Add Tailwind CSS?", ["Yes", "No"], true);
    if (tw == null || tw < 0) return;
    web.tailwind = tw === 0;
  }
  // With a folder open (a course folder, say), new projects go inside it by default.
  let dir = null;
  if (S.root) {
    const where = await choose("Where should it go?", [`Inside ${base(S.root)}`, "Somewhere else…"], true);
    if (where == null) return;
    if (where === 0) dir = S.root;
  }
  dir ??= await openDialog({ directory: true, multiple: false, title: "Where should the project go?" });
  if (!dir) return;
  dir = norm(dir);
  const label = web ? (kind === "next" ? "Next.js" : VITE.find(([, t]) => t === web.template)[0]) + " app" : kinds[i];
  const name = (await promptText(`New ${label} in ${base(dir)}`, "", web ? "project name, like my-app" : "project name, like hello_world"))?.trim();
  if (!name) return;
  if (web ? !/^[a-z0-9][a-z0-9._-]*$/.test(name) : !/^[A-Za-z][\w-]*$/.test(name)) {
    toast(web ? "Web app names use lowercase letters, numbers, - . and _ (npm's rule)." : "Use letters, numbers, - and _ only, starting with a letter.", 5000);
    return;
  }
  if (web) { await newWebProject({ ...web, name, dir }); return; }
  // Lust programs and apps come from lust new itself when lust is installed, so they always match
  // the Lust you have (and lust new gets built programs ready on this PC).
  if ((kind === "lust" || kind === "lust-app") && (await invoke("tool_info", { name: settings.lust || "lust" }).catch(() => null))) {
    const at = join(dir, name);
    startSteps([{ label: "lust new", program: settings.lust || "lust", args: ["new", name, ...(kind === "lust-app" ? ["app"] : [])], cwd: dir, scaffold: true }],
      () => openNewProject(at, "main.lst", null));
    return;
  }
  const MAIN = { lust: "main.lst", "lust-app": "main.lst", lustscript: "main.lsc", rust: "src/main.rs", "rust-lib": "src/lib.rs", console: "Program.cs", classlib: "Class1.cs", web: "index.html", node: "index.js", lua: "main.lua" };
  const plain = !["rust", "rust-lib", "console", "classlib"].includes(kind); // no language server to start
  try {
    const p = norm(await invoke("new_project", { parent: dir, name, kind }));
    await openNewProject(p, MAIN[kind], plain ? null : kind.startsWith("rust") ? "rust" : "csharp");
  } catch (e) { toast(String(e), 6000); }
}
// Opens a project that was just made: inside the open folder, or as the folder.
async function openNewProject(p, main, server) {
  prefs.trust = { ...(prefs.trust || {}), [p]: true }; // made here, so its code is yours
  savePrefs();
  if (S.root && isUnder(p, S.root)) {
    await revealInTree(join(p, main));
    S.open.add(p);
    await refreshTree();
    if (server) startServer(server);
    await openFile(join(p, main), null, { quiet: true });
    revealInTree(join(p, main));
    toast(`Created ${base(p)}. Run, Build and Test use the project of the file you have open.`, 4000);
  } else if (await openFolder(p)) {
    await openFile(join(p, main), null, { quiet: true });
    revealInTree(join(p, main));
  }
}
// Vite and Next.js: the official create commands, shown in Output, then Tailwind and the first file.
async function newWebProject(o) {
  const at = join(o.dir, o.name);
  if ((await invoke("file_stats", { paths: [at] }).catch(() => [null]))[0] != null) { toast(`There's already something called ${o.name} there.`); return; }
  const steps = createSteps(o).map((s) => ({ ...s, scaffold: true })); // making a project, not running one
  if (!(await haveTools(steps, () => newWebProject(o)))) return;
  startSteps(steps, async () => {
    try {
      if (o.kind === "vite" && o.tailwind) {
        const cfgs = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"].map((f) => join(at, f));
        const cfg = cfgs[(await invoke("file_stats", { paths: cfgs })).findIndex((x) => x != null)];
        const old = cfg ? await invoke("read_file", { path: cfg }) : "";
        await invoke("write_file", { path: cfg || join(at, o.ts ? "vite.config.ts" : "vite.config.js"), contents: withTailwindPlugin(old) });
        const cssPaths = CSS_FILES.map((f) => join(at, f));
        const css = cssPaths[(await invoke("file_stats", { paths: cssPaths })).findIndex((x) => x != null)];
        if (css) await invoke("write_file", { path: css, contents: '@import "tailwindcss";\n\n' + (await invoke("read_file", { path: css })) });
      }
      const firsts = FIRST_FILES.map((f) => join(at, f));
      const first = FIRST_FILES[(await invoke("file_stats", { paths: firsts })).findIndex((x) => x != null)] || "package.json";
      await openNewProject(at, first, null);
      toast("Ready. F5 starts the dev server.", 5000);
    } catch (e) { toast("The project was made, but setting it up didn't finish: " + e, 6000); }
  });
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
  command: (...a) => C(...a), setSetting, toast, choose, promptText, copy,
  showPanel, focusPanel, focusZone, currentZone, showSideView, sideViews, get sideView() { return sideView; },
  openFile, activate, addTab, save, saveAll, startSteps, appendOut, renderTabs, renderMain, renderStatus, scheduleUi,
  dispatchBuf, serverOf, needServer, syncDoc, renderMd, hl, norm, rel, base, parent, join, isUnder, isAbs, esc, splitArgs,
  highlightInto, loadFiles, fileIcon: (p) => (fileIcons() ? iconHtml(p) : '<span class="dot"></span>'), pages, palModes, extraExt, folderHooks, editorTheme: theme, renderTreeSoon: scheduleUi, showMenu, reloadClean, refreshTree, activeHooks, saveHooks, readyHooks, applyWorkspaceEdit, closeInfo, setInfo: showInfoAt, bufListeners, decorationCopiers, focusListeners, settingHooks, statusItems: [], scrollMarks: [], openers,
  cwd: () => S.ctx?.dir || S.root || "",
  trusted: () => trusted(),
  ensureTrusted, isUntrustedError, askTrust, trustHooks,
  indentOf,
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
// Updating from the main window: the other windows report and save their unsaved files.
let askSeq = 0;
function askWindows(event, payload, ms, expect = Infinity) {
  const id = winLabel + ":" + ++askSeq, got = [];
  return new Promise((resolve) => {
    let un = null, timer = 0;
    const finish = () => { clearTimeout(timer); un?.(); resolve(got); };
    listen(event + "-reply", (e) => { if (e.payload?.id === id) { got.push(e.payload); if (got.length >= expect) finish(); } }).then((u) => {
      un = u;
      emit(event, { ...payload, id, from: winLabel }).catch(() => {});
      timer = setTimeout(finish, ms);
    });
  });
}
listen("update-query", (e) => {
  if (e.payload?.from === winLabel) return;
  emit("update-query-reply", { id: e.payload.id, label: winLabel, dirty: dirtyPaths().map(base) }).catch(() => {});
});
listen("update-prepare", async (e) => {
  if (e.payload?.from === winLabel) return;
  saveSession();
  const ok = !e.payload.save || !dirtyPaths().length || (await saveAll());
  if (ok) for (const b of S.bufs.values()) b.dirty = false; // restarting: no "unsaved changes" question on the way out
  emit("update-prepare-reply", { id: e.payload.id, label: winLabel, ok }).catch(() => {});
});
listen("settings-changed", (e) => { if (e.payload?.from !== winLabel) reloadSettingsFromFile(true); });
async function boot() {
  await loadSettings();
  settingsFile = norm(await invoke("settings_path").catch(() => "")) || null;
  initSettings({
    keymap, apply: applySetting, toast, choose, appName: APP_NAME,
    // Installing tools (winget, npm -g, cargo install) runs no project code.
    runTask: (program, args, label, done, fail) => startSteps([{ label, program, args, scaffold: true }], done, fail),
    restartServer: (id) => (S.root ? startServer(id) : toast("Open a folder first.")),
    stopServer: (id) => servers[id].stop(),
    openFile: (p) => openFile(norm(p)),
    saved: () => emit("settings-changed", { from: winLabel }).catch(() => {}),
    editSnippets: () => snippets?.edit(),
    installDebugger: (kind) => debug?.install(kind),
    debuggerFor: async (kind) => debug?.adapterPath(kind),
    checkUpdate: () => updater?.check(),
  });
  updater = initUpdate({
    $, toast, settings, isMain: winLabel === "main",
    // Ledger restarts to update: every window's unsaved work is asked about and saved first, then
    // everything Ledger started is ended (the installer closes Ledger without the usual exit).
    beforeInstall: async () => {
      saveSession();
      await new Promise((r) => setTimeout(r, 400)); // saveSession writes after a short delay
      const others = await askWindows("update-query", {}, 800);
      const mine = dirtyPaths();
      const names = [...mine.map(base), ...others.flatMap((r) => r.dirty || [])];
      let keep = true;
      if (names.length) {
        const wins = (mine.length ? 1 : 0) + others.filter((r) => r.dirty?.length).length;
        const where = wins > 1 ? ` (in ${wins} windows)` : others.some((r) => r.dirty?.length) ? " in another window" : "";
        const c = await choose(`Save changes to ${names.length === 1 ? names[0] : names.length + " files"}${where} before Ledger restarts?`, ["Save all and restart", "Restart without saving", "Cancel"]);
        if (!c || c === "Cancel") return false;
        keep = c === "Save all and restart";
      }
      if (keep && mine.length && !(await saveAll())) return false;
      if (others.length) {
        const done = await askWindows("update-prepare", { save: keep }, 30000, others.length);
        if (done.length < others.length || done.some((r) => !r.ok)) { toast("Another window couldn't save its files, so Ledger didn't restart. Save them there, then try again.", 8000); return false; }
      }
      await invoke("stop_everything").catch(() => {});
      return true;
    },
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
  initGitMore(app, initGit(app));
  initDb(app);
  initImages(app);
  initMarkdown(app);
  initTests(app);
  initColours(app);
  initPrettier(app, formatters);
  initEmmet(app);
  initMarks(app);
  initTodo(app);
  initCsv(app);
  initHex(app);
  initHistory(app);
  debug = app.debug = initDebugger(app);
  view = panes[0].view = new EditorView({ parent: $("editor") });
  panes[0].el.classList.add("focused");
  renderMain();
  renderPanel();
  renderProblems();

  let focusT = null;
  // Coming back to Ledger looks for files changed meanwhile; the whole-folder walk at most every
  // 10 seconds, so Alt-Tabbing in a big repository stays cheap.
  let lastWalk = 0;
  window.addEventListener("focus", () => { clearTimeout(focusT); focusT = setTimeout(() => { reloadClean(); if (S.root && Date.now() - lastWalk > 10000) { lastWalk = Date.now(); refreshTree(); } }, 150); });
  setInterval(() => { if (document.hasFocus()) reloadClean(); }, 3000);
  window.addEventListener("blur", () => { if (settings.autoSave === "focus") saveAll(); });

  try {
    getCurrentWindow().onCloseRequested(async (ev) => {
      const pages = S.tabs.filter((k) => isPage(k) && pageOf(k)?.confirmClose);
      if (pages.length) {
        ev.preventDefault();
        for (const k of pages) if (!(await pageOf(k).confirmClose(k))) return;
        for (const k of pages) pageOf(k)?.close?.(k);
        S.tabs = S.tabs.filter((k) => !pages.includes(k));
        if (!dirtyPaths().length) { getCurrentWindow().destroy(); return; }
      }
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
