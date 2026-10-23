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
