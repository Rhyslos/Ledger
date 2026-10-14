// Shortcuts. Every action in the app is a command with an id; keys map to ids,
// and the user can remap any of them in Settings.

const NAMED = {
  " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Escape: "Esc", Delete: "Delete", Backspace: "Backspace", Enter: "Enter", Tab: "Tab",
  PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End", Insert: "Insert", ContextMenu: "ContextMenu",
};
const CODES = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", NumpadAdd: "=", NumpadSubtract: "-",
};

/** A keyboard event as "Ctrl+Shift+P". Letters and digits use the physical key, so layouts don't matter. */
export function keyString(e) {
  // On Windows AltGr arrives as Ctrl+Alt. If it produced a different character
  // (€, @, { on Norwegian keyboards) that's typing, not a shortcut.
  const phys = /^Key([A-Z])$/.exec(e.code)?.[1] || /^Digit(\d)$/.exec(e.code)?.[1];
  if (e.ctrlKey && e.altKey && e.key.length === 1 && phys && e.key.toLowerCase() !== phys.toLowerCase()) return null;
  let k;
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) k = e.code.slice(6);
  // + - = follow the printed character, so zoom works on any layout (on Norwegian keyboards
  // the + key sits where US keyboards have -).
  else if (e.key === "+" || e.key === "-" || e.key === "=") k = e.key === "+" ? "Plus" : e.key;
  else if (CODES[e.code]) k = CODES[e.code];
  else if (/^F\d{1,2}$/.test(e.key)) k = e.key;
  else if (NAMED[e.key]) k = NAMED[e.key];
  else if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return null;
  else k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, k].join("+");
}

/** Normalise user-typed or stored strings so "shift+ctrl+p" matches "Ctrl+Shift+P". */
export function normKey(s) {
  if (!s) return "";
  const parts = String(s).split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  const set = new Set(parts.map((p) => p.toLowerCase()));
  const mods = [];
  if (set.has("ctrl") || set.has("cmd") || set.has("control")) mods.push("Ctrl");
  if (set.has("alt") || set.has("option")) mods.push("Alt");
  if (set.has("shift")) mods.push("Shift");
  const k = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  return [...mods, k].join("+");
}

/** Pretty for display: "Ctrl Shift P". */
export const showKey = (s) => (s ? s.replace(/\+/g, " ").replace(/\bPlus\b/, "+") : "");

export class Keymap {
  constructor() { this.cmds = new Map(); this.overrides = {}; this.rebuild(); }
  add(id, title, keys, run, opts = {}) {
    this.cmds.set(id, { id, title, defaults: [].concat(keys || []).map(normKey), run, ...opts });
    this.stale = true; // commands can be added after start-up (terminal, debugger, Git…)
  }
  setOverrides(o) { this.overrides = o || {}; this.rebuild(); }
  keysFor(id) {
    const c = this.cmds.get(id);
    if (!c) return [];
    return id in this.overrides ? [].concat(this.overrides[id] || []).map(normKey).filter(Boolean) : c.defaults;
  }
  rebuild() {
    this.stale = false;
    this.map = new Map();
    for (const id of this.cmds.keys()) for (const k of this.keysFor(id)) if (!this.map.has(k)) this.map.set(k, id);
  }
  lookup(k) { if (this.stale) this.rebuild(); return this.map.get(k); }
  /** Other commands already using `key`. */
  conflicts(key, except) {
    const k = normKey(key);
    return [...this.cmds.keys()].filter((id) => id !== except && this.keysFor(id).includes(k));
  }
  label(id) { return showKey(this.keysFor(id)[0] || ""); }
  /** Keys in use, for checks that need the whole table. */
  keysInUse() { if (this.stale) this.rebuild(); return this.map; }
  list() { return [...this.cmds.values()]; }
}
