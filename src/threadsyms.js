// Red Thread's reading of document symbols (thread.js): what a use sits in, and imports.
// Symbols a use can sit inside and be followed from: functions and methods first, then variables,
// fields and properties, then classes, modules and the like.
const FUNCTIONS = new Set([6, 9, 12]);
const VALUES = new Set([7, 8, 13, 14]);
const CONTAINERS = new Set([2, 3, 5, 10, 11, 23]);
// An import names a thing without using it: left out of the list (and counted).
export const isImport = (line) => /^\s*(import\b|export\s+(\*|\{[^}]*\})\s+from\b|using\s+[\w.]+\s*;|use\s+[\w:{}, *]+;|(const|let|var)\s+[\w{}\s,]+=\s*require\()/.test(line);
export const KIND = { 2: "module", 3: "namespace", 5: "class", 6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 22: "enum member", 23: "struct", 26: "type parameter" };

export const inRange = (r, p) => (p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character)) && (p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character));

/** documentSymbol's answer, nested or flat, as one list with each symbol's depth. */
export function flatSymbols(res) {
  const out = [];
  const walk = (list, depth) => {
    for (const s of list || []) {
      const range = s.range || s.location?.range, sel = s.selectionRange || (range && { start: range.start, end: range.start }); // flat lists have no name range
      if (!range) continue;
      out.push({ name: s.name, kind: s.kind, detail: s.detail || "", range, sel, depth });
      walk(s.children, depth + 1);
    }
  };
  walk(res, 0);
  return out;
}

/** What a use sits in, to follow next: the innermost function or method; or, outside any function,
 *  the variable, field or property it's part of (export const stock = new Inventory(), a class's
 *  bag = new Inventory()); else the class or module around it. Null at the top level of a file. */
export function enclosing(symbols, pos) {
  const size = (s) => (s.range.end.line - s.range.start.line) * 1e4 + (s.range.end.character - s.range.start.character);
  const inner = (kinds) => {
    let best = null;
    for (const s of symbols) {
      if (!kinds.has(s.kind) || !inRange(s.range, pos) || inRange(s.sel, pos)) continue;
      if (!best || size(s) < size(best) || (size(s) === size(best) && s.depth > best.depth)) best = s;
    }
    return best;
  };
  const fn = inner(FUNCTIONS), box = inner(CONTAINERS), val = inner(VALUES);
  if (fn) return fn;
  if (val && (!box || size(val) < size(box))) return val;
  return box;
}

/** The symbol whose name is at this position (the definition), or the innermost one around it. */
export function symbolAt(symbols, pos) {
  return symbols.find((s) => inRange(s.sel, pos)) || null;
}
