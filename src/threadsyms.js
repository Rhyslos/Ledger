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

// ----- without a language server: a guess from the text -----
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "else", "match", "using", "lock", "foreach", "elif", "do", "try", "await", "typeof", "sizeof", "when", "loop"]);
const ID = "[A-Za-z_$][\\w$]*";
const DECLS = [
  [new RegExp(`\\b(class|struct|enum|trait|interface|record|object|impl|module|namespace)\\s+(?:<[^>]*>\\s*)?(?:[\\w:]+\\s+for\\s+)?(${ID})`), (m) => [m[2], { class: 5, struct: 23, enum: 10, trait: 11, interface: 11, record: 5, object: 5, impl: 5, module: 2, namespace: 3 }[m[1]]]],
  [new RegExp(`\\b(?:fn|function|def|func|sub)\\s+((?:${ID}[.:])*${ID})`), (m) => [m[1].split(/[.:]/).pop(), 12]],
  [new RegExp(`\\bmethod\\b[^(=]*?(${ID})\\s*\\(`), (m) => [m[1], 6]],
  [new RegExp(`\\b(?:const|let|var)\\s+(${ID})\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|${ID}\\s*=>)`), (m) => [m[1], 12]],
  // C#, Java, TypeScript and JavaScript methods: "public int Total(…) {", "async load(…) {".
  [new RegExp(`^\\s*(?:[\\w<>\\[\\],?.]+\\s+)*(${ID})\\s*(?:<[^>]*>)?\\s*\\([^;]*\\)\\s*(?:[:\\w<>\\[\\]?|\\s.]*)?(?:\\{|=>|$)`), (m) => (KEYWORDS.has(m[1]) ? null : [m[1], 6])],
];
const indentOf = (t) => t.length - t.trimStart().length;

/** What a line sits in, read from the text: the nearest line above it, less indented, that
 *  declares a function, method, class and the like. A symbol like documentSymbol's, or null. */
export function guessEnclosing(lines, line) {
  const own = lines[line] ?? "";
  let limit = indentOf(own);
  if (!own.trim()) return null;
  for (let l = line - 1; l >= 0 && limit > 0; l--) {
    const t = lines[l];
    if (!t.trim() || /^\s*[{}]\s*$/.test(t)) continue; // a brace on its own line (C#) isn't what it's in
    const ind = indentOf(t);
    if (ind >= limit) continue;
    limit = ind;
    for (const [re, take] of DECLS) {
      const m = re.exec(t);
      const got = m && take(m);
      if (!got || !got[0]) continue;
      const [name, kind] = got;
      // It ends at the next line as little indented as it (a closing } or "end" belongs to it).
      let end = l;
      for (let k = l + 1; k < lines.length; k++) {
        const u = lines[k];
        if (!u.trim()) continue;
        if (indentOf(u) <= ind) { if (/^\s*(\}|end\b|\))/.test(u)) end = k; break; }
        end = k;
      }
      const at = t.indexOf(name, m.index);
      return { name, kind, depth: 0, guessed: true, range: { start: { line: l, character: ind }, end: { line: end, character: (lines[end] || "").length } }, sel: { start: { line: l, character: at }, end: { line: l, character: at + name.length } } };
    }
  }
  return null;
}

/** The name a line declares (fn x, class X, method int x(…), const x = () =>…), or null. */
export function declName(text) {
  for (const [re, take] of DECLS) {
    const m = re.exec(text);
    const got = m && take(m);
    if (got?.[0]) return got[0];
  }
  return null;
}
