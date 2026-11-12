// Checks pure helpers used all over Ledger: output links (src/ansi.js) and the LSP snippet
// parser (src/lsp.js's unsnippet, loaded on its own since lsp.js needs a Tauri window).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ansiToHtml } from "../src/ansi.js";

const links = (line) => [...ansiToHtml(line).matchAll(/data-file="([^"]*)" data-line="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`);

test("output links: paths with spaces, relative paths, Lust", () => {
  assert.deepEqual(links("    at main (C:\\Users\\John Smith\\proj\\index.js:3:9)"), ["C:\\Users\\John Smith\\proj\\index.js:3"]);
  assert.deepEqual(links("error: src/main.rs:14:20 boom"), ["src/main.rs:14"]);
  assert.deepEqual(links("  main.lst:3:5  missing ;"), ["main.lst:3"]);
  assert.deepEqual(links("C:\\proj\\Player.cs(12,5): error CS0103: x"), ["C:\\proj\\Player.cs:12"]);
});

// unsnippet without importing lsp.js (which starts Tauri things).
const src = readFileSync(new URL("../src/lsp.js", import.meta.url), "utf8");
const unsnippet = new Function(src.slice(src.indexOf("export function unsnippet"), src.indexOf("const KIND = {")).replace("export ", "") + "; return unsnippet;")();

test("LSP snippets: nested placeholders, choices, variables, escapes", () => {
  assert.deepEqual(unsnippet("foo(${1:a, ${2:b}})$0"), { text: "foo(a, b)", cursor: 4 });
  assert.deepEqual(unsnippet("${1|one,two|} $0"), { text: "one ", cursor: 0 });
  assert.deepEqual(unsnippet("${TM_FILENAME:file}.rs"), { text: "file.rs", cursor: 7 });
  assert.deepEqual(unsnippet("a \\$ b $1"), { text: "a $ b ", cursor: 6 });
  assert.equal(unsnippet("fn ${1:name}(${2}) {\n\t$0\n}").text, "fn name() {\n\t\n}");
});

test("a dev server's address stays one link when its port is coloured differently (Vite)", () => {
  const vite = "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m";
  const html = ansiToHtml(vite);
  assert.match(html, /<a href="http:\/\/localhost:5173\/">http:\/\/localhost:5173\/<\/a>/);
  assert.match(html, /<span class="a-36"><a /);
  // Colours after the address carry on as before.
  assert.match(ansiToHtml("\x1b[36mhttp://localhost:\x1b[1m3000\x1b[22m\x1b[39m ready \x1b[31mred\x1b[39m"), /<\/a><\/span> ready <span class="a-31">red<\/span>/);
});

test("TypeScript and Vitest locations are clickable even when their parts are coloured apart", () => {
  const tsc = ansiToHtml("\x1b[96msrc/main.ts\x1b[0m:\x1b[93m3\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m TS2322");
  assert.match(tsc, /<a data-file="src\/main\.ts" data-line="3" data-col="7"[^>]*>src\/main\.ts:3:7<\/a>/);
  assert.match(tsc, /<span class="a-91">error<\/span>/);
  assert.match(ansiToHtml(" \x1b[31m❯\x1b[39m src/a.test.ts\x1b[2m:\x1b[22m\x1b[2m12:5\x1b[22m"), /data-file="src\/a\.test\.ts" data-line="12" data-col="5"/);
  // tsc without colours: src/main.ts(3,7): error TS…
  assert.match(ansiToHtml("src/main.ts(3,7): error TS2322: Type"), /data-file="src\/main\.ts" data-line="3" data-col="7"/);
  // Ordinary coloured words are left alone.
  assert.equal(ansiToHtml("\x1b[1m\x1b[31mBold\x1b[39m text\x1b[22m"), '<span class="a-b a-31">Bold</span><span class="a-b"> text</span>');
});

test("ESLint's problems link to the file named on the line above them", () => {
  const ctx = {};
  assert.match(ansiToHtml("\x1b[4m/home/u/p/src/App.tsx\x1b[24m", ctx), /<a data-file="\/home\/u\/p\/src\/App\.tsx" data-line="1"/);
  assert.match(ansiToHtml("  \x1b[2m12:5\x1b[22m  \x1b[31merror\x1b[39m  'x' is unused  no-unused-vars", ctx), /<a data-file="\/home\/u\/p\/src\/App\.tsx" data-line="12" data-col="5"[^>]*>12:5<\/a>/);
  assert.match(ansiToHtml("  3:1  warning  Unexpected console  no-console", ctx), /data-line="3" data-col="1"/);
  ansiToHtml("✖ 2 problems (1 error, 1 warning)", ctx);
  assert.doesNotMatch(ansiToHtml("  4:2  error  later", ctx), /<a /); // after the summary: no file
  assert.doesNotMatch(ansiToHtml("  4:2  error  no file yet", {}), /<a /);
  assert.doesNotMatch(ansiToHtml("> vite build", ctx), /<a /);
});
