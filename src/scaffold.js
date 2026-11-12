// New Project for web apps: runs the official scaffolders (create-vite and
// create-next-app), so projects match what the command line makes, then adds
// Tailwind the way its docs describe for Vite.

export const VITE = [
  ["React", "react"], ["Vue", "vue"], ["Svelte", "svelte"], ["Preact", "preact"],
  ["Solid", "solid"], ["Lit", "lit"], ["Qwik", "qwik"], ["Vanilla (no framework)", "vanilla"],
];

/** The steps that create the project, for startSteps. dir: the parent folder. */
export function createSteps({ kind, template, ts, tailwind, name, dir, bare }) {
  const at = dir.replace(/[\\/]+$/, "") + "/" + name;
  if (kind === "next") {
    return [{
      label: "create-next-app", program: "npx", cwd: dir,
      args: ["--yes", "create-next-app@latest", name, ts ? "--ts" : "--js", tailwind ? "--tailwind" : "--no-tailwind", "--eslint", "--app", "--no-src-dir", "--import-alias", "@/*", "--use-npm", "--turbopack", ...(bare ? ["--empty", "--no-agents-md"] : []), "--yes"],
    }];
  }
  return [
    { label: "create-vite", program: "npm", cwd: dir, args: ["create", "--yes", "vite@latest", name, "--", "--template", template + (ts ? "-ts" : ""), "--no-interactive"] },
    { label: "npm install", program: "npm", cwd: at, args: tailwind ? ["install", "tailwindcss", "@tailwindcss/vite"] : ["install"] },
  ];
}

/** vite.config with the Tailwind plugin added (or a new one, for vanilla). */
export function withTailwindPlugin(text) {
  if (!text) return "import { defineConfig } from 'vite'\nimport tailwindcss from '@tailwindcss/vite'\n\nexport default defineConfig({\n  plugins: [tailwindcss()],\n})\n";
  if (text.includes("@tailwindcss/vite")) return text;
  let out = "import tailwindcss from '@tailwindcss/vite'\n" + text;
  if (/plugins:\s*\[/.test(out)) out = out.replace(/plugins:\s*\[/, (m) => m + "tailwindcss(), ");
  else out = out.replace(/defineConfig\(\{/, "defineConfig({\n  plugins: [tailwindcss()],");
  return out;
}

// Where each Vite template keeps its main stylesheet and the file worth opening first.
export const CSS_FILES = ["src/index.css", "src/style.css", "src/app.css", "src/global.css", "src/styles.css"];
export const FIRST_FILES = ["src/App.tsx", "src/App.jsx", "src/App.vue", "src/App.svelte", "src/app.tsx", "src/app.jsx", "app/page.tsx", "app/page.js", "src/routes/index.tsx", "src/my-element.ts", "src/my-element.js", "src/main.ts", "src/main.js", "index.html"];

// Barebones: what's left of a Vite template without its starter page (the logos, the counter, the
// links and their styles). The setup stays: package.json, the configs, index.html and an entry file
// that shows one heading, with the global stylesheet kept but empty, ready for your own.
const HELLO = "<h1>Hello, world</h1>";
const BARE = {
  // template: [global stylesheet, starter files to remove, (x = ".tsx"/".jsx" or ".ts"/".js", ts) => files to write]
  react: ["src/index.css", ["src/App.css"], (x) => ({ [`src/App${x}`]: `function App() {\n  return ${HELLO}\n}\n\nexport default App\n` })],
  solid: ["src/index.css", ["src/App.css"], (x) => ({ [`src/App${x}`]: `function App() {\n  return ${HELLO}\n}\n\nexport default App\n` })],
  preact: ["src/index.css", ["src/app.css"], (x) => ({ [`src/app${x}`]: `export function App() {\n  return ${HELLO}\n}\n` })],
  qwik: ["src/index.css", ["src/app.css"], (x) => ({ [`src/app${x}`]: `import { component$ } from '@builder.io/qwik'\n\nexport const App = component$(() => {\n  return ${HELLO}\n})\n` })],
  vue: ["src/style.css", ["src/components/HelloWorld.vue"], (x, ts) => ({ "src/App.vue": `<script setup${ts ? ' lang="ts"' : ""}>\n</script>\n\n<template>\n  ${HELLO}\n</template>\n` })],
  svelte: ["src/app.css", ["src/lib/Counter.svelte"], (x, ts) => ({ "src/App.svelte": `<script${ts ? ' lang="ts"' : ""}>\n</script>\n\n${HELLO}\n` })],
  vanilla: ["src/style.css", ["src/counter.ts", "src/counter.js"], (x, ts) => ({
    [`src/main${x}`]: `import './style.css'\n\ndocument.querySelector${ts ? "<HTMLDivElement>" : ""}('#app')${ts ? "!" : ""}.innerHTML = '${HELLO}'\n`,
  })],
  lit: ["src/index.css", [], (x, ts) => ({
    [`src/my-element${x}`]: ts
      ? "import { LitElement, html } from 'lit'\nimport { customElement } from 'lit/decorators.js'\n\n@customElement('my-element')\nexport class MyElement extends LitElement {\n  render() {\n    return html`<slot></slot>`\n  }\n}\n\ndeclare global {\n  interface HTMLElementTagNameMap {\n    'my-element': MyElement\n  }\n}\n"
      : "import { LitElement, html } from 'lit'\n\nexport class MyElement extends LitElement {\n  render() {\n    return html`<slot></slot>`\n  }\n}\n\nwindow.customElements.define('my-element', MyElement)\n",
  })],
};

/**
 * The changes that turn a fresh Vite template into a barebones project: { remove: [paths, folders
 * end in /], write: { path: contents }, html: (index.html) => index.html }. Paths are relative.
 */
export function bareVite(template, ts) {
  const b = BARE[template];
  if (!b) return null;
  const [css, starter, files] = b;
  const jsx = ["react", "solid", "preact", "qwik"].includes(template);
  const x = (ts ? ".ts" : ".js") + (jsx ? "x" : "");
  return {
    remove: ["src/assets/", "public/icons.svg", "public/favicon.svg", "README.md", ...starter],
    write: { ...files(x, ts), [css]: "" },
    // No Vite logo in the tab, and Lit's page shows the same heading as the others.
    html: (text) => text
      .replace(/^[ \t]*<link rel="icon"[^>]*>\r?\n/m, "")
      .replace(/<my-element>[\s\S]*?<\/my-element>/, `<my-element>\n      ${HELLO}\n    </my-element>`),
  };
}

// Go Live: a project built with one of these has to be served by its own dev server (TypeScript,
// JSX and imports from node_modules don't work as plain files).
const DEV_SERVERS = ["vite", "next", "astro", "@sveltejs/kit", "nuxt", "@angular/cli", "react-scripts", "parcel", "webpack-dev-server", "@remix-run/dev", "gatsby"];
export function needsDevServer(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return DEV_SERVERS.some((d) => d in deps);
}
