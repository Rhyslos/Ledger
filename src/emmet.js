// Emmet: type an abbreviation and press Tab. ul>li.item*3, div.card>h2{Title}+p, ! for a whole page,
// link:css, input:email in HTML and JSX; m10, df, p10-20, bgc#fff in CSS (and <style> blocks).
// Tab only expands where an abbreviation makes sense: in HTML text (not inside a tag, a comment or
// a <script>), in JSX children or right after "(" in JSX files, and at the start of a line inside a
// CSS rule. A plain word expands only when it's an HTML element (or a capitalised component in JSX),
// so Tab after ordinary text still indents. The suggestion list shows what an abbreviation becomes.
import expand, { extract } from "emmet";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { syntaxTree, indentUnit } from "@codemirror/language";
import { snippet } from "@codemirror/autocomplete";

const SYNTAX = { html: "html", jsx: "jsx", tsx: "jsx", css: "css", scss: "scss", less: "less" };
const TAGS = new Set(("a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr svg").split(" "));
const OPERATORS = /[.#>+*^{[(:!]/;

const ancestors = (state, pos) => { const out = []; for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) out.push(n.name); return out; };
// Whether JSX can start at `pos` outside a tag: right after a "(" that opens a group, not a call
// ("return (", "=> (", "= (", "? (", ", (" and the like), looking back a few lines.
function jsxCanStart(state, pos) {
  const text = state.sliceDoc(Math.max(0, pos - 400), pos).replace(/\s+$/, "");
  if (!text.endsWith("(")) return false;
  const before = text.slice(0, -1).replace(/\s+$/, "");
  return !before || /(^|[^\w$.])return$|=>$|[=(,?:&|[{]$/.test(before);
}
// The element the abbreviation starts with: "div" in div.card>p, "Card" in Card*2.
const firstName = (abbr) => /^[A-Za-z][\w-]*/.exec(abbr)?.[0] || "";
function inCssBlock(state, pos, lang, names) {
  if (lang === "css" || names.includes("StyleSheet")) return names.includes("Block");
  // SCSS and Less have no syntax tree: count braces before the cursor.
  const text = state.sliceDoc(Math.max(0, pos - 20000), pos).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"[^"\n]*"|'[^'\n]*'/g, "");
  let depth = 0;
  for (const c of text) depth += c === "{" ? 1 : c === "}" ? -1 : 0;
  return depth > 0;
}

/** The abbreviation before the cursor and how to expand it, or null where Tab should just indent. */
export function findAbbreviation(state, lang) {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty || !SYNTAX[lang]) return null;
  const pos = sel.main.head, line = state.doc.lineAt(pos), before = line.text.slice(0, pos - line.from);
  const next = line.text[pos - line.from];
  if (next && !/[\s<)};]/.test(next)) return null;
  const names = lang === "scss" || lang === "less" ? [] : ancestors(state, pos);
  const stylesheet = lang === "css" || lang === "scss" || lang === "less" || names.includes("StyleSheet");
  const ex = extract(before, before.length, { type: stylesheet ? "stylesheet" : "markup", lookAhead: false });
  if (!ex || !ex.abbreviation) return null;
  const abbr = ex.abbreviation, from = line.from + ex.start;
  if (stylesheet) {
    if (before.slice(0, ex.start).trim() || /^[.#&@:]/.test(abbr) || !inCssBlock(state, from, lang, names)) return null;
    return { from, to: pos, abbr, type: "stylesheet", syntax: names.includes("StyleSheet") ? "css" : SYNTAX[lang] };
  }
  const bare = /^[A-Za-z][\w-]*$/.test(abbr);
  const charBefore = before[ex.start - 1];
  if (lang === "html") {
    if (names.some((n) => n === "OpenTag" || n === "CloseTag" || n === "SelfClosingTag" || n === "Comment" || n === "Script" || n === "Attribute")) return null;
    if (charBefore && !/[\s>]/.test(charBefore)) return null;
    if (bare && !TAGS.has(abbr.toLowerCase())) return null;
    if (!bare && !OPERATORS.test(abbr)) return null;
  } else {
    if (names.some((n) => /String|Comment|TemplateString|JSXAttribute/.test(n))) return null;
    const inJsx = names[0] === "JSXText" || (names.includes("JSXElement") && charBefore === ">");
    if (!inJsx && !jsxCanStart(state, from)) return null; // outside a tag, only where JSX can begin
    if (charBefore && !/[\s>(]/.test(charBefore)) return null;
    // It has to start with an HTML element or a component, so user.name or items.map isn't one.
    const first = firstName(abbr);
    if (first ? !TAGS.has(first) && !/^[A-Z]/.test(first) : !/^[.#]/.test(abbr)) return null;
    if (!bare && !OPERATORS.test(abbr)) return null;
  }
  return { from, to: pos, abbr, type: "markup", syntax: SYNTAX[lang] === "html" ? "html" : "jsx" };
}

const field = (i, p) => `\${${i}${p ? ":" + p.replace(/[{}]/g, "") : ""}}`;
export function expandAbbreviation(found) {
  try {
    const text = expand(found.abbr, { type: found.type, syntax: found.syntax, options: { "output.field": field } });
    if (!text || (found.type === "stylesheet" && !text.includes(":"))) return null;
    return text;
  } catch { return null; }
}

function run(lang) {
  return (view) => {
    const found = findAbbreviation(view.state, lang);
    const text = found && expandAbbreviation(found);
    if (!text) return false;
    snippet(text)(view, null, found.from, found.to);
    return true;
  };
}

/** Tab expansion for a file in `lang` (nothing for other languages). */
export const emmetFor = (lang) => (SYNTAX[lang] ? Prec.high(keymap.of([{ key: "Tab", run: run(lang) }])) : []);

const oneLine = (t) => { const s = t.replace(/\s*\n\s*/g, "").replace(/\s+/g, " ").trim(); return s.length > 48 ? s.slice(0, 47) + "…" : s; };
/** A suggestion showing what the abbreviation becomes (only for ones with operators, not words). */
export const emmetSource = (lang) => (SYNTAX[lang] ? (ctx) => {
  const found = findAbbreviation(ctx.state, lang);
  if (!found) return null;
  // Words are what the language server is for; only offer abbreviations that are clearly Emmet.
  if (found.type === "markup" ? /^[A-Za-z][\w-]*$/.test(found.abbr) : !/\d|[#:+!]/.test(found.abbr)) return null;
  const text = expandAbbreviation(found);
  if (!text) return null;
  const preview = text.replace(/\$\{\d+(?::([^}]*))?\}/g, "$1").replace(/\t/g, "  ");
  return {
    from: found.from,
    options: [{ label: found.abbr, detail: "→ " + oneLine(preview) + "  · Emmet", type: "emmet", info: () => { const pre = document.createElement("pre"); pre.className = "cm-emmet-preview"; pre.textContent = preview; return pre; }, apply: (view, c, from, to) => snippet(text)(view, c, from, to) }],
    filter: false,
  };
} : null);

export function initEmmet(app) {
  app.extraExt.push((path, b) => (app.settings.emmet === false ? [] : emmetFor(b.lang)));
  app.command("emmet.wrap", "Emmet: wrap with abbreviation", [], async () => {
    const b = app.S.bufs.get(app.S.active), v = app.view;
    if (!b || !v || b.ro) return;
    if (!SYNTAX[b.lang] || /css|scss|less/.test(SYNTAX[b.lang])) { app.toast("Wrapping works in HTML and JSX files."); return; }
    const abbr = (await app.promptText("Wrap with (e.g. div.card, ul>li*, a[href=#])", "", "e.g. div.card"))?.trim();
    if (!abbr) return;
    if (!wrapWithAbbreviation(v, b.lang, abbr)) app.toast("That isn't an abbreviation Emmet understands.");
    v.focus();
  }, { alias: "emmet wrap surround tag" });
}

/** Emmet's "wrap with abbreviation": the selection (or the cursor's line) inside what `abbr`
 *  makes, e.g. ul>li* puts each selected line in its own <li>. Returns false if it can't. */
export function wrapWithAbbreviation(view, lang, abbr) {
  if (!SYNTAX[lang] || SYNTAX[lang] === "css" || SYNTAX[lang] === "scss" || SYNTAX[lang] === "less") return false;
  const st = view.state, r = st.selection.main;
  const from = r.empty ? st.doc.lineAt(r.head).from : r.from, to = r.empty ? st.doc.lineAt(r.head).to : r.to;
  const sel = st.sliceDoc(from, to), indent = /^\s*/.exec(sel)[0];
  const lines = sel.split("\n").map((l) => l.trim()).filter(Boolean);
  let out;
  try { out = expand(abbr, { syntax: SYNTAX[lang] === "html" ? "html" : "jsx", text: /\*(?!\d)/.test(abbr) ? lines : lines.join("\n"), options: { "output.indent": st.facet(indentUnit) } }); } catch { return false; }
  if (!out) return false;
  out = out.split("\n").map((l, i) => (i ? indent + l : l)).join("\n");
  view.dispatch({ changes: { from: from + indent.length, to, insert: out }, userEvent: "input" });
  return true;
}
