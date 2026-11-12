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
