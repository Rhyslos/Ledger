// Editing commands people coming from VS Code reach for, with its keys where they're free:
// select line (Ctrl L), select every match (Ctrl Shift L), add a cursor above or below
// (Ctrl Alt Up/Down), a new line above (Ctrl Shift Enter), and in the command list: sort lines,
// upper and lower case, trim trailing spaces, fold and unfold all, indent and outdent, and more.
import { EditorSelection } from "@codemirror/state";
import { selectLine, indentMore, indentLess, toggleComment, copyLineDown, deleteLine, moveLineUp, moveLineDown } from "@codemirror/commands";
import { selectSelectionMatches, openSearchPanel } from "@codemirror/search";
import { openReplace } from "./findbar.js";
import { foldAll, unfoldAll, indentUnit, getIndentation } from "@codemirror/language";

export function initEditCommands(app) {
  const C = (id, title, keys, run, alias) => app.command(id, title, keys, () => { const v = app.view; if (v && app.S.bufs.has(app.S.active)) { run(v); v.focus(); } }, alias ? { alias } : undefined);

  // A cursor on the line above (or below) every cursor, at the same column where it fits.
  const addCursor = (dir) => (v) => {
    const st = v.state, ranges = [...st.selection.ranges];
    for (const r of st.selection.ranges) {
      const line = st.doc.lineAt(r.head), n = line.number + dir;
      if (n < 1 || n > st.doc.lines) continue;
      const target = st.doc.line(n), col = Math.min(r.head - line.from, target.length);
      ranges.push(EditorSelection.cursor(target.from + col));
    }
    v.dispatch({ selection: EditorSelection.create(ranges, ranges.length - 1), scrollIntoView: true });
  };
  // A new, indented line above the cursor's line.
  const lineAbove = (v) => {
    const st = v.state;
    v.dispatch(st.changeByRange((r) => {
      const line = st.doc.lineAt(r.head);
      const ind = /^\s*/.exec(line.text)[0];
      return { changes: { from: line.from, insert: ind + "\n" }, range: EditorSelection.cursor(line.from + ind.length) };
    }), { scrollIntoView: true, userEvent: "input" });
  };
  // Replaces each selection (or the whole lines it touches, for line commands) with f(text).
  const onLines = (f) => (v) => {
    const st = v.state;
    v.dispatch(st.changeByRange((r) => {
      const a = st.doc.lineAt(r.from), b = st.doc.lineAt(r.empty ? r.to : Math.max(r.from, r.to - 1));
      const text = st.sliceDoc(a.from, b.to), out = f(text.split("\n")).join("\n");
      return { changes: { from: a.from, to: b.to, insert: out }, range: EditorSelection.range(a.from, a.from + out.length) };
    }), { userEvent: "input" });
  };
  const onText = (f) => (v) => {
    const st = v.state;
    v.dispatch(st.changeByRange((r) => {
      const range = r.empty ? st.wordAt(r.head) || r : r;
      const out = f(st.sliceDoc(range.from, range.to));
      return { changes: { from: range.from, to: range.to, insert: out }, range: EditorSelection.range(range.from, range.from + out.length) };
    }), { userEvent: "input" });
  };
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  app.command("editor.find", "Find in this file", "Ctrl+F", () => { const v = app.view; if (v && app.S.bufs.has(app.S.active)) openSearchPanel(v); });
  app.command("editor.replace", "Replace in this file", "Ctrl+H", () => { const v = app.view; if (v && app.S.bufs.has(app.S.active)) openReplace(v); });
  C("editor.selectLine", "Select the line (again: the next one too)", "Ctrl+L", selectLine);
  C("editor.selectAllMatches", "Select every match of the selection", "Ctrl+Shift+L", selectSelectionMatches, "multiple cursors occurrences");
  C("editor.cursorAbove", "Add a cursor above", "Ctrl+Alt+Up", addCursor(-1), "multiple cursors column");
  C("editor.cursorBelow", "Add a cursor below", "Ctrl+Alt+Down", addCursor(1), "multiple cursors column");
  C("editor.lineAbove", "New line above", "Ctrl+Shift+Enter", lineAbove, "insert");
  C("editor.sortLines", "Sort lines (A to Z)", [], onLines((l) => [...l].sort(collator.compare)), "order");
  C("editor.sortLinesDesc", "Sort lines (Z to A)", [], onLines((l) => [...l].sort(collator.compare).reverse()), "order descending");
  C("editor.uniqueLines", "Remove duplicate lines", [], onLines((l) => [...new Set(l)]), "unique dedupe");
  C("editor.reverseLines", "Reverse lines", [], onLines((l) => [...l].reverse()));
  C("editor.upper", "UPPER CASE", [], onText((t) => t.toUpperCase()), "uppercase transform");
  C("editor.lower", "lower case", [], onText((t) => t.toLowerCase()), "lowercase transform");
  C("editor.title", "Title Case", [], onText((t) => t.replace(/\b\p{L}/gu, (c) => c.toUpperCase())), "capitalize transform");
  C("editor.trimTrailing", "Trim trailing spaces", [], (v) => {
    const changes = [];
    for (let n = 1; n <= v.state.doc.lines; n++) { const l = v.state.doc.line(n), m = /\s+$/.exec(l.text); if (m) changes.push({ from: l.from + m.index, to: l.to }); }
    if (changes.length) v.dispatch({ changes, userEvent: "delete" });
    app.toast(changes.length ? `Trimmed ${changes.length} line${changes.length === 1 ? "" : "s"}.` : "No trailing spaces.");
  }, "whitespace");
  C("editor.duplicate", "Duplicate line", [], copyLineDown, "copy line");
  C("editor.deleteLine", "Delete line", [], deleteLine, "remove line");
  C("editor.moveUp", "Move line up", [], moveLineUp);
  C("editor.moveDown", "Move line down", [], moveLineDown);
  C("editor.comment", "Comment or uncomment", [], toggleComment, "toggle comment");
  C("editor.indent", "Indent", [], indentMore, "tab");
  C("editor.outdent", "Outdent", [], indentLess, "unindent dedent");
  C("editor.foldAll", "Fold all", [], foldAll, "collapse code folding");
  C("editor.unfoldAll", "Unfold all", [], unfoldAll, "expand code folding");
  C("editor.reindent", "Re-indent the selected lines", [], (v) => {
    const st = v.state, unit = st.facet(indentUnit);
    v.dispatch(st.changeByRange((r) => {
      const changes = [];
      for (let n = st.doc.lineAt(r.from).number; n <= st.doc.lineAt(r.to).number; n++) {
        const l = st.doc.line(n), want = getIndentation(st, l.from);
        if (want == null || !l.text.trim()) continue;
        const cur = /^\s*/.exec(l.text)[0], ind = unit === "\t" ? "\t".repeat(Math.floor(want / st.tabSize)) : " ".repeat(want);
        if (cur !== ind) changes.push({ from: l.from, to: l.from + cur.length, insert: ind });
      }
      return { changes, range: r };
    }), { userEvent: "input" });
  }, "format indentation");
  const winPath = (p) => (/^[A-Za-z]:|^\/\//.test(p) ? p.replace(/\//g, "\\") : p); // C:\x\y.rs, as Windows writes it
  app.command("file.copyPath", "Copy the file's path", [], () => { if (app.S.active && !app.S.active.startsWith("@")) app.copy(winPath(app.S.active)); });
  app.command("file.copyRelPath", "Copy the file's relative path", [], () => { if (app.S.active && !app.S.active.startsWith("@")) app.copy(app.rel(app.S.active)); });
}
