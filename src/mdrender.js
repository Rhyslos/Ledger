// Markdown → HTML for the preview (md.js sanitizes it): GitHub-flavoured Markdown via marked, plus
// footnotes, and the source line each top-level block starts on so the preview can follow the editor.
import { Marked } from "marked";

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Footnotes: [^id] in the text, [^id]: the note on its own line (indented lines continue it).
// The notes are collected while rendering and listed at the end, numbered in the order they're cited.
let notes = null; // { defs: Map(id -> tokens), order: [id] }
const footnotes = {
  extensions: [
    {
      name: "footnoteDef", level: "block",
      start: (src) => src.match(/^\[\^[^\]\s]+\]:/m)?.index,
      tokenizer(src) {
        const m = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?:[ \t]*\n)*(?: {2,}|\t)[^\n]*)*)(?:\n|$)/.exec(src);
        if (!m) return;
        const tok = { type: "footnoteDef", raw: m[0], id: m[1], tokens: [] };
        this.lexer.inline(m[2].replace(/\n(?: {2,4}|\t)/g, "\n").trim(), tok.tokens);
        return tok;
      },
      renderer(tok) { notes?.defs.set(tok.id, tok.tokens); return ""; },
    },
    {
      name: "footnoteRef", level: "inline",
      start: (src) => src.indexOf("[^"),
      tokenizer(src) {
        const m = /^\[\^([^\]\s]+)\](?!:)/.exec(src);
        if (m) return { type: "footnoteRef", raw: m[0], id: m[1] };
      },
      renderer(tok) {
        if (!notes) return escHtml(tok.raw);
        let n = notes.order.indexOf(tok.id) + 1;
        if (!n) n = notes.order.push(tok.id);
        const id = escHtml(tok.id);
        return `<sup data-fnref><a href="#fn-${id}" id="fnref-${id}">${n}</a></sup>`;
      },
    },
  ],
};
const md = new Marked({ gfm: true, breaks: false }, footnotes);

/** Markdown → HTML, with each top-level block's first source line (1-based) in order. */
export function toHtml(src) {
  src = src.replace(/\r\n?/g, "\n");
  notes = { defs: new Map(), order: [] };
  try {
    const tokens = md.lexer(src);
    // Definitions render last, but references may come first: collect them before rendering.
    for (const t of tokens) if (t.type === "footnoteDef") notes.defs.set(t.id, t.tokens);
    const lines = [];
    let line = 1;
    for (const t of tokens) {
      const skip = t.type === "space" || t.type === "def" || t.type === "footnoteDef";
      if (!skip) lines.push({ line, count: t.type === "html" ? null : 1, raw: t.type === "html" ? t.raw : null });
      line += (t.raw.match(/\n/g) || []).length;
    }
    let html = md.parser(tokens);
    const cited = notes.order.filter((id) => notes.defs.has(id));
    if (cited.length) {
      html += `<section data-footnotes><ol>${cited.map((id) => {
        const body = new md.Parser(md.defaults).parseInline(notes.defs.get(id));
        return `<li id="fn-${escHtml(id)}">${body} <a href="#fnref-${escHtml(id)}" data-fnback aria-label="Back to the text">↩</a></li>`;
      }).join("")}</ol></section>`;
    }
    return { html, lines };
  } finally { notes = null; }
}

