// Settings: stored as settings.json in the app's config folder and shown as a
// page in a tab (Ctrl+P). Everything on the page works from the keyboard.
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { keyString, showKey } from "./keys.js";
import { esc } from "./ansi.js";

export const DEFAULTS = {
  theme: "system",
  fontSize: 14,
  fontFamily: "",
  uiFont: "",
  uiSize: 14,
  statusBar: "bottom",
  codeColours: "quiet",
  wordWrap: false,
  bracketColors: true,
  indentGuides: true,
  stickyScroll: true,
  smoothCaret: true,
  cursorStyle: "line",
  smoothScroll: true,
  codeLens: true,
  gitGutter: true,
  dependencyHints: true,
  inlayHints: true,
  tabSize: 4,
  formatOnSave: false,
  autoSave: "off",
  rustAnalyzer: "rust-analyzer",
  rustCheck: "check",
  csharpServer: "csharp-ls",
  csharpArgs: "",
  godot: "",
  lust: "lust",
  terminalShell: "",
  debugRust: "",
  debugCsharp: "",
  keys: {},
};

export const settings = structuredClone(DEFAULTS);
let ctx = null; // { keymap, apply(key), runTask(program, args, label), toast, restartServer(id), appName }
let recording = null;
let filter = "";
let saveT = null;
let tools = {};
let exe = "";

export const isRecording = () => !!recording;

/** strict: throw on a broken file instead of ignoring it (used after editing settings.json). */
export async function loadSettings(strict = false) {
  try {
    const raw = await invoke("settings_read");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (strict) { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, structuredClone(DEFAULTS)); }
      Object.assign(settings, parsed);
    }
  } catch (e) { if (strict) throw e; }
  settings.keys = settings.keys || {};
  return settings;
}

// Only the keys this window changed are written over what's in the file, so
// two windows changing different settings don't undo each other.
const changed = new Set();
function save(all) {
  if (all) for (const k of Object.keys(settings)) changed.add(k);
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    let onDisk = {};
    try { onDisk = JSON.parse((await invoke("settings_read")) || "{}"); } catch {}
    for (const k of changed) onDisk[k] = settings[k];
    changed.clear();
    invoke("settings_write", { json: JSON.stringify({ ...structuredClone(DEFAULTS), ...onDisk }, null, 2) }).then(() => ctx?.saved?.(), (e) => ctx?.toast("Couldn't save settings: " + e));
  }, 250);
}

export function setSetting(key, value) {
  settings[key] = value;
  changed.add(key);
  save();
  ctx?.apply(key);
}

export function initSettings(c) { ctx = c; }

export const refreshSettingsTools = () => refreshTools();

async function refreshTools() {
  const names = { cargo: "cargo", ra: settings.rustAnalyzer || "rust-analyzer", dotnet: "dotnet", cs: settings.csharpServer || "csharp-ls", godot: settings.godot, git: "git", lust: settings.lust || "lust" };
  const out = {};
  await Promise.all(Object.entries(names).map(async ([k, n]) => { out[k] = n ? await invoke("tool_info", { name: n }).catch(() => null) : null; }));
  out.lldb = await ctx.debuggerFor?.("rust").catch(() => null);
  out.netcoredbg = await ctx.debuggerFor?.("csharp").catch(() => null);
  tools = out;
  try { exe = await invoke("exe_path"); } catch {}
}

// ---------- page ----------
const row = (label, control, hint = "", id = "") =>
  `<div class="srow"><label class="sl"${id ? ` for="${id}"` : ""}>${label}</label><div class="sc">${control}${hint ? `<div class="hint">${hint}</div>` : ""}</div></div>`;
const select = (id, key, opts) =>
  `<select id="${id}" data-set="${key}">${opts.map(([v, l]) => `<option value="${esc(v)}"${String(settings[key]) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const check = (id, key, label) => `<label class="chk"><input type="checkbox" id="${id}" data-set="${key}"${settings[key] ? " checked" : ""}> ${label}</label>`;
const text = (id, key, ph = "", type = "text", extra = "") => `<input type="${type}" id="${id}" data-set="${key}" value="${esc(settings[key] ?? "")}" placeholder="${esc(ph)}" spellcheck="false" ${extra}>`;
const found = (p, missing) => (p ? `<span class="ok">Found</span> <code>${esc(p)}</code>` : `<span class="bad">Not found.</span> ${missing}`);
const copyRow = (label, value) =>
  `<div class="copyrow"><span class="k">${label}</span><code>${esc(value)}</code><button class="btn" data-copy="${esc(value)}">Copy</button></div>`;

export function settingsHtml() {
  const km = ctx.keymap;
  const flags = "{project} --goto {file}:{line}:{col}";
  const csFlags = "{project} --goto0 {file}:{line}:{col}"; // Godot's C# setting counts lines from 0
  const q = filter.trim().toLowerCase();
  const cmds = km.list().filter((c) => !c.hidden && (!q || c.title.toLowerCase().includes(q) || km.keysFor(c.id).join(" ").toLowerCase().includes(q)));
  return `<div class="wi settings">
        <h1>Settings</h1>
    <p class="lede">Changes apply right away. Tab moves between fields; Ctrl+W closes this page.</p>

    <section aria-labelledby="sAppear"><h2 id="sAppear">Appearance</h2>
      ${row("Theme", select("sTheme", "theme", [["system", "Match Windows"], ["light", "Light"], ["dark", "Dark"]]), "", "sTheme")}
      ${row("Editor font size", text("sFont", "fontSize", "14", "number", 'min="9" max="32" step="0.5"'), "Ctrl + and Ctrl - change it too; Ctrl 0 resets.", "sFont")}
      ${row("Editor font", text("sFamily", "fontFamily", "IBM Plex Mono", "text", 'list="codeFonts"') + `<datalist id="codeFonts">${["Noto Sans Mono", "Noto Sans", "Cascadia Code", "Consolas", "JetBrains Mono", "Fira Code"].map((f) => `<option value="${f}">`).join("")}</datalist>`, "Pick one or type any installed font. Fonts made for code (Mono) keep columns lined up. Leave empty for the default.", "sFamily")}
      ${row("Interface font", text("sUiFont", "uiFont", "IBM Plex Sans", "text", 'list="uiFonts"') + `<datalist id="uiFonts">${["Noto Sans", "Segoe UI", "Inter", "Arial"].map((f) => `<option value="${f}">`).join("")}</datalist>`, "The menus, tabs, side bar and settings. Pick one or type any installed font. Leave empty for the default.", "sUiFont")}
      ${row("Interface text size", text("sUi", "uiSize", "14", "number", 'min="11" max="20" step="0.5"'), "", "sUi")}
      ${row("Code colours", select("sCode", "codeColours", [["quiet", "Quiet, like Lust"], ["colourful", "Colourful"]]), "Quiet keeps code calm: keywords in red, classes in blue, types in a soft green, values in gold and constants in teal, with the rest plain. Lust files are always quiet.", "sCode")}
      ${row("Status bar", select("sStatus", "statusBar", [["bottom", "Along the bottom"], ["top", "Along the top"]]), "The bar with Run, Build, problems and the cursor position.", "sStatus")}
    </section>

    <section aria-labelledby="sEdit"><h2 id="sEdit">Editing</h2>
      ${row("Tab size", select("sTab", "tabSize", [[2, "2 spaces"], [4, "4 spaces"], [8, "8 spaces"]]), "", "sTab")}
      ${row("Wrapping", check("sWrap", "wordWrap", "Wrap long lines"))}
      ${row("Type hints", check("sHints", "inlayHints", "Show the types and parameter names the language server works out, in grey"), "They aren't part of your file. Rust and C# only.")}
      ${row("Formatting", check("sFmt", "formatOnSave", "Format Rust and C# files when saving"))}
      ${row("Auto save", select("sAuto", "autoSave", [["off", "Off"], ["delay", "A second after typing stops"], ["focus", "When switching tabs or apps"]]), "", "sAuto")}
      ${row("Brackets", check("sBr", "bracketColors", "Colour matching bracket pairs by depth"))}
      ${row("Indentation", check("sIg", "indentGuides", "Show indent guides"))}
      ${row("Sticky scroll", check("sSticky", "stickyScroll", "Keep the lines that open the current block (fn, impl, class…) pinned at the top while scrolling"))}
      ${row("Cursor", select("sCursor", "cursorStyle", [["line", "Line"], ["chevron", "Ledger Cursor ›"], ["block", "Block"], ["underline", "Underline"]]), "The Ledger Cursor is the red › from Ledger's icon.", "sCursor")}
      ${row("Smooth cursor", check("sSmoothCaret", "smoothCaret", "The cursor fades in and out, and glides when it moves"))}
      ${row("Smooth scrolling", check("sSmoothScroll", "smoothScroll", "Ease each mouse wheel step instead of jumping"), "Touchpads already scroll smoothly, so they're left as they are.")}
      ${row("Run and Debug links", check("sLens", "codeLens", "Show ▶ Run test and Debug above tests and main functions"))}
      ${row("Git", check("sGitGutter", "gitGutter", "Mark changed lines next to the line numbers"))}
      ${row("Dependencies", check("sDeps", "dependencyHints", "In Cargo.toml and .csproj files, show the newest version of each package (looked up on crates.io and nuget.org)"))}
      ${row("Snippets", `<div class="bar"><button class="btn" data-act="snippets">Edit snippets</button></div>`, "Your own snippets for each language, in snippets.json. They show up in completions by their prefix.")}
    </section>

    <section aria-labelledby="sTerm"><h2 id="sTerm">Terminal</h2>
      ${row("Shell", text("sShell", "terminalShell", "PowerShell (pwsh if it's installed)"), "The program a new terminal runs, like cmd.exe, pwsh.exe or a full path to Git Bash. Leave empty for PowerShell. Ctrl+` opens a terminal.", "sShell")}
    </section>

    <section aria-labelledby="sDbg"><h2 id="sDbg">Debugging</h2>
      ${row("Rust debugger", text("sDbgRs", "debugRust", "Downloaded codelldb") + `<div class="tool">${found(tools.lldb, "Not installed yet.")}</div><div class="bar"><button class="btn" data-act="dbg-install-rust">Download codelldb</button></div>`, "Leave empty to use the one Ledger downloads (about 40 MB, from github.com/vadimcn/codelldb).", "sDbgRs")}
      ${row("C# and Godot debugger", text("sDbgCs", "debugCsharp", "Downloaded netcoredbg") + `<div class="tool">${found(tools.netcoredbg, "Not installed yet.")}</div><div class="bar"><button class="btn" data-act="dbg-install-csharp">Download netcoredbg</button></div>`, "Leave empty to use the one Ledger downloads (about 10 MB, from github.com/Samsung/netcoredbg).", "sDbgCs")}
    </section>

    <section aria-labelledby="sRust"><h2 id="sRust">Rust</h2>
      ${row("cargo", `<div class="tool">${found(tools.cargo, 'Install Rust from <a href="https://rustup.rs" target="_blank">rustup.rs</a>.')}</div>`)}
      ${row("rust-analyzer", text("sRa", "rustAnalyzer", "rust-analyzer") + `<div class="tool">${found(tools.ra, "")}</div><div class="bar"><button class="btn" data-act="ra-install">Install rust-analyzer and rust-src</button><button class="btn" data-act="restart-rust">Restart</button></div>`, "A name on PATH or a full path to the program.", "sRa")}
      ${row("Check on save", select("sCheck", "rustCheck", [["check", "cargo check"], ["clippy", "cargo clippy"]]), "What rust-analyzer runs for errors after you save.", "sCheck")}
    </section>

    <section aria-labelledby="sCs"><h2 id="sCs">C# and .NET</h2>
      ${row("dotnet", `<div class="tool">${found(tools.dotnet, 'Install the .NET SDK from <a href="https://dotnet.microsoft.com/download" target="_blank">dotnet.microsoft.com</a>.')}</div>`)}
      ${row("Language server", text("sCs", "csharpServer", "csharp-ls") + `<div class="tool">${found(tools.cs, "")}</div><div class="bar"><button class="btn" data-act="cs-install">Install or update csharp-ls</button><button class="btn" data-act="restart-csharp">Restart</button></div>`, "csharp-ls needs the .NET 10 runtime (installing the .NET 10 SDK covers it). Any C# server that speaks LSP works here, for example OmniSharp with the argument -lsp.", "sCs")}
      ${row("Server arguments", text("sCsArgs", "csharpArgs", "none"), "Separated by spaces.", "sCsArgs")}
    </section>

    <section aria-labelledby="sLust"><h2 id="sLust">Lust</h2>
      ${row("lust", text("sLustPath", "lust", "lust") + `<div class="tool">${found(tools.lust, 'Run build.cmd in the <a href="https://github.com/Rhyslos/Lust" target="_blank">Lust repo</a>, then put the full path to its bin\\lust.exe here.')}</div>`, "Runs .lust files (Run, Check, Build) and checks them for mistakes when you save. A name on PATH or a full path to lust.exe.", "sLustPath")}
    </section>

    <section aria-labelledby="sGodot"><h2 id="sGodot">Godot</h2>
      ${row("Godot program", `<div class="pick">${text("sGodotPath", "godot", "C:\\Godot\\Godot_v4.x-stable_mono_win64.exe")}<button class="btn" data-act="godot-browse">Browse…</button></div><div class="tool">${settings.godot ? found(tools.godot, "That file wasn't found.") : ""}</div>`, "Used by Play. Pick the .NET (mono) build if your project uses C#.", "sGodotPath")}
      <div class="callout">
        <h3>Open scripts from Godot in ${esc(ctx.appName)}</h3>
        <p class="hint">In Godot: <b>Editor › Editor Settings</b>. Turn on <b>Advanced Settings</b> at the top if you can't see these.</p>
        <p class="sub">For C# scripts: <b>Dotnet › Editor</b>. Set <b>External Editor</b> to <b>Custom</b>, then:</p>
        ${copyRow("Custom Exec Path", exe || "(the path to " + ctx.appName + ".exe)")}
        ${copyRow("Custom Exec Path Args", csFlags)}
        <p class="sub">For GDScript and other text files: <b>Text Editor › External</b>. Turn on <b>Use External Editor</b>, then:</p>
        ${copyRow("Exec Path", exe || "(the path to " + ctx.appName + ".exe)")}
        ${copyRow("Exec Flags", flags)}
        <p class="hint">If ${esc(ctx.appName)} is already open, the file opens in the same window at the right line. Godot keeps shaders in its own editor, so open .gdshader files from the explorer here.</p>
      </div>
    </section>

    <section aria-labelledby="sKeys"><h2 id="sKeys">Keyboard shortcuts</h2>
      <p class="hint">Select a shortcut and press Enter, then press the new keys. Esc cancels, Backspace removes the shortcut.</p>
      <input type="search" id="sKeyFilter" class="kfilter" placeholder="Filter shortcuts" value="${esc(filter)}" aria-label="Filter shortcuts">
      <div class="ktable" role="list">${cmds.map((c) => {
        const keys = km.keysFor(c.id), changed = c.id in settings.keys, rec = recording === c.id;
        const clash = keys.flatMap((k) => km.conflicts(k, c.id)).map((id) => km.cmds.get(id)?.title).filter(Boolean);
        return `<div class="krow" role="listitem"><span class="kt">${esc(c.title)}${clash.length ? `<span class="hint"> · also used by ${esc(clash.join(", "))}</span>` : ""}</span>
          <button class="kbtn${rec ? " rec" : ""}" data-rec="${esc(c.id)}" aria-label="Shortcut for ${esc(c.title)}: ${esc(showKey(keys.join(", ")) || "none")}">${rec ? "Press keys…" : keys.length ? keys.map((k) => `<kbd>${esc(showKey(k))}</kbd>`).join(' <span class="hint">or</span> ') : '<span class="hint">none</span>'}</button>
          ${changed ? `<button class="btn plain" data-reset="${esc(c.id)}">Reset</button>` : "<span></span>"}</div>`;
      }).join("")}</div>
      <div class="bar"><button class="btn" data-act="keys-reset">Reset all shortcuts</button></div>
    </section>

    <section aria-labelledby="sFile"><h2 id="sFile">Settings file</h2>
      <div class="bar"><button class="btn" data-act="open-json">Open settings.json</button><button class="btn" data-act="reset-all">Reset all settings</button></div>
    </section>
  </div>`;
}

export function wireSettings(root, rerender) {
  const refocus = (sel) => requestAnimationFrame(() => root.querySelector(sel)?.focus());

  root.onchange = (ev) => {
    const el = ev.target.closest("[data-set]");
    if (!el) return;
    const key = el.dataset.set;
    let v = el.type === "checkbox" ? el.checked : el.value;
    if (el.type === "number") { v = parseFloat(v); if (!isFinite(v)) return; v = Math.min(+el.max || 99, Math.max(+el.min || 1, v)); }
    if (key === "tabSize") v = +v;
    setSetting(key, v);
    if (["rustAnalyzer", "csharpServer", "godot", "debugRust", "debugCsharp", "lust"].includes(key)) refreshTools().then(() => rerender(true));
  };
  root.oninput = (ev) => {
    if (ev.target.id === "sKeyFilter") { filter = ev.target.value; rerender(true); refocus("#sKeyFilter"); }
  };
  root.onclick = async (ev) => {
    const cp = ev.target.closest("[data-copy]");
    if (cp) { navigator.clipboard?.writeText(cp.dataset.copy).then(() => ctx.toast("Copied"), () => ctx.toast("Couldn't copy")); return; }
    const r = ev.target.closest("[data-rec]");
    if (r) { recording = r.dataset.rec; rerender(true); refocus(`[data-rec="${CSS.escape(recording)}"]`); return; }
    const rs = ev.target.closest("[data-reset]");
    if (rs) { const k = { ...settings.keys }; delete k[rs.dataset.reset]; setSetting("keys", k); rerender(true); refocus(`[data-rec="${CSS.escape(rs.dataset.reset)}"]`); return; }
    const a = ev.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "godot-browse") {
      const p = await openDialog({ title: "Find the Godot program", multiple: false, directory: false, filters: [{ name: "Programs", extensions: ["exe", "x86_64", "app", "*"] }] });
      if (p) { setSetting("godot", String(p)); await refreshTools(); rerender(true); refocus("#sGodotPath"); }
    }
    if (act === "cs-install") await ctx.stopServer("csharp"); // Windows can't replace a running .exe
    if (act === "cs-install") ctx.runTask("dotnet", ["tool", "update", "--global", "csharp-ls"], "Installing csharp-ls", () => { refreshTools().then(() => rerender(true)); ctx.restartServer("csharp"); });
    if (act === "ra-install") await ctx.stopServer("rust");
    if (act === "ra-install") ctx.runTask("rustup", ["component", "add", "rust-analyzer", "rust-src"], "Installing rust-analyzer", () => { refreshTools().then(() => rerender(true)); ctx.restartServer("rust"); });
    if (act === "restart-rust") ctx.restartServer("rust");
    if (act === "snippets") ctx.editSnippets?.();
    if (act === "dbg-install-rust" || act === "dbg-install-csharp") {
      a.disabled = true;
      a.textContent = "Downloading…";
      try { await ctx.installDebugger(act.endsWith("rust") ? "rust" : "csharp"); } catch (e) { ctx.toast(String(e), 8000); }
      await refreshTools();
      rerender(true);
    }
    if (act === "restart-csharp") ctx.restartServer("csharp");
    if (act === "keys-reset") { setSetting("keys", {}); rerender(true); }
    if (act === "open-json") { try { const p = await invoke("settings_write", { json: JSON.stringify(settings, null, 2) }); ctx.openFile(p); } catch (e) { ctx.toast(String(e)); } }
    if (act === "reset-all") {
      if ((await ctx.choose("Reset every setting to its default?", ["Reset", "Cancel"])) !== "Reset") return;
      for (const k of Object.keys(settings)) delete settings[k];
      Object.assign(settings, structuredClone(DEFAULTS));
      save(true);
      for (const k of Object.keys(DEFAULTS)) ctx.apply(k);
      rerender(true);
    }
  };
  // Recording a shortcut: capture before anything else sees the keys.
  root.addEventListener("keydown", (ev) => {
    if (!recording) return;
    const k = keyString(ev);
    if (!k) return;
    ev.preventDefault();
    ev.stopPropagation();
    const id = recording;
    recording = null;
    if (k === "Esc") { rerender(true); refocus(`[data-rec="${CSS.escape(id)}"]`); return; }
    const keys = { ...settings.keys };
    keys[id] = k === "Backspace" || k === "Delete" ? [] : [k];
    setSetting("keys", keys);
    rerender(true);
    refocus(`[data-rec="${CSS.escape(id)}"]`);
  }, true);
  root.addEventListener("focusout", (ev) => {
    if (recording && ev.target.closest?.("[data-rec]") && !root.contains(ev.relatedTarget)) { recording = null; rerender(true); }
  });
}
