// Database viewer: a tab for SQLite files (.db, .sqlite…). Browse tables in a
// grid with sorting, a search box and filters that need no SQL; see each
// table's structure; run SQL with completion for table and column names;
// edit cells, add and delete rows, then review and save in one go; export
// to CSV or JSON. The reading and writing happens in src-tauri/src/db.rs.
import { EditorView, keymap, drawSelection, lineNumbers, placeholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { autocompletion, completionKeymap, closeBrackets } from "@codemirror/autocomplete";
import { syntaxHighlighting } from "@codemirror/language";
import { sql, SQLite } from "@codemirror/lang-sql";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";

export const DB_EXT = /\.(db|sqlite|sqlite3|db3|s3db)$/i;
const PAGE = 200;
const OPS = [
  ["contains", "contains"], ["eq", "is"], ["ne", "is not"], ["starts", "starts with"], ["ends", "ends with"],
  ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"], ["empty", "is empty"], ["notempty", "isn't empty"], ["null", "is NULL"],
];
const NO_VALUE = new Set(["empty", "notempty", "null"]);

export function initDb(app) {
  const { esc, invoke, toast, choose, base } = app;
  const el = document.getElementById("dbpage");
  const dbs = new Map(); // tab key -> state of that database tab
  let shown = null; // key drawn right now
  let sqlView = null, sqlFor = null;

  const keyOf = (path) => "@db:" + app.norm(path);
  const fresh = (path) => ({
    path, tables: [], table: null, mode: "data", filter: "",
    view: null, offset: 0, data: null, sel: new Set(), err: null,
    edits: new Map(), inserts: [], deletes: new Set(), // pending changes to the current table
    query: "", result: null, qerr: null, running: false,
  });
  const pending = (d) => d.edits.size + d.inserts.length + d.deletes.size;

  async function openDb(path, opts = {}) {
    const key = keyOf(path);
    const isNew = !dbs.has(key);
    if (isNew) dbs.set(key, fresh(app.norm(path)));
    app.addTab(key);
    if (!opts.background) app.activate(key);
    if (isNew) await loadSchema(dbs.get(key));
    const d = dbs.get(key);
    // A brand-new database: start in the SQL tab with a table to make.
    if (isNew && !d.err && !d.tables.length) {
      d.mode = "sql";
      d.query = "CREATE TABLE items (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL,\n  created_at TEXT DEFAULT CURRENT_TIMESTAMP\n);\n";
      if (shown === key) draw();
    }
    return true;
  }

  /** New SQLite database…: dir is where the save dialog starts (the explorer folder). */
  async function newDb(dir) {
    const start = dir || app.S.root;
    const out = await saveDialog({ title: "New SQLite database", defaultPath: start ? app.join(start, "database.db") : "database.db", filters: [{ name: "SQLite database", extensions: ["db", "sqlite", "sqlite3"] }] });
    if (!out) return;
    try {
      const made = await invoke("db_create", { path: out });
      if (made) app.refreshTree?.();
      await openDb(out);
    } catch (e) { toast("Couldn't make the database: " + e, 6000); }
  }
  async function openDbFile() {
    const p = await openDialog({ title: "Open a database", multiple: false, directory: false, filters: [{ name: "SQLite database", extensions: ["db", "sqlite", "sqlite3", "db3", "s3db"] }, { name: "All files", extensions: ["*"] }] });
    if (p) openDb(String(p));
  }
  app.command("db.new", "New SQLite database…", [], () => newDb());
  app.command("db.open", "Open database…", [], openDbFile);
  app.newDb = newDb;

  async function loadSchema(d, keepTable) {
    try {
      d.tables = await invoke("db_schema", { path: d.path });
      d.err = null;
    } catch (e) { d.err = String(e); d.tables = []; }
    const t = (keepTable && d.tables.find((x) => x.name === d.table)) || d.tables.find((x) => x.kind === "table") || d.tables[0];
    if (t && (!keepTable || !d.view)) pickTable(d, t.name, false);
    await loadRows(d);
  }

  function pickTable(d, name, load = true) {
    if (d.table === name && d.view) return;
    d.table = name;
    d.view = { table: name, filters: [], search: "", sort: null, desc: false };
    d.offset = 0; d.sel.clear(); d.edits.clear(); d.inserts = []; d.deletes.clear();
    if (d.mode === "sql") d.mode = "data";
    if (load) loadRows(d);
  }

  async function loadRows(d) {
    if (!d.view) { draw(); return; }
    try {
      d.data = await invoke("db_rows", { path: d.path, view: d.view, offset: d.offset, limit: PAGE });
      d.inTx = d.data.in_transaction;
      d.err = null;
    } catch (e) { d.data = null; d.err = String(e); }
    draw();
  }

  const tableOf = (d) => d.tables.find((t) => t.name === d.table);
  const cur = () => dbs.get(shown);

  // ---------- drawing ----------
  function cellHtml(v, edited) {
    if (v === null || v === undefined) return `<span class="db-null">NULL</span>`;
    if (typeof v === "object" && "$blob" in v) return `<span class="db-null">blob · ${v.$blob} bytes</span>`;
    const s = String(v);
    return `<span${edited ? ' class="db-edited"' : ""}>${esc(s.length > 400 ? s.slice(0, 400) + "…" : s)}</span>`;
  }

  function gridHtml(cols, rows, opts = {}) {
    const { sort, desc, rowids, edits, deletes, sel, inserts, editable, start = 0 } = opts;
    const head = cols.map((c) => `<th data-col="${esc(c)}" title="${opts.sortable ? "Sort by " + esc(c) : esc(c)}">${esc(c)}${sort === c ? (desc ? " ▾" : " ▴") : ""}</th>`).join("");
    const body = [];
    (inserts || []).forEach((r, i) => body.push(`<tr class="db-new" data-new="${i}"><td class="db-n">new</td>${cols.map((c) => `<td data-c="${esc(c)}">${cellHtml(r[c] ?? null, c in r)}</td>`).join("")}</tr>`));
    rows.forEach((r, i) => {
      const id = rowids?.[i];
      const cls = [deletes?.has(id) ? "db-del" : "", sel?.has(id) ? "db-sel" : ""].join(" ").trim();
      body.push(`<tr${cls ? ` class="${cls}"` : ""}${id !== undefined ? ` data-id="${id}"` : ""}><td class="db-n"${editable ? ' title="Click to select the row"' : ""}>${start + i + 1}</td>${r
        .map((v, j) => { const k = `${id}:${cols[j]}`; const ed = edits?.has(k); return `<td data-c="${esc(cols[j])}">${cellHtml(ed ? edits.get(k) : v, ed)}</td>`; })
        .join("")}</tr>`);
    });
    return `<div class="db-grid" tabindex="0"><table><thead><tr><th class="db-n"></th>${head}</tr></thead><tbody>${body.join("") || `<tr><td class="db-n"></td><td colspan="${cols.length || 1}" class="db-empty">No rows</td></tr>`}</tbody></table></div>`;
  }

  function draw() {
    const d = cur();
    if (!d) return;
    const t = tableOf(d);
    const q = d.filter.toLowerCase();
    const list = d.tables.filter((x) => !q || x.name.toLowerCase().includes(q));
    const side = `<aside class="db-side">
      <div class="db-file" title="${esc(d.path)}">${esc(base(d.path))}</div>
      <input type="search" class="db-tfilter" placeholder="Find a table" value="${esc(d.filter)}" spellcheck="false">
      <div class="db-tables" role="listbox" aria-label="Tables">${list.map((x) => `<button class="db-t${x.name === d.table && d.mode !== "sql" ? " on" : ""}" data-table="${esc(x.name)}" role="option"><span>${x.kind === "view" ? "◇ " : ""}${esc(x.name)}</span><span class="db-cnt">${x.rows ?? ""}</span></button>`).join("") || `<div class="hint">${d.err ? "" : "No tables"}</div>`}</div>
      <button class="btn db-sqlbtn${d.mode === "sql" ? " primary" : ""}" data-act="sql">SQL query</button>
    </aside>`;
    let main;
    if (d.mode === "sql") main = sqlHtml(d);
    else if (!t) main = `<div class="db-msg">${esc(d.err || "This database has no tables yet. Use SQL query to create one.")}</div>`;
    else if (d.mode === "structure") main = structureHtml(d, t);
    else main = dataHtml(d, t);
    const tabs = d.mode === "sql" ? "" : `<div class="db-modes"><button data-mode="data" class="${d.mode === "data" ? "on" : ""}">Data</button><button data-mode="structure" class="${d.mode === "structure" ? "on" : ""}">Structure</button></div>`;
    const tx = d.inTx ? `<div class="db-tx">A transaction is open: run <b>COMMIT</b> to keep its changes or <b>ROLLBACK</b> to undo them. Until then other programs can't write to this database. <button class="btn" data-act="commit">Commit</button><button class="btn" data-act="rollback">Roll back</button></div>` : "";
    el.innerHTML = `<div class="db">${side}<section class="db-main">${tx}${tabs}${main}</section></div>`;
    if (d.mode === "sql") mountSql(d);
  }

  function dataHtml(d, t) {
    const data = d.data, v = d.view, n = pending(d);
    if (!data) return `<div class="db-msg">${esc(d.err || "Loading…")}</div>`;
    const from = data.total ? d.offset + 1 : 0, to = Math.min(d.offset + PAGE, data.total);
    const chips = v.filters.map((f, i) => `<span class="db-chip">${esc(f.col)} ${esc(OPS.find((o) => o[0] === f.op)[1])}${NO_VALUE.has(f.op) ? "" : ` <b>${esc(f.value)}</b>`}<button data-unfilter="${i}" aria-label="Remove filter">×</button></span>`).join("");
    const canEdit = t.editable;
    return `<div class="db-bar">
        <input type="search" class="db-search" placeholder="Search all columns" value="${esc(v.search)}" spellcheck="false">
        <button class="btn" data-act="filter">+ Filter</button>${chips}
        <span class="sp"></span>
        <span class="db-count">${from.toLocaleString()}–${to.toLocaleString()} of ${data.total.toLocaleString()}</span>
        <button class="btn" data-act="prev" ${d.offset ? "" : "disabled"} aria-label="Previous page">‹</button>
        <button class="btn" data-act="next" ${to < data.total ? "" : "disabled"} aria-label="Next page">›</button>
        <button class="btn" data-act="refresh" title="Read the database again (it also updates by itself when another program writes to it)">Refresh</button>
        <button class="btn" data-act="export">Export…</button>
      </div>
      <div class="db-bar db-editbar">${canEdit
        ? `<button class="btn" data-act="addrow">+ Row</button><button class="btn" data-act="delrows" ${d.sel.size ? "" : "disabled"}>Delete ${d.sel.size ? d.sel.size + " " : ""}row${d.sel.size === 1 ? "" : "s"}</button><span class="hint">Double-click a cell to edit it. Click a row number to select the row.</span>`
        : `<span class="hint">${t.kind === "view" ? "Views can't be edited." : "This table has no rowid, so it can't be edited here. SQL query works."}</span>`}
        <span class="sp"></span>${n ? `<span class="db-pending">${n} unsaved change${n === 1 ? "" : "s"}</span><button class="btn" data-act="discard">Discard</button><button class="btn primary" data-act="apply">Review and save</button>` : ""}
      </div>
      ${gridHtml(data.columns, data.rows, { sortable: true, sort: v.sort, desc: v.desc, rowids: data.rowids, edits: d.edits, deletes: d.deletes, sel: d.sel, inserts: d.inserts, editable: canEdit, start: d.offset })}`;
  }

  function structureHtml(d, t) {
    const rows = t.columns.map((c) => `<tr><td class="db-n">${c.pk ? "🔑" : ""}</td><td>${esc(c.name)}</td><td>${esc(c.type || "")}</td><td>${c.notnull ? "NOT NULL" : ""}</td><td>${c.default == null ? "" : esc(c.default)}</td></tr>`).join("");
    return `<div class="db-scroll">
      <div class="db-grid"><table><thead><tr><th class="db-n"></th><th>Column</th><th>Type</th><th>Null</th><th>Default</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h3 class="db-h">${t.kind === "view" ? "View" : "Table"} definition</h3><pre class="db-sql">${esc(t.sql)}</pre>
      ${t.indexes.length ? `<h3 class="db-h">Indexes</h3><pre class="db-sql">${esc(t.indexes.join(";\n\n"))}</pre>` : ""}
      <p class="hint">${(t.rows ?? 0).toLocaleString()} row${t.rows === 1 ? "" : "s"}.</p>
    </div>`;
  }

  function sqlHtml(d) {
    const r = d.result;
    let out = "";
    if (d.running) out = `<div class="db-msg">Running… <button class="btn" data-act="stopq">Stop</button></div>`;
    else if (d.qerr) out = `<div class="db-msg db-err">${esc(d.qerr)}</div>`;
    else if (r) {
      const info = [r.columns.length ? `${r.rows.length.toLocaleString()}${r.truncated ? "+" : ""} row${r.rows.length === 1 ? "" : "s"}` : "", r.changed ? `${r.changed} row${r.changed === 1 ? "" : "s"} changed` : "", `${r.ms} ms`].filter(Boolean).join(" · ");
      out = `<div class="db-bar"><span class="db-count">${info}${r.truncated ? " (showing the first 5,000)" : ""}</span><span class="sp"></span>${r.columns.length ? '<button class="btn" data-act="qexport">Export…</button>' : ""}</div>
        ${r.columns.length ? gridHtml(r.columns, r.rows) : `<div class="db-msg">${r.changed ? "Done." : "The query ran. It returned no rows."}</div>`}`;
    } else out = `<div class="db-msg hint">Write SQL above and press Ctrl+Enter. Table and column names complete as you type.</div>`;
    return `<div class="db-bar"><button class="btn primary" data-act="run">Run <kbd>Ctrl Enter</kbd></button><button class="btn" data-act="history">History…</button><span class="sp"></span><span class="hint">SELECT shows rows; other statements change the file right away.</span></div>
      <div class="db-sqled"></div><div class="db-result">${out}</div>`;
  }

  // ---------- SQL editor ----------
  function schemaFor(d) {
    return Object.fromEntries(d.tables.map((t) => [t.name, t.columns.map((c) => c.name)]));
  }
  function mountSql(d) {
    const host = el.querySelector(".db-sqled");
    if (sqlView && sqlFor === d) { host.replaceWith(sqlView.dom.parentElement || sqlView.dom); return; }
    sqlView?.destroy();
    sqlFor = d;
    sqlView = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: d.query,
        extensions: [
          lineNumbers(), history(), drawSelection(), closeBrackets(), autocompletion(), placeholder("SELECT * FROM …"),
          sql({ dialect: SQLite, schema: schemaFor(d), defaultTable: d.table || undefined, upperCaseKeywords: true }),
          syntaxHighlighting(app.hl), app.editorTheme,
          keymap.of([{ key: "Mod-Enter", run: () => { runQuery(d); return true; } }, ...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => { if (u.docChanged) d.query = u.state.doc.toString(); }),
        ],
      }),
    });
    requestAnimationFrame(() => sqlView?.focus());
  }

  async function runQuery(d) {
    const text = (sqlView?.state.sliceDoc(sqlView.state.selection.main.from, sqlView.state.selection.main.to) || d.query).trim();
    if (!text) return;
    d.running = true; d.qerr = null; drawResult(d);
    try {
      d.result = await invoke("db_query", { path: d.path, sql: text });
      if (d.inTx !== d.result.in_transaction) { d.inTx = d.result.in_transaction; draw(); }
      remember(d.path, text);
      if (d.result.changed || /^\s*(create|drop|alter)\b/im.test(text)) loadSchema(d, true); // counts and tables changed
    } catch (e) { d.qerr = String(e); d.result = null; }
    d.running = false;
    drawResult(d);
  }
  function drawResult(d) {
    if (cur() !== d || d.mode !== "sql") return;
    const tmp = document.createElement("div");
    tmp.innerHTML = sqlHtml(d);
    el.querySelector(".db-result")?.replaceWith(tmp.querySelector(".db-result"));
  }

  const histKey = (p) => "ledger-sql-history:" + p;
  function remember(path, text) {
    try {
      const h = JSON.parse(localStorage.getItem(histKey(path)) || "[]").filter((x) => x !== text);
      h.unshift(text);
      localStorage.setItem(histKey(path), JSON.stringify(h.slice(0, 30)));
    } catch {}
  }
  async function pickHistory(d) {
    let h = [];
    try { h = JSON.parse(localStorage.getItem(histKey(d.path)) || "[]"); } catch {}
    if (!h.length) { toast("No queries run on this database yet."); return; }
    const i = await choose("Run again or edit a recent query", h.map((x) => x.replace(/\s+/g, " ").slice(0, 120)), true);
    if (i == null || i < 0) return;
    d.query = h[i];
    sqlView?.dispatch({ changes: { from: 0, to: sqlView.state.doc.length, insert: h[i] } });
    sqlView?.focus();
  }

  // ---------- editing ----------
  const numericCol = (t, c) => /INT|REAL|FLOA|DOUB|NUM|DEC/i.test(t.columns.find((x) => x.name === c)?.type || "");
  function parseValue(t, col, text) {
    if (text === "NULL") return null;
    if (numericCol(t, col) && text.trim() !== "" && !isNaN(Number(text))) return Number(text);
    return text;
  }
  function editCell(d, td) {
    const t = tableOf(d), tr = td.closest("tr"), col = td.dataset.c;
    if (!t?.editable || !col || tr.classList.contains("db-del")) return;
    const ni = tr.dataset.new, id = tr.dataset.id;
    let value;
    if (ni !== undefined) value = d.inserts[+ni][col] ?? null;
    else {
      const k = `${id}:${col}`, j = d.data.columns.indexOf(col);
      value = d.edits.has(k) ? d.edits.get(k) : d.data.rows[d.data.rowids.indexOf(+id)][j];
    }
    if (value && typeof value === "object") { toast("Blobs can't be edited here."); return; }
    const input = document.createElement(String(value ?? "").includes("\n") ? "textarea" : "input");
    input.className = "db-input";
    input.value = value === null ? "NULL" : String(value);
    input.title = "Enter saves the cell, Esc cancels. Type NULL for an empty (NULL) value.";
    td.replaceChildren(input);
    input.focus(); input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return; done = true;
      if (keep) {
        const nv = parseValue(t, col, input.value);
        if (ni !== undefined) d.inserts[+ni][col] = nv;
        else if (nv !== value) d.edits.set(`${id}:${col}`, nv);
      }
      draw();
      app.renderTabs();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !(ev.shiftKey && input.tagName === "TEXTAREA")) { ev.preventDefault(); finish(true); }
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  async function applyEdits(d, ask = true) {
    const t = tableOf(d), cells = d.edits.size, adds = d.inserts.length, dels = d.deletes.size;
    const parts = [cells && `${cells} changed cell${cells === 1 ? "" : "s"}`, adds && `${adds} new row${adds === 1 ? "" : "s"}`, dels && `${dels} deleted row${dels === 1 ? "" : "s"}`].filter(Boolean).join(", ");
    const c = ask ? await choose(`Save to ${t.name}: ${parts}? Everything is saved together, or nothing if something fails.`, ["Save", "Cancel"]) : "Save";
    if (ask && c !== "Save") return false;
    const edits = [
      ...[...d.edits].filter(([k]) => !d.deletes.has(+k.split(":")[0])).map(([k, value]) => { const i = k.indexOf(":"); return { kind: "update", rowid: +k.slice(0, i), column: k.slice(i + 1), value }; }),
      ...d.inserts.map((values) => ({ kind: "insert", values })),
      ...[...d.deletes].map((rowid) => ({ kind: "delete", rowid })),
    ];
    try {
      await invoke("db_apply", { path: d.path, table: t.name, edits });
      d.edits.clear(); d.inserts = []; d.deletes.clear(); d.sel.clear();
      toast("Saved.");
      await loadSchema(d, true);
      app.renderTabs();
      return true;
    } catch (e) { toast("Nothing was saved: " + e, 7000); return false; }
  }

  async function addFilter(d) {
    const cols = d.data?.columns || [];
    if (!cols.length) return;
    const ci = await choose("Filter which column?", cols, true);
    if (ci == null || ci < 0) return;
    const oi = await choose(`${cols[ci]}…`, OPS.map((o) => o[1]), true);
    if (oi == null || oi < 0) return;
    const op = OPS[oi][0];
    let value = "";
    if (!NO_VALUE.has(op)) {
      value = await app.promptText(`${cols[ci]} ${OPS[oi][1]}…`, "", "value");
      if (value == null) return;
    }
    d.view.filters.push({ col: cols[ci], op, value });
    d.offset = 0;
    loadRows(d);
  }

  async function exportTable(d) {
    const f = await choose("Export as", ["CSV", "JSON"], true);
    if (f == null || f < 0) return;
    const ext = f ? "json" : "csv";
    const out = await saveDialog({ defaultPath: `${d.table}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!out) return;
    try {
      const n = await invoke("db_export", { path: d.path, view: d.view, format: ext, out });
      toast(`Exported ${n.toLocaleString()} row${n === 1 ? "" : "s"}.`);
    } catch (e) { toast("Couldn't export: " + e, 6000); }
  }
  async function exportResult(d) {
    const r = d.result;
    const f = await choose("Export the results as", ["CSV", "JSON"], true);
    if (f == null || f < 0) return;
    const ext = f ? "json" : "csv";
    const out = await saveDialog({ defaultPath: `query.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!out) return;
    const txt = (v) => (v === null ? "" : typeof v === "object" ? `<${v.$blob} bytes>` : String(v));
    const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const text = ext === "csv"
      ? [r.columns.map(q).join(","), ...r.rows.map((row) => row.map((v) => q(txt(v))).join(","))].join("\r\n") + "\r\n"
      : JSON.stringify(r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))), null, 2) + "\n";
    try { await invoke("write_file", { path: out, contents: text }); toast(`Exported ${r.rows.length.toLocaleString()} rows.`); }
    catch (e) { toast("Couldn't export: " + e, 6000); }
  }

  async function endTx(d, keep) {
    try {
      const r = await invoke("db_query", { path: d.path, sql: keep ? "COMMIT;" : "ROLLBACK;" });
      d.inTx = r.in_transaction;
      toast(keep ? "Committed." : "Rolled back.");
    } catch (e) { toast(String(e), 6000); }
    await loadSchema(d, true);
  }

  // When another program writes to the database (a game saving, a server handling a request), the
  // tab reads it again. SQLite writes to name.db-wal first in WAL mode, so that file is watched too.
  const stamps = new Map(); // path -> last seen times
  setInterval(async () => {
    const d = cur();
    const typing = el.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (!d || el.hidden || document.hidden || d.mode === "sql" || pending(d) || typing || el.querySelector(".db-input")) return;
    const t = (await invoke("file_stats", { paths: [d.path, d.path + "-wal"] }).catch(() => [])).join(",");
    const was = stamps.get(d.path);
    stamps.set(d.path, t);
    if (was !== undefined && was !== t) {
      const keep = el.querySelector(".db-grid")?.scrollTop || 0;
      await loadSchema(d, true);
      const g = el.querySelector(".db-grid");
      if (g) g.scrollTop = keep;
    }
  }, 2000);

  // ---------- events ----------
  let searchT = null;
  el.addEventListener("input", (ev) => {
    const d = cur();
    if (!d) return;
    if (ev.target.matches(".db-tfilter")) {
      d.filter = ev.target.value;
      const pos = ev.target.selectionStart;
      draw();
      const f = el.querySelector(".db-tfilter"); f.focus(); f.setSelectionRange(pos, pos);
    }
    if (ev.target.matches(".db-search")) {
      clearTimeout(searchT);
      const v = ev.target.value;
      searchT = setTimeout(async () => {
        d.view.search = v; d.offset = 0;
        await loadRows(d);
        const s = el.querySelector(".db-search"); if (s) { s.focus(); s.setSelectionRange(v.length, v.length); }
      }, 300);
    }
  });
  el.addEventListener("click", (ev) => {
    const d = cur();
    if (!d) return;
    const tb = ev.target.closest("[data-table]");
    if (tb) {
      if (pending(d) && tb.dataset.table !== d.table) { toast("Save or discard your changes first."); return; }
      if (d.mode === "sql") d.mode = "data";
      pickTable(d, tb.dataset.table);
      draw();
      return;
    }
    const m = ev.target.closest("[data-mode]");
    if (m) { d.mode = m.dataset.mode; draw(); return; }
    const un = ev.target.closest("[data-unfilter]");
    if (un) { d.view.filters.splice(+un.dataset.unfilter, 1); d.offset = 0; loadRows(d); return; }
    const th = ev.target.closest("th[data-col]");
    if (th && d.mode === "data") {
      const c = th.dataset.col, v = d.view;
      if (v.sort !== c) { v.sort = c; v.desc = false; } else if (!v.desc) v.desc = true; else { v.sort = null; v.desc = false; }
      d.offset = 0; loadRows(d);
      return;
    }
    const num = ev.target.closest("td.db-n");
    if (num && d.mode === "data" && tableOf(d)?.editable) {
      const id = num.closest("tr").dataset.id;
      if (id !== undefined) { const n = +id; d.sel.has(n) ? d.sel.delete(n) : d.sel.add(n); draw(); }
      return;
    }
    const a = ev.target.closest("[data-act]")?.dataset.act;
    if (!a) return;
    if (a === "sql") { d.mode = "sql"; draw(); }
    else if (a === "run") runQuery(d);
    else if (a === "history") pickHistory(d);
    else if (a === "filter") addFilter(d);
    else if (a === "prev") { d.offset = Math.max(0, d.offset - PAGE); loadRows(d); }
    else if (a === "next") { d.offset += PAGE; loadRows(d); }
    else if (a === "export") exportTable(d);
    else if (a === "refresh") loadSchema(d, true);
    else if (a === "commit" || a === "rollback") endTx(d, a === "commit");
    else if (a === "qexport") exportResult(d);
    else if (a === "stopq") invoke("db_stop", { path: d.path }).catch(() => {});
    else if (a === "addrow") { d.inserts.unshift({}); draw(); app.renderTabs(); }
    else if (a === "delrows") { for (const id of d.sel) d.deletes.add(id); d.sel.clear(); draw(); app.renderTabs(); }
    else if (a === "discard") { d.edits.clear(); d.inserts = []; d.deletes.clear(); draw(); app.renderTabs(); }
    else if (a === "apply") applyEdits(d);
  });
  el.addEventListener("dblclick", (ev) => {
    const d = cur(), td = ev.target.closest("td[data-c]");
    if (d && td && d.mode === "data") editCell(d, td);
  });

  app.pages.push({
    el,
    match: (k) => k.startsWith("@db:"),
    render: (k) => {
      if (shown !== k) { sqlView?.destroy(); sqlView = null; sqlFor = null; }
      shown = k;
      draw();
    },
    label: (k) => { const d = dbs.get(k); return (d ? base(d.path) : "Database") + (d && pending(d) ? " •" : ""); },
    dot: "db",
    confirmClose: async (k) => {
      const d = dbs.get(k);
      if (d?.inTx) {
        const c = await choose(`${base(d.path)} has a transaction open. Keep its changes?`, ["Commit", "Roll back", "Cancel"]);
        if (!c || c === "Cancel") return false;
        await invoke("db_query", { path: d.path, sql: c === "Commit" ? "COMMIT;" : "ROLLBACK;" }).catch((e) => toast(String(e), 6000));
        d.inTx = false;
      }
      if (!d || !pending(d)) return true;
      const c = await choose(`${base(d.path)} has ${pending(d)} unsaved change${pending(d) === 1 ? "" : "s"} to ${d.table}.`, ["Save", "Don't save", "Cancel"]);
      if (c === "Save") return applyEdits(d, false);
      return c === "Don't save";
    },
    focus: () => (cur()?.mode === "sql" ? sqlView?.focus() : el.querySelector(".db-grid")?.focus()),
    close: (k) => {
      if (shown === k) { sqlView?.destroy(); sqlView = null; sqlFor = null; shown = null; }
      const d = dbs.get(k);
      if (d) { invoke("db_close", { path: d.path }).catch(() => {}); stamps.delete(d.path); }
      dbs.delete(k);
    },
  });
  app.openDb = openDb;
}
