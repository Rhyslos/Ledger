// File icons (Material Icon Theme, MIT: public/fileicons/LICENSE.txt). Made by scripts/fileicons.mjs.
// Looks for the file's whole name (package.json, Dockerfile), then its extensions from the
// longest (app.test.tsx: test.tsx, then tsx), then the language Ledger opens it as.
import MAP from "./fileicons.json";
import { langOf, LANGS } from "./langs.js";

// Folder names whose own icon gives way to what's in them (assets/ full of MP3s is a music folder).
const GENERAL = new Set(["folder-resource", "folder-public", "folder-content", "folder-src", "folder-dist", "folder-other"]);

export function iconFor(path, dir = false, open = false, media = null) {
  const name = String(path).split(/[\\/]/).pop().toLowerCase();
  if (dir) {
    const named = MAP.folder[name];
    // A folder of nothing but audio, video, images or fonts (from list_dir) shows as one.
    if (media && (!named || GENERAL.has(named))) return `folder-${media}${open ? "-open" : ""}`;
    return (open ? MAP.folderOpen : MAP.folder)[name] || (open ? "folder-open" : "folder");
  }
  // Lust's own: Lt for programs (.lst, and Lust 1's .lust), Ls for LustScript, Lq for LustQL.
  if (/\.(lst|lust)$/.test(name)) return "lust";
  if (/\.lsc$/.test(name)) return "lust-script";
  if (/\.lql$/.test(name)) return "lust-query";
  if (MAP.name[name]) return MAP.name[name];
  for (let i = name.indexOf("."); i >= 0; i = name.indexOf(".", i + 1)) {
    const e = MAP.ext[name.slice(i + 1)];
    if (e) return e;
  }
  const id = LANGS[langOf(path)]?.languageId;
  return (id && MAP.lang[id]) || "file";
}

/** An <img> for the file's icon. */
export const iconHtml = (path, dir = false, open = false, media = null) =>
  `<img class="fi" src="/fileicons/${iconFor(path, dir, open, media)}.svg" alt="" draggable="false">`;
