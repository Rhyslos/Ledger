// Colours for HTML, JSX, CSS and JavaScript that go further than the shared
// highlight tags: HTML elements are coloured by what kind of element they are
// (layout reds, text blues, form and media greens), CSS is muted magenta, and
// capitalised JS names get the class colour like C#. Works on the syntax tree,
// so it also covers <style> and <script> inside HTML. Colours: style.css (--w-*).
import { ViewPlugin, Decoration } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Prec, RangeSetBuilder } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

const group = (s, cls) => Object.fromEntries(s.split(/\s+/).map((n) => [n, cls]));
const ELEMENTS = {
  ...group("html body main header footer nav section article aside div hgroup search", "layout"),
  ...group("head meta link title base script style noscript template slot", "meta"),
  ...group("h1 h2 h3 h4 h5 h6 p a span strong em b i u s small mark code pre kbd samp var blockquote q cite abbr time sub sup br hr wbr ul ol li dl dt dd address del ins dfn bdi bdo ruby rt rp data", "text"),
  ...group("table thead tbody tfoot tr td th caption colgroup col", "table"),
  ...group("form input button select option optgroup textarea label fieldset legend datalist output progress meter details summary dialog menu", "form"),
  ...group("img picture source video audio track canvas svg iframe embed object map area figure figcaption math", "media"),
};
const elementClass = (name) => ELEMENTS[name.toLowerCase()] || "comp";

// @media, @import… (only inside CSS statements: JS has an "import" node too), and !important
const CSS_AT = new Set(["media", "import", "charset", "namespace", "keyframes", "supports", "container", "layer", "font-face", "page"]);

const marks = {};
const mark = (cls) => (marks[cls] ??= Decoration.mark({ class: "cm-w-" + cls }));

function build(view) {
  const b = new RangeSetBuilder();
  const doc = view.state.doc;
  let last = 0;
  const add = (from, to, cls) => { if (from >= last) { b.add(from, to, mark(cls)); last = from; } };
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter(n) {
        const name = n.name, parent = n.node.parent?.name;
        let cls = null;
        // HTML elements, and lowercase JSX elements like <div>
        if (name === "TagName" && parent !== "TagSelector") cls = elementClass(doc.sliceString(n.from, n.to));
        else if (name === "JSXBuiltin") { const id = n.node.firstChild; if (id) add(id.from, id.to, elementClass(doc.sliceString(id.from, id.to))); return false; }
        else if (name === "JSXIdentifier") cls = parent === "JSXAttribute" ? "attr" : "comp"; // <MyButton>, <Menu.Item>
        else if (name === "AttributeName") cls = "attr";
        else if (name === "StartTag" || name === "StartCloseTag" || name === "EndTag" || name === "SelfCloseEndTag" || name === "JSXStartTag" || name === "JSXStartCloseTag" || name === "JSXEndTag" || name === "JSXSelfCloseEndTag") cls = "punct";
        // CSS
        else if (name === "TagName" || name === "ClassName" || name === "IdName" || name === "UniversalSelector" || name === "NestingSelector") cls = "sel";
        else if (name === "PseudoClassName") cls = "pseudo";
        else if ((CSS_AT.has(name) && parent?.endsWith("Statement")) || name === "AtKeyword" || name === "Important") cls = "at";
        else if (name === "PropertyName" && parent === "Declaration") cls = "prop";
        else if (name === "VariableName" && doc.sliceString(n.from, n.from + 2) === "--") cls = "cssvar";
        else if (name === "Callee") cls = "call";
        else if (name === "ValueName") cls = "value";
        // JavaScript: PascalCase reads as a class (like C#), ALL_CAPS as a constant
        else if (name === "VariableName" || name === "VariableDefinition" || name === "TypeName") {
          const s = doc.sliceString(n.from, n.to);
          if (/^[A-Z][A-Z0-9_]+$/.test(s)) cls = "const";
          else if (/^[A-Z]/.test(s)) cls = "class";
        } else if (name === "null" || name === "BooleanLiteral" || name === "undefined") cls = "const";
        else if (name === "this" || name === "super") cls = "self";
        if (cls) add(n.from, n.to, cls);
      },
    });
  }
  return b.finish();
}

const plugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
  }
}, { decorations: (v) => v.decorations });

/** For HTML, CSS, JavaScript and TypeScript (with or without JSX). */
export const webColours = () => Prec.high(plugin);

// SCSS and Less use the older tokenizer (no syntax tree), so they get the magenta through tags.
export const legacyCssColours = () => Prec.high(syntaxHighlighting(HighlightStyle.define([
  { tag: [t.tagName, t.keyword, t.definitionKeyword, t.modifier, t.className, t.labelName], color: "var(--w-magenta)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--w-prop)" },
  { tag: [t.special(t.variableName), t.variableName], color: "var(--w-cssvar)" },
  { tag: t.atom, color: "var(--w-value)" },
])));
