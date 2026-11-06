// The minimap: a small picture of the file at the editor's right edge, in the editor's own syntax
// colours, with the part on screen shaded. Click it to jump there, or drag the shaded part to
// scroll. Errors and warnings tint their lines; Git changes show as a bar down its left edge.
//
// It draws only the lines it shows, from the syntax colours the editor has already worked out, at
// most once a frame, so typing in a long file costs about the same with it as without.
// Settings › Editor: minimap (on), minimapOverlay ("always", or "mouse-over" to shade the part on
// screen only while the pointer is over the minimap).
import { ViewPlugin, EditorView } from "@codemirror/view";
import { syntaxTree, highlightingFor } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { forEachDiagnostic } from "@codemirror/lint";

const WIDTH = 84; // CSS pixels
const LINE = 2; // each line is 2 pixels tall
const CHAR = 1; // and each character 1 pixel wide, so about 80 columns show
const MAX_LINES = 200000; // past this, skip it

/** Where the minimap shows and what's shaded, in its own pixels, from the editor's scroll. */
export function geometry({ lines, scrollTop, viewH, docH, mapH }) {
  const total = lines * LINE; // the whole picture
  const scrollMax = Math.max(0, docH - viewH);
  const frac = scrollMax > 0 ? Math.min(1, Math.max(0, scrollTop / scrollMax)) : 0;
  const offset = total > mapH ? frac * (total - mapH) : 0; // the picture scrolls when it's taller
  const sliderH = Math.max(LINE * 2, Math.min(total, mapH, (viewH / Math.max(docH, 1)) * total));
  const sliderTop = Math.min(Math.min(total, mapH) - sliderH, Math.max(0, (scrollTop / Math.max(docH, 1)) * total - offset));
  return { total, offset, sliderTop, sliderH, first: Math.floor(offset / LINE) };
}

export function initMinimap(app) {
  const { settings } = app;
  let colours = new Map(); // highlight class → colour, read from the theme
  let palette = null; // --good, --info and such

  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.dom = document.createElement("div");
      this.dom.className = "lg-minimap";
      this.dom.setAttribute("aria-hidden", "true");
      this.canvas = document.createElement("canvas");
      this.slider = document.createElement("div");
      this.slider.className = "lg-minimap-slider";
      this.dom.append(this.canvas, this.slider);
      view.dom.appendChild(this.dom);
      this.onScroll = () => this.schedule();
      view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      this.dom.addEventListener("mousedown", (e) => this.press(e));
      this.dom.addEventListener("wheel", (e) => { view.scrollDOM.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
      this.queued = false;
      this.schedule();
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.geometryChanged || u.selectionSet || u.transactions.some((t) => t.effects.length)) this.schedule();
    }
    schedule() {
      if (this.queued) return;
      this.queued = true;
      this.view.requestMeasure({ read: (v) => this.read(v), write: (m) => { this.queued = false; this.draw(m); } });
    }
    read(v) {
      const s = v.scrollDOM;
      const bar = s.offsetWidth - s.clientWidth; // the scrollbar stays to the minimap's right
      return { scrollTop: s.scrollTop, viewH: s.clientHeight, docH: v.contentHeight, top: s.offsetTop, bar, dpr: window.devicePixelRatio || 1, ink: readColours(v) };
    }
    draw(m) {
      const { view } = this;
      const st = view.state, doc = st.doc;
      const mapH = m.viewH;
      if (!mapH) return;
      this.dom.classList.toggle("hover-only", settings.minimapOverlay === "mouse-over");
      Object.assign(this.dom.style, { top: m.top + "px", height: mapH + "px", right: m.bar + "px", width: WIDTH + "px" });
      const g = geometry({ lines: doc.lines, scrollTop: m.scrollTop, viewH: m.viewH, docH: m.docH, mapH });
      this.geo = { ...g, mapH, ...m };
      Object.assign(this.slider.style, { top: g.sliderTop + "px", height: g.sliderH + "px" });
      const W = Math.round(WIDTH * m.dpr), H = Math.round(mapH * m.dpr);
      if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
      const c = this.canvas.getContext("2d");
      c.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
      c.clearRect(0, 0, WIDTH, mapH);
      const firstLine = Math.min(doc.lines, g.first + 1);
      const lastLine = Math.min(doc.lines, firstLine + Math.ceil(mapH / LINE) + 1);
      const y0 = (firstLine - 1) * LINE - g.offset;
      const yOf = (n) => y0 + (n - firstLine) * LINE;
      const from = doc.line(firstLine).from, to = doc.line(lastLine).to;

      // Lines with problems, under the text.
      forEachDiagnostic(st, (d, a0, b0) => {
        if (b0 < from || a0 > to) return;
        const a = Math.max(firstLine, doc.lineAt(Math.max(a0, from)).number), b = Math.min(lastLine, doc.lineAt(Math.min(b0, to)).number);
        c.fillStyle = d.severity === "error" ? m.ink.error : d.severity === "warning" ? m.ink.warning : m.ink.info;
        c.globalAlpha = 0.35;
        for (let n = a; n <= b; n++) c.fillRect(0, yOf(n), WIDTH, LINE);
      });
      // The cursor's line.
      const cur = doc.lineAt(st.selection.main.head).number;
      if (cur >= firstLine && cur <= lastLine) { c.globalAlpha = 0.25; c.fillStyle = m.ink.text; c.fillRect(0, yOf(cur), WIDTH, LINE); }

      // The text: each run of characters as a small bar in its syntax colour.
      c.globalAlpha = 0.75;
      const tab = st.tabSize;
      const spans = []; // [from, to, colour] in the shown lines, in order
      highlightTree(syntaxTree(st), { style: (tags) => highlightingFor(st, tags) }, (a, b, cls) => spans.push([a, b, colourOf(cls, m.ink)]), from, to);
      let si = 0;
      for (let n = firstLine; n <= lastLine; n++) {
        const line = doc.line(n), text = line.text, y = yOf(n);
        let col = 0, runStart = -1, runColour = null;
        const flush = (end) => { if (runStart >= 0) { c.fillStyle = runColour; c.fillRect(2 + runStart * CHAR, y, (end - runStart) * CHAR, LINE - 0.5); runStart = -1; } };
        while (si < spans.length && spans[si][1] <= line.from) si++;
        let j = si;
        for (let i = 0; i < text.length && 2 + col * CHAR < WIDTH; i++) {
          const ch = text.charCodeAt(i);
          if (ch === 32 || ch === 9) { flush(col); col = ch === 9 ? col + tab - (col % tab) : col + 1; continue; }
          const pos = line.from + i;
          while (j < spans.length && spans[j][1] <= pos) j++;
          const colour = j < spans.length && spans[j][0] <= pos ? spans[j][2] : m.ink.text;
          if (colour !== runColour) { flush(col); runColour = colour; }
          if (runStart < 0) runStart = col;
          col++;
        }
        flush(col);
      }

      // Git changes down the left edge (what the overview ruler shows, from git.js).
      c.globalAlpha = 1;
      for (const f of app.scrollMarks) {
        for (const mk of f(st) || []) {
          if (mk.pos < from || mk.pos > to) continue;
          const ink = mk.kind === "add" ? m.ink.add : mk.kind === "mod" ? m.ink.mod : mk.kind === "del" ? m.ink.del : null;
          if (!ink) continue;
          c.fillStyle = ink;
          c.fillRect(0, yOf(doc.lineAt(mk.pos).number), 2, mk.kind === "del" ? 1 : LINE);
        }
      }
    }
    /** Click: jump there (that line in the middle of the screen). Drag the shaded part: scroll. */
    press(e) {
      if (e.button !== 0 || !this.geo) return;
      e.preventDefault();
      const { view } = this, g = this.geo;
      const rect = this.dom.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const onSlider = y >= g.sliderTop && y <= g.sliderTop + g.sliderH;
      if (!onSlider) {
        const n = Math.min(view.state.doc.lines, Math.max(1, Math.floor((y + g.offset) / LINE) + 1));
        const top = view.lineBlockAt(view.state.doc.line(n).from).top;
        view.scrollDOM.scrollTop = Math.max(0, top - g.viewH / 2);
      }
      // Dragging follows the pointer: the shaded part stays under it.
      const grab = onSlider ? y - g.sliderTop : g.sliderH / 2;
      const move = (ev) => {
        const gg = this.geo;
        const travel = Math.min(gg.total, gg.mapH) - gg.sliderH;
        if (travel <= 0) return;
        const frac = Math.min(1, Math.max(0, (ev.clientY - rect.top - grab) / travel));
        view.scrollDOM.scrollTop = frac * Math.max(0, gg.docH - gg.viewH);
      };
      const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); this.dom.classList.remove("dragging"); };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
      this.dom.classList.add("dragging");
    }
    destroy() {
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
      this.dom.remove();
    }
  });

  /** A highlight class's colour in the current theme (looked up once). */
  function colourOf(cls, ink) {
    if (!cls) return ink.text;
    let c = colours.get(cls);
    if (c === undefined) {
      const probe = document.createElement("span");
      probe.className = cls;
      probe.textContent = "x";
      (app.view?.contentDOM || document.body).appendChild(probe);
      c = getComputedStyle(probe).color || ink.text;
      probe.remove();
      colours.set(cls, c);
    }
    return c;
  }
  function readColours(view) {
    if (palette) return palette;
    const cs = getComputedStyle(view.dom), v = (n, d) => cs.getPropertyValue(n).trim() || d;
    palette = { text: getComputedStyle(view.contentDOM).color, error: v("--seal", "#c33"), warning: v("--warn", "#c90"), info: v("--info", "#38c"), add: v("--good", "#3a3"), mod: v("--info", "#38c"), del: v("--seal", "#c33") };
    return palette;
  }

  const ext = [plugin, EditorView.editorAttributes.of({ class: "lg-has-minimap" })];
  app.extraExt.push((path, b) => {
    // Not for tabs that aren't files (decompiled sources, HTTP responses), or giant files.
    if (settings.minimap === false || b?.virtual) return [];
    if ((b?.state?.doc.lines || 0) > MAX_LINES) return [];
    return ext;
  });

  // A new theme or font: read the colours again and redraw.
  const recolour = () => { colours = new Map(); palette = null; app.reconfigureExtras?.(); };
  app.settingHooks.push((key) => {
    if (["minimap", "minimapOverlay", "theme", "codeColours", "fontFamily", "fontSize"].includes(key)) recolour();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", recolour);

  app.command("view.minimap", "View: show or hide the minimap", [], () => app.setSetting("minimap", settings.minimap === false), { alias: "overview map scroll" });
}
