// How Markdown looks in the editor: headings by size, the # * ` markers dimmed, code on a tinted
// background and quotes with a bar, so the source reads like a document while staying plain text.
import { ViewPlugin, Decoration } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { Prec, RangeSetBuilder } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

const style = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700", color: "var(--ink)" },
  { tag: t.heading2, fontSize: "1.35em", fontWeight: "650", color: "var(--ink)" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "600", color: "var(--ink)" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600", color: "var(--ink)" },
  { tag: t.processingInstruction, color: "var(--faint) !important", fontWeight: "400 !important" },
  { tag: t.quote, color: "var(--muted)" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.url, color: "var(--faint)" },
  { tag: t.list, color: "var(--accent)" },
  { tag: t.contentSeparator, color: "var(--faint)" },
]);

const line = (cls) => Decoration.line({ class: cls });
const code = Decoration.mark({ class: "cm-md-code" });

function build(view) {
  const b = new RangeSetBuilder();
  const doc = view.state.doc;
  const marks = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: (n) => {
        const name = n.name;
        let cls = null;
        if (name === "FencedCode" || name === "CodeBlock") cls = "cm-md-fence";
        else if (name === "Blockquote") cls = "cm-md-quote";
        else if (name === "InlineCode") { marks.push([n.from, n.to, code]); return false; }
        if (!cls) return;
        const a = doc.lineAt(Math.max(n.from, from)).number, z = doc.lineAt(Math.min(n.to, to)).number;
        for (let i = a; i <= z; i++) {
          const ln = doc.line(i);
          let c = cls;
          if (cls === "cm-md-fence") { if (ln.from <= n.from) c += " cm-md-fence-first"; if (ln.to >= n.to) c += " cm-md-fence-last"; }
          marks.push([ln.from, ln.from, line(c)]);
        }
        return cls === "cm-md-quote" ? undefined : false;
      },
    });
  }
  // Line decorations first at a position, then marks, in order.
  marks.sort((x, y) => x[0] - y[0] || (x[2].spec.class?.startsWith("cm-md-code") ? 1 : 0) - (y[2].spec.class?.startsWith("cm-md-code") ? 1 : 0) || x[1] - y[1]);
  let last = -1;
  for (const [f, to, d] of marks) {
    if (f === to && f === last && d !== code) continue; // one line class per line (a quote in a quote)
    b.add(f, to, d);
    if (f === to) last = f;
  }
  return b.finish();
}

const blocks = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view); }
  update(u) { if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view); }
}, { decorations: (v) => v.decorations });

export const markdownLook = () => [Prec.high(syntaxHighlighting(style)), blocks];
