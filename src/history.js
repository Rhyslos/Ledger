// Local history: every save keeps a copy of the file (the last 50 per file, in Ledger's own folder,
// never in the project), plus the file as it was before your first edit, so you can go back to
// an earlier version even in a folder without Git, or one you haven't committed in a while.
// "Local history: this file's saved versions" lists them; picking one shows it next to the file
// now, with "Restore this version".
import { ago } from "./gitmore.js";

const MAX_TEXT = 2 * 1024 * 1024;

export function initHistory(app) {
  const { S, settings, invoke, toast, base } = app;
  const before = new Map(); // path -> the text on disk before the first edit this session

  app.bufListeners.push((path, b) => {
    if (!before.has(path) && !b.virtual && b.saved) before.set(path, b.saved.toString());
  });
  app.saveHooks.push(async (path, b) => {
    if (settings.localHistory === false || !b || b.virtual) return;
    const text = b.state.doc.toString();
    if (text.length > MAX_TEXT) return;
    try {
      if (before.has(path)) { await invoke("history_add", { path, text: before.get(path) }); before.delete(path); }
      await invoke("history_add", { path, text });
    } catch {}
  });

  const when = (t) => {
    const d = new Date(t), now = new Date();
    const day = d.toDateString() === now.toDateString() ? "Today" : d.toDateString() === new Date(now - 864e5).toDateString() ? "Yesterday" : d.toLocaleDateString();
    return `${day} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  };
  const size = (n) => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB");

  async function show(path = S.active) {
    const b = S.bufs.get(path);
    if (!b || b.virtual) { toast("Open a file first."); return; }
    const list = await invoke("history_list", { path }).catch(() => []);
    if (!list.length) { toast(settings.localHistory === false ? "Local history is off (Settings › Editing)." : `No saved versions of ${base(path)} yet. Every save from now on keeps one.`); return; }
    const i = await app.choose(`Saved versions of ${base(path)}`, list.map((v, n) => `${when(v.time)}  ·  ${ago(v.time)}  ·  ${size(v.size)}${n === 0 ? "  ·  latest save" : ""}`), true, { filter: list.length > 8 });
    if (i == null || i < 0) return;
    const v = list[i];
    let text;
    try { text = await invoke("history_read", { path, id: v.id }); } catch (e) { toast(String(e)); return; }
    const cur = S.bufs.get(path);
    if (cur && cur.state.doc.toString() === text.replace(/\r\n/g, "\n")) { toast("That version is the same as the file is now."); return; }
    app.openDiff?.({
      path, title: `${base(path)} · ${when(v.time)}`,
      left: text.replace(/\r\n/g, "\n"), right: cur ? cur.state.doc.toString() : "",
      leftLabel: `Saved ${ago(v.time)}`, rightLabel: cur?.dirty ? "Now (not saved)" : "Now",
      actions: [{
        label: "Restore this version",
        run: () => {
          const b2 = S.bufs.get(path);
          if (!b2) { toast("Open the file first."); return; }
          const t = text.replace(/\r\n/g, "\n");
          app.dispatchBuf(path, { changes: { from: 0, to: b2.state.doc.length, insert: t }, userEvent: "input.restore" });
          app.openFile(path);
          toast("Restored. Save to keep it, or undo (Ctrl Z) to go back.");
        },
      }],
    });
  }
  app.command("history.show", "Local history: this file's saved versions", [], () => show());
}
