// Built-in terminals in the bottom panel. Each one is a real shell (PowerShell
// by default) running in a Windows pseudo console on the Rust side.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { on } from "./win.js";
import { esc } from "./ansi.js";

export function initTerminal(app) {
  const { $, settings } = app;
  const terms = new Map(); // id -> { term, fit, el, name, exited }
  let cur = null;
  let seq = 0;

  const warnedRestricted = new Set();
  const early = new Map(); // output that arrives before term_open has returned the id
  on("term-data", (e) => {
    const t = terms.get(e.payload.id);
    if (t) t.term.write(e.payload.data);
    else early.set(e.payload.id, (early.get(e.payload.id) || "") + e.payload.data);
  });
  on("term-exit", (e) => {
    const t = terms.get(e.payload.id);
    if (!t) return;
    t.exited = true;
    t.term.write("\r\n\x1b[2m[The shell has ended. Press Enter to close this terminal.]\x1b[0m\r\n");
    renderTabs();
  });

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function theme() {
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    return {
      background: css("--bg"), foreground: css("--ink"), cursor: css("--accent"), cursorAccent: css("--bg"),
      selectionBackground: css("--select"), selectionInactiveBackground: css("--select"),
      ...(dark ? {} : { black: "#202020", red: "#a3262e", green: "#2f7a3e", yellow: "#8a5a0a", blue: "#2f5fa0", magenta: "#7a3fa8", cyan: "#1f7a80", white: "#6b6b68", brightBlack: "#6b6b68", brightWhite: "#202020", brightYellow: "#a8670f" }),
    };
  }
  const font = () => ({ fontFamily: settings.fontFamily ? `"${settings.fontFamily}", IBM Plex Mono, Consolas, monospace` : "IBM Plex Mono, Consolas, monospace", fontSize: Math.max(10, settings.fontSize - 1) });

  let creating = null;
  function create() {
    if (!creating) creating = make().finally(() => { creating = null; });
    return creating;
  }
  async function make() {
    const el = document.createElement("div");
    el.className = "term";
    $("terms").append(el);
    const term = new Terminal({
      ...font(), theme: theme(), cursorBlink: true, scrollback: 5000, allowProposedApi: false, macOptionIsMeta: true,
      // Windows' pseudo console rewraps lines itself; tell xterm so they don't fight.
      ...(navigator.userAgent.includes("Windows") ? { windowsPty: { backend: "conpty", buildNumber: 22000 } } : {}),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // Windows Terminal habits: Ctrl+C copies when text is selected, Ctrl+V pastes.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.code === "KeyC" && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyC") { navigator.clipboard?.writeText(term.getSelection()); return false; }
      if (ev.ctrlKey && (ev.code === "KeyV" || (ev.shiftKey && ev.code === "KeyV"))) return false; // the browser's paste event does it
      return true;
    });
    try { await document.fonts?.load?.(`${term.options.fontSize}px ${term.options.fontFamily}`); } catch {}
    try { fit.fit(); } catch {}
    let id;
    try {
      // Restricted mode keeps Ledger from running the folder's code; a terminal runs whatever you type.
      if (app.S.root && !app.trusted() && !warnedRestricted.has(app.S.root)) { warnedRestricted.add(app.S.root); app.toast("This folder is in restricted mode, but the terminal runs whatever you type in it, the folder's scripts included.", 7000); }
      id = await invoke("term_open", { cwd: app.cwd(), cols: term.cols, rows: term.rows, shell: settings.terminalShell || null });
    } catch (e) {
      term.dispose(); el.remove();
      app.toast(String(e), 6000);
      return null;
    }
    const t = { id, term, fit, el, name: (settings.terminalShell || (navigator.userAgent.includes("Windows") ? "pwsh" : "shell")).split(/[\\/ ]/).filter(Boolean).pop().replace(/\.exe$/i, ""), n: ++seq, exited: false };
    terms.set(id, t);
    if (early.has(id)) { term.write(early.get(id)); early.delete(id); }
    term.onData((d) => {
      if (t.exited) { if (d === "\r") close(id); return; }
      invoke("term_write", { id, data: d }).catch(() => {});
    });
    term.onResize(({ cols, rows }) => invoke("term_resize", { id, cols, rows }).catch(() => {}));
    select(id);
    return t;
  }

  function select(id) {
    cur = id;
    for (const [k, t] of terms) t.el.hidden = k !== id;
    renderTabs();
    requestAnimationFrame(() => { const t = terms.get(id); if (t) { try { t.fit.fit(); } catch {} } });
  }
  async function close(id = cur) {
    const t = terms.get(id);
    if (!t) return;
    terms.delete(id);
    invoke("term_close", { id }).catch(() => {});
    t.term.dispose();
    t.el.remove();
    const next = [...terms.keys()].pop();
    if (next != null) { select(next); focus(); }
    else { cur = null; renderTabs(); app.focusZone("editor"); }
  }
  function renderTabs() {
    $("termTabs").innerHTML = terms.size > 1 || [...terms.values()].some((t) => t.exited)
      ? [...terms.values()].map((t) => `<button data-term="${t.id}" aria-pressed="${t.id === cur}" title="${esc(t.name)}${t.exited ? " (ended)" : ""}">${t.n} ${esc(t.name)}${t.exited ? " ✕" : ""}</button>`).join("")
      : "";
    $("bKillTerm").title = "Close terminal";
  }
  $("termTabs").addEventListener("click", (ev) => { const b = ev.target.closest("[data-term]"); if (b) { select(+b.dataset.term); focus(); } });
  $("bNewTerm").onclick = () => newTerminal();
  $("bKillTerm").onclick = () => close();

  function focus() { terms.get(cur)?.term.focus(); }
  async function show(focusIt = true) {
    app.showPanel("terminal");
    if (!terms.size) await create();
    requestAnimationFrame(() => { const t = terms.get(cur); try { t?.fit.fit(); } catch {} if (focusIt) focus(); });
  }
  async function newTerminal() {
    if (!terms.size && !creating) { await show(true); return; } // the first one opens with the panel
    app.showPanel("terminal");
    await creating;
    if (terms.size) await make(); else await create();
    requestAnimationFrame(focus);
  }
  function toggle() {
    if (app.currentZone() === "panel" && app.S.ptab === "terminal" && app.S.panel) app.focusZone("editor");
    else show(true);
  }
  function cycle(d) {
    const ids = [...terms.keys()];
    if (ids.length < 2) return;
    select(ids[(ids.indexOf(cur) + d + ids.length) % ids.length]);
    focus();
  }

  // Keep the terminal sized to the panel, and to its font: rows are counted from the font's
  // line height, so a font that finishes loading late would otherwise leave the last row
  // (the prompt) hanging just below the bottom of the panel.
  const refit = () => { const t = terms.get(cur); if (t && !$("terms").hidden) { try { t.fit.fit(); } catch {} } };
  new ResizeObserver(refit).observe($("terms"));
  document.fonts?.addEventListener?.("loadingdone", () => requestAnimationFrame(refit));
  app.panelTabs.terminal.focus = () => (terms.size ? focus() : show(true));
  app.panelTabs.terminal.shown = () => { if (!terms.size) create().then(() => requestAnimationFrame(focus)); else { const t = terms.get(cur); try { t?.fit.fit(); } catch {} } };

  function restyle() { for (const t of terms.values()) { t.term.options.theme = theme(); Object.assign(t.term.options, font()); try { t.fit.fit(); } catch {} } }

  const C = app.command;
  C("terminal.toggle", "Terminal", "Ctrl+`", toggle);
  C("terminal.new", "New terminal", ["Ctrl+T", "Ctrl+Shift+`"], newTerminal);
  C("terminal.close", "Close terminal", [], () => close());
  C("terminal.next", "Next terminal", [], () => cycle(1));
  C("terminal.prev", "Previous terminal", [], () => cycle(-1));

  /** Types a command into the terminal (opening one if there's none) and presses Enter. */
  async function runInTerminal(line) {
    await show(true);
    await creating;
    const t = terms.get(cur);
    if (!t || t.exited) { await make(); }
    const id = cur;
    if (id == null) return;
    await invoke("term_write", { id, data: line + "\r" }).catch((e) => app.toast(String(e)));
  }
  app.runInTerminal = runInTerminal;

  return { restyle, show, newTerminal, runInTerminal, closeAll: () => { for (const id of [...terms.keys()]) close(id); } };
}
