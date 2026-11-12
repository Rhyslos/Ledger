// Red Thread: what a use sits in (the thing the thread follows next), and which lines are imports.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { flatSymbols, enclosing, symbolAt, isImport } from "../src/threadsyms.js";

const R = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
// class Player {            0
//   bag = new Inventory();  1
//   pickUp(item) {          2
//     const x = 1;          3
//     this.bag.add(item);   4
//   }                       5
// }                         6
// export const stock = new Inventory();   8
const syms = flatSymbols([
  { name: "Player", kind: 5, range: R(0, 0, 6, 1), selectionRange: R(0, 6, 0, 12), children: [
    { name: "bag", kind: 7, range: R(1, 2, 1, 24), selectionRange: R(1, 2, 1, 5) },
    { name: "pickUp", kind: 6, range: R(2, 2, 5, 3), selectionRange: R(2, 2, 2, 8), children: [
      { name: "x", kind: 14, range: R(3, 10, 3, 15), selectionRange: R(3, 10, 3, 11) },
    ] },
  ] },
  { name: "stock", kind: 14, range: R(8, 13, 8, 36), selectionRange: R(8, 13, 8, 18) },
]);

test("a use inside a method follows the method, not a local variable beside it", () => {
  assert.equal(enclosing(syms, { line: 4, character: 13 }).name, "pickUp");
  assert.equal(enclosing(syms, { line: 3, character: 14 }).name, "pickUp");
});

test("outside any function: the field or top-level constant it's part of", () => {
  assert.equal(enclosing(syms, { line: 1, character: 14 }).name, "bag");
  assert.equal(enclosing(syms, { line: 8, character: 25 }).name, "stock");
});

test("a symbol's own name isn't a use inside it; nothing around a line means the top level", () => {
  assert.equal(enclosing(syms, { line: 2, character: 4 }).name, "Player");
  assert.equal(enclosing(syms, { line: 7, character: 0 }), null);
});

test("the definition at a position, from its name", () => {
  assert.equal(symbolAt(syms, { line: 2, character: 5 }).name, "pickUp");
  assert.equal(symbolAt(syms, { line: 4, character: 5 }), null);
});

test("flat SymbolInformation lists work too", () => {
  const flat = flatSymbols([{ name: "f", kind: 12, location: { uri: "file:///a.js", range: R(0, 0, 3, 1) } }]);
  assert.equal(enclosing(flat, { line: 1, character: 2 }).name, "f");
});

test("imports are told apart from uses", () => {
  for (const l of ['import { Inventory } from "./inventory";', "import Inventory from './x'", 'export { Inventory } from "./inventory";', "using Game.Items;", "use crate::inventory::{Inventory, Item};", "const { Inventory } = require('./inv');"]) assert.ok(isImport(l), l);
  for (const l of ["const bag = new Inventory();", "export class Backpack extends Inventory {", "  inventory.add(item);", "export const stock = new Inventory();"]) assert.ok(!isImport(l), l);
});

import { guessEnclosing, declName } from "../src/threadsyms.js";

test("without a server: what a line sits in, guessed from the text, in several languages", () => {
  const rust = ["impl Counter {", "    pub fn add(&mut self, w: &str) {", "        self.words.push(w);", "    }", "}"];
  assert.deepEqual([guessEnclosing(rust, 2).name, guessEnclosing(rust, 2).kind, guessEnclosing(rust, 2).range.end.line], ["add", 12, 3]);
  const cs = ["public class Account", "{", "    public decimal Deposit(decimal amount)", "    {", "        if (amount <= 0)", "            throw new X();", "    }", "}"];
  assert.equal(guessEnclosing(cs, 5).name, "Deposit"); // past the "if" to the method
  const js = ["export class Player {", "  pickUp(item) {", "    this.bag.add(item);", "  }", "}", "const sell = (p) => {", "  p.pickUp(1);", "};"];
  assert.equal(guessEnclosing(js, 2).name, "pickUp");
  assert.equal(guessEnclosing(js, 6).name, "sell");
  const lust = ["class Tasks", "    method string summary(int done)", "        return done", "    end", "end"];
  assert.equal(guessEnclosing(lust, 2).name, "summary");
  assert.equal(guessEnclosing(["x = 1", "print(x)"], 1), null); // top level
});

test("without a server: a line that declares the name isn't a use of it", () => {
  assert.equal(declName("    pub fn add(&mut self, w: &str) {"), "add");
  assert.equal(declName("public class Account"), "Account");
  assert.equal(declName("    method string summary(int done)"), "summary");
  assert.equal(declName("const sell = (p) => {"), "sell");
  assert.equal(declName("        if (amount <= 0)"), null);
  assert.equal(declName("    stock.add(item);"), null);
});

test("Lust: keyword declarations only, nested by indentation (view lines aren't declarations)", async () => {
  const { textSymbols, declName } = await import("../src/threadsyms.js");
  const lines = ["class Tasks", "    method string summary(int done)", "        return done", "    end", "end", "view {", "    text summary(1)", "}"];
  const syms = textSymbols(lines, true);
  assert.deepEqual(syms.map((s) => [s.name, s.children.map((c) => c.name)]), [["Tasks", ["summary"]]]);
  assert.equal(declName("    text summary(1)", true), null);
  assert.equal(declName("    text summary(1)"), "summary"); // in C#-like languages it would be
});
