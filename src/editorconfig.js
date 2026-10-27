// .editorconfig: indentation and line endings a project asks for (C# projects nearly always have
// one). Sections are globs ([*], [*.cs], [*.{cs,csx}], [src/**.json]); files nearer the file win,
// and root = true stops the search.

/** Parses an .editorconfig into { root, sections: [{ glob, props }] }. */
export function parseEditorConfig(text) {
  const out = { root: false, sections: [] };
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#" || line[0] === ";") continue;
    const sec = /^\[(.*)\]$/.exec(line);
    if (sec) { cur = { glob: sec[1], props: {} }; out.sections.push(cur); continue; }
    const kv = /^([^=:]+?)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const k = kv[1].toLowerCase(), v = kv[2].toLowerCase();
    if (!cur) { if (k === "root") out.root = v === "true"; continue; }
    cur.props[k] = v;
  }
  return out;
}

/** EditorConfig's glob → RegExp, for a path relative to the .editorconfig's folder. */
export function globToRegExp(glob) {
  let g = glob;
  // A glob without a slash matches the name in any folder.
  if (!g.includes("/")) g = "**/" + g;
  else if (g.startsWith("/")) g = g.slice(1);
  let re = "", i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += ".*"; i += 2; if (g[i] === "/") { re = re.slice(0, -2) + "(?:.*/)?"; i++; } continue; }
    if (c === "*") { re += "[^/]*"; i++; continue; }
    if (c === "?") { re += "[^/]"; i++; continue; }
    if (c === "{") {
      const end = g.indexOf("}", i);
      if (end > i) {
        const parts = g.slice(i + 1, end).split(",");
        const nums = /^(-?\d+)\.\.(-?\d+)$/.exec(g.slice(i + 1, end));
        re += nums ? "-?\\d+" : "(?:" + parts.map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
        i = end + 1;
        continue;
      }
    }
    if (c === "[") { const end = g.indexOf("]", i); if (end > i) { re += "[" + g.slice(i + 1, end).replace(/^!/, "^") + "]"; i = end + 1; continue; } }
    re += c.replace(/[.+^$()|\\]/g, "\\$&");
    i++;
  }
  return new RegExp("^" + re + "$", "i");
}

/** The properties for `rel` (relative to the config's folder) from one parsed config. */
export function propsFor(cfg, rel) {
  const props = {};
  for (const s of cfg.sections) if (globToRegExp(s.glob).test(rel)) Object.assign(props, s.props);
  return props;
}

/** What Ledger uses: { tabs, size } and an end of line ("\r\n" / "\n"), or nulls. */
export function settingsFrom(props) {
  const style = props.indent_style, size = parseInt(props.indent_size === "tab" ? props.tab_width : props.indent_size || props.tab_width, 10);
  const indent = style === "tab" ? { tabs: true, size: size > 0 ? size : 4 } : style === "space" || size > 0 ? { tabs: false, size: size > 0 ? size : 4 } : null;
  const eol = props.end_of_line === "crlf" ? "\r\n" : props.end_of_line === "lf" ? "\n" : null;
  return { indent, eol, trim: props.trim_trailing_whitespace === "true", finalNewline: props.insert_final_newline === "true" ? true : props.insert_final_newline === "false" ? false : null };
}
