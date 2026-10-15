// Renames the app everywhere it shows: window title, Start menu entry,
// installer, the .exe itself and the README.
//
//   npm run rename -- "New Name"
//   npm run rename -- "New Name" --identifier com.yourname.newname
//
// The identifier decides where settings are stored (in %APPDATA%), so it's
// left alone unless you pass --identifier; changing it starts settings fresh.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const idIdx = args.indexOf("--identifier");
const identifier = idIdx >= 0 ? args.splice(idIdx, 2)[1] : null;
const name = args.join(" ").trim();

if (!name || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)) {
  console.error('Usage: npm run rename -- "New Name" [--identifier com.you.app]\nUse letters, numbers, spaces, dots, dashes or underscores.');
  process.exit(1);
}

const file = (p) => path.join(root, p);
const conf = JSON.parse(fs.readFileSync(file("src-tauri/tauri.conf.json"), "utf8"));
const old = conf.productName;
const oldExe = conf.mainBinaryName || old;
const exeName = name.replace(/[^\p{L}\p{N}._-]/gu, "");
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";

conf.productName = name;
conf.mainBinaryName = exeName;
for (const w of conf.app.windows) w.title = name;
if (identifier) conf.identifier = identifier;
fs.writeFileSync(file("src-tauri/tauri.conf.json"), JSON.stringify(conf, null, 2) + "\n");

const pkg = JSON.parse(fs.readFileSync(file("package.json"), "utf8"));
pkg.name = slug;
fs.writeFileSync(file("package.json"), JSON.stringify(pkg, null, 2) + "\n");
if (fs.existsSync(file("package-lock.json"))) {
  const lock = JSON.parse(fs.readFileSync(file("package-lock.json"), "utf8"));
  lock.name = slug;
  if (lock.packages?.[""]) lock.packages[""].name = slug;
  fs.writeFileSync(file("package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
}

// Display text only. Storage keys (lower-case) are untouched so nothing resets.
const swap = (p) => {
  const f = file(p);
  if (!fs.existsSync(f)) return;
  const s = fs.readFileSync(f, "utf8");
  // "Meisner's Ledger" is the other app the look comes from; leave it alone.
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = s.split(`${oldExe}.exe`).join(`${exeName}.exe`).replace(new RegExp(`(?<!Meisner's )${esc(old)}`, "g"), name);
  if (out !== s) fs.writeFileSync(f, out);
};
fs.writeFileSync(file("src/app.js"), fs.readFileSync(file("src/app.js"), "utf8").replace(/^export const APP_NAME = .*$/m, `export const APP_NAME = ${JSON.stringify(name)};`));
["index.html", "README.md", "src/lsp.js", "src-tauri/src/lib.rs", "src-tauri/src/main.rs"].forEach(swap);

console.log(`Renamed "${old}" to "${name}". The program will be ${exeName}.exe.${identifier ? ` Identifier is now ${identifier}.` : ""}`);
console.log("Rebuild to see it: npm run tauri dev, or build.cmd for the installer.");
