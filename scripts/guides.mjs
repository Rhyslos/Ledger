// Builds Ledger's two guides, the Lust language guide and the Ledger user guide, into
// self-contained pages in src-tauri/guides/, which the app carries inside it and opens in the
// browser (the "Docs" commands).
//
//   node scripts/guides.mjs          build them
//   node scripts/guides.mjs --check  only check they're up to date (npm test does this too)
//
// The words are in guides/lust.html and guides/ledger.html, as chapters (<section class="chapter">).
// Both share guides/guide.css and guides/guide.js. Code goes in <pre data-lang="lust"> (or "text"),
// written as it is, with no escaping: this script escapes and colours it. data-file="main.lst" on
// the <pre> puts a file name over the code.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ---------- colouring Lust, as Ledger's quiet colours do ----------
const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
const STRUCTURE = words(`class object node assembly component event schema route method hook has new create lock state
  fetch get pass end save load saved lua view style native database`);
const FLOW = words("is then or either check when loop stop skip return try error like keep send on tween to over not in enter open close");
const TYPES = words("int int8 int16 int32 uint8 uint16 uint32 float string bool array cMap map vec2 vec3 rotation colour entity");
const VALUES = words("true false nothing this");
const OBJECTS = words("Maths Files Time Json Web Random Colour Rotation Ease App print wait ask");
// The pieces of a view are words only at the start of a line (as in Lust itself).
const PIECES = words(`column row stack space text button scroll image every input textarea checkbox switch radio number
  slider datePicker colourPicker icon grid split tabs tab branch progress canvas box circle line dropdown menu item divider
  dialog window table list key drop tray toast press drag release hover`);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls, s) => `<span class="tk-${cls}">${esc(s)}</span>`;

export function highlightLust(src) {
  let out = "", i = 0, lineStart = true, prev = [];
  const push = (html, tok) => { out += html; if (tok) prev.push(tok); };
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if (rest.startsWith("--[[")) {
      const e = rest.indexOf("]]");
      const s = e < 0 ? rest : rest.slice(0, e + 2);
      push(span("c", s)); i += s.length; continue;
    }
    if (rest.startsWith("--") || rest.startsWith("//")) {
      const e = rest.indexOf("\n");
      const s = e < 0 ? rest : rest.slice(0, e);
      push(span("c", s)); i += s.length; continue;
    }
    if (rest[0] === "\n") { out += "\n"; i++; lineStart = true; prev = []; continue; }
    if ((m = /^[ \t]+/.exec(rest))) { out += m[0]; i += m[0].length; continue; }
    if (rest[0] === '"') {
      let j = 1;
      while (j < rest.length && rest[j] !== '"' && rest[j] !== "\n") j += rest[j] === "\\" ? 2 : 1;
      const s = rest.slice(0, j + 1);
      push(span("v", s), "str"); i += s.length; lineStart = false; continue;
    }
    if ((m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest))) { push(span("v", m[0]), "num"); i += m[0].length; lineStart = false; continue; }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      const w = m[0], last = prev[prev.length - 1], before = prev[prev.length - 2];
      const afterDot = last === "." || last === ":";
      let cls = null;
      if (afterDot) cls = before && /^[A-Z]/.test(before) && /^[A-Z]/.test(w) && last === "." ? "s" : null;
      else if (lineStart && PIECES.has(w)) cls = "n";
      else if (STRUCTURE.has(w)) cls = "k";
      else if (FLOW.has(w)) cls = "f";
      else if (TYPES.has(w)) cls = "t";
      else if (VALUES.has(w)) cls = "v";
      else if (OBJECTS.has(w)) cls = "o";
      else if (/^[A-Z]/.test(w)) cls = "n";
      push(cls ? span(cls, w) : esc(w), w); i += w.length; lineStart = false; continue;
    }
    if ((m = /^(=>|[;,{}\[\]()?:.])/.exec(rest))) { push(span("p", m[0]), m[0]); i += m[0].length; lineStart = false; continue; }
    push(esc(rest[0]), rest[0]); i++; lineStart = false;
  }
  return out;
}

// Code is written indented with the HTML around it: take the common indent off.
function dedent(s) {
  s = s.replace(/^\n+/, "").replace(/\s+$/, "");
  const lines = s.split("\n");
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(pad)).join("\n");
}

function codeBlocks(html) {
  return html.replace(/<pre data-lang="(\w+)"([^>]*)>([\s\S]*?)<\/pre>/g, (_, lang, attrs, body) => {
    // Written either way, raw (<) or escaped (&lt;): the same code.
    const src = dedent(body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    const inner = lang === "lust" ? highlightLust(src) : esc(src);
    return `<pre class="code" data-lang="${lang}"${attrs}><code>${inner}</code></pre>`;
  });
}

// ---------- the pages ----------
const svg64 = (p) => "data:image/svg+xml;base64," + Buffer.from(read(p).trim()).toString("base64");
const GUIDES = {
  lust: {
    title: "Lust Language Guide",
    word: "Lust",
    small: "Language guide",
    description: "Every part of Lust: its syntax, types, views, library and commands, with examples.",
    logo: "src/assets/lust-lst.svg",
    search: "Search Lust",
    other: { href: "ledger.html", long: "Ledger user guide", short: "Ledger" },
    footer: "Lust is free and open source under the MIT licence. This guide follows the Lust rulebook (LUST.md) as of Lust 2.0.0 alpha 73; when the two differ, the rulebook wins.",
  },
  ledger: {
    title: "Ledger User Guide",
    word: "Ledger",
    small: "User guide",
    description: "How to use Ledger, the code editor: every view, tool and shortcut, step by step.",
    logo: "src-tauri/app-icons/ledger-plain.svg",
    search: "Search the guide",
    other: { href: "lust.html", long: "Lust language guide", short: "Lust" },
    footer: "Ledger has no AI in it, and never will. This guide describes the version it came with; Ctrl Shift P › Docs always opens the guide for the Ledger you have.",
  },
};

function page(name) {
  const g = GUIDES[name];
  const logo = svg64(g.logo);
  const body = codeBlocks(read(`guides/${name}.html`));
  return `<!DOCTYPE html>
<!-- Made by scripts/guides.mjs from guides/${name}.html. Edit that, not this. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${g.title}</title>
<meta name="description" content="${g.description}">
<link rel="icon" type="image/svg+xml" href="${logo}">
<script>
/* The chosen theme is set before anything is drawn, so the page never
   flashes the other one. Storage can be refused (file://, private windows). */
(function () {
  try {
    var t = window.localStorage.getItem("guide-theme");
    if (t === "light" || t === "dark") { document.documentElement.setAttribute("data-theme", t); }
  } catch (e) { /* follow the system */ }
}());
</script>
<style>
:root { --logo: url("${logo}"); }
${read("guides/guide.css")}
</style>
</head>
<body>
<header class="top">
  <button class="icon-button" id="toc-button" type="button" aria-controls="toc" aria-expanded="false" title="Contents">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"></path></svg>
  </button>
  <a class="brand" href="#welcome" title="To the top">
    <span class="logo" role="img" aria-label="${g.word}"></span>
    <span class="word">${g.word}</span> <small>${g.small}</small>
  </a>
  <div class="crumb" id="crumb" aria-label="You are reading">
    <a class="chap" id="crumb-chapter" href="#welcome">Welcome</a>
    <span class="sep hidden" aria-hidden="true">›</span>
    <span class="sub" id="crumb-section"></span>
  </div>
  <a class="other-guide" href="${g.other.href}" title="Open the ${g.other.long}">${g.other.short}<span class="long">&nbsp;${g.other.long.split(" ").slice(1).join(" ")}</span>&nbsp;→</a>
  <div class="search" role="search">
    <svg class="glass" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
    <input id="guide-search" type="search" placeholder="${g.search}" autocomplete="off" spellcheck="false" aria-label="${g.search}" aria-controls="results" aria-expanded="false">
    <span class="hint"><kbd>/</kbd><kbd>Ctrl K</kbd></span>
    <div class="results" id="results" role="listbox" aria-label="Search results"></div>
  </div>
  <button class="icon-button" id="theme-button" type="button" data-mode="system" title="Theme: Auto (follows the system). Click for Light." aria-label="Theme: Auto (follows the system). Click for Light.">
    <svg class="i-system" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"></path></svg>
    <svg class="i-light" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>
    <svg class="i-dark" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"></path></svg>
    <span class="label">Auto</span>
  </button>
  <div class="progress" id="progress" aria-hidden="true"></div>
</header>
<div class="page">
<nav class="toc" id="toc" aria-label="Contents"><div class="toc-head"><span>Contents</span><span class="read" id="toc-read">0% read</span></div></nav>
<div class="scrim" id="scrim"></div>
<main id="main">
<div class="guide">
${body.trim()}

<footer>
<p>${g.footer}</p>
</footer>
</div>
</main>
</div>
<button class="icon-button to-top" id="to-top" type="button" title="Back to the top">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>
  <span class="label">Top</span>
</button>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<div class="lightbox" id="lightbox" role="dialog" aria-modal="true" aria-label="Picture, large" aria-hidden="true">
  <button class="icon-button" type="button" aria-label="Close">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>
  </button>
  <img alt="">
  <p></p>
</div>
<script>
${read("guides/guide.js").trim()}
</script>
</body>
</html>
`;
}

// Every link inside a page goes somewhere, and so does every link to the other guide.
function ids(page) { const html = page.slice(0, page.lastIndexOf("<script>")); return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])); }
export function checkLinks(pages) {
  const bad = [];
  const have = Object.fromEntries(Object.entries(pages).map(([n, h]) => [n, ids(h)]));
  for (const [name, page] of Object.entries(pages)) {
    const html = page.slice(0, page.lastIndexOf("<script>")); // the words, not the script
    for (const m of html.matchAll(/href="([a-z]+\.html)?#([^"]+)"/g)) {
      const target = m[1] ? m[1].replace(/\.html$/, "") : name;
      if (!have[target]) bad.push(`${name}: link to ${m[1]} (no such guide)`);
      else if (!have[target].has(m[2])) bad.push(`${name}: link to ${m[1] || ""}#${m[2]}, which isn't there`);
    }
    const seen = new Set();
    for (const m of html.matchAll(/\sid="([^"]+)"/g)) { if (seen.has(m[1])) bad.push(`${name}: id ${m[1]} twice`); seen.add(m[1]); }
  }
  return bad;
}

export function buildGuides() {
  const pages = Object.fromEntries(Object.keys(GUIDES).map((n) => [n, page(n)]));
  const bad = checkLinks(pages);
  if (bad.length) throw new Error("Broken links in the guides:\n  " + bad.join("\n  "));
  return pages;
}

export const outPath = (name) => join(ROOT, "src-tauri", "guides", `${name}.html`);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pages = buildGuides();
  if (process.argv.includes("--check")) {
    const stale = Object.entries(pages).filter(([n, h]) => { try { return readFileSync(outPath(n), "utf8") !== h; } catch { return true; } });
    if (stale.length) { console.error(`Out of date: ${stale.map(([n]) => n).join(", ")}. Run: node scripts/guides.mjs`); process.exit(1); }
    console.log("The guides are up to date.");
  } else {
    mkdirSync(join(ROOT, "src-tauri", "guides"), { recursive: true });
    for (const [n, h] of Object.entries(pages)) { writeFileSync(outPath(n), h); console.log(`${outPath(n)}  ${(h.length / 1024).toFixed(0)} KB`); }
  }
}
