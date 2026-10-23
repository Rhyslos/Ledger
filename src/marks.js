// Bookmarks and the overview ruler.
//
// Bookmarks: Ctrl Alt K marks the line (a thin bar at its left), Ctrl Alt L and Ctrl Alt J go to the
// next and previous one in the file, and "Bookmarks: list" shows every bookmark in the folder.
// They're kept per folder, so they're still there next time.
//
// The overview ruler: a thin strip over the editor's scrollbar with a tick for every error and
// warning, search match, Git change and bookmark in the file, and the cursor, so you can see where
// they are in a long file. Other parts add their own ticks through app.scrollMarks.
import { ViewPlugin, Decoration, EditorView, gutter, GutterMarker } from "@codemirror/view";
import { StateField, StateEffect, RangeSet, RangeSetBuilder } from "@codemirror/state";
import { forEachDiagnostic } from "@codemirror/lint";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";

// ---------- bookmarks ----------
const toggleMark = StateEffect.define(); // a line start
const setMarks = StateEffect.define(); // [line starts]
const markDeco = Decoration.line({ class: "cm-bookmarked", attributes: { title: "Bookmark (Ctrl Alt K)" } });
const bookmarkField = StateField.define({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMarks)) set = RangeSet.of(e.value.map((p) => markDeco.range(p)), true);
      if (e.is(toggleMark)) {
        let had = false;
        set.between(e.value, e.value, (from) => { if (from === e.value) had = true; });
        set = had ? set.update({ filter: (from) => from !== e.value }) : set.update({ add: [markDeco.range(e.value)], sort: true });
      }
    }
    // Two marks that ended up on one line (its line break deleted) become one.
    if (tr.docChanged) {
      const seen = new Set();
      set = set.update({ filter: (from) => { const l = tr.state.doc.lineAt(from).number; if (seen.has(l)) return false; seen.add(l); return true; } });
    }
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});
// A small ribbon next to the line number, so a bookmark can't be mistaken for the cursor or a Git bar.
class Ribbon extends GutterMarker {
  toDOM() { const s = document.createElement("span"); s.className = "cm-bookmark-ribbon"; s.title = "Bookmark (Ctrl Alt K removes it)"; return s; }
}
const RIBBON = new Ribbon();
const bookmarkGutter = gutter({
  class: "cm-bookmark-gutter",
  markers: (v) => {
    const set = v.state.field(bookmarkField, false), out = [];
    if (set) for (const c = set.iter(); c.value; c.next()) out.push(RIBBON.range(c.from));
    return RangeSet.of(out);
  },
  initialSpacer: () => RIBBON,
});
export const bookmarkLines = (state) => {
  const out = [];
  const set = state.field(bookmarkField, false);
  set?.between(0, state.doc.length, (from) => { out.push(state.doc.lineAt(from).number); });
  return out;
};

// ---------- overview ruler ----------
const MAX_SEARCH = 2000;
const searchCache = { doc: null, q: null, found: [] };
function collect(view, extra) {
  const st = view.state, marks = [];
  forEachDiagnostic(st, (d) => marks.push({ pos: d.from, kind: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info" }));
  if (searchPanelOpen(st)) {
    const q = getSearchQuery(st);
    if (q.valid && q.search) {
      // Found again only when the text or the search changes, not on every cursor move.
      if (searchCache.doc !== st.doc || !searchCache.q?.eq(q)) {
        const found = [], cur = q.getCursor(st);
        for (let i = 0, r = cur.next(); !r.done && i < MAX_SEARCH; r = cur.next(), i++) found.push({ pos: r.value.from, kind: "search" });
        Object.assign(searchCache, { doc: st.doc, q, found });
      }
      marks.push(...searchCache.found);
    }
  }
  st.field(bookmarkField, false)?.between(0, st.doc.length, (from) => { marks.push({ pos: from, kind: "bookmark" }); });
  for (const f of extra) for (const m of f(st) || []) marks.push(m);
  marks.push({ pos: st.selection.main.head, kind: "cursor" });
  return marks;
}
const ORDER = ["cursor", "search", "add", "mod", "del", "bookmark", "info", "warning", "error"]; // later draws on top

function overview(extra) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.dom = document.createElement("div");
      this.dom.className = "cm-overview";
      this.dom.setAttribute("aria-hidden", "true");
      view.dom.appendChild(this.dom);
      this.queued = false;
      this.schedule();
    }
    update(u) {
      if (u.docChanged || u.geometryChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.length)) this.schedule();
    }
    schedule() {
      if (this.queued) return;
      this.queued = true;
      requestAnimationFrame(() => {
        this.queued = false;
        if (!this.view.dom.isConnected) return;
        this.view.requestMeasure({ read: (v) => this.read(v), write: (r) => this.write(r) });
      });
    }
    read(v) {
      const height = v.scrollDOM.clientHeight, top = v.scrollDOM.offsetTop;
      const total = Math.max(v.contentHeight, height);
      if (!height || v.contentHeight <= height) return { height, top, ticks: [] }; // no scrollbar: nothing to map onto
      const seen = new Map(); // one tick per pixel row and kind
      for (const m of collect(v, extra)) {
        const pos = Math.min(Math.max(m.pos, 0), v.state.doc.length);
        const y = Math.round((v.lineBlockAt(pos).top / total) * height);
        seen.set(m.kind + ":" + y, { y, kind: m.kind });
      }
      return { height, top, ticks: [...seen.values()].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)) };
    }
    write({ height, top, ticks }) {
      this.dom.style.top = top + "px";
      this.dom.style.height = height + "px";
      this.dom.innerHTML = ticks.map((t) => `<i class="ov-${t.kind}" style="top:${Math.min(t.y, height - 2)}px"></i>`).join("");
    }
    destroy() { this.dom.remove(); }
  });
}

export function initMarks(app) {
  const { S, prefs, savePrefs, rel, join, toast } = app;
  const saved = () => ((prefs.bookmarks ||= {})[S.root] ||= {});
  function persist(path) {
    const b = S.bufs.get(path);
    if (!b || !S.root || b.virtual) return;
    const lines = bookmarkLines(b.state);
    const m = saved();
    if (lines.length) m[rel(path)] = lines; else delete m[rel(path)];
    if (!Object.keys(m).length) delete prefs.bookmarks[S.root];
    savePrefs();
  }
  const initial = (path, state) => {
    const lines = (S.root && prefs.bookmarks?.[S.root]?.[rel(path)]) || [];
    const b = new RangeSetBuilder();
    for (const n of [...new Set(lines)].sort((a, c) => a - c)) if (n >= 1 && n <= state.doc.lines) b.add(state.doc.line(n).from, state.doc.line(n).from, markDeco);
    return b.finish();
  };
  const ruler = overview(app.scrollMarks);
  app.extraExt.push((path, b) => [bookmarkField.init((state) => initial(path, state)), bookmarkGutter, app.settings.overviewRuler === false ? [] : ruler]);
  app.saveHooks.push((path) => persist(path));

  function toggle() {
    const v = app.view, path = S.active;
    if (!v || !S.bufs.has(path)) return;
    const lines = new Set(v.state.selection.ranges.map((r) => v.state.doc.lineAt(r.head).from));
    v.dispatch({ effects: [...lines].map((p) => toggleMark.of(p)) });
    persist(path);
  }
  function go(dir) {
    const v = app.view;
    if (!v || !S.bufs.has(S.active)) return;
    const lines = bookmarkLines(v.state);
    if (!lines.length) { toast("No bookmarks in this file. Ctrl Alt K marks the line."); return; }
    const cur = v.state.doc.lineAt(v.state.selection.main.head).number;
    const n = dir > 0 ? lines.find((l) => l > cur) ?? lines[0] : [...lines].reverse().find((l) => l < cur) ?? lines[lines.length - 1];
    const pos = v.state.doc.line(n).from;
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    v.focus();
  }
  async function list() {
    if (!S.root) { toast("Open a folder first."); return; }
    for (const p of S.bufs.keys()) persist(p);
    const items = [];
    for (const [file, lines] of Object.entries(prefs.bookmarks?.[S.root] || {})) {
      const path = join(S.root, file), b = S.bufs.get(path);
      for (const n of lines) {
        const text = b && n <= b.state.doc.lines ? b.state.doc.line(n).text.trim() : "";
        items.push({ path, n, label: `${file}:${n}${text ? "  " + text.slice(0, 80) : ""}` });
      }
    }
    if (!items.length) { toast("No bookmarks in this folder yet. Ctrl Alt K marks the line."); return; }
    const i = await app.choose("Bookmarks", items.map((x) => x.label), true, { filter: true });
    if (i == null || i < 0) return;
    const it = items[i];
    app.openFile(it.path, { line: it.n - 1, character: 0 });
  }
  function clear() {
    const v = app.view;
    if (!v || !S.bufs.has(S.active)) return;
    v.dispatch({ effects: setMarks.of([]) });
    persist(S.active);
  }
  app.command("bookmark.toggle", "Bookmarks: mark or unmark this line", ["Ctrl+Alt+K"], toggle);
  app.command("bookmark.next", "Bookmarks: next in this file", ["Ctrl+Alt+L"], () => go(1));
  app.command("bookmark.prev", "Bookmarks: previous in this file", ["Ctrl+Alt+J"], () => go(-1));
  app.command("bookmark.list", "Bookmarks: list all in this folder", [], list);
  app.command("bookmark.clear", "Bookmarks: clear this file's", [], clear);
}
