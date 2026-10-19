// New Project for web apps: runs the official scaffolders (create-vite and
// create-next-app), so projects match what the command line makes, then adds
// Tailwind the way its docs describe for Vite.

export const VITE = [
  ["React", "react"], ["Vue", "vue"], ["Svelte", "svelte"], ["Preact", "preact"],
  ["Solid", "solid"], ["Lit", "lit"], ["Qwik", "qwik"], ["Vanilla (no framework)", "vanilla"],
];

/** The steps that create the project, for startSteps. dir: the parent folder. */
export function createSteps({ kind, template, ts, tailwind, name, dir }) {
  const at = dir.replace(/[\\/]+$/, "") + "/" + name;
  if (kind === "next") {
    return [{
      label: "create-next-app", program: "npx", cwd: dir,
      args: ["--yes", "create-next-app@latest", name, ts ? "--ts" : "--js", tailwind ? "--tailwind" : "--no-tailwind", "--eslint", "--app", "--no-src-dir", "--import-alias", "@/*", "--use-npm", "--turbopack", "--yes"],
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
