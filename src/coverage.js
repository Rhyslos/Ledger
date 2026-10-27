// Code coverage from a Cobertura report (what coverlet writes for dotnet test --collect "XPlat
// Code Coverage"): which lines of which files ran during the tests.

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
};
const isAbs = (p) => /^([a-zA-Z]:)?[\\/]/.test(p);

/**
 * Cobertura XML → Map(file → { hit: Set(line), miss: Set(line) }), lines counted from 1.
 * Relative file names are joined to the report's <source> folders (the first one, or the one
 * `exists` says has the file).
 */
export function parseCobertura(xml, exists = () => true) {
  const sources = [...xml.matchAll(/<source>([^<]*)<\/source>/g)].map((m) => m[1].trim()).filter(Boolean);
  const where = (f) => {
    const name = f.replace(/\\/g, "/");
    if (isAbs(f) || !sources.length) return name;
    const paths = sources.map((s) => s.replace(/\\/g, "/").replace(/\/$/, "") + "/" + name);
    return paths.find(exists) || paths[0];
  };
  const out = new Map();
  // Each <class filename="..."> holds its <lines>; a class's methods repeat the same lines.
  for (const m of xml.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
    const file = attr(m[1], "filename");
    if (!file) continue;
    const key = where(file);
    if (!out.has(key)) out.set(key, { hit: new Set(), miss: new Set() });
    const f = out.get(key);
    for (const l of m[2].matchAll(/<line\b([^>]*?)\/?>/g)) {
      const n = +attr(l[1], "number"), hits = +attr(l[1], "hits");
      if (!(n > 0)) continue;
      if (hits > 0) { f.hit.add(n); f.miss.delete(n); } else if (!f.hit.has(n)) f.miss.add(n);
    }
  }
  return out;
}

/** The share of lines that ran, 0–100, over every file. */
export function coveredPercent(cov) {
  let hit = 0, all = 0;
  for (const f of cov.values()) { hit += f.hit.size; all += f.hit.size + f.miss.size; }
  return all ? Math.round((hit / all) * 1000) / 10 : 0;
}
