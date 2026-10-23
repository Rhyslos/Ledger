// Task output → HTML: ANSI colours become classes, and file locations from
// rustc, Lust, MSBuild (dotnet) and .NET stack traces become clickable links.
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const link = (file, line, col, text) => `<a data-file="${esc(file)}" data-line="${line}" data-col="${col || 1}" tabindex="0">${esc(text)}</a>`;

// rustc / panics: src/main.rs:14:20, and Lust: main.lust:3:5 or main.lust:3
// A full Windows path may have spaces in it (C:\Users\John Smith\proj\index.js:3:9), so that form
// is tried first, from the drive letter on; other paths stop at a space.
const EXT = String.raw`(?:rs|lust|lst|lsc|m?[jt]sx?|cjs|vue|svelte|s?css|lua)`;
const RS = new RegExp(String.raw`([A-Za-z]:[\\/](?:[^:*?"<>|\r\n\\/]+[\\/])*[^:*?"<>|\r\n\\/ ][^:*?"<>|\r\n\\/]*\.${EXT}|(?:[A-Za-z]:)?[\w.\-\/\\]*[\w\-]\.${EXT}):(\d+)(?::(\d+))?`, "g");
// Web addresses, such as the one a dev server prints when it starts.
const URLS = /https?:\/\/[^\s"'<>]*[^\s"'<>.,;:)\]]/g;
// MSBuild: C:\proj\Player.cs(12,5): error CS0103: ...   (may contain spaces, so anchored at line start)
const MSB = /^(\s*)(.+?\.(?:cs|csproj|props|targets|sln|slnx|xaml))\((\d+)(?:,(\d+))?(?:,\d+,\d+)?\)(.*)$/;
// .NET stack trace: at Player._Ready() in C:\proj\Player.cs:line 14
const TRACE = /( in )(.+?\.cs):line (\d+)/;

function linkify(text) {
  let m = MSB.exec(text);
  if (m) {
    const rest = esc(m[5]).replace(/: (error|warning) /, (_, w) => `: <span class="a-${w === "error" ? 31 : 33} a-b">${w}</span> `);
    return esc(m[1]) + link(m[2], m[3], m[4], `${m[2]}(${m[3]}${m[4] ? "," + m[4] : ""})`) + rest;
  }
  m = TRACE.exec(text);
  if (m) {
    const i = m.index;
    return esc(text.slice(0, i)) + esc(m[1]) + link(m[2], m[3], 1, `${m[2]}:line ${m[3]}`) + esc(text.slice(i + m[0].length));
  }
  let out = "", last = 0;
  for (const u of text.matchAll(URLS)) {
    out += files(text.slice(last, u.index)) + `<a href="${esc(u[0])}">${esc(u[0])}</a>`;
    last = u.index + u[0].length;
  }
  return out + files(text.slice(last));
}

function files(text) {
  let out = "", last = 0;
  for (const r of text.matchAll(RS)) {
    out += esc(text.slice(last, r.index)) + link(r[1], r[2], r[3], r[0]);
    last = r.index + r[0].length;
  }
  return out + esc(text.slice(last));
}

export function ansiToHtml(input) {
  const s = String(input);
  // Plain lines (dotnet, Godot) get the smarter link pass on the whole line.
  if (!s.includes("\x1b[")) return linkify(s);
  let out = "", cls = new Set();
  const parts = s.split(/\x1b\[([\d;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const codes = parts[i] === "" ? [0] : parts[i].split(";").map(Number);
      for (let j = 0; j < codes.length; j++) {
        const c = codes[j];
        if (c === 0) cls.clear();
        else if (c === 1) cls.add("a-b");
        else if (c === 2) cls.add("a-d");
        else if (c === 3) cls.add("a-i");
        else if (c === 4) cls.add("a-u");
        else if (c === 22) { cls.delete("a-b"); cls.delete("a-d"); }
        else if (c === 39) [...cls].filter((k) => /^a-\d/.test(k)).forEach((k) => cls.delete(k));
        else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) { [...cls].filter((k) => /^a-\d/.test(k)).forEach((k) => cls.delete(k)); cls.add("a-" + c); }
        else if (c === 38 || c === 48) j += codes[j + 1] === 5 ? 2 : 4;
      }
      continue;
    }
    const t = parts[i].replace(/\x1b\[[\d;?]*[A-Za-z]/g, "");
    if (!t) continue;
    out += cls.size ? `<span class="${[...cls].join(" ")}">${linkify(t)}</span>` : linkify(t);
  }
  return out;
}
