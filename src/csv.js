// CSV and TSV files: in the editor each column has its own colour, so you can follow a column down
// the file, and "CSV: show as a table" (Ctrl Shift V, like the Markdown preview) opens the file as a
// table: a header row that stays put, sorting by any column, a filter box, and double-click to jump
// to that row in the text. The table follows your edits as you type.
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

export const CSV_EXT = /\.(csv|tsv|tab|psv)$/i;
const sepOf = (path, text) => {
  if (/\.(tsv|tab)$/i.test(path)) return "\t";
  if (/\.psv$/i.test(path)) return "|";
  // A .csv with semicolons (Excel in Norwegian and many other languages writes those).
  const first = text.slice(0, text.indexOf("\n") >>> 0 || 2000);
  return (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
};

/** RFC 4180: quoted fields can hold the separator, "" for a quote, and line breaks. Rows carry the
 *  line they start on. */
export function parseCsv(text, sep, max = Infinity) {
  const rows = [];
  let row = [], field = "", q = false, line = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else { if (c === "\n") line++; field += c; }
    } else if (c === '"' && field === "") q = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push({ line: start, cells: row });
      if (rows.length >= max) return rows;
      row = []; line++; start = line;
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push({ line: start, cells: row }); }
  return rows;
}

// ---------- coloured columns in the editor ----------
const COLS = 6;
const colMarks = Array.from({ length: COLS }, (_, i) => Decoration.mark({ class: "cm-csv-" + i }));
function columns(view, sep) {
  const b = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos), t = line.text;
      if (t.length < 20000) {
        let col = 0, s = 0, q = false;
        for (let i = 0; i <= t.length; i++) {
          const c = t[i];
          if (c === '"') q = !q;
          if (i === t.length || (c === sep && !q)) {
            if (i > s) b.add(line.from + s, line.from + i, colMarks[col % COLS]);
            col++; s = i + 1;
          }
        }
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}
export const csvColumns = (path) => ViewPlugin.fromClass(class {
  constructor(v) { this.sep = sepOf(path, v.state.doc.sliceString(0, 4000)); this.decorations = columns(v, this.sep); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = columns(u.view, this.sep); }
}, { decorations: (v) => v.decorations });

// ---------- the table ----------
const MAX_ROWS = 5000;
export function initCsv(app) {
  const { S, esc, base, invoke } = app;
  const el = document.getElementById("csvpage");
  const tables = new Map(); // key -> { path, sort: {col, dir}, filter, header }
  let shown = null, timer = 0;
  const keyOf = (path) => "@csv:" + app.norm(path);

  async function textOf(path) {
    const b = S.bufs.get(path);
    if (b) return b.state.doc.toString();
    return invoke("read_file", { path }).catch(() => "");
  }

  async function draw() {
    const t = tables.get(shown);
    if (!t || !el) return;
    const text = await textOf(t.path);
    const sep = sepOf(t.path, text);
    let rows = parseCsv(text, sep, MAX_ROWS + 2);
    const more = rows.length > MAX_ROWS + 1;
    if (more) rows = rows.slice(0, MAX_ROWS + 1);
    const head = t.header && rows.length ? rows[0].cells : null;
    let body = t.header ? rows.slice(1) : rows;
    const width = Math.max(1, ...rows.slice(0, 200).map((r) => r.cells.length));
    if (t.filter) { const f = t.filter.toLowerCase(); body = body.filter((r) => r.cells.some((c) => c.toLowerCase().includes(f))); }
    if (t.sort) {
      const { col, dir } = t.sort, num = body.every((r) => r.cells[col] == null || r.cells[col] === "" || !isNaN(+r.cells[col]));
      body = [...body].sort((a, b) => {
        const x = a.cells[col] ?? "", y = b.cells[col] ?? "";
        return (num ? (+x || 0) - (+y || 0) : x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" })) * dir;
      });
    }
    const cols = Array.from({ length: width }, (_, i) => i);
    const th = (i) => {
      const name = head ? head[i] ?? "" : `Column ${i + 1}`;
      const arrow = t.sort?.col === i ? (t.sort.dir > 0 ? " ▲" : " ▼") : "";
      return `<th data-col="${i}" class="csv-c${i % COLS}" title="Sort by ${esc(name)}">${esc(name)}${arrow}</th>`;
    };
    const scroll = el.querySelector(".csv-scroll")?.scrollTop || 0;
    const hadFocus = el.contains(document.activeElement) && document.activeElement.matches("input");
    el.innerHTML = `<div class="csv-view">
      <div class="img-bar">
        <b title="${esc(t.path)}">${esc(base(t.path))}</b>
        <span class="img-info">${body.length}${t.filter ? " matching" : ""} row${body.length === 1 ? "" : "s"} · ${width} column${width === 1 ? "" : "s"} · ${sep === "\t" ? "tabs" : `“${esc(sep)}”`}${more ? ` · showing the first ${MAX_ROWS}` : ""}</span>
        <span class="sp"></span>
        <input type="search" class="csv-filter" placeholder="Filter rows" value="${esc(t.filter || "")}" aria-label="Filter rows" spellcheck="false">
        <label class="chk" title="Use the first row as column names"><input type="checkbox" data-act="header"${t.header ? " checked" : ""}> First row is the header</label>
        <button class="btn" data-act="text" title="Back to the text (Ctrl Shift V)">Edit as text</button>
      </div>
      <div class="csv-scroll" tabindex="0"><table class="csv-table"><thead><tr><th class="csv-n">#</th>${cols.map(th).join("")}</tr></thead><tbody>
        ${body.map((r) => `<tr data-line="${r.line}"><td class="csv-n">${r.line + 1}</td>${cols.map((i) => `<td class="csv-c${i % COLS}">${esc(r.cells[i] ?? "")}</td>`).join("")}</tr>`).join("")}
      </tbody></table>${body.length ? "" : `<p class="hint" style="padding:12px">${t.filter ? "No rows match." : "This file is empty."}</p>`}</div>
    </div>`;
    el.querySelector(".csv-scroll").scrollTop = scroll;
    if (hadFocus) { const i = el.querySelector(".csv-filter"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  async function openTable(path = S.active) {
    path = String(path || "").replace(/^@csv:/, "");
    if (!CSV_EXT.test(path)) { app.toast("Open a .csv or .tsv file to see it as a table."); return false; }
    const key = keyOf(path);
    if (!tables.has(key)) tables.set(key, { path: app.norm(path), sort: null, filter: "", header: true });
    app.addTab(key);
    app.activate(key);
    return true;
  }
  el?.addEventListener("click", (e) => {
    const t = tables.get(shown);
    if (!t) return;
    const th = e.target.closest("th[data-col]");
    if (th) {
      const col = +th.dataset.col;
      t.sort = t.sort?.col !== col ? { col, dir: 1 } : t.sort.dir > 0 ? { col, dir: -1 } : null;
      draw();
      return;
    }
    const a = e.target.closest("[data-act]")?.dataset.act;
    if (a === "text") app.openFile(t.path);
  });
  el?.addEventListener("change", (e) => { const t = tables.get(shown); if (t && e.target.dataset.act === "header") { t.header = e.target.checked; t.sort = null; draw(); } });
  el?.addEventListener("input", (e) => {
    const t = tables.get(shown);
    if (!t || !e.target.matches(".csv-filter")) return;
    t.filter = e.target.value;
    clearTimeout(timer); timer = setTimeout(draw, 150);
  });
  el?.addEventListener("dblclick", (e) => {
    const t = tables.get(shown), tr = e.target.closest("tr[data-line]");
    if (t && tr) app.openFile(t.path, { line: +tr.dataset.line, character: 0 });
  });
  // The table follows edits to the text.
  app.bufListeners.push((path) => { if (shown === keyOf(path)) { clearTimeout(timer); timer = setTimeout(draw, 250); } });
  app.saveHooks.push((path) => { if (shown === keyOf(path)) draw(); });

  app.pages.push({
    el,
    match: (k) => k.startsWith("@csv:"),
    render: (k) => { const again = shown === k; shown = k; draw(); if (!again) requestAnimationFrame(() => el.querySelector(".csv-scroll")?.focus({ preventScroll: true })); },
    label: (k) => base(tables.get(k)?.path || k.slice(5)) + " · table",
    dot: "cfg",
    focus: () => el.querySelector(".csv-scroll")?.focus({ preventScroll: true }),
    close: (k) => { tables.delete(k); if (shown === k) shown = null; },
  });
  app.openers.push((path) => (String(path).startsWith("@csv:") ? openTable(path) : null));
  app.csvTable = (path = S.active) => (String(path).startsWith("@csv:") ? app.openFile(path.slice(5)) : openTable(path));
  app.command("csv.table", "CSV: show as a table (or back to the text)", [], () => app.csvTable());
}
