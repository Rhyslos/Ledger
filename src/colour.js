// Colours in code: a small swatch before every colour (#hex, rgb(), hsl(), Godot's Color(r, g, b)),
// and clicking it opens Ledger's colour picker, the one from Nodelit made quieter: a hue ring with
// a circle or triangle inside, or a detailed hexagon grid with HSL sliders, plus Hex and RGB fields, the
// colours already in the file, and your saved colours. Edits go straight into the code, written
// the way the colour was written (#abc stays short, rgb() stays rgb()).
import { ViewPlugin, Decoration, WidgetType, EditorView } from "@codemirror/view";
import { RangeSetBuilder, Transaction } from "@codemirror/state";

// ---------- colour maths ----------
export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
export const rgbToHex = ({ r, g, b }) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

export function normalizeHex(v) {
  if (typeof v !== "string") return null;
  let h = v.trim();
  if (!h.startsWith("#")) h = "#" + h;
  if (/^#[0-9a-f]{3}$/i.test(h)) h = "#" + [...h.slice(1)].map((c) => c + c).join("");
  return /^#[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : null;
}
export function hexToRgb(v) {
  const h = normalizeHex(v) ?? "#000000";
  return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) };
}
export function rgbToHsv({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255, max = Math.max(R, G, B), d = max - Math.min(R, G, B);
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: max ? d / max : 0, v: max };
}
export function hsvToRgb({ h, s, v }) {
  const H = ((h % 360) + 360) % 360, c = v * s, x = c * (1 - Math.abs(((H / 60) % 2) - 1)), m = v - c;
  const p = H < 60 ? [c, x, 0] : H < 120 ? [x, c, 0] : H < 180 ? [0, c, x] : H < 240 ? [0, x, c] : H < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((p[0] + m) * 255), g: Math.round((p[1] + m) * 255), b: Math.round((p[2] + m) * 255) };
}
export const hsvToHex = (hsv) => rgbToHex(hsvToRgb(hsv));
function rgbToHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255, max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h: rgbToHsv({ r, g, b }).h, s, l };
}
function hslToRgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s, v = l + c / 2;
  return hsvToRgb({ h, s: v ? c / v : 0, v });
}
function readableOn(hex) {
  const lin = Object.values(hexToRgb(hex)).map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] > 0.5 ? "#141414" : "#ffffff";
}

// ---------- colours in text ----------
const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
// Hex (not in an HTML entity, a link like href="#top", or url(#id)), rgb()/hsl() in CSS's
// spelling, and Godot's Color(r, g, b) with a capital C.
const RE = new RegExp(
  String.raw`(?<![&\w#])(?<!href=["']?)(?<!url\(["']?)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])` +
  String.raw`|\b(?:rgba?|hsla?|RGBA?|HSLA?)\(\s*${NUM}(?:deg|turn|%)?(?:\s*,\s*|\s+)${NUM}%?(?:\s*,\s*|\s+)${NUM}%?(?:\s*[,/]\s*${NUM}%?)?\s*\)` +
  String.raw`|\bColor\(\s*${NUM}f?\s*,\s*${NUM}f?\s*,\s*${NUM}f?(?:\s*,\s*${NUM}f?)?\s*\)`,
  "g");
// In prose (Markdown, plain text) #123 is an issue number, not a colour: only six or eight digits there.
const PROSE = new Set(["markdown", "text"]);
const GODOT = new Set(["gdscript", "godot", "csharp", "gdshader"]);

/** Reads one colour as written. Returns { r, g, b, a, fmt } or null. */
export function parseColour(text) {
  let m;
  if (text[0] === "#") {
    const h = text.slice(1), long = h.length > 4, at = (i) => parseInt(long ? h.slice(i * 2, i * 2 + 2) : h[i] + h[i], 16);
    if (!/^[0-9a-f]+$/i.test(h) || ![3, 4, 6, 8].includes(h.length)) return null;
    return { r: at(0), g: at(1), b: at(2), a: h.length === 4 || h.length === 8 ? at(3) / 255 : 1, fmt: { kind: "hex", short: !long, upper: /[A-F]/.test(h) && !/[a-f]/.test(h), alpha: h.length === 4 || h.length === 8 } };
  }
  if ((m = /^Color\((.*)\)$/i.exec(text))) {
    const n = m[1].split(",").map((s) => parseFloat(s));
    if (n.some(isNaN) || n.slice(0, 3).some((v) => v < 0 || v > 1.0001)) return null; // Color(0-255) isn't Godot's
    return { r: n[0] * 255, g: n[1] * 255, b: n[2] * 255, a: n.length > 3 ? clamp(n[3], 0, 1) : 1, fmt: { kind: "godot", alpha: n.length > 3, suffix: /\df/.test(m[1]) } };
  }
  if ((m = /^(rgba?|hsla?)\((.*)\)$/i.exec(text))) {
    const fn = m[1].toLowerCase(), body = m[2], comma = body.includes(",");
    const parts = body.split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const num = (s, scale) => (s.endsWith("%") ? (parseFloat(s) / 100) * scale : parseFloat(s));
    const a = parts[3] != null ? clamp(num(parts[3], 1), 0, 1) : 1;
    const fmt = { kind: fn.startsWith("rgb") ? "rgb" : "hsl", fn, comma, alpha: parts.length === 4, pct: parts[0].endsWith("%") };
    if (fmt.kind === "rgb") {
      const [r, g, b] = parts.slice(0, 3).map((s) => clamp(num(s, 255), 0, 255));
      return [r, g, b].some(isNaN) ? null : { r, g, b, a, fmt };
    }
    let h = parseFloat(parts[0]);
    if (parts[0].endsWith("turn")) h *= 360;
    const hsl = { h, s: clamp(num(parts[1], 1), 0, 1), l: clamp(num(parts[2], 1), 0, 1) };
    const rgb = hslToRgb(hsl);
    return isNaN(h) ? null : { ...rgb, a, fmt: { ...fmt, hsl, rgb } };
  }
  return null;
}

const trim = (n, d = 3) => String(+n.toFixed(d));
/** Writes a colour the way the original was written. */
export function formatColour({ r, g, b, a = 1 }, fmt) {
  const withA = fmt.alpha || a < 0.999;
  if (fmt.kind === "hex") {
    let h = rgbToHex({ r, g, b }).slice(1) + (withA ? hex2(a * 255) : "");
    if (fmt.short && [...Array(h.length / 2).keys()].every((i) => h[i * 2] === h[i * 2 + 1])) h = [...Array(h.length / 2).keys()].map((i) => h[i * 2]).join("");
    return "#" + (fmt.upper ? h.toUpperCase() : h);
  }
  if (fmt.kind === "godot") {
    const f = (v) => trim(v / 255) + (fmt.suffix ? "f" : "");
    return `Color(${f(r)}, ${f(g)}, ${f(b)}${withA ? ", " + trim(a) + (fmt.suffix ? "f" : "") : ""})`;
  }
  const A = trim(a, 2);
  if (fmt.kind === "rgb") {
    const c = [r, g, b].map((v) => (fmt.pct ? trim((v / 255) * 100, 1) + "%" : Math.round(v)));
    if (!fmt.comma) return `rgb(${c.join(" ")}${withA ? " / " + A : ""})`;
    return withA ? `rgba(${c.join(", ")}, ${A})` : `${fmt.fn === "rgba" ? "rgba" : "rgb"}(${c.join(", ")}${fmt.fn === "rgba" ? ", 1" : ""})`;
  }
  // The colour itself unchanged (only alpha moved): keep the numbers as they were written.
  const same = fmt.hsl && fmt.rgb && Math.round(r) === fmt.rgb.r && Math.round(g) === fmt.rgb.g && Math.round(b) === fmt.rgb.b;
  const { h, s, l } = same ? fmt.hsl : rgbToHsl({ r, g, b });
  const c = [trim(h, 1), trim(s * 100, 1) + "%", trim(l * 100, 1) + "%"];
  if (!fmt.comma) return `hsl(${c.join(" ")}${withA ? " / " + A : ""})`;
  return withA ? `hsla(${c.join(", ")}, ${A})` : `${fmt.fn === "hsla" ? "hsla" : "hsl"}(${c.join(", ")}${fmt.fn === "hsla" ? ", 1" : ""})`;
}

// CSS's named colours (red, rebeccapurple…), in style sheets only, and only after a property's
// colon: `color: tomato`, not `.tomato {` or `grid-area: red-box`. Editing one writes it as hex.
const NAMED = new Map("aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32".split(" ").reduce((a, x, i, l) => (i % 2 ? a : [...a, [x, "#" + l[i + 1]]]), []));
const STYLE = new Set(["css", "scss", "less"]);
const NAMED_RE = /(?<![\w$@#.-])[a-z]{3,20}(?![\w(-])/gi;
function namedIn(text, out) {
  const colon = text.indexOf(":");
  if (colon < 0) return;
  NAMED_RE.lastIndex = colon;
  for (let m; (m = NAMED_RE.exec(text)); ) {
    const hex = NAMED.get(m[0].toLowerCase());
    if (!hex) continue;
    // Inside a value: a colon before it, after the last ; or {.
    const before = text.slice(0, m.index), start = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"));
    if (before.indexOf(":", start + 1) < 0 || /\/[/*][^]*$/.test(before) || out.some((o) => m.index < o.to && m.index + m[0].length > o.from)) continue;
    out.push({ from: m.index, to: m.index + m[0].length, text: m[0], c: { ...hexToRgb(hex), a: 1, fmt: { kind: "hex", short: false, upper: false, alpha: false, named: true } } });
  }
  out.sort((a, b) => a.from - b.from);
}

/** Every colour in a line: [{ from, to, text, c }] with positions relative to the line. */
export function coloursIn(text, lang) {
  const out = [];
  if (text.length > 4000) return out;
  if (STYLE.has(lang)) { const rest = coloursInRaw(text, lang); namedIn(text, rest); return rest; }
  return coloursInRaw(text, lang);
}
function coloursInRaw(text, lang) {
  const out = [];
  RE.lastIndex = 0;
  for (let m; (m = RE.exec(text)); ) {
    if (m[0][0] === "C" && !GODOT.has(lang)) continue;
    if (m[0][0] === "#" && PROSE.has(lang) && m[0].length < 7) continue;
    const c = parseColour(m[0]);
    if (c) out.push({ from: m.index, to: m.index + m[0].length, text: m[0], c });
  }
  return out;
}

// ---------- swatches in the editor ----------
const cssColour = ({ r, g, b, a }) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
class Swatch extends WidgetType {
  constructor(colour) { super(); this.colour = colour; }
  eq(o) { return o.colour === this.colour; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-colour-swatch";
    s.title = "Pick a colour";
    const i = document.createElement("span");
    i.style.background = this.colour;
    s.append(i);
    return s;
  }
  ignoreEvent() { return false; }
}

function build(view, lang) {
  const b = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      for (const m of coloursIn(line.text, lang)) b.add(line.from + m.from, line.from + m.from, Decoration.widget({ widget: new Swatch(cssColour(m.c)), side: -1 }));
      pos = line.to + 1;
    }
  }
  return b.finish();
}

/** The colour under (or touching) a position, with document positions. */
export function colourAt(state, pos, lang) {
  const line = state.doc.lineAt(pos);
  const m = coloursIn(line.text, lang).find((x) => pos - line.from >= x.from && pos - line.from <= x.to);
  return m ? { ...m, from: line.from + m.from, to: line.from + m.to } : null;
}

/** Swatches for a file in `lang`; `open(view, pos)` is called when one is clicked. */
export function colourSwatches(lang, open) {
  return [
    ViewPlugin.fromClass(class {
      constructor(v) { this.decorations = build(v, lang); }
      update(u) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view, lang); }
    }, { decorations: (v) => v.decorations }),
    EditorView.domEventHandlers({
      mousedown(e, v) {
        const s = e.target.closest?.(".cm-colour-swatch");
        if (!s || e.button !== 0) return false;
        e.preventDefault();
        open(v, v.posAtDOM(s), s);
        return true;
      },
    }),
  ];
}

// ---------- the picker ----------
const HUE_STOPS = Array.from({ length: 13 }, (_, i) => `hsl(${i * 30}, 100%, 50%)`).join(", ");
const SAVED_KEY = "ledger-colours", MODE_KEY = "ledger-colour-mode", SHAPE_KEY = "ledger-colour-shape";
const pref = (k, ok, d) => { try { const v = localStorage.getItem(k); return ok.includes(v) ? v : d; } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const loadSaved = () => { try { const v = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"); return Array.isArray(v) ? v.filter(normalizeHex).slice(0, 24) : []; } catch { return []; } };
const ICON = {
  circle: '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>',
  triangle: '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 2.5 14 13H2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="12" height="12"><path d="m3 8.5 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};

function trianglePoints(r) {
  return [0, 120, 240].map((o) => { const a = ((o - 90) * Math.PI) / 180; return { x: r * Math.cos(a), y: r * Math.sin(a) }; });
}
function barycentric(p, [a, b, c]) {
  const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  const wa = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / d;
  const wb = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / d;
  const w = [wa, wb, 1 - wa - wb].map((x) => Math.max(x, 0)), t = w[0] + w[1] + w[2];
  return t ? w.map((x) => x / t) : [1, 0, 0];
}
function hexCells(radius) {
  const cells = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      const x = Math.sqrt(3) * (q + r / 2), y = 1.5 * r;
      let hue = (Math.atan2(y, x) * 180) / Math.PI + 90;
      if (hue < 0) hue += 360;
      cells.push({ x, y, hue, d: Math.hypot(x, y) });
    }
  }
  const far = Math.max(...cells.map((c) => c.d));
  return cells.map((c) => ({ ...c, sat: c.d / far }));
}
const CELLS = hexCells(5);
const cellPoints = (cx, cy, r) => Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 180) * (60 * i - 30); return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`; }).join(" ");

/** Opens the picker by `anchor` (a DOM element or rect). `onChange({r,g,b,a})` runs live while
 *  you pick; `onClose()` once it closes. `inFile` lists colours to offer (hex). Returns close(). */
export function openPicker({ anchor, colour, inFile = [], onChange, onClose }) {
  document.querySelector(".cp-pop")?._close?.();
  const startRgb = { r: colour.r, g: colour.g, b: colour.b };
  let hsv = rgbToHsv(startRgb), alpha = colour.a ?? 1;
  let mode = pref(MODE_KEY, ["wheel", "grid"], "wheel"), shape = pref(SHAPE_KEY, ["circle", "triangle"], "circle");
  let saved = loadSaved();
  const el = document.createElement("div");
  el.className = "cp-pop";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Colour picker");
  document.body.append(el);

  const hex = () => hsvToHex(hsv);
  const emit = () => { const { r, g, b } = hsvToRgb(hsv); onChange?.({ r, g, b, a: alpha }); };
  const set = (next, from) => { hsv = next; emit(); paint(from); };

  // ----- layout (built once; paint() keeps it current) -----
  const SIZE = 184, RING = SIZE * 0.14, INNER = SIZE - RING * 2 - 10, TR = INNER / 2, V = trianglePoints(TR);
  el.innerHTML = `
    <div class="cp-head">
      <div class="cp-seg" data-group="mode"><button data-mode="wheel">Wheel</button><button data-mode="grid">Detailed</button></div>
      <div class="cp-seg cp-shapes" data-group="shape"><button data-shape="circle" title="Circle centre" aria-label="Circle centre">${ICON.circle}</button><button data-shape="triangle" title="Triangle centre" aria-label="Triangle centre">${ICON.triangle}</button></div>
    </div>
    <div class="cp-body">
      <div class="cp-wheel" style="width:${SIZE}px;height:${SIZE}px">
        <div class="cp-ring" style="background:conic-gradient(from 0deg, ${HUE_STOPS});--ring-inner:${((SIZE / 2 - RING) / (SIZE / 2)) * 100}%"></div>
        <span class="cp-handle cp-hue"></span>
        <div class="cp-disc" style="width:${INNER}px;height:${INNER}px"></div>
        <svg class="cp-tri" width="${INNER}" height="${INNER}" viewBox="${-TR} ${-TR} ${INNER} ${INNER}">
          <defs>
            <linearGradient id="cp-sat" gradientUnits="userSpaceOnUse" x1="${V[1].x}" y1="${V[1].y}" x2="${V[0].x}" y2="${V[0].y}"><stop offset="0" stop-color="#fff"/><stop class="cp-pure" offset="1" stop-color="red"/></linearGradient>
            <linearGradient id="cp-val" gradientUnits="userSpaceOnUse" x1="${V[2].x}" y1="${V[2].y}" x2="${(V[0].x + V[1].x) / 2}" y2="${(V[0].y + V[1].y) / 2}"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
          </defs>
          <polygon points="${V.map((p) => p.x + "," + p.y).join(" ")}" fill="url(#cp-sat)"/>
          <polygon points="${V.map((p) => p.x + "," + p.y).join(" ")}" fill="url(#cp-val)"/>
        </svg>
        <span class="cp-handle cp-area"></span>
      </div>
      <div class="cp-grid">
        <div class="cp-grid-top">
          <svg class="cp-cells" viewBox="-110 -110 220 220">${CELLS.map((c, i) => `<polygon data-cell="${i}" points="${cellPoints(c.x * 10.4, c.y * 10.4, 10.2)}"/>`).join("")}</svg>
          <input type="range" class="cp-bright" min="0" max="100" aria-label="Brightness" orient="vertical">
        </div>
        <div class="cp-cmyk">${[["h", 360, "Hue"], ["s", 100, "Saturation"], ["l", 100, "Lightness"]].map(([k, max, t]) => `<label title="${t}"><span>${k.toUpperCase()}</span><input type="range" min="0" max="${max}" data-hsl="${k}" class="cp-track-${k}" aria-label="${t}"><input type="number" min="0" max="${max}" data-hsln="${k}" aria-label="${t}"></label>`).join("")}</div>
      </div>
    </div>
    <label class="cp-alpha"><span>Alpha</span><input type="range" min="0" max="100" data-alpha><input type="number" min="0" max="100" data-alphan></label>
    <div class="cp-row cp-infile" ${inFile.length ? "" : "hidden"}><span class="cp-label">In this file</span><div class="cp-dots" data-list="file"></div></div>
    <div class="cp-row"><span class="cp-label">Saved</span><div class="cp-dots" data-list="saved"></div></div>
    <div class="cp-readout">
      <div class="cp-line">
        <span class="cp-preview" title="How text looks on this colour (it switches between dark and light text to stay readable)">Aa</span>
        <label class="cp-field cp-hexf"><span>Hex</span><input data-hex maxlength="7" spellcheck="false"></label>
        <button class="cp-copy" data-copy="hex" title="Copy hex" aria-label="Copy hex">${ICON.copy}</button>
      </div>
      <div class="cp-line">
        ${["r", "g", "b"].map((k) => `<label class="cp-field"><span>${k.toUpperCase()}</span><input type="number" min="0" max="255" data-rgb="${k}"></label>`).join("")}
        <button class="cp-copy" data-copy="rgb" title="Copy RGB" aria-label="Copy RGB">${ICON.copy}</button>
      </div>
    </div>
    <div class="cp-foot"><button class="cp-link" data-revert>Undo changes</button><span class="cp-hint">Esc or Enter to close</span></div>`;
  const q = (s) => el.querySelector(s);
  const wheel = q(".cp-wheel"), disc = q(".cp-disc"), tri = q(".cp-tri");

  function dots(list, which) {
    // Colours with transparency (#rrggbbaa) sit on a checkerboard, so they don't all look alike.
    return list.map((h) => `<span class="cp-slot"><button class="cp-dot${h.length > 7 ? " cp-alpha" : ""}" data-pick="${h}" style="--c:${h}" title="${h}"></button>${which === "saved" ? `<button class="cp-forget" data-forget="${h}" title="Remove from saved" aria-label="Remove ${h} from saved">×</button>` : ""}</span>`).join("")
      + (which === "saved" ? `<button class="cp-dot cp-add" data-save title="Save this colour" aria-label="Save this colour">+</button>` : "");
  }
  q('[data-list="file"]').innerHTML = dots(inFile.slice(0, 14), "file");
  const paintSaved = () => (q('[data-list="saved"]').innerHTML = dots(saved, "saved"));
  paintSaved();

  function paint(from) {
    const h = hex(), rgb = hsvToRgb(hsv), pure = `hsl(${hsv.h}, 100%, 50%)`;
    for (const b of el.querySelectorAll("[data-mode]")) b.classList.toggle("on", b.dataset.mode === mode);
    for (const b of el.querySelectorAll("[data-shape]")) b.classList.toggle("on", b.dataset.shape === shape);
    q(".cp-shapes").style.visibility = mode === "wheel" ? "" : "hidden";
    wheel.hidden = mode !== "wheel";
    q(".cp-grid").hidden = mode !== "grid";
    // wheel
    const ha = ((hsv.h - 90) * Math.PI) / 180, hr = SIZE / 2 - RING / 2;
    Object.assign(q(".cp-hue").style, { transform: `translate(calc(${hr * Math.cos(ha)}px - 50%), calc(${hr * Math.sin(ha)}px - 50%))`, background: pure });
    disc.hidden = shape !== "circle";
    tri.style.display = shape === "triangle" ? "" : "none";
    disc.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${pure}`;
    q(".cp-pure").setAttribute("stop-color", pure);
    let p;
    if (shape === "triangle") {
      const w = [hsv.s * hsv.v, (1 - hsv.s) * hsv.v, 1 - hsv.v];
      p = { x: V[0].x * w[0] + V[1].x * w[1] + V[2].x * w[2], y: V[0].y * w[0] + V[1].y * w[1] + V[2].y * w[2] };
    } else p = { x: hsv.s * INNER - INNER / 2, y: (1 - hsv.v) * INNER - INNER / 2 };
    Object.assign(q(".cp-area").style, { transform: `translate(calc(${p.x}px - 50%), calc(${p.y}px - 50%))`, background: h });
    // grid
    if (mode === "grid") {
      for (const poly of el.querySelectorAll("[data-cell]")) {
        const c = CELLS[poly.dataset.cell];
        poly.setAttribute("fill", hsvToHex({ h: c.hue, s: c.sat, v: hsv.v }));
        poly.classList.toggle("on", Math.abs(c.sat - hsv.s) < 0.08 && (c.sat < 0.08 || Math.abs(c.hue - hsv.h) < 14 || Math.abs(c.hue - hsv.h) > 346));
      }
      if (from !== "bright") q(".cp-bright").value = Math.round(hsv.v * 100);
      // HSL, the way CSS writes it (hsl(210 50% 40%)).
      const hl = rgbToHsl(rgb), shown = { h: Math.round(hsv.h), s: Math.round(hl.s * 100), l: Math.round(hl.l * 100) };
      for (const k of ["h", "s", "l"]) {
        if (from !== "hsl:" + k) q(`[data-hsl="${k}"]`).value = shown[k];
        if (from !== "hsln:" + k) q(`[data-hsln="${k}"]`).value = shown[k];
      }
    }
    // alpha, readout
    q("[data-alpha]").style.setProperty("--to", h);
    if (from !== "alpha") q("[data-alpha]").value = Math.round(alpha * 100);
    if (from !== "alphan") q("[data-alphan]").value = Math.round(alpha * 100);
    Object.assign(q(".cp-preview").style, { background: h, color: readableOn(h) });
    if (from !== "hex") q("[data-hex]").value = h;
    for (const k of ["r", "g", "b"]) if (from !== "rgb:" + k) q(`[data-rgb="${k}"]`).value = rgb[k];
    for (const d of el.querySelectorAll("[data-pick]")) d.classList.toggle("on", d.dataset.pick.toLowerCase().slice(0, 7) === h && (d.dataset.pick.length < 9 || Math.abs(parseInt(d.dataset.pick.slice(7), 16) / 255 - alpha) < 0.01));
  }

  // ----- dragging on the wheel -----
  const at = (e) => { const r = wheel.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }; };
  const applyHue = (p) => { let a = (Math.atan2(p.y, p.x) * 180) / Math.PI + 90; if (a < 0) a += 360; set({ ...hsv, h: a }); };
  const applyArea = (p) => {
    if (shape === "triangle") {
      const [hue, white] = barycentric(p, V), v = hue + white;
      set({ h: hsv.h, s: clamp(v ? hue / v : 0, 0, 1), v: clamp(v, 0, 1) });
    } else {
      const R = INNER / 2, d = Math.hypot(p.x, p.y), k = d > R ? R / d : 1;
      set({ h: hsv.h, s: clamp((p.x * k + R) / INNER, 0, 1), v: clamp(1 - (p.y * k + R) / INNER, 0, 1) });
    }
  };
  wheel.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = at(e), d = Math.hypot(p.x, p.y), what = d > SIZE / 2 - RING - 3 ? "hue" : "area";
    e.preventDefault();
    wheel.setPointerCapture(e.pointerId);
    const go = (ev) => (what === "hue" ? applyHue(at(ev)) : applyArea(at(ev)));
    go(e);
    const up = () => { wheel.removeEventListener("pointermove", go); wheel.removeEventListener("pointerup", up); wheel.removeEventListener("pointercancel", up); };
    wheel.addEventListener("pointermove", go);
    wheel.addEventListener("pointerup", up);
    wheel.addEventListener("pointercancel", up);
  });

  // ----- everything else -----
  el.addEventListener("pointerdown", (e) => { const c = e.target.closest("[data-cell]"); if (c) { const x = CELLS[c.dataset.cell]; set({ h: x.hue, s: x.sat, v: hsv.v }); } });
  let copied = 0;
  el.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.mode) { mode = t.dataset.mode; keep(MODE_KEY, mode); paint(); }
    else if (t.dataset.shape) { shape = t.dataset.shape; keep(SHAPE_KEY, shape); paint(); }
    else if (t.dataset.pick) { const p = t.dataset.pick; alpha = p.length > 7 ? parseInt(p.slice(7, 9), 16) / 255 : 1; set(rgbToHsv(hexToRgb(p.slice(0, 7)))); }
    else if (t.dataset.forget) { saved = saved.filter((x) => x !== t.dataset.forget); keep(SAVED_KEY, JSON.stringify(saved)); paintSaved(); paint(); }
    else if (t.hasAttribute("data-save")) { saved = [...saved.filter((x) => x !== hex()), hex()].slice(-24); keep(SAVED_KEY, JSON.stringify(saved)); paintSaved(); paint(); }
    else if (t.dataset.copy) {
      const rgb = hsvToRgb(hsv);
      navigator.clipboard?.writeText(t.dataset.copy === "hex" ? hex() : `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`).catch(() => {});
      t.innerHTML = ICON.check;
      clearTimeout(copied);
      copied = setTimeout(() => { for (const b of el.querySelectorAll("[data-copy]")) b.innerHTML = ICON.copy; }, 1200);
    } else if (t.hasAttribute("data-revert")) { alpha = colour.a ?? 1; set(rgbToHsv(startRgb)); }
  });
  el.addEventListener("input", (e) => {
    const t = e.target, d = t.dataset;
    if (d.hex !== undefined) { const h = normalizeHex(t.value); if (h) set(rgbToHsv(hexToRgb(h)), "hex"); }
    else if (d.rgb) { const rgb = { ...hsvToRgb(hsv), [d.rgb]: clamp(+t.value || 0, 0, 255) }; set(rgbToHsv(rgb), "rgb:" + d.rgb); }
    else if (d.hsl || d.hsln) {
      const k = d.hsl || d.hsln, hl = { ...rgbToHsl(hsvToRgb(hsv)), h: hsv.h }, v = +t.value || 0; // the picker's hue survives grey
      const next = { ...hl, [k]: k === "h" ? clamp(v, 0, 360) : clamp(v, 0, 100) / 100 };
      set(rgbToHsv(hslToRgb(next)), (d.hsl ? "hsl:" : "hsln:") + k);
    }
    else if (t.classList.contains("cp-bright")) set({ ...hsv, v: +t.value / 100 }, "bright");
    else if (d.alpha !== undefined || d.alphan !== undefined) { alpha = clamp(+t.value || 0, 0, 100) / 100; emit(); paint(d.alpha !== undefined ? "alpha" : "alphan"); }
  });
  q("[data-hex]").addEventListener("blur", (e) => (e.target.value = hex()));

  // ----- placing and closing -----
  // Below the colour, else above it, else beside it: never on top of the colour being edited.
  // In a short window it scrolls rather than running off the bottom.
  function place() {
    const a = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor, M = 8;
    el.style.maxHeight = innerHeight - 2 * M + "px";
    const w = el.offsetWidth, h = el.offsetHeight;
    let left, top;
    if (!a) { left = (innerWidth - w) / 2; top = (innerHeight - h) / 2; }
    else if (a.bottom + 6 + h + M <= innerHeight) { left = a.left; top = a.bottom + 6; }
    else if (a.top - 6 - h >= M) { left = a.left; top = a.top - 6 - h; }
    else {
      top = Math.min(Math.max(M, a.top - h / 2), innerHeight - h - M);
      left = a.right + 16 + w + M <= innerWidth ? a.right + 16 : a.left - 16 - w;
    }
    left = Math.min(Math.max(M, left), innerWidth - w - M);
    Object.assign(el.style, { left: left + "px", top: Math.max(M, top) + "px" });
  }
  const prevFocus = document.activeElement;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    removeEventListener("pointerdown", outside, true);
    removeEventListener("keydown", key, true);
    removeEventListener("resize", close);
    el.remove();
    onClose?.();
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
  }
  const outside = (e) => { if (!el.contains(e.target)) close(); };
  const key = (e) => {
    if (e.key === "Escape" || (e.key === "Enter" && !e.target.closest?.("button"))) { e.preventDefault(); e.stopPropagation(); close(); }
  };
  el._close = close;
  paint();
  place();
  requestAnimationFrame(() => {
    if (closed) return;
    addEventListener("pointerdown", outside, true);
    addEventListener("keydown", key, true);
    addEventListener("resize", close);
    q("[data-hex]").focus();
    q("[data-hex]").select();
  });
  return close;
}

/** Wires the picker to the editor: swatches in every file, and a command at the cursor. */
export function initColours(app) {
  const { S, settings } = app;
  function inFile(state, lang) {
    const seen = new Set();
    for (let i = 1; i <= Math.min(state.doc.lines, 5000) && seen.size < 14; i++) {
      for (const m of coloursIn(state.doc.line(i).text, lang)) seen.add(rgbToHex(m.c) + (m.c.a < 0.999 ? hex2(m.c.a * 255) : ""));
    }
    return [...seen];
  }
  function edit(view, found, lang, anchor) {
    let from = found.from, to = found.to;
    // Keep clear of the whole colour as written (swatch and text), not just the swatch.
    const s = view.coordsAtPos(from, 1), e = view.coordsAtPos(to, -1), r0 = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    if (s && e) anchor = { left: Math.min(s.left, r0?.left ?? s.left), right: Math.max(e.right, r0?.right ?? e.right), top: Math.min(s.top, e.top, r0?.top ?? s.top), bottom: Math.max(s.bottom, e.bottom, r0?.bottom ?? s.bottom) };
    const fmt = found.c.fmt;
    let first = true, expected = view.state.doc;
    const original = view.state.sliceDoc(from, to);
    const close = openPicker({
      anchor,
      colour: found.c,
      inFile: inFile(view.state, lang).filter((h) => h.slice(0, 7) !== rgbToHex(found.c)),
      onChange(c) {
        // The editor shows something else now (another tab, a reload, an edit from elsewhere):
        // stop, rather than write into the wrong place.
        if (view.state.doc !== expected || !view.dom.isConnected) { close(); return; }
        const text = formatColour(c, fmt);
        if (text === view.state.sliceDoc(from, to)) return;
        // While the picker is open the changes stay out of undo; closing it records one step from
        // the colour you started with to the one you ended on.
        view.dispatch({ changes: { from, to, insert: text }, annotations: Transaction.addToHistory.of(false), scrollIntoView: false });
        first = false;
        to = from + text.length;
        expected = view.state.doc;
      },
      onClose: () => {
        if (!first && view.state.doc === expected && view.dom.isConnected) {
          const now = view.state.sliceDoc(from, to);
          view.dispatch({ changes: { from, to, insert: original }, annotations: Transaction.addToHistory.of(false) });
          view.dispatch({ changes: { from, to: from + original.length, insert: now }, userEvent: "input.colour", scrollIntoView: false });
        }
        view.focus();
      },
    });
  }
  const open = (lang) => (view, pos, swatchEl) => {
    const found = colourAt(view.state, pos, lang);
    if (found) edit(view, found, lang, swatchEl);
  };
  // Lust views draw their own swatches (src/lustview.js), so Lust files don't get a second set.
  app.extraExt.push((path, b) => (settings.colourSwatches === false || b.lang === "text" || b.lang === "lust" ? [] : colourSwatches(b.lang, open(b.lang))));

  app.command("colour.pick", "Pick a colour", [], () => {
    const v = app.view, b = S.bufs.get(S.active);
    if (!v || !b) { app.toast("Open a file first."); return; }
    const pos = v.state.selection.main.head;
    const found = colourAt(v.state, pos, b.lang);
    const coords = v.coordsAtPos(pos);
    const anchor = coords ? { left: coords.left, right: coords.right, top: coords.top, bottom: coords.bottom } : null;
    if (found) { edit(v, found, b.lang, anchor); return; }
    // Not on a colour: insert one at the cursor and edit that.
    const sel = v.state.selection.main;
    const start = { r: 47, g: 109, b: 176, a: 1, fmt: { kind: "hex", short: false, upper: false, alpha: false } };
    const text = formatColour(start, start.fmt);
    v.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length } });
    edit(v, { from: sel.from, to: sel.from + text.length, c: start }, b.lang, anchor);
  });
}
