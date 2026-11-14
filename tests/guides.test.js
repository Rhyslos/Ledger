// The guides (scripts/guides.mjs makes src-tauri/guides/ from guides/): what's built is what's
// written, every link goes somewhere, and Lust code is coloured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildGuides, outPath, highlightLust, checkLinks } from "../scripts/guides.mjs";

test("the built guides are up to date with guides/ (run: npm run guides)", () => {
  const pages = buildGuides(); // throws on a broken link
  for (const [name, html] of Object.entries(pages)) assert.equal(readFileSync(outPath(name), "utf8").replace(/\r\n/g, "\n"), html, `${name}.html is out of date`);
});

test("a link to a place that isn't there is caught", () => {
  const page = (body) => `<main>${body}</main><script>x</script>`;
  assert.deepEqual(checkLinks({ lust: page('<h2 id="a"></h2><a href="#a"></a>'), ledger: page('<a href="lust.html#a"></a>') }), []);
  assert.equal(checkLinks({ lust: page('<a href="#nope"></a>'), ledger: page("") }).length, 1);
  assert.equal(checkLinks({ lust: page(""), ledger: page('<a href="lust.html#nope"></a>') }).length, 1);
});

test("Lust code is coloured the way Ledger colours it", () => {
  const h = highlightLust('int hp = 3; -- note\nis hp < 5? then { print("{hp}"); }\ntext label [muted];');
  assert.match(h, /<span class="tk-t">int<\/span>/);
  assert.match(h, /<span class="tk-c">-- note<\/span>/);
  assert.match(h, /<span class="tk-f">is<\/span> hp &lt; <span class="tk-v">5<\/span>/);
  assert.match(h, /<span class="tk-o">print<\/span>/);
  assert.match(h, /<span class="tk-n">text<\/span> label/); // a piece at the start of a line
  assert.doesNotMatch(highlightLust("x.text()"), /tk-n/); // a method, not a piece
  assert.match(highlightLust("GameState.Combat"), /<span class="tk-n">GameState<\/span><span class="tk-p">\.<\/span><span class="tk-s">Combat<\/span>/);
});
