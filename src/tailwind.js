// Tailwind class completion, without a language server: the project's own
// Tailwind (v3 or v4) lists every class it knows, including ones added in
// @theme or tailwind.config, and Ledger offers them inside class="",
// className, @apply and clsx()/cn(). Colour classes get a swatch.
import { autocompletion } from "@codemirror/autocomplete";

// Runs in the project folder with node; prints {classes, variants, colors} or null.
const SCRIPT = String.raw`
import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.cwd(), req = createRequire(join(root, "package.json"));
const done = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
let version;
try { version = req("tailwindcss/package.json").version; } catch { done(null); }
const out = { classes: [], variants: [], colors: {} };
const flat = (o, p) => { for (const [k, v] of Object.entries(o || {})) { const n = k === "DEFAULT" ? p : p ? p + "-" + k : k; if (typeof v === "string") out.colors[n] = v; else if (v && typeof v === "object") flat(v, n); } };
if (version.startsWith("3")) {
  const resolveConfig = req("tailwindcss/resolveConfig");
  const { createContext } = req("tailwindcss/lib/lib/setupContextUtils");
  const file = ["js", "cjs", "mjs", "ts"].map((e) => join(root, "tailwind.config." + e)).find(existsSync);
  let cfg = {};
  if (file) { try { const m = await import(pathToFileURL(file).href); cfg = m.default || m; } catch {} }
  const ctx = createContext(resolveConfig(cfg));
  out.classes = ctx.getClassList().map((c) => (Array.isArray(c) ? c[0] : c));
  out.variants = [...ctx.variantMap.keys()];
  flat(ctx.tailwindConfig.theme.colors, "");
} else {
  const SKIP = new Set(["node_modules", "dist", "build", "out", "target"]);
  const find = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (depth < 5 && !SKIP.has(e.name) && !e.name.startsWith(".")) { const f = find(p, depth + 1); if (f) return f; } }
      else if (e.name.endsWith(".css") && /@import\s+["']tailwindcss/.test(readFileSync(p, "utf8"))) return p;
    }
    return null;
  };
  const css = find(root, 0);
  if (!css) done(null);
  const node = await import(pathToFileURL(req.resolve("@tailwindcss/node")).href);
  const ds = await node.__unstable__loadDesignSystem(readFileSync(css, "utf8"), { base: dirname(css) });
  out.classes = ds.getClassList().map(([n]) => n);
  out.variants = ds.getVariants().filter((v) => !v.isArbitrary).map((v) => v.name);
  for (const [k, v] of ds.theme.entries()) if (k.startsWith("--color-")) out.colors[k.slice(8)] = v.value;
}
done(out);
`;

let host = null; // { run(dir, args) -> stdout, dir() -> project folder or null }
// Listing a project's classes means starting node and loading Tailwind: a second or more, longer on
// Windows. So the list is kept between sessions (localStorage), fetched ahead of time when a file in
// the project opens, and refreshed in the background, while the old list keeps answering.
const ready = new Map(); // folder -> { options }: what completion uses right now
const running = new Map(); // folder -> Promise of a listing in progress
const fresh = new Set(); // folders already listed (or being listed) this session
const STORE = (dir) => "ledger-tailwind:" + dir;

export function initTailwind(h) { host = h; }

function build(d) {
  const colourOf = (cls) => { // bg-red-500/50 -> the red-500 colour
    const base = cls.replace(/\/\d+$/, "").split("-");
    for (let i = 1; i < base.length; i++) { const c = d.colors[base.slice(i).join("-")]; if (c) return c; }
    return null;
  };
  const options = d.classes.map((label) => {
    const o = { label, type: "tw" };
    const c = colourOf(label);
    if (c) o.twColour = c;
    return o;
  });
  for (const v of d.variants) options.push({ label: v + ":", type: "keyword", boost: -2 });
  return { options };
}

/** Lists the classes again in the background; the current list stays until the new one is in. */
function refresh(dir) {
  if (running.has(dir)) return running.get(dir);
  fresh.add(dir);
  const p = host.run(dir, ["--input-type=module", "-e", SCRIPT]).then((text) => {
    const d = JSON.parse(text || "null");
    if (!d) return ready.get(dir) || null;
    try { localStorage.setItem(STORE(dir), JSON.stringify(d)); } catch {} // too big for the store: just this session
    const r = build(d);
    ready.set(dir, r);
    return r;
  }).catch(() => ready.get(dir) || null).then((r) => {
    running.delete(dir);
    if (!r) setTimeout(() => fresh.delete(dir), 15000); // not installed yet, or a broken config: try again soon
    return r;
  });
  running.set(dir, p);
  return p;
}

/** The list right away if there is one (this session's, or the one kept from last time). */
function now(dir) {
  if (!ready.has(dir)) {
    try {
      const kept = JSON.parse(localStorage.getItem(STORE(dir)) || "null");
      if (kept) ready.set(dir, build(kept));
    } catch {}
  }
  if (!fresh.has(dir)) refresh(dir); // once a session, so new classes and theme colours show up
  return ready.get(dir) || null;
}
const load = (dir) => now(dir) || running.get(dir) || null;

/** Get the list ready before it's needed: called when a file opens. */
export function tailwindWarm() {
  const dir = host?.dir();
  if (dir) now(dir);
}

/** After a CSS file or tailwind.config changes: list again in the background. */
export function tailwindChanged() {
  for (const dir of new Set([...ready.keys(), ...fresh])) refresh(dir);
}

// Where a class list is being typed: class="…", className="…" or {`…`}, @apply …, clsx("…") and friends.
const WHERE = /(?:\bclass(?:Name)?\s*=\s*\{?\s*["'`][^"'`]*|@apply\s+[^;{}]*|\b(?:clsx|cn|cva|cx|twMerge|twJoin|classNames|classnames|tw)\s*\([^)]*?["'`][^"'`]*)$/;

const lineBefore = (ctx) => { const line = ctx.state.doc.lineAt(ctx.pos); return line.text.slice(0, ctx.pos - line.from); };
/** True when the cursor is in a class list (main.js skips the language server there). */
export const inClassList = (ctx) => WHERE.test(lineBefore(ctx));
const VALID = /^[-\w./[\]%#!]*$/;

async function source(ctx) {
  const dir = host?.dir();
  if (!dir) return null;
  const before = lineBefore(ctx);
  if (!WHERE.test(before)) return null;
  const word = /[^\s"'`]*$/.exec(before)[0];
  // After hover: or md:, complete the class that comes after the last colon.
  const seg = word.slice(word.lastIndexOf(":") + 1);
  if (!seg && !ctx.explicit) return null;
  const data = await load(dir);
  if (!data || ctx.aborted) return null;
  // 23,000 classes: hand the editor only those starting with the first letter typed, then let it
  // narrow that list itself while the word keeps growing.
  const options = seg ? data.options.filter((o) => o.label[0] === seg[0]) : data.options;
  return { from: ctx.pos - seg.length, options, validFor: (text) => VALID.test(text) && text.startsWith(seg) };
}

const swatch = {
  position: 20,
  render(c) {
    if (!c.twColour) return null;
    const s = document.createElement("span");
    s.className = "cm-tw-swatch";
    s.style.background = c.twColour;
    return s;
  },
};

/** Completion source for main.js's list, plus the colour swatches. */
export const tailwindSource = source;
export const tailwindSwatches = () => autocompletion({ addToOptions: [swatch] });
