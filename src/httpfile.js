// .http files (as in Visual Studio, Rider and VS Code's REST Client): requests separated by ###,
// file variables (@host = https://localhost:5001) used as {{host}}, and environments from
// http-client.env.json next to the file.
//
//   @host = https://localhost:5001
//   ###
//   # @name list
//   GET {{host}}/todos
//   Accept: application/json
//
//   ###
//   POST {{host}}/todos
//   Content-Type: application/json
//
//   { "title": "Write it" }

const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT";
// The URL may hold spaces inside {{$randomInt 1 10}}, so it runs to an optional HTTP/1.1 at the end.
const REQ_LINE = new RegExp(`^(?:(${METHODS})\\s+)?(\\S.*?)(?:\\s+HTTP\\/[\\d.]+)?\\s*$`);

/** Text → { vars, requests: [{ line, name, method, url, headers: [[k, v]], body }] }; lines from 0. */
export function parseHttpFile(text) {
  const lines = String(text).split(/\r?\n/);
  const vars = {}, requests = [];
  let cur = null, part = "start", name = null;
  const finish = () => {
    if (!cur) return;
    cur.body = cur.bodyLines.join("\n").replace(/\s+$/, "");
    delete cur.bodyLines;
    requests.push(cur);
    cur = null;
  };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    // ### starts the next request; words after it name it (### list todos).
    if (/^###/.test(line)) { finish(); part = "start"; name = line.replace(/^#+\s*/, "") || null; return; }
    if (part === "body") { cur.bodyLines.push(raw); return; }
    const t = line.trim();
    const named = /^(?:#|\/\/)\s*@name\s+(\S+)/.exec(t);
    if (named) { name = named[1]; return; }
    if (/^(#|\/\/)/.test(t)) return;
    if (part === "start") {
      if (!t) return;
      const v = /^@([\w.-]+)\s*=\s*(.*)$/.exec(t);
      if (v) { vars[v[1]] = v[2].trim(); return; }
      const m = REQ_LINE.exec(t);
      if (!m || (!m[1] && !/^(https?:\/\/|\{\{)/i.test(m[2])) || (!m[1] && /\s/.test(m[2].replace(/\{\{[^}]*\}\}/g, "")))) return;
      cur = { line: i, name, method: (m[1] || "GET").toUpperCase(), url: m[2], headers: [], bodyLines: [] };
      part = "headers";
      return;
    }
    if (part === "headers") {
      if (!t) { part = "body"; return; }
      const h = /^([^:\s]+)\s*:\s*(.*)$/.exec(t);
      if (h) cur.headers.push([h[1], h[2]]);
      // A query line continuing the URL: ?page=2 or &size=10.
      else if (/^[?&]/.test(t)) cur.url += t;
    }
  });
  finish();
  return { vars, requests };
}

/** {{name}} → its value (file variables first, then the environment), plus {{$guid}} and friends. */
export function expand(str, vars, env = {}, depth = 0) {
  return String(str).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (all, key) => {
    const dyn = /^\$(\w+)\s*(.*)$/.exec(key);
    if (dyn) {
      const [, fn, rest] = dyn;
      if (fn === "guid" || fn === "uuid") return crypto.randomUUID();
      if (fn === "timestamp") return String(Math.floor(Date.now() / 1000));
      if (fn === "randomInt") { const [lo, hi] = rest.split(/\s+/).map(Number); const a = Number.isFinite(lo) ? lo : 0, b = Number.isFinite(hi) ? hi : 1000; return String(a + Math.floor(Math.random() * Math.max(1, b - a))); }
      if (fn === "datetime" || fn === "localDatetime") return new Date().toISOString();
      return all;
    }
    const v = key in vars ? vars[key] : key in env ? env[key] : null;
    if (v == null) return all;
    return depth < 5 ? expand(v, vars, env, depth + 1) : String(v);
  });
}

/** http-client.env.json → { names: [...], vars(name) → { ...$shared, ...that environment } }. */
export function readEnvFile(text) {
  let j = {};
  try { j = JSON.parse(text); } catch {}
  const names = Object.keys(j).filter((k) => k !== "$shared" && j[k] && typeof j[k] === "object");
  const flat = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => typeof v !== "object" || v == null).map(([k, v]) => [k, String(v ?? "")]));
  return { names, vars: (name) => ({ ...flat(j.$shared), ...flat(j[name]) }) };
}
