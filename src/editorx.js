// Editor polish: coloured bracket pairs, indent guides and sticky scroll.
// Each is a plain CodeMirror extension, switched on and off from Settings.
import { ViewPlugin, Decoration, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree, highlightingFor } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";

// Strings, characters and comments, by node name in both Lezer trees (String,
// LineComment, Char…) and the simpler highlighters (string, comment, string-2…).
const SKIP = /^(\w*string\w*|\w*comment\w*|char\w*|regexp?)([.\-].*)?$/i;
const OPEN = "([{", CLOSE = ")]}";
const MAX = 1_000_000;

/** Ranges of strings and comments up to `to`, so brackets inside them are left alone. */
function skipRanges(state, to) {
  const out = [];
  syntaxTree(state).iterate({
    to,
    enter(n) {
      if (n.type.isTop) return;
      if (SKIP.test(n.type.name) && n.to > n.from) { out.push([n.from, n.to]); return false; }
    },
  });
  return out;
}

// ---------- bracket pairs ----------
const brMarks = [1, 2, 3].map((n) => Decoration.mark({ class: `cm-br${n}` }));
function bracketDecos(view) {
  const { state } = view;
  const b = new RangeSetBuilder();
  if (state.doc.length > MAX) return b.finish();
  const end = view.visibleRanges.length ? view.visibleRanges[view.visibleRanges.length - 1].to : 0;
  const skip = skipRanges(state, end);
  const text = state.sliceDoc(0, end);
  const vis = view.visibleRanges;
  let si = 0, vi = 0;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 40 && c !== 41 && c !== 91 && c !== 93 && c !== 123 && c !== 125) continue;
    while (si < skip.length && skip[si][1] <= i) si++;
    if (si < skip.length && skip[si][0] <= i) { i = skip[si][1] - 1; continue; }
    const ch = text[i];
    let depth;
    if (OPEN.includes(ch)) { depth = stack.length; stack.push(ch); }
    else {
      const want = OPEN[CLOSE.indexOf(ch)];
      if (stack[stack.length - 1] === want) { stack.pop(); depth = stack.length; }
      else continue; // unmatched: leave it to the error squiggles
    }
    while (vi < vis.length && vis[vi].to <= i) vi++;
    if (vi < vis.length && vis[vi].from <= i) b.add(i, i + 1, brMarks[depth % 3]);
  }
  return b.finish();
}
export const bracketColors = ViewPlugin.fromClass(class {
  constructor(v) { this.decorations = bracketDecos(v); }
  update(u) { if (u.docChanged || u.viewportChanged || u.transactions.length && syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = bracketDecos(u.view); }
}, { decorations: (v) => v.decorations });

// ---------- indent guides ----------
function indentOf(text, tab) {
  let col = 0;
  for (const ch of text) {
    if (ch === " ") col++;
    else if (ch === "\t") col += tab - (col % tab);
    else return col;
  }
  return -1; // blank
}
const guideCache = new Map();
const guideDeco = (n) => {
  if (!guideCache.has(n)) guideCache.set(n, Decoration.line({ attributes: { class: "cm-ig", style: `background-size: calc(var(--tabw) * ${n}) 100%` } }));
  return guideCache.get(n);
};
function guideDecos(view) {
  const { state } = view;
  const tab = state.tabSize;
  const b = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      let ind = indentOf(line.text, tab);
      if (ind < 0) {
        // Blank lines carry the guides of the code around them.
        let prev = 0, next = 0;
        for (let n = line.number - 1, k = 0; n >= 1 && k < 200; n--, k++) { const x = indentOf(state.doc.line(n).text, tab); if (x >= 0) { prev = x; break; } }
        for (let n = line.number + 1, k = 0; n <= state.doc.lines && k < 200; n++, k++) { const x = indentOf(state.doc.line(n).text, tab); if (x >= 0) { next = x; break; } }
        ind = Math.min(prev, next);
      }
      const levels = Math.floor(ind / tab);
      if (levels > 0) b.add(line.from, line.from, guideDeco(levels));
      pos = line.to + 1;
    }
  }
  return b.finish();
}
export const indentGuides = [
  ViewPlugin.fromClass(class {
    constructor(v) { this.decorations = guideDecos(v); }
    update(u) { if (u.docChanged || u.viewportChanged || u.startState.tabSize !== u.state.tabSize) this.decorations = guideDecos(u.view); }
  }, { decorations: (v) => v.decorations }),
  EditorView.contentAttributes.compute(["tabSize"], (st) => ({ style: `--tabw: ${st.tabSize}ch` })),
];

// ---------- sticky scroll ----------
// The lines that open the blocks you're scrolled into (fn, impl, class, if…)
// stay pinned at the top. Works from indentation, so every language gets it.
const BRACE_ONLY = /^\s*[{[(]\s*$/;
function headersFor(state, lineNo) {
  const tab = state.tabSize;
  let n = lineNo, cur = -1;
  while (n <= state.doc.lines && cur < 0) { cur = indentOf(state.doc.line(n).text, tab); if (cur < 0) n++; }
  if (cur <= 0) return [];
  const out = [];
  for (let i = lineNo - 1; i >= 1 && cur > 0; i--) {
    const t = state.doc.line(i).text;
    const ind = indentOf(t, tab);
    if (ind < 0 || ind >= cur) continue;
    // A lone "{" belongs to the line above it; comments aren't headers.
    if (BRACE_ONLY.test(t) || /^\s*(\/\/|\/\*|\*|#|--)/.test(t)) continue;
    out.unshift(i);
    cur = ind;
  }
  return out;
}
const MAX_STICKY = 5;
export function stickyScroll() {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.dom = document.createElement("div");
      this.dom.className = "cm-sticky";
      this.dom.hidden = true;
      this.dom.setAttribute("aria-hidden", "true");
      view.dom.append(this.dom);
      this.key = "";
      this.onScroll = () => this.measure();
      view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      this.dom.addEventListener("mousedown", (e) => {
        const d = e.target.closest("[data-line]");
        if (!d) return;
        e.preventDefault();
        const line = view.state.doc.line(+d.dataset.line);
        view.dispatch({ selection: { anchor: line.from + (indentOf(line.text, 1) > 0 ? indentOf(line.text, 1) : 0) }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 4 + (+d.dataset.i) * view.defaultLineHeight }) });
        view.focus();
      });
      this.measure();
    }
    update(u) { if (u.docChanged || u.geometryChanged || u.viewportChanged) this.measure(); }
    measure() {
      this.view.requestMeasure({
        read: (v) => {
          const top = v.scrollDOM.scrollTop;
          const lh = v.defaultLineHeight;
          // Where the top of the visible area is, in the document's own heights.
          const docTop = v.scrollDOM.getBoundingClientRect().top - v.documentTop;
          // The pinned lines cover the top of the editor, so what matters is the first line
          // that's fully visible below them. Pinning more lines can hide another opener, so
          // look again until the answer settles.
          let lines = [];
          for (let round = 0; round <= MAX_STICKY; round++) {
            const cover = docTop + lines.length * lh;
            let block = v.lineBlockAtHeight(cover + 1);
            if (lines.length && block.top < cover - 1 && block.to < v.state.doc.length) block = v.lineBlockAt(block.to + 1);
            const next = headersFor(v.state, v.state.doc.lineAt(block.from).number).slice(-MAX_STICKY);
            if (next.join() === lines.join()) break;
            lines = next;
          }
          const left = v.contentDOM.getBoundingClientRect().left - v.dom.getBoundingClientRect().left;
          return { lines, left, lh, scrolled: top > 2 };
        },
        write: ({ lines, left, lh, scrolled }) => {
          const key = lines.join(",") + "|" + left;
          if (!scrolled || !lines.length) { this.dom.hidden = true; this.key = ""; return; }
          this.dom.hidden = false;
          if (key === this.key) return;
          this.key = key;
          this.dom.style.paddingLeft = left + "px";
          this.dom.innerHTML = "";
          const tree = syntaxTree(this.view.state);
          // Colour them with whatever highlighting this file really uses (Lust has its own).
          const state = this.view.state;
          const highlighter = { style: (tags) => highlightingFor(state, tags) };
          lines.forEach((n, i) => {
            const line = this.view.state.doc.line(n);
            const row = document.createElement("div");
            row.dataset.line = n;
            row.dataset.i = i;
            row.style.height = lh + "px";
            row.style.paddingLeft = "6px";
            let pos = line.from;
            const put = (to, cls) => {
              if (to <= pos) return;
              const sp = document.createElement("span");
              if (cls) sp.className = cls;
              sp.textContent = this.view.state.sliceDoc(pos, to);
              row.append(sp);
              pos = to;
            };
            highlightTree(tree, highlighter, (from, to, cls) => { put(Math.max(from, line.from), ""); put(Math.min(to, line.to), cls); }, line.from, line.to);
            put(line.to, "");
            this.dom.append(row);
          });
        },
      });
    }
    destroy() { this.view.scrollDOM.removeEventListener("scroll", this.onScroll); this.dom.remove(); }
  });
}
