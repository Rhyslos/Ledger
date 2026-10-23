// Checks the Lust view help (src/luststyles.js): where the cursor is, what's suggested there,
// the colour swatches and the hover help. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLES, STYLE, PIECES, COLOURS, fits, styleContext, suggestions, colourSpots, explainAt, namedStyles, ownerOf } from "../src/luststyles.js";

// The cursor is where | is.
const at = (src) => { const pos = src.indexOf("|"); return { text: src.slice(0, pos) + src.slice(pos + 1), pos }; };
const cx = (src) => { const { text, pos } = at(src); return styleContext(text, pos); };
const labels = (src) => { const { text, pos } = at(src); return (suggestions(styleContext(text, pos), text) || []).map((s) => s.label); };

test("the table is complete and consistent", () => {
  const kinds = new Set(["none", "number", "colour", "text", "bool", "fill", "styles"]);
  const places = new Set(["pieces", "view", ...Object.keys(PIECES)]);
  const names = new Set();
  for (const s of STYLES) {
    assert.ok(!names.has(s.name), "twice: " + s.name);
    names.add(s.name);
    for (const k of s.takes.split(" ")) assert.ok(kinds.has(k), `${s.name} takes ${k}`);
    for (const p of s.on.split(" ")) assert.ok(places.has(p), `${s.name} on ${p}`);
    assert.ok(s.doc && s.example, s.name + " has a doc and an example");
  }
  // Every word Lust knows today (LUST.md section 17, check.rs check_styles).
  for (const w of "pad padX padY padTop padRight padBottom padLeft gap width height grow minWidth maxWidth minHeight maxHeight size tiny small large huge weight bold muted strike nowrap color background subtle round pill border borderWidth shadow opacity left center right top middle bottom spread hover placeholder from to step cover disabled title tip dark font animate columns cell down open x y toX toY radius thick".split(" ")) assert.ok(STYLE[w], w);
  for (const p of "column row stack scroll space text button input textarea checkbox slider image every key dropdown menu item divider dialog grid split tabs tab branch progress canvas box circle line".split(" ")) assert.ok(PIECES[p], p);
  assert.equal(Object.keys(COLOURS).length, 2 + 9 + 9 + 9 * 9);
  for (const hex of Object.values(COLOURS)) assert.match(hex, /^#[0-9a-f]{6}$/);
  assert.equal(COLOURS.blue7, "#1c7ed6");
  assert.equal(COLOURS.gray, undefined); // gray only comes in shades
});

test("outside a [ ] there is no style context", () => {
  assert.equal(cx("column |"), null);
  assert.equal(cx("column [gap 8] { | }"), null);
  assert.equal(cx("column [gap 8]|"), null);
  assert.equal(cx("int[] xs = [1, |"), null); // a list, not styles
  assert.equal(cx("state Mood = [Calm, |"), null);
  assert.equal(cx("save game = [|"), null);
  assert.equal(cx("x = items[|"), null);
  assert.equal(cx("text = [|"), null); // a variable called text
  assert.equal(cx("-- column [|"), null); // a comment
  assert.equal(cx('text "column [|"'), null); // quoted text
  assert.equal(cx("--[[ column [\n|"), null);
});

test("which piece a [ ] belongs to", () => {
  assert.deepEqual(ownerOf("    view "), { kind: "view" });
  assert.deepEqual(ownerOf("style card = "), { kind: "style" });
  assert.deepEqual(ownerOf('  text "Hi" + name '), { kind: "piece", piece: "text" });
  assert.deepEqual(ownerOf("  text (#todos).text() "), { kind: "piece", piece: "text" });
  assert.deepEqual(ownerOf("  TodoRow "), { kind: "custom", piece: "TodoRow" });
  assert.equal(ownerOf("  text.trim() "), null);
  assert.equal(ownerOf("  text("), null);
  assert.equal(ownerOf("  todos "), null);
});

test("inside a piece's [ ]", () => {
  const c = cx("    column [|");
  assert.equal(c.kind, "piece");
  assert.equal(c.piece, "column");
  assert.equal(c.at, "name");
  assert.equal(c.word, "");
  const b = cx('button "Go" [blue, ro|');
  assert.equal(b.piece, "button");
  assert.equal(b.at, "name");
  assert.equal(b.word, "ro");
  assert.equal(cx('text "Hi" [|').piece, "text");
  // over several lines
  assert.equal(cx("column [\n    gap 8,\n    pa|\n] {").word, "pa");
  // in a nested view, after other pieces
  assert.equal(cx("view [title \"A\"] {\n  column [gap 8] {\n    slider volume [from 0, |").piece, "slider");
});

test("the window's [ ] has only the window's settings", () => {
  const c = cx('view [title "Hi", |');
  assert.equal(c.kind, "view");
  assert.deepEqual(labels('view [title "Hi", |').sort(), ["background", "dark", "font", "height", "minHeight", "minWidth", "title", "width"]);
  assert.ok(!labels("view [|").includes("blue")); // no colour words on their own
  assert.ok(!labels("column [|").includes("title"));
});

test("piece-only words go only on their piece", () => {
  assert.ok(labels("input name [|").includes("placeholder"));
  assert.ok(!labels("text name [|").includes("placeholder"));
  for (const w of ["from", "to", "step"]) {
    assert.ok(labels("slider volume [|").includes(w));
    assert.ok(!labels("button \"Go\" [|").includes(w));
  }
  assert.ok(labels('image "a.png" [|').includes("cover"));
  assert.ok(!labels("row [|").includes("cover"));
  // everyday words fit everywhere, also on your own pieces and in named styles
  for (const src of ["row [|", "TodoRow [|", "style card = [|", "input name [|"]) {
    const l = labels(src);
    for (const w of ["pad", "gap", "round", "background", "hover", "disabled", "blue", "gray3"]) assert.ok(l.includes(w), `${w} in ${src}`);
    assert.ok(!l.includes("title"), "no title in " + src);
  }
  // a named style can be for any piece
  assert.ok(labels("style field = [|").includes("placeholder"));
  assert.ok(!labels("TodoRow [|").includes("placeholder"));
});

test("after a word that takes a colour, colours", () => {
  for (const w of ["color", "background", "border"]) {
    const c = cx(`button "Go" [${w} |`);
    assert.equal(c.at, "value");
    assert.equal(c.style, w);
    const l = labels(`button "Go" [${w} bl|`);
    assert.ok(l.includes("blue") && l.includes("gray9") && l.includes("white"));
    assert.ok(!l.includes("pad"));
  }
  assert.equal(cx("row [background bl|").word, "bl");
  assert.ok(labels("view [background |").includes("gray1")); // the window's background too
  assert.deepEqual(labels("row [width |"), ["fill"]);
  assert.equal(suggestions(cx("row [pad |"), ""), null); // a number: nothing to suggest
  assert.equal(cx('row [disabled name == "|'), null); // in quoted text
  assert.equal(cx("row [disabled not rea|").at, "other");
});

test("hover:[ … ] holds styles for the same piece", () => {
  const c = cx("row [gap 8, hover:[|");
  assert.equal(c.kind, "piece");
  assert.equal(c.piece, "row");
  assert.equal(c.nested, true);
  assert.equal(c.at, "name");
  assert.equal(cx("row [gap 8, hover:[background |").style, "background");
  // back out of the hover, in the outer list again
  const out = cx("row [hover:[background gray1], |");
  assert.equal(out.nested, false);
  assert.equal(out.at, "name");
  // another [ inside a style list is a value's, not styles
  assert.equal(cx("row [grow sizes[|"), null);
});

test("named styles", () => {
  const src = "style card = [pad 16, round, shadow];\nstyle chip = [pad 6];\n\ncolumn [|";
  assert.deepEqual(namedStyles(src), { card: "pad 16, round, shadow", chip: "pad 6" });
  const l = labels(src);
  assert.ok(l.includes("card") && l.includes("chip"));
  assert.ok(!labels("style card = [pad 16];\nview [|").includes("card"));
});

test("fits", () => {
  assert.equal(fits(STYLE.title, "view"), true);
  assert.equal(fits(STYLE.title, "piece", "text"), false);
  assert.equal(fits(STYLE.pad, "view"), false);
  assert.equal(fits(STYLE.width, "view"), true);
  assert.equal(fits(STYLE.placeholder, "piece", "input"), true);
  assert.equal(fits(STYLE.placeholder, "custom", "Search"), false);
});

test("colour swatches", () => {
  const text = 'red = 1;\nrow [blue, background gray1, border "#2f9e44", color "#abc"] {\n  text "blue" [color "nope"];\n}';
  const spots = colourSpots(text).map((s) => [text.slice(s.from, s.to), s.colour]);
  assert.deepEqual(spots, [["blue", COLOURS.blue], ["gray1", COLOURS.gray1], ['"#2f9e44"', "#2f9e44"], ['"#abc"', "#abc"]]);
  // only those in view
  const later = text.indexOf("background");
  assert.equal(colourSpots(text, later).length, 3);
  assert.deepEqual(colourSpots(""), []);
});

test("hover help", () => {
  const { text, pos } = at("column [p|ad 16, background blue] {\n    slider volume;\n}");
  const e = explainAt(text, pos);
  assert.equal(e.title, "pad");
  assert.match(e.doc, /Space inside/);
  assert.equal(text.slice(e.from, e.to), "pad");
  const col = explainAt(text, text.indexOf("blue") + 1);
  assert.equal(col.colour, COLOURS.blue);
  const piece = explainAt(text, text.indexOf("slider") + 2);
  assert.equal(piece.title, "slider");
  assert.equal(explainAt(text, text.indexOf("volume")), null);
  assert.equal(explainAt(text, text.indexOf("16")), null);
  assert.equal(explainAt("view [title \"A\"] {", 1).title, "view");
  assert.equal(explainAt("text = 4;", 1), null); // a variable, not a piece
  assert.equal(explainAt("style card = [pad 4];\nrow [card]", 30).title, "card");
});

test("odd input never throws", () => {
  const bits = ["[", "]", "{", "}", "(", ")", ",", " ", "\n", '"', "--", "--[[", "]]", "view", "column", "pad", "hover:", "#", "blue", "style x =", "16"];
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 2000; n++) {
    let s = "";
    for (let k = 0; k < 30; k++) s += bits[Math.floor(rand() * bits.length)];
    for (let p = 0; p <= s.length; p += 3) {
      const c = styleContext(s, p);
      suggestions(c, s);
      explainAt(s, p);
    }
    colourSpots(s);
  }
});

test("a big file stays quick", () => {
  const row = 'row [gap 8, pad 4, hover:[background gray1]] { text "Item" [muted, color blue6]; }\n';
  const text = row.repeat(3000); // about 250 KB
  const t = performance.now();
  styleContext(text, text.length - 10);
  colourSpots(text);
  assert.ok(performance.now() - t < 500, "took " + (performance.now() - t) + " ms");
});
