// Semantic tokens from a language server: what each name is (a type, a method, a constant…), as
// classes for the editor. Kept apart from lspmore.js so it can be tested without a window.
// The server's token type and modifiers -> a class. Keywords, strings, numbers and comments are
// left to the grammar; this adds what the grammar can't know.
export function semanticClass(type, mods = []) {
  const t = String(type).toLowerCase(), m = new Set(mods.map((x) => String(x).toLowerCase()));
  let c = null;
  if (/namespace|module/.test(t)) c = "ns";
  else if (/typeparameter|type parameter/.test(t)) c = "tparam";
  else if (/enummember|enum member|constant/.test(t)) c = "const";
  else if (/interface/.test(t)) c = "iface";
  else if (/class|struct|record|enum|delegate|^type$|type name|builtintype/.test(t)) c = "type";
  else if (/method|function|extension/.test(t)) c = "fn";
  else if (/property|event/.test(t)) c = "prop";
  else if (/field/.test(t)) c = "field";
  else if (/parameter/.test(t)) c = "param";
  else if (/variable|local/.test(t)) c = "var";
  else if (/macro|preprocessor/.test(t)) c = "macro";
  else if (/decorator|attribute/.test(t)) c = "type";
  if (!c) return null;
  // A static readonly field or a readonly static property reads like a constant.
  if ((c === "field" || c === "prop" || c === "var") && m.has("readonly") && m.has("static")) c = "const";
  let cls = "cm-st-" + c;
  if (m.has("static") && (c === "fn" || c === "prop" || c === "field")) cls += " cm-st-static";
  if (m.has("deprecated")) cls += " cm-st-deprecated";
  return cls;
}

/** Decodes LSP's relative token data into [{ from, to, cls }]. */
export function decodeTokens(doc, data, legend) {
  const out = [], types = legend?.tokenTypes || [], modNames = legend?.tokenModifiers || [];
  let line = 0, ch = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const dl = data[i], dc = data[i + 1], len = data[i + 2], ti = data[i + 3], mi = data[i + 4];
    line += dl;
    ch = dl ? dc : ch + dc;
    const mods = [];
    for (let b = 0; b < modNames.length; b++) if (mi & (1 << b)) mods.push(modNames[b]);
    const cls = semanticClass(types[ti], mods);
    if (!cls || line >= doc.lines) continue;
    const l = doc.line(line + 1), from = Math.min(l.from + ch, l.to), to = Math.min(from + len, l.to);
    if (to > from) out.push({ from, to, cls });
  }
  return out;
}

