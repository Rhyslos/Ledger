// Markdown: the preview's renderer (footnotes, source lines) and the code-fence languages.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { toHtml } from "../src/mdrender.js";
import { fenceLanguage } from "../src/langs.js";

test("each block knows the source line it starts on", () => {
  const { lines } = toHtml("# Title\n\nPara one\nstill one\n\n- a\n- b\n\n```js\nx\n```\n");
  assert.deepEqual(lines.map((l) => l.line), [1, 3, 6, 9]);
});

test("Windows line endings count the same", () => {
  const { lines } = toHtml("# A\r\n\r\nB\r\n");
  assert.deepEqual(lines.map((l) => l.line), [1, 3]);
});

test("HTML blocks are counted by what they become (a comment is nothing)", () => {
  const { lines } = toHtml("<!-- x -->\n\ntext\n");
  assert.equal(lines[0].count, null);
  assert.equal(lines[0].raw.trim(), "<!-- x -->");
});

test("footnotes: numbered in the order cited, listed at the end", () => {
  const { html, lines } = toHtml("Two[^b] and one[^a].\n\n[^a]: First.\n[^b]: Second\n    continued.\n");
  assert.match(html, /href="#fn-b" id="fnref-b">1</);
  assert.match(html, /href="#fn-a" id="fnref-a">2</);
  assert.match(html, /<section data-footnotes><ol><li id="fn-b">Second\ncontinued\./);
  assert.equal(lines.length, 1); // the definitions aren't blocks of their own
});

test("a reference with no note stays as text, and no list is added", () => {
  const { html } = toHtml("See[^none].\n");
  assert.doesNotMatch(html, /data-footnotes/);
});

test("code fences: Ledger's languages and common extras, by the names people write", () => {
  for (const n of ["ts", "TypeScript", "rust", "cs", "c#", "json", "yml", "bash", "sh", "py", "diff", "sql", "go", "cpp", "rust title=main.rs"]) assert.ok(fenceLanguage(n), n);
  assert.equal(fenceLanguage(""), null);
  assert.equal(fenceLanguage("mermaid"), null);
  assert.equal(fenceLanguage("md"), null); // not Markdown inside Markdown
});
