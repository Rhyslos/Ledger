// Makes Ledger's file icons from the Material Icon Theme (MIT, github.com/material-extensions/vscode-material-icon-theme).
// Run from Ledger's folder:  npm pack material-icon-theme && tar xzf material-icon-theme-*.tgz && node scripts/fileicons.mjs package
// Writes public/fileicons/*.svg (only the icons Ledger uses), its LICENSE, and src/fileicons.json (what maps to what).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const pkg = process.argv[2] || "package";
const m = JSON.parse(readFileSync(join(pkg, "dist/material-icons.json"), "utf8"));
// Folders with their own icon: the common ones (the theme knows thousands).
const FOLDERS = `src source lib libs components component pages app api assets asset resources public static images img icons fonts styles style css scss sass
  scripts script js ts test tests __tests__ spec docs doc config configs dist build out target bin node_modules .git .github .vscode .idea vendor packages
  utils util helpers hooks services models views controllers routes middleware database db migrations data i18n locales types typings interfaces layouts
  templates themes theme server client shared core plugins addons ui audio sounds music video videos scenes shaders materials textures sprites levels maps
  tools temp tmp logs cache coverage examples demo android ios windows docker .husky prisma graphql store stores context contexts content posts blog`.split(/\s+/);
const out = { ext: m.fileExtensions, name: m.fileNames, lang: m.languageIds, folder: {}, folderOpen: {} };
for (const f of FOLDERS) {
  if (m.folderNames[f]) out.folder[f] = m.folderNames[f];
  if (m.folderNamesExpanded[f]) out.folderOpen[f] = m.folderNamesExpanded[f];
}
const used = new Set([...Object.values(out.ext), ...Object.values(out.name), ...Object.values(out.lang), ...Object.values(out.folder), ...Object.values(out.folderOpen), m.file, m.folder, m.folderExpanded]);
const dir = "public/fileicons";
if (existsSync(dir)) rmSync(dir, { recursive: true });
mkdirSync(dir, { recursive: true });
let n = 0;
for (const id of used) {
  const def = m.iconDefinitions[id];
  if (!def) continue;
  copyFileSync(join(pkg, "dist", def.iconPath), join(dir, id + ".svg"));
  n++;
}
copyFileSync(join(pkg, "LICENSE"), join(dir, "LICENSE.txt"));
// Lust's own icons: Lt (programs), Ls (LustScript), Lq (LustQL).
copyFileSync("src/assets/lust-lst.svg", join(dir, "lust.svg"));
copyFileSync("src/assets/lust-lsc.svg", join(dir, "lust-script.svg"));
copyFileSync("src/assets/lust-lql.svg", join(dir, "lust-query.svg"));
writeFileSync("src/fileicons.json", JSON.stringify(out));
console.log(`${n} icons in ${dir}, map in src/fileicons.json`);
