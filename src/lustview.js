// Help with Lust views in the editor, from the tables in luststyles.js:
// - inside a piece's [ ], completion offers only the style words that fit that piece
//   (the window's settings on view [ ], placeholder only on input…), colours after
//   color, background and border, and the file's own named styles;
// - colours get a small square of their real colour, in the list and next to colour
//   words and "#hex" text in [ ];
// - hovering a style word or a piece explains it, with an example.
import { autocompletion, insertCompletionText, pickedCompletion, startCompletion, snippet } from "@codemirror/autocomplete";
import { hoverTooltip, ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { styleContext, suggestions, colourSpots, explainAt, takes } from "./luststyles.js";

// ----- completion -----

/** A small panel beside the list (and the hover) with the explanation and an example. */
function helpDom({ title, doc, example, colour }) {
  const d = document.createElement("div");
  d.className = "hv";
  const p = document.createElement("p");
  if (colour) p.append(swatchDom(colour), " ");
  if (title) {
    const t = document.createElement("strong");
    t.textContent = title;
    p.append(t, " ");
  }
  p.append(doc);
  d.append(p);
  if (example) {
    const c = document.createElement("code");
    c.textContent = example;
    d.append(c);
  }
  return d;
}

// After a word that takes a value, a space goes in and the list opens again for colours or fill.
const insertThen = (text, reopen) => (view, c, from, to) => {
  view.dispatch({ ...insertCompletionText(view.state, text, from, to), annotations: pickedCompletion.of(c) });
  if (reopen) startCompletion(view);
};
const hoverSnippet = snippet("hover:[${}]");

const WHAT = { number: "a number", colour: "a colour", text: "text", bool: "a bool", fill: "fill", styles: "styles" };
function styleOption(s) {
  const alone = takes(s, "none");
  const needs = s.takes.split(" ").filter((k) => k !== "none").map((k) => WHAT[k]);
  const o = { label: s.name, type: "property", detail: needs.join(" or ") + (needs.length && alone ? ", or alone" : ""), info: () => helpDom(s) };
  if (takes(s, "styles")) o.apply = (view, c, from, to) => hoverSnippet(view, c, from, to);
  else if (!alone) o.apply = insertThen(s.name + " ", takes(s, "colour") || takes(s, "fill"));
  return o;
}

/**
 * Completion inside a view's style lists. Gives back undefined when the cursor isn't in one
 * (the usual Lust list answers then), null when it is but nothing fits.
 */
export function lustStyleSource(ctx) {
  const text = ctx.state.doc.toString();
  const cx = styleContext(text, ctx.pos);
  if (!cx || cx.at === "other") return undefined; // a value can be any Lust: the usual list
  const list = suggestions(cx, text);
  if (!list) return cx.at === "value" ? undefined : null;
  const options = list.map((x) => {
    if (x.kind === "style") return styleOption(x.style);
    if (x.kind === "colour") return { label: x.label, type: "constant", detail: "colour", lustColour: x.colour, boost: cx.at === "name" ? -1 : 0 };
    if (x.kind === "named") return { label: x.label, type: "variable", detail: "your style", info: () => helpDom({ doc: "Your own style.", example: x.detail }) };
    return { label: x.label, type: "keyword", detail: x.detail };
  });
  return { from: cx.from, options, validFor: /^\w*$/ };
}

const listSwatch = {
  position: 20,
  render(c) {
    if (!c.lustColour) return null;
    return swatchDom(c.lustColour);
  },
};

// ----- swatches in the text -----

function swatchDom(colour) {
  const s = document.createElement("span");
  s.className = "cm-lust-swatch";
  s.style.background = colour;
  return s;
}

class Swatch extends WidgetType {
  constructor(colour) { super(); this.colour = colour; }
  eq(o) { return o.colour === this.colour; }
  toDOM() { const s = swatchDom(this.colour); s.setAttribute("aria-hidden", "true"); return s; }
  ignoreEvent() { return true; }
}

function swatches(view) {
  const b = new RangeSetBuilder();
  const r = view.visibleRanges;
  if (!r.length) return b.finish();
  const text = view.state.doc.toString();
  for (const s of colourSpots(text, r[0].from, r[r.length - 1].to)) b.add(s.from, s.from, Decoration.widget({ widget: new Swatch(s.colour), side: -1 }));
  return b.finish();
}

const swatchPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = swatches(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = swatches(u.view); }
}, { decorations: (v) => v.decorations });

// ----- hover -----

const hover = hoverTooltip((view, pos) => {
  const e = explainAt(view.state.doc.toString(), pos);
  if (!e) return null;
  return {
    pos: e.from, end: e.to, above: true,
    create: () => ({ dom: helpDom(e) }),
  };
}, { hoverTime: 350 });

/** Everything above, for the Lust language. */
export const lustViewHelp = () => [autocompletion({ addToOptions: [listSwatch] }), swatchPlugin, hover];
