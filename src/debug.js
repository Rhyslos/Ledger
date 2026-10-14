// Dev-only: mirror console output and errors to the terminal running `tauri dev`.
import { invoke } from "@tauri-apps/api/core";
const send = (level, args) => invoke("js_log", { level, msg: args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") }).catch(() => {});
for (const level of ["log", "warn", "error"]) { const orig = console[level]; console[level] = (...a) => { orig(...a); send(level, a); }; }
window.addEventListener("error", (e) => send("error", [e.error || e.message]));
window.addEventListener("unhandledrejection", (e) => send("error", ["unhandled:", e.reason]));

// Test hook (VITE_TEST=1 only): runs the script in /tmp/ledger-eval-<window>.js
// whenever it changes, and logs the result. Lets an automated check drive the app.
if (import.meta.env.VITE_TEST) import("./win.js").then(({ winLabel }) => {
  let last = null; // the script already there at startup is not re-run
  setInterval(async () => {
    let src = "";
    try { src = await invoke("read_file", { path: `/tmp/ledger-eval-${winLabel}.js` }); } catch { if (last === null) last = ""; return; }
    if (last === null) { last = src; return; }
    if (src === last) return;
    last = src;
    try {
      const r = await (0, eval)(`(async () => { ${src} })()`);
      send("log", ["EVAL", winLabel, typeof r === "string" ? r : JSON.stringify(r)]);
    } catch (e) { send("error", ["EVAL", winLabel, e.stack || String(e)]); }
  }, 300);
});
