//! Database viewer: reads and edits SQLite files with SQLite built in
//! (rusqlite, bundled), so nothing has to be installed. The page in
//! src/db.js asks for the schema, pages of rows (filtered and sorted here, in
//! SQL), runs queries, and saves edits in one transaction.

use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Instant;

type Res<T> = Result<T, String>;

const MAX_QUERY_ROWS: usize = 5000;

/// One connection per open database tab, kept until the tab closes (db_close). Every run in the
/// tab shares it, so a BEGIN in one run and a COMMIT in a later one work, and foreign keys are on
/// for all of them (SQLite turns them off in every new connection).
static CONNS: LazyLock<Mutex<HashMap<String, Arc<Mutex<Connection>>>>> = LazyLock::new(Default::default);

fn conn(path: &str) -> Res<Arc<Mutex<Connection>>> {
    let mut all = CONNS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = all.get(path) {
        return Ok(c.clone());
    }
    let c = Arc::new(Mutex::new(open(path)?));
    all.insert(path.to_string(), c.clone());
    Ok(c)
}

fn lock(c: &Arc<Mutex<Connection>>) -> MutexGuard<'_, Connection> {
    c.lock().unwrap_or_else(|e| e.into_inner())
}

/// Closes the tab's connection. A transaction left open is rolled back.
#[tauri::command]
pub fn db_close(path: String) {
    CONNS.lock().unwrap_or_else(|e| e.into_inner()).remove(&path);
}

fn open(path: &str) -> Res<Connection> {
    let mut head = [0u8; 16];
    use std::io::Read;
    std::fs::File::open(path).map_err(|e| format!("Couldn't open the file ({e})."))?.read(&mut head).ok();
    // An empty file is an empty database to SQLite.
    let empty = std::fs::metadata(path).map(|m| m.len() == 0).unwrap_or(false);
    if !empty && &head != b"SQLite format 3\0" {
        return Err("This isn't a SQLite database.".into());
    }
    let flags = OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    // Read-write when the file allows it, read-only otherwise (a write then says why it failed).
    let c = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_READ_WRITE)
        .or_else(|_| Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_READ_ONLY))
        .map_err(|e| e.to_string())?;
    c.busy_timeout(std::time::Duration::from_secs(3)).ok();
    c.execute_batch("PRAGMA foreign_keys = ON;").ok();
    Ok(c)
}

/// "name" → "\"name\"", safe for any table or column name.
fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({ "$blob": b.len() }),
    }
}

fn to_sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

/// A filter value typed in the grid: numbers compare as numbers.
fn typed(s: &str) -> Sql {
    let t = s.trim();
    if let Ok(i) = t.parse::<i64>() {
        return Sql::Integer(i);
    }
    if let Ok(f) = t.parse::<f64>() {
        if t.contains('.') {
            return Sql::Real(f);
        }
    }
    Sql::Text(s.to_string())
}

fn like(s: &str, pre: &str, post: &str) -> Sql {
    let esc = s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    Sql::Text(format!("{pre}{esc}{post}"))
}

// ---------- schema ----------

#[derive(Serialize)]
pub struct Column {
    name: String,
    #[serde(rename = "type")]
    ty: String,
    pk: bool,
    notnull: bool,
    default: Option<String>,
}

#[derive(Serialize)]
pub struct Table {
    name: String,
    kind: String,
    rows: Option<i64>,
    columns: Vec<Column>,
    /// Rows have a rowid, so they can be edited (not views or WITHOUT ROWID tables).
    editable: bool,
    sql: String,
    indexes: Vec<String>,
}

#[tauri::command]
pub async fn db_schema(path: String) -> Res<Vec<Table>> {
    blocking(move || schema(&path)).await
}

fn schema(path: &str) -> Res<Vec<Table>> {
    let cc = conn(path)?;
    let c = lock(&cc);
    let mut st = c
        .prepare("SELECT name, type, coalesce(sql, '') FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .map_err(|e| e.to_string())?;
    let list: Vec<(String, String, String)> = st
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    let mut out = Vec::new();
    for (name, kind, sql) in list {
        let mut cols = Vec::new();
        if let Ok(mut st) = c.prepare(&format!("PRAGMA table_info({})", ident(&name))) {
            let rows = st.query_map([], |r| {
                Ok(Column { name: r.get(1)?, ty: r.get::<_, Option<String>>(2)?.unwrap_or_default(), notnull: r.get::<_, i64>(3)? != 0, default: r.get(4)?, pk: r.get::<_, i64>(5)? != 0 })
            });
            if let Ok(rows) = rows {
                cols = rows.filter_map(Result::ok).collect();
            }
        }
        let rows = c.query_row(&format!("SELECT count(*) FROM {}", ident(&name)), [], |r| r.get(0)).ok();
        let editable = kind == "table" && c.prepare(&format!("SELECT rowid FROM {} LIMIT 0", ident(&name))).is_ok();
        let mut indexes = Vec::new();
        if let Ok(mut st) = c.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL") {
            if let Ok(rows) = st.query_map([&name], |r| r.get::<_, String>(0)) {
                indexes = rows.filter_map(Result::ok).collect();
            }
        }
        out.push(Table { name, kind, rows, columns: cols, editable, sql, indexes });
    }
    Ok(out)
}

// ---------- browsing ----------

#[derive(Deserialize, Clone)]
pub struct Filter {
    col: String,
    op: String,
    #[serde(default)]
    value: String,
}

#[derive(Deserialize, Clone)]
pub struct View {
    table: String,
    #[serde(default)]
    filters: Vec<Filter>,
    /// Matches any column.
    #[serde(default)]
    search: String,
    sort: Option<String>,
    #[serde(default)]
    desc: bool,
}

/// The WHERE and ORDER BY for a view of a table, with its parameters.
fn clauses(c: &Connection, v: &View) -> Res<(String, Vec<Sql>)> {
    let mut wh = Vec::new();
    let mut ps = Vec::new();
    for f in &v.filters {
        let col = ident(&f.col);
        let (sql, p) = match f.op.as_str() {
            "eq" => (format!("{col} = ?"), Some(typed(&f.value))),
            "ne" => (format!("({col} IS NULL OR {col} <> ?)"), Some(typed(&f.value))),
            "contains" => (format!("{col} LIKE ? ESCAPE '\\'"), Some(like(&f.value, "%", "%"))),
            "starts" => (format!("{col} LIKE ? ESCAPE '\\'"), Some(like(&f.value, "", "%"))),
            "ends" => (format!("{col} LIKE ? ESCAPE '\\'"), Some(like(&f.value, "%", ""))),
            "gt" => (format!("{col} > ?"), Some(typed(&f.value))),
            "gte" => (format!("{col} >= ?"), Some(typed(&f.value))),
            "lt" => (format!("{col} < ?"), Some(typed(&f.value))),
            "lte" => (format!("{col} <= ?"), Some(typed(&f.value))),
            "empty" => (format!("({col} IS NULL OR {col} = '')"), None),
            "notempty" => (format!("({col} IS NOT NULL AND {col} <> '')"), None),
            "null" => (format!("{col} IS NULL"), None),
            other => return Err(format!("Unknown filter: {other}")),
        };
        wh.push(sql);
        ps.extend(p);
    }
    if !v.search.trim().is_empty() {
        let cols: Vec<String> = {
            let mut st = c.prepare(&format!("SELECT * FROM {} LIMIT 0", ident(&v.table))).map_err(|e| e.to_string())?;
            st.column_names().into_iter().map(String::from).collect()
        };
        if !cols.is_empty() {
            wh.push(format!("({})", cols.iter().map(|n| format!("CAST({} AS TEXT) LIKE ? ESCAPE '\\'", ident(n))).collect::<Vec<_>>().join(" OR ")));
            for _ in &cols {
                ps.push(like(v.search.trim(), "%", "%"));
            }
        }
    }
    let mut sql = String::new();
    if !wh.is_empty() {
        sql += &format!(" WHERE {}", wh.join(" AND "));
    }
    if let Some(s) = &v.sort {
        sql += &format!(" ORDER BY {} {}", ident(s), if v.desc { "DESC" } else { "ASC" });
    }
    Ok((sql, ps))
}

#[derive(Serialize)]
pub struct Rows {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    /// rowid of each row, when the table can be edited.
    rowids: Option<Vec<i64>>,
    total: i64,
    in_transaction: bool,
}

#[tauri::command]
pub async fn db_rows(path: String, view: View, offset: i64, limit: i64) -> Res<Rows> {
    blocking(move || rows(&path, &view, offset, limit)).await
}

fn rows(path: &str, v: &View, offset: i64, limit: i64) -> Res<Rows> {
    let cc = conn(path)?;
    let c = lock(&cc);
    let (tail, ps) = clauses(&c, v)?;
    let t = ident(&v.table);
    let total: i64 = c.query_row(&format!("SELECT count(*) FROM {t}{}", tail.split(" ORDER BY ").next().unwrap_or("")), params_from_iter(ps.iter()), |r| r.get(0)).map_err(|e| e.to_string())?;
    let with_rowid = format!("SELECT rowid AS \"__ledger_rowid\", * FROM {t}{tail} LIMIT {limit} OFFSET {offset}");
    let (mut st, has_id) = match c.prepare(&with_rowid) {
        Ok(st) => (st, true),
        Err(_) => (c.prepare(&format!("SELECT * FROM {t}{tail} LIMIT {limit} OFFSET {offset}")).map_err(|e| e.to_string())?, false),
    };
    let skip = has_id as usize;
    let columns: Vec<String> = st.column_names().into_iter().skip(skip).map(String::from).collect();
    let n = columns.len();
    let mut out = Vec::new();
    let mut ids = Vec::new();
    let mut q = st.query(params_from_iter(ps.iter())).map_err(|e| e.to_string())?;
    while let Some(r) = q.next().map_err(|e| e.to_string())? {
        if has_id {
            ids.push(r.get::<_, i64>(0).unwrap_or(0));
        }
        out.push((0..n).map(|i| r.get_ref(i + skip).map(to_json).unwrap_or(Value::Null)).collect());
    }
    let in_transaction = !c.is_autocommit();
    drop(q);
    drop(st);
    Ok(Rows { columns, rows: out, rowids: has_id.then_some(ids), total, in_transaction })
}

// ---------- queries ----------

#[derive(Serialize)]
pub struct Query {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    truncated: bool,
    /// Rows changed by INSERT, UPDATE or DELETE statements.
    changed: u64,
    statements: usize,
    ms: u128,
    /// A BEGIN without its COMMIT or ROLLBACK yet.
    in_transaction: bool,
}

/// Runs one or more statements; the last one that returns rows is shown.
#[tauri::command]
pub async fn db_query(path: String, sql: String) -> Res<Query> {
    blocking(move || query(&path, &sql)).await
}

fn query(path: &str, sql: &str) -> Res<Query> {
    let cc = conn(path)?;
    let c = lock(&cc);
    let start = Instant::now();
    let mut res = Query { columns: vec![], rows: vec![], truncated: false, changed: 0, statements: 0, ms: 0, in_transaction: false };
    let mut batch = rusqlite::Batch::new(&c, sql);
    while let Some(mut st) = batch.next().map_err(|e| e.to_string())? {
        res.statements += 1;
        if st.column_count() > 0 {
            let columns: Vec<String> = st.column_names().into_iter().map(String::from).collect();
            let n = columns.len();
            let mut rows = Vec::new();
            let mut truncated = false;
            let mut q = st.query([]).map_err(|e| e.to_string())?;
            while let Some(r) = q.next().map_err(|e| e.to_string())? {
                if rows.len() == MAX_QUERY_ROWS {
                    truncated = true;
                    break;
                }
                rows.push((0..n).map(|i| r.get_ref(i).map(to_json).unwrap_or(Value::Null)).collect());
            }
            res.columns = columns;
            res.rows = rows;
            res.truncated = truncated;
        } else {
            let before = c.total_changes();
            st.raw_execute().map_err(|e| e.to_string())?;
            res.changed += c.total_changes() - before;
        }
    }
    res.ms = start.elapsed().as_millis();
    res.in_transaction = !c.is_autocommit();
    Ok(res)
}

// ---------- editing ----------

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Edit {
    Update { rowid: i64, column: String, value: Value },
    Insert { values: Map<String, Value> },
    Delete { rowid: i64 },
}

/// Saves all edits to one table, or none of them if one fails.
#[tauri::command]
pub async fn db_apply(path: String, table: String, edits: Vec<Edit>) -> Res<usize> {
    blocking(move || apply(&path, &table, edits)).await
}

fn apply(path: &str, table: &str, edits: Vec<Edit>) -> Res<usize> {
    let cc = conn(path)?;
    let mut c = lock(&cc);
    // A savepoint works inside a transaction someone started with BEGIN, and on its own.
    let tx = c.savepoint().map_err(|e| e.to_string())?;
    let t = ident(table);
    let mut n = 0;
    for e in &edits {
        n += match e {
            Edit::Update { rowid, column, value } => tx.execute(&format!("UPDATE {t} SET {} = ?1 WHERE rowid = ?2", ident(column)), rusqlite::params![to_sql(value), rowid]),
            Edit::Delete { rowid } => tx.execute(&format!("DELETE FROM {t} WHERE rowid = ?1"), [rowid]),
            Edit::Insert { values } if values.is_empty() => tx.execute(&format!("INSERT INTO {t} DEFAULT VALUES"), []),
            Edit::Insert { values } => {
                let cols: Vec<String> = values.keys().map(|k| ident(k)).collect();
                let marks: Vec<String> = (1..=values.len()).map(|i| format!("?{i}")).collect();
                tx.execute(&format!("INSERT INTO {t} ({}) VALUES ({})", cols.join(", "), marks.join(", ")), params_from_iter(values.values().map(to_sql)))
            }
        }
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

// ---------- new database ----------

/// Makes a new, empty SQLite file. Returns false if the file was already there (it's opened as it is).
#[tauri::command]
pub async fn db_create(path: String) -> Res<bool> {
    blocking(move || {
        if std::path::Path::new(&path).exists() {
            return Ok(false);
        }
        let c = Connection::open(&path).map_err(|e| e.to_string())?;
        // SQLite writes nothing until there's something to save; this makes it a real database file now.
        c.execute_batch("PRAGMA user_version = 1; PRAGMA user_version = 0;").map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
}

// ---------- export ----------

/// Writes a table (with the grid's filters and sort) to CSV or JSON. Returns the row count.
#[tauri::command]
pub async fn db_export(path: String, view: View, format: String, out: String) -> Res<usize> {
    blocking(move || export(&path, &view, &format, &out)).await
}

fn export(path: &str, v: &View, format: &str, out: &str) -> Res<usize> {
    let cc = conn(path)?;
    let c = lock(&cc);
    let (tail, ps) = clauses(&c, v)?;
    let mut st = c.prepare(&format!("SELECT * FROM {}{tail}", ident(&v.table))).map_err(|e| e.to_string())?;
    let cols: Vec<String> = st.column_names().into_iter().map(String::from).collect();
    let mut q = st.query(params_from_iter(ps.iter())).map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    while let Some(r) = q.next().map_err(|e| e.to_string())? {
        rows.push((0..cols.len()).map(|i| r.get_ref(i).map(to_json).unwrap_or(Value::Null)).collect::<Vec<_>>());
    }
    let text = if format == "json" { to_json_text(&cols, &rows) } else { to_csv(&cols, &rows) };
    std::fs::write(out, text).map_err(|e| format!("Couldn't write the file ({e})."))?;
    Ok(rows.len())
}

fn cell_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(o) if o.contains_key("$blob") => format!("<{} bytes>", o["$blob"]),
        other => other.to_string(),
    }
}

pub fn to_csv(cols: &[String], rows: &[Vec<Value>]) -> String {
    let q = |s: &str| if s.contains([',', '"', '\n', '\r']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() };
    let mut out = cols.iter().map(|c| q(c)).collect::<Vec<_>>().join(",") + "\r\n";
    for r in rows {
        out += &(r.iter().map(|v| q(&cell_text(v))).collect::<Vec<_>>().join(",") + "\r\n");
    }
    out
}

/// An array of objects, keys in the table's column order.
pub fn to_json_text(cols: &[String], rows: &[Vec<Value>]) -> String {
    let key = |c: &String| serde_json::to_string(c).unwrap_or_default();
    let objs: Vec<String> = rows
        .iter()
        .map(|r| format!("  {{ {} }}", cols.iter().zip(r).map(|(c, v)| format!("{}: {}", key(c), v)).collect::<Vec<_>>().join(", ")))
        .collect();
    format!("[\n{}\n]\n", objs.join(",\n"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}
