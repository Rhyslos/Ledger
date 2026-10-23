// Formatting web files with Prettier. A project with Prettier installed (and a trusted folder) is
// formatted by its own Prettier, with its .prettierrc and .prettierignore. Anything else uses the
// Prettier built into Ledger, loaded the first time it's needed, with the project's .prettierrc
// (JSON or simple YAML) or package.json "prettier" settings when there are any.
// Settings › Editing › Web formatting can hand formatting back to the language servers instead.

// Which Prettier parser, and which built-in plugins it needs.
const PARSERS = {
  javascript: ["babel", ["babel", "estree"]],
  jsx: ["babel", ["babel", "estree"]],
  typescript: ["typescript", ["typescript", "estree"]],
  tsx: ["typescript", ["typescript", "estree"]],
  html: ["html", ["html", "postcss", "babel", "estree"]],
  css: ["css", ["postcss"]],
  scss: ["scss", ["postcss"]],
  less: ["less", ["postcss"]],
  json: ["json", ["babel", "estree"]],
  jsonc: ["json", ["babel", "estree"]],
  markdown: ["markdown", ["markdown"]],
  yaml: ["yaml", ["yaml"]],
};
const PLUGINS = {
  babel: () => import("prettier/plugins/babel"),
  estree: () => import("prettier/plugins/estree"),
  typescript: () => import("prettier/plugins/typescript"),
  html: () => import("prettier/plugins/html"),
  postcss: () => import("prettier/plugins/postcss"),
  markdown: () => import("prettier/plugins/markdown"),
  yaml: () => import("prettier/plugins/yaml"),
};

// Runs in the project folder with node: formats stdin as argv[1] using the project's Prettier.
// Prints {text}, {ignored: true}, {missing: true} or {error}.
const SCRIPT = String.raw`
const { createRequire } = require("node:module");
const { join } = require("node:path");
const file = process.argv[1], tabWidth = +process.argv[2] || 2;
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
let src = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (src += d));
process.stdin.on("end", async () => {
  let p;
  try { p = createRequire(join(process.cwd(), "package.json"))("prettier"); } catch { out({ missing: true }); }
  try {
    const info = await p.getFileInfo(file, { ignorePath: join(process.cwd(), ".prettierignore") });
    if (info.ignored) out({ ignored: true });
    const cfg = await p.resolveConfig(file, { editorconfig: true });
    const text = await p.format(src, { ...(cfg || { tabWidth }), filepath: file });
    out({ text });
  } catch (e) { out({ error: String(e && e.message || e).split("\n").slice(0, 6).join("\n") }); }
});`;

export function initPrettier(app, formatters) {
  const { S, settings, invoke, join, parent, isUnder, toast } = app;
  const hasProjectPrettier = new Map(); // project folder -> bool (cleared when package.json changes)

  async function projectPrettier(dir) {
    if (!hasProjectPrettier.has(dir)) {
      const r = await invoke("file_stats", { paths: [join(dir, "node_modules/prettier/package.json")] }).catch(() => null);
      hasProjectPrettier.set(dir, !!r?.[0]);
    }
    return hasProjectPrettier.get(dir);
  }

  // .prettierrc (JSON, or "key: value" lines) or package.json's "prettier", nearest folder up.
  async function bundledConfig(path) {
    for (let d = parent(path); d && (isUnder(d, S.root) || d === S.root); d = parent(d)) {
      for (const name of [".prettierrc", ".prettierrc.json", "package.json"]) {
        const text = await invoke("read_file", { path: join(d, name) }).catch(() => null);
        if (text == null) continue;
        if (name === "package.json") {
          try { const p = JSON.parse(text).prettier; if (p && typeof p === "object") return p; } catch {}
          continue;
        }
        try { return JSON.parse(text); } catch {}
        const o = {};
        for (const line of text.split(/\r?\n/)) {
          const m = /^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/.exec(line);
          if (m) o[m[1]] = /^(true|false)$/.test(m[2]) ? m[2] === "true" : /^\d+$/.test(m[2]) ? +m[2] : m[2].replace(/^["']|["']$/g, "");
        }
        return o;
      }
      if (d === S.root) break;
    }
    return null;
  }

  async function withBundled(text, path, lang) {
    const [parser, names] = PARSERS[lang];
    const [{ format }, ...plugins] = await Promise.all([import("prettier/standalone"), ...names.map((n) => PLUGINS[n]())]);
    const cfg = (await bundledConfig(path)) || { tabWidth: settings.tabSize };
    return format(text, { ...cfg, parser, plugins: plugins.map((m) => m.default || m), filepath: path });
  }

  formatters.push((path, b) => {
    if (settings.webFormatter === "server" || !PARSERS[b.lang] || b.virtual) return null;
    return async (text) => {
      const P = await app.projectFor(path).catch(() => null);
      const dir = P?.dir || S.root;
      if (dir && app.trusted() && (await projectPrettier(dir))) {
        const r = await invoke("run_capture", { cwd: dir, program: "node", args: ["-e", SCRIPT, path, String(settings.tabSize)], input: text }).catch((e) => ({ code: -1, out: "", err: String(e) }));
        let res = null;
        try { res = JSON.parse(r.out); } catch {}
        if (res?.ignored) { toast("This file is in .prettierignore."); return text; }
        if (res?.text != null) return res.text;
        if (res?.error) { toast("Prettier: " + res.error.split("\n")[0], 5000); return null; }
        // No node, or Prettier missing after all: Ledger's own below.
        if (res?.missing) hasProjectPrettier.set(dir, false);
      }
      try { return await withBundled(text, path, b.lang); }
      catch (e) { toast("Prettier: " + String(e?.message || e).split("\n")[0], 5000); return null; }
    };
  });

  app.saveHooks?.push?.((path) => { if (/(^|\/)package\.json$/.test(path)) hasProjectPrettier.clear(); });
}
