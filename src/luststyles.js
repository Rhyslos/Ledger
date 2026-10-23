// Everything Ledger knows about Lust views (LUST.md section 17): the pieces of a screen,
// the style words that go in their [ ], and the colours. Completion, hover help and the
// colour swatches all read these tables, so a new word or piece is one line here.
//
// No editor code in this file, so `npm test` can check it with plain Node.

// ----- pieces -----
// The pieces of a screen, with a one-line explanation and an example for hover help.
// To add a piece: one line here. Its name is then coloured, completed and explained.
export const PIECES = {
  column: { doc: "Pieces from top to bottom.", example: "column [gap 8] { … }" },
  row: { doc: "Pieces side by side.", example: "row [gap 8] { … }" },
  stack: { doc: "Pieces in layers on top of each other, the later ones in front.", example: "stack { image \"cat.png\"; text \"Cat\" [bottom]; }" },
  scroll: { doc: "A column that scrolls when what it holds is taller than it is.", example: "scroll [gap 4] { … }" },
  space: { doc: "Empty room that pushes what comes after it to the end.", example: "row { text \"Back\"; space; text \"Next\"; }" },
  text: { doc: "Words on the screen.", example: "text \"Hello\" [size 24];" },
  button: { doc: "Something to click. Its { } runs when it's clicked.", example: "button \"Add\" [blue, round] { add(); }" },
  input: { doc: "A text box, bound to a string field: typing changes the field.", example: "input name [placeholder \"Your name\"];" },
  checkbox: { doc: "A tick box, bound to a bool field.", example: "checkbox done;" },
  slider: { doc: "A bar with a knob that drags a number field between from and to.", example: "slider volume [from 0, to 100, step 5];" },
  image: { doc: "A PNG or JPEG picture.", example: "image \"cat.png\" [width 120];" },
  every: { doc: "Runs its block again and again while it's in the view. Takes no room.", example: "every 1.0 { seconds = seconds + 1; }" },
};

// The view itself: its [ ] is the window's settings.
export const VIEW = { doc: "What the screen shows. Its [ ] holds the window's settings: title, width, height, minWidth, minHeight and background.", example: "view [title \"To do\", width 420, height 600] { … }" };

// ----- styles -----
// Each style word:
//   name     the word.
//   takes    what can follow it, separated by spaces: none (the word alone), number, colour,
//            text, bool, fill (the word fill), styles (a nested [ ], like hover:[ … ]).
//   on       where it fits: "pieces" (every piece, your own ones and named styles too),
//            "view" (the window's [ ]), or piece names like "input" or "slider image".
//   doc      one plain line for hover help.
//   example  how it's written.
// To add a style word: one line here, in the group it belongs to.
export const STYLES = [
  // spacing
  { name: "pad", takes: "number none", on: "pieces", doc: "Space inside the piece, around what it holds.", example: "pad 16, padX 8, padY 4" },
  { name: "padX", takes: "number", on: "pieces", doc: "Space inside on the left and right.", example: "padX 8" },
  { name: "padY", takes: "number", on: "pieces", doc: "Space inside at the top and bottom.", example: "padY 4" },
  { name: "padTop", takes: "number", on: "pieces", doc: "Space inside at the top.", example: "padTop 8" },
  { name: "padRight", takes: "number", on: "pieces", doc: "Space inside on the right.", example: "padRight 8" },
  { name: "padBottom", takes: "number", on: "pieces", doc: "Space inside at the bottom.", example: "padBottom 8" },
  { name: "padLeft", takes: "number", on: "pieces", doc: "Space inside on the left.", example: "padLeft 8" },
  { name: "gap", takes: "number none", on: "pieces", doc: "Space between the pieces it holds.", example: "column [gap 8]" },
  // size
  { name: "width", takes: "number fill", on: "pieces view", doc: "How wide it is. On a view, how wide the window opens; width fill takes the room left over in a row.", example: "width 200, width fill" },
  { name: "height", takes: "number fill", on: "pieces view", doc: "How tall it is. On a view, how tall the window opens; height fill takes the room left over in a column.", example: "height 40, height fill" },
  { name: "grow", takes: "number none", on: "pieces", doc: "Its share of the room left over, next to other fills: grow 2 takes twice what grow 1 does.", example: "grow 2" },
  { name: "minWidth", takes: "number", on: "pieces view", doc: "The narrowest it (or the window) can get.", example: "minWidth 120" },
  { name: "maxWidth", takes: "number", on: "pieces", doc: "The widest it can get.", example: "maxWidth 600" },
  { name: "minHeight", takes: "number", on: "pieces view", doc: "The shortest it (or the window) can get.", example: "minHeight 40" },
  { name: "maxHeight", takes: "number", on: "pieces", doc: "The tallest it can get.", example: "maxHeight 300" },
  // text
  { name: "size", takes: "number", on: "pieces", doc: "How big the text is, in pixels.", example: "size 24" },
  { name: "tiny", takes: "none", on: "pieces", doc: "Very small text.", example: "text \"v1.0\" [tiny]" },
  { name: "small", takes: "none", on: "pieces", doc: "Small text.", example: "text \"3 things\" [small]" },
  { name: "large", takes: "none", on: "pieces", doc: "Large text.", example: "text \"Welcome\" [large]" },
  { name: "huge", takes: "none", on: "pieces", doc: "Very large text, for titles.", example: "text \"Score\" [huge]" },
  { name: "weight", takes: "number", on: "pieces", doc: "How thick the letters are, from 100 (thin) to 900 (heavy). 400 is normal.", example: "weight 600" },
  { name: "bold", takes: "none", on: "pieces", doc: "Bold text.", example: "text \"Done\" [bold]" },
  { name: "muted", takes: "none", on: "pieces", doc: "Greyed text, for things that matter less.", example: "text \"Nothing yet\" [muted]" },
  { name: "strike", takes: "none", on: "pieces", doc: "Text with a line through it.", example: "text label [muted, strike]" },
  { name: "nowrap", takes: "none", on: "pieces", doc: "Keeps text on one line instead of wrapping.", example: "text path [nowrap]" },
  // colour (a colour word on its own also colours text, or a whole button)
  { name: "color", takes: "colour", on: "pieces", doc: "The colour of the text.", example: "color red7, color \"#2f9e44\"" },
  { name: "background", takes: "colour", on: "pieces view", doc: "The colour behind the piece, or behind the whole window on a view.", example: "background gray1" },
  { name: "subtle", takes: "none", on: "pieces", doc: "A button with no background until the mouse is over it.", example: "button \"✕\" [subtle, small]" },
  // shape
  { name: "round", takes: "none number", on: "pieces", doc: "Rounded corners. A number says how round.", example: "round, round 12" },
  { name: "pill", takes: "none", on: "pieces", doc: "Fully rounded ends, like a pill.", example: "button \"Tag\" [pill]" },
  { name: "border", takes: "none colour", on: "pieces", doc: "A thin line around the piece, in a colour if one is given.", example: "border, border red" },
  { name: "borderWidth", takes: "number", on: "pieces", doc: "How thick the border is.", example: "borderWidth 2" },
  { name: "shadow", takes: "none", on: "pieces", doc: "A soft shadow under the piece.", example: "column [pad 16, round, shadow]" },
  { name: "opacity", takes: "number", on: "pieces", doc: "How see-through it is, from 0 (invisible) to 1 (solid).", example: "opacity 0.5" },
  // placement
  { name: "left", takes: "none", on: "pieces", doc: "Places what it holds, or its text, on the left.", example: "column [left]" },
  { name: "center", takes: "none", on: "pieces", doc: "Places what it holds, or its text, in the middle side to side.", example: "column [center]" },
  { name: "right", takes: "none", on: "pieces", doc: "Places what it holds, or its text, on the right.", example: "row [right]" },
  { name: "top", takes: "none", on: "pieces", doc: "Places what it holds at the top.", example: "row [top]" },
  { name: "middle", takes: "none", on: "pieces", doc: "Places what it holds in the middle up and down.", example: "column [middle]" },
  { name: "bottom", takes: "none", on: "pieces", doc: "Places what it holds at the bottom.", example: "stack { text \"New\" [bottom, right]; }" },
  { name: "spread", takes: "none", on: "pieces", doc: "Shares the spare room evenly between the pieces it holds.", example: "row [spread] { text \"Back\"; text \"Next\"; }" },
  // under the mouse
  { name: "hover", takes: "styles", on: "pieces", doc: "Styles used while the mouse is over the piece.", example: "hover:[background gray1]" },
  // inputs and pictures
  { name: "placeholder", takes: "text", on: "input", doc: "What an empty input shows.", example: "placeholder \"Your name\"" },
  { name: "from", takes: "number", on: "slider", doc: "The slider's lowest number.", example: "slider volume [from 0, to 100]" },
  { name: "to", takes: "number", on: "slider", doc: "The slider's highest number.", example: "slider volume [from 0, to 100]" },
  { name: "step", takes: "number", on: "slider", doc: "How far one step moves the slider. step 0 slides smoothly.", example: "step 5" },
  { name: "cover", takes: "none", on: "image", doc: "Fills the width and height it's given, cut to fit, instead of fitting inside them.", example: "image \"cat.png\" [width 48, height 48, cover]" },
  // off
  { name: "disabled", takes: "none bool", on: "pieces", doc: "Greys the piece out and stops it being clicked, typed in or reached with Tab.", example: "disabled, disabled name == \"\"" },
  // the window
  { name: "title", takes: "text", on: "view", doc: "The window's title.", example: "title \"To do\"" },
];

// ----- colours -----
// The Open Color palette, as Lust has it (src/native_ui.rs). blue1 is pale, blue9 deep.
export const COLOURS = {
  white: "#ffffff", black: "#000000",
  gray1: "#f8f9fa", gray2: "#f1f3f5", gray3: "#e9ecef", gray4: "#dee2e6", gray5: "#ced4da", gray6: "#adb5bd", gray7: "#868e96", gray8: "#495057", gray9: "#212529",
  red: "#e03131", orange: "#f76707", yellow: "#f59f00", green: "#2f9e44", teal: "#0c8599", blue: "#1c7ed6", indigo: "#4263eb", purple: "#7048e8", pink: "#d6336c",
  red1: "#ffe3e3", red2: "#ffc9c9", red3: "#ffa8a8", red4: "#ff8787", red5: "#ff6b6b", red6: "#fa5252", red7: "#f03e3e", red8: "#e03131", red9: "#c92a2a",
  orange1: "#ffe8cc", orange2: "#ffd8a8", orange3: "#ffc078", orange4: "#ffa94d", orange5: "#ff922b", orange6: "#fd7e14", orange7: "#f76707", orange8: "#e8590c", orange9: "#d9480f",
  yellow1: "#fff3bf", yellow2: "#ffec99", yellow3: "#ffe066", yellow4: "#ffd43b", yellow5: "#fcc419", yellow6: "#fab005", yellow7: "#f59f00", yellow8: "#f08c00", yellow9: "#e67700",
  green1: "#d3f9d8", green2: "#b2f2bb", green3: "#8ce99a", green4: "#69db7c", green5: "#51cf66", green6: "#40c057", green7: "#37b24d", green8: "#2f9e44", green9: "#2b8a3e",
  teal1: "#c5f6fa", teal2: "#99e9f2", teal3: "#66d9e8", teal4: "#3bc9db", teal5: "#22b8cf", teal6: "#15aabf", teal7: "#1098ad", teal8: "#0c8599", teal9: "#0b7285",
  blue1: "#d0ebff", blue2: "#a5d8ff", blue3: "#74c0fc", blue4: "#4dabf7", blue5: "#339af0", blue6: "#228be6", blue7: "#1c7ed6", blue8: "#1971c2", blue9: "#1864ab",
  indigo1: "#dbe4ff", indigo2: "#bac8ff", indigo3: "#91a7ff", indigo4: "#748ffc", indigo5: "#5c7cfa", indigo6: "#4c6ef5", indigo7: "#4263eb", indigo8: "#3b5bdb", indigo9: "#364fc7",
  purple1: "#e5dbff", purple2: "#d0bfff", purple3: "#b197fc", purple4: "#9775fa", purple5: "#845ef7", purple6: "#7950f2", purple7: "#7048e8", purple8: "#6741d9", purple9: "#5f3dc4",
  pink1: "#ffdeeb", pink2: "#fcc2d7", pink3: "#faa2c1", pink4: "#f783ac", pink5: "#f06595", pink6: "#e64980", pink7: "#d6336c", pink8: "#c2255c", pink9: "#a61e4d",
};

// ----- lookups built from the tables -----
export const STYLE = Object.fromEntries(STYLES.map((s) => [s.name, s]));
export const takes = (s, kind) => s.takes.split(" ").includes(kind);
const onList = (s) => s.on.split(" ");

/**
 * Does this style word fit here? `where` is a styleContext's kind and piece:
 * the window ("view"), a named style ("style": anything a piece can have),
 * one of Lust's pieces ("piece", "slider"), or your own piece ("custom").
 */
export function fits(s, kind, piece) {
  const on = onList(s);
  if (kind === "view") return on.includes("view");
  if (on.includes("pieces")) return true;
  if (kind === "style") return !on.every((p) => p === "view"); // a named style can be for any piece
  return kind === "piece" && on.includes(piece);
}

/** The named styles a file defines: style card = [ … ]; → { card: "pad 16, round" }. */
export function namedStyles(text) {
  const out = {};
  for (const m of text.matchAll(/^[ \t]*style\s+([A-Za-z_]\w*)\s*=\s*\[([^\]\n]*)/gm)) out[m[1]] = m[2].trim();
  return out;
}

// ----- where the cursor is -----

/** What a [ ] belongs to, from the line before it: the window, a named style, a piece, your own piece, or nothing (a list, an index). */
export function ownerOf(lineBefore) {
  if (/^\s*view\s*$/.test(lineBefore)) return { kind: "view" };
  if (/^\s*style\s+[A-Za-z_]\w*\s*=\s*$/.test(lineBefore)) return { kind: "style" };
  const m = /^\s*([A-Za-z_]\w*)(.*)$/.exec(lineBefore);
  if (!m) return null;
  // text "Hi" [, button "Go" [, input name [ … but not text = …, text.trim(), text(…).
  if (Object.hasOwn(PIECES, m[1]) && !/^\s*[=.:,]|^\(/.test(m[2])) return { kind: "piece", piece: m[1] };
  if (/^[A-Z]/.test(m[1]) && /^\s*$/.test(m[2])) return { kind: "custom", piece: m[1] }; // TodoRow [width 300]
  return null;
}

/**
 * Reads Lust code from the start up to `end`, skipping comments and text in quotes, and keeps
 * track of the brackets that are open. Each open [ that holds styles knows what it belongs to,
 * and where its current item (after the last comma) starts. `visit(kind, from, to, top)` hears
 * about every word ("word") and every piece of quoted text ("string"), with the innermost
 * open bracket. Gives back the brackets still open at `end`, and whether `end` is inside a
 * comment or quoted text.
 */
export function scan(text, end = text.length, visit = null) {
  const stack = [];
  let i = 0, inside = null;
  const lineStart = (p) => text.lastIndexOf("\n", p - 1) + 1;
  while (i < end) {
    const c = text[i];
    if ((c === "-" && text[i + 1] === "-") || (c === "/" && text[i + 1] === "/")) {
      if (c === "-" && text.startsWith("[[", i + 2)) {
        const close = text.indexOf("]]", i + 4);
        if (close < 0 || close + 2 > end) { inside = "comment"; break; }
        i = close + 2;
        continue;
      }
      const nl = text.indexOf("\n", i);
      if (nl < 0 || nl >= end) { inside = "comment"; break; }
      i = nl;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const closed = text[j] === '"';
      if (visit) visit("string", i, Math.min(closed ? j + 1 : j, text.length), stack[stack.length - 1]);
      if (end <= j) { inside = "string"; break; } // the cursor is before the closing quote (or the line's end)
      i = closed ? j + 1 : j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /\w/.test(text[j])) j++;
      if (visit) visit("word", i, j, stack[stack.length - 1]);
      i = j;
      continue;
    }
    if (c === "[") {
      const top = stack[stack.length - 1];
      let style = null;
      if (top?.style) {
        // hover:[ … ] inside a style list holds styles for the same piece; any other [ is a value's.
        if (/\bhover\s*:\s*$/.test(text.slice(top.itemFrom, i))) style = { ...top.style, nested: true };
      } else if (!top || top.ch !== "(") style = ownerOf(text.slice(lineStart(i), i));
      stack.push({ ch: c, at: i, style, itemFrom: i + 1 });
    } else if (c === "{" || c === "(") stack.push({ ch: c, at: i, style: null });
    else if (c === "]" || c === "}" || c === ")") stack.pop();
    else if (c === "," && stack.length && stack[stack.length - 1].style) stack[stack.length - 1].itemFrom = i + 1;
    i++;
  }
  return { stack, inside };
}

/**
 * Where the cursor is, if it's in a style list: { kind, piece, nested, at, style, word, from }.
 * at is "name" (typing a style's name: word is what's typed so far), "value" (after a style's
 * name and a space: style is that name, word what's typed of its value), or "other" (further
 * into a value, like disabled name == ""). from is where the typed word starts.
 * Null when the cursor isn't in a style list (or is in a comment or quoted text).
 */
export function styleContext(text, pos) {
  const { stack, inside } = scan(text, pos);
  const top = stack[stack.length - 1];
  if (inside || !top?.style) return null;
  const item = text.slice(top.itemFrom, pos);
  const base = { kind: top.style.kind, piece: top.style.piece, nested: !!top.style.nested };
  let m = /^\s*([A-Za-z_]\w*)?$/.exec(item);
  if (m) return { ...base, at: "name", word: m[1] || "", from: pos - (m[1] || "").length };
  m = /^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)?$/.exec(item);
  if (m) return { ...base, at: "value", style: m[1], word: m[2] || "", from: pos - (m[2] || "").length };
  return { ...base, at: "other" };
}

/**
 * The suggestions for a style context, as plain objects: { label, kind, detail, style?, colour? }.
 * kind is "style", "colour", "named" or "word". Null when there's nothing to suggest here.
 */
export function suggestions(cx, text) {
  if (!cx) return null;
  if (cx.at === "name") {
    const out = STYLES.filter((s) => fits(s, cx.kind, cx.piece)).map((s) => ({ label: s.name, kind: "style", style: s }));
    if (cx.kind !== "view") {
      for (const [name, body] of Object.entries(namedStyles(text))) if (!STYLE[name]) out.push({ label: name, kind: "named", detail: body });
      for (const [name, hex] of Object.entries(COLOURS)) out.push({ label: name, kind: "colour", colour: hex });
    }
    return out;
  }
  if (cx.at === "value") {
    const s = STYLE[cx.style];
    if (!s || (cx.kind === "view" && !fits(s, "view"))) return null;
    const out = [];
    if (takes(s, "colour")) for (const [name, hex] of Object.entries(COLOURS)) out.push({ label: name, kind: "colour", colour: hex });
    if (takes(s, "fill") && cx.kind !== "view") out.push({ label: "fill", kind: "word", detail: "take the room left over" });
    return out.length ? out : null;
  }
  return null;
}

/**
 * The colours shown in a file's style lists, for the swatches next to them: [{ from, to, colour }].
 * Colour words (blue, gray3) and "#hex" text, from `from` to `to` in the file.
 */
export function colourSpots(text, from = 0, to = text.length) {
  const out = [];
  scan(text, Math.min(text.length, to), (kind, a, b, top) => {
    if (b < from || !top?.style) return;
    if (kind === "word") {
      const w = text.slice(a, b);
      if (Object.hasOwn(COLOURS, w)) out.push({ from: a, to: b, colour: COLOURS[w] });
    } else {
      const m = /^"(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))"$/.exec(text.slice(a, b));
      if (m) out.push({ from: a, to: b, colour: m[1] });
    }
  });
  return out;
}

/** What hovering at `pos` explains: { from, to, title, doc, example?, colour? }, or null. */
export function explainAt(text, pos) {
  let a = pos, b = pos;
  while (a > 0 && /\w/.test(text[a - 1])) a--;
  while (b < text.length && /\w/.test(text[b])) b++;
  if (a === b || !/[A-Za-z_]/.test(text[a])) return null;
  const word = text.slice(a, b);
  const cx = styleContext(text, a);
  if (cx) {
    if (Object.hasOwn(COLOURS, word) && (cx.at === "name" || cx.at === "value")) return { from: a, to: b, title: word, doc: `A colour from the Open Color palette (${COLOURS[word]}).`, colour: COLOURS[word] };
    if (cx.at !== "name") return word === "fill" && cx.at === "value" ? { from: a, to: b, title: "fill", doc: "Takes the room left over: in a row for width, in a column for height.", example: "width fill" } : null;
    const s = STYLE[word];
    if (s) return { from: a, to: b, title: s.name, doc: s.doc, example: s.example };
    const named = namedStyles(text)[word];
    if (named != null) return { from: a, to: b, title: word, doc: "Your own style, named with style " + word + " = [ … ];", example: named };
    return null;
  }
  // A piece starts its line (like the colouring decides): column [gap 8] {, text "Hi";
  const line = text.slice(text.lastIndexOf("\n", a - 1) + 1, a);
  if (line.trim() !== "") return null;
  if (word === "view" && /^\s*[[{]/.test(text.slice(b))) return { from: a, to: b, title: "view", doc: VIEW.doc, example: VIEW.example };
  if (Object.hasOwn(PIECES, word) && !/^\s*[=.:,]|^\(/.test(text.slice(b, b + 40)) && !scan(text, a).inside) return { from: a, to: b, title: word, doc: PIECES[word].doc, example: PIECES[word].example };
  return null;
}
