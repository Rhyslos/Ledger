// Checks the pure parts of the editing features: colours in code (src/colour.js), Emmet's
// "where can an abbreviation go" rules (src/emmet.js), CSV parsing (src/csv.js), merge conflicts
// and blame parsing (src/gitmore.js). Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection, Text } from "@codemirror/state";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { ensureSyntaxTree } from "@codemirror/language";
import { coloursIn, parseColour, formatColour } from "../src/colour.js";
import { findAbbreviation, expandAbbreviation } from "../src/emmet.js";
import { parseCsv } from "../src/csv.js";
import { findConflicts, resolution, parseBlame, ago } from "../src/gitmore.js";

test("colours are found and written back the way they were written", () => {
  const found = coloursIn("a{color:#abc; b:#AABBCC; c:rgb(10 20 30 / 50%); d:hsl(210, 50%, 40%)}", "css").map((m) => m.text);
  assert.deepEqual(found, ["#abc", "#AABBCC", "rgb(10 20 30 / 50%)", "hsl(210, 50%, 40%)"]);
  const red = { r: 255, g: 0, b: 0, a: 1 };
  assert.equal(formatColour(red, parseColour("#abc").fmt), "#f00");
  assert.equal(formatColour(red, parseColour("#AABBCC").fmt), "#FF0000");
  assert.equal(formatColour({ ...red, a: 0.5 }, parseColour("rgb(1, 2, 3)").fmt), "rgba(255, 0, 0, 0.5)");
  assert.equal(formatColour(red, parseColour("Color(0.2, 0.4, 0.6)").fmt), "Color(1, 0, 0)");
  // Only alpha moved: hsl() keeps its numbers.
  const h = parseColour("hsl(120, 50%, 50%)");
  assert.equal(formatColour({ r: h.r, g: h.g, b: h.b, a: 0.5 }, h.fmt), "hsla(120, 50%, 50%, 0.5)");
});

test("things that aren't colours get no swatch", () => {
  assert.deepEqual(coloursIn("&#160; #define x color(0.1, 0.2, 0.3)", "javascript"), []);
  assert.deepEqual(coloursIn('<a href="#cafe">x</a><rect fill="url(#abc)"/>', "html"), []);
  assert.deepEqual(coloursIn("Color(0.1, 0.2, 0.3)", "javascript"), []); // Godot's Color only in Godot files
  assert.deepEqual(coloursIn("fixes #123", "markdown"), []);
  assert.equal(coloursIn("Color(0.1, 0.2, 0.3)", "gdscript").length, 1);
});

const LANG = { html: html(), css: css(), jsx: javascript({ jsx: true }), scss: [] };
function emmet(lang, src) {
  const pos = src.indexOf("|"), doc = src.replace("|", "");
  const st = EditorState.create({ doc, selection: EditorSelection.cursor(pos), extensions: [LANG[lang]] });
  ensureSyntaxTree(st, doc.length, 5000);
  const f = findAbbreviation(st, lang);
  return f && expandAbbreviation(f);
}

test("Emmet expands where abbreviations make sense", () => {
  assert.match(emmet("html", "<body>\n  ul>li*2|\n</body>"), /^<ul>\n\t<li>\$\{1\}<\/li>/);
  assert.equal(emmet("css", ".a {\n  df|\n}"), "display: flex;");
  assert.equal(emmet("scss", ".a {\n  p10-20|\n}"), "padding: 10px 20px;");
  assert.match(emmet("jsx", "const A = () => (\n  div.card>p|\n);"), /^<div className="card">/);
  assert.match(emmet("jsx", "return (\n  Card|\n);"), /^<Card>/);
});

test("Emmet leaves ordinary text and code alone", () => {
  for (const [lang, src] of [
    ["html", "<body>\n  hello|\n</body>"], ["html", "<div cl|></div>"], ["html", "<!-- ul>li| -->"], ["html", "<script>\n  a.b|\n</script>"],
    ["css", "body|"], ["css", ".a {\n  color: red;|\n}"], ["scss", "p10|"],
    ["jsx", "console.log(user.na|"], ["jsx", "items.map((it) => it.name|"], ["jsx", "if (a > b.c|"], ["jsx", "call(x.y|"], ["jsx", "const s = 'div.x|';"],
  ]) assert.equal(emmet(lang, src), null, src);
});

test("CSV: quotes, separators inside quotes, line breaks inside quotes", () => {
  const rows = parseCsv('a;b\n"x; y";"he said ""hi"""\n"two\nlines";3\n', ";");
  assert.deepEqual(rows.map((r) => r.cells), [["a", "b"], ["x; y", 'he said "hi"'], ["two\nlines", "3"]]);
  assert.deepEqual(rows.map((r) => r.line), [0, 1, 2]);
  assert.deepEqual(parseCsv("a,b\r\n1,2", ",").map((r) => r.cells), [["a", "b"], ["1", "2"]]);
});

test("merge conflicts: found, and each side kept", () => {
  const doc = Text.of("top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\nend".split("\n"));
  const [c] = findConflicts(doc);
  assert.deepEqual([c.start, c.mid, c.end, c.theirs], [2, 4, 6, "feature"]);
  assert.equal(resolution(doc, c, "ours"), "ours\n");
  assert.equal(resolution(doc, c, "theirs"), "theirs\n");
  assert.equal(resolution(doc, c, "both"), "ours\ntheirs\n");
  assert.deepEqual(findConflicts(Text.of(["no", "conflicts"])), []);
});

test("blame: porcelain output to a commit per line", () => {
  const sha = "a".repeat(40);
  const out = `${sha} 1 1 2\nauthor Yuna\nauthor-mail <y@x>\nauthor-time 1700000000\nsummary First\n\tline one\n${sha} 2 2\n\tline two\n`;
  const lines = parseBlame(out);
  assert.equal(lines[1].author, "Yuna");
  assert.equal(lines[2], lines[1]);
  assert.equal(lines[1].summary, "First");
  assert.equal(ago(Date.now() - 3 * 86400e3), "3 days ago");
});
