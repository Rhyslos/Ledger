// cargo's messages as Problems (src/rustdiag.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cargoDiags } from "../src/rustdiag.js";

test("errors and warnings with their place, once each", () => {
  const c = cargoDiags();
  for (const l of [
    "    Checking wordfreq v0.1.0 (/p/wordfreq)",
    "\x1b[0m\x1b[1m\x1b[38;5;9merror[E0599]\x1b[0m\x1b[0m\x1b[1m: no method named `foo` found for struct `Counter` in the current scope\x1b[0m",
    "  \x1b[0m\x1b[0m\x1b[1m\x1b[38;5;12m--> \x1b[0m\x1b[0msrc/main.rs:29:53\x1b[0m",
    "   |",
    "29 |     c.foo();",
    "warning: unused variable: `x`",
    " --> src/lib.rs:3:9",
    "  = note: `#[warn(unused_variables)]` on by default",
    "warning: length comparison to zero",
    "  --> src/lib.rs:10:8",
    "   = help: for further information visit https://rust-lang.github.io/rust-clippy",
    "warning: `wordfreq` (lib) generated 2 warnings",
    "error: could not compile `wordfreq` (bin \"wordfreq\") due to 1 previous error",
    "  --> src/never.rs:1:1",
    "error[E0599]: no method named `foo` found for struct `Counter` in the current scope",
    "  --> src/main.rs:29:53",
  ]) c.line(l);
  const m = c.take();
  assert.deepEqual([...m.keys()].sort(), ["src/lib.rs", "src/main.rs"]);
  const main = m.get("src/main.rs");
  assert.equal(main.length, 1);
  assert.deepEqual([main[0].severity, main[0].range.start.line, main[0].range.start.character], [1, 28, 52]);
  assert.match(main[0].message, /no method named `foo`.*\(E0599\)$/);
  const lib = m.get("src/lib.rs");
  assert.deepEqual(lib.map((d) => [d.severity, d.range.start.line]), [[2, 2], [2, 9]]);
});

test("a message and its place in one piece of output", () => {
  const c = cargoDiags();
  c.line("error: expected one of `!` or `::`, found keyword `pub`\n --> src/lib.rs:6:1\n  |\n4 | double");
  assert.deepEqual(c.take().get("src/lib.rs").map((d) => d.range.start.line), [5]);
});
