// A small LSP client. The Rust side frames and pipes bytes for each server
// (keyed by id: "rust", "csharp"); this file speaks the protocol. The debugger
// (dap.js) uses the same pipe under the id "dap".
import { invoke } from "@tauri-apps/api/core";
import { on as listen } from "./win.js";

export const norm = (p) => String(p || "").replace(/\\/g, "/");

export function pathToUri(p) {
  let s = norm(p);
  if (!s.startsWith("/")) s = "/" + s; // C:/x -> /C:/x
  return "file://" + s.split("/").map((seg, i) => (i === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join("/");
}
export function uriToPath(u) {
  let s = decodeURIComponent(String(u).replace(/^file:\/\//, ""));
  if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
  if (/^[a-z]:\//.test(s)) s = s[0].toUpperCase() + s.slice(1); // some servers lower-case the drive
  return s;
}

// Positions: LSP and CodeMirror both count UTF-16 code units.
export function toOffset(doc, pos) {
  const n = Math.min(Math.max(pos.line + 1, 1), doc.lines);
  const line = doc.line(n);
  return Math.min(line.from + Math.max(0, pos.character), line.to);
}
export function toPos(doc, off) {
  const line = doc.lineAt(off);
  return { line: line.number - 1, character: off - line.from };
}

const SEV = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
export const severity = (n) => SEV[n] || "info";

const CAPS = {
  general: { positionEncodings: ["utf-16"] },
  window: { workDoneProgress: true, showMessage: {} },
  workspace: { configuration: true, applyEdit: true, workspaceFolders: true, workspaceEdit: { documentChanges: true }, inlayHint: { refreshSupport: true }, symbol: {} },
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"], labelDetailsSupport: true }, contextSupport: true },
    hover: { contentFormat: ["markdown", "plaintext"] },
    signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true }, contextSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    definition: { linkSupport: true },
    formatting: {},
    rename: { prepareSupport: false },
    inlayHint: { dynamicRegistration: false },
    codeAction: {
      codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"] } },
      resolveSupport: { properties: ["edit"] },
      dataSupport: true,
    },
    publishDiagnostics: { relatedInformation: false, versionSupport: false },
  },
  experimental: { serverStatusNotification: true },
};

let listening = null;
const clients = new Map();
/** Other users of the stdio pipe (the debugger), keyed by id. */
export const pipeClients = new Map();
export function ensureListening() {
  if (!listening) {
    listening = Promise.all([
      listen("lsp-message", (e) => (clients.get(e.payload.id) || pipeClients.get(e.payload.id))?.receive(e.payload)),
      listen("lsp-exit", (e) => (clients.get(e.payload.id) || pipeClients.get(e.payload.id))?.exited(e.payload)),
    ]);
  }
  return listening;
}

export class Lsp {
  /** on: { diagnostics(path, list), status(), message(text), applyEdit(edit) } */
  constructor(id, label, on) {
    this.id = id;
    this.label = label;
    this.on = on;
    this.pending = new Map();
    this.early = new Map(); // exits that arrived before lsp_start returned their pid
    this.versions = new Map();
    this.progress = new Map();
    this.seq = 0;
    this.gen = 0;
    this.pid = null;
    this.alive = false;
    this.state = { text: "", busy: false, bad: false, detail: "" };
    this.ready = Promise.resolve(false);
    clients.set(id, this);
  }

  setStatus(text, busy = false, bad = false, detail = "") {
    this.state = { text, busy, bad, detail };
    this.on.status(this);
  }

  /** spec: { exe, args, initOptions, missing } */
  async start(root, spec) {
    this.settings = spec.settings || {};
    const gen = ++this.gen;
    this.root = root;
    this.alive = false;
    this.pid = null;
    this.versions.clear();
    this.progress.clear();
    this.health = null;
    for (const [, p] of this.pending) p.reject(new Error("restarted"));
    this.pending.clear();
    this.setStatus("starting", true);
    let ok;
    this.ready = new Promise((r) => (ok = r));
    await ensureListening();
    try {
      const r = await invoke("lsp_start", { id: this.id, root, exe: spec.exe, args: spec.args || [] });
      if (gen !== this.gen) return false;
      this.pid = r.pid;
      this.exe = r.exe;
      const died = this.early.get(r.pid);
      this.early.clear();
      if (died) { this.alive = true; this.exited(died); ok(false); return false; }
    } catch (e) {
      const s = String(e);
      this.setStatus("not installed", false, true, s.startsWith("not found") ? spec.missing : s);
      ok(false);
      return false;
    }
    this.alive = true;
    try {
      const uri = pathToUri(root);
      const timeout = new Promise((_, no) => setTimeout(() => no(new Error(`${this.label} didn't answer within two minutes.`)), 120000));
      const init = await Promise.race([timeout, this.raw("initialize", {
        processId: null,
        clientInfo: { name: "Ledger" },
        rootUri: uri,
        rootPath: root,
        workspaceFolders: [{ uri, name: norm(root).split("/").pop() }],
        capabilities: CAPS,
        initializationOptions: spec.initOptions || {},
      })]);
      if (gen !== this.gen) return false;
      this.caps = init?.capabilities || {};
      this.notify("initialized", {}, true);
      ok(true);
      // Servers without status notifications are "ready" once initialised.
      if (this.caps.experimental?.serverStatusNotification || this.id === "rust") this.setStatus("indexing", true);
      else this.setStatus("ready");
      return true;
    } catch (e) {
      ok(false);
      this.setStatus("failed", false, true, String(e.message || e));
      return false;
    }
  }

  async stop() {
    this.gen++;
    this.alive = false;
    this.versions.clear();
    try { await invoke("lsp_stop", { id: this.id }); } catch {}
    this.setStatus("");
  }

  exited(p) {
    if (!this.pid && !this.alive) { this.early.set(p.pid, p); return; }
    if (!this.alive || (this.pid && p.pid !== this.pid)) return;
    this.alive = false;
    for (const [, r] of this.pending) r.reject(new Error("server stopped"));
    this.pending.clear();
    const why = String(p.stderr || "").trim();
    const missing = /Unknown binary|not installed|rustup component add|You must install|framework.*not found|install.*\.NET/i.test(why);
    this.setStatus(missing ? "not installed" : "stopped", false, true, why.split("\n").slice(-4).join("\n") || `${this.label} stopped.`);
  }

  send(obj) {
    return invoke("lsp_send", { id: this.id, msg: JSON.stringify({ jsonrpc: "2.0", ...obj }) }).catch(() => {});
  }
  raw(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
    });
  }
  async request(method, params) {
    if (!(await this.ready) || !this.alive) return null;
    try { return await this.raw(method, params); } catch { return null; }
  }
  async notify(method, params, now) {
    if (!now && !(await this.ready)) return;
    if (this.alive) this.send({ method, params });
  }

  receive({ pid, msg }) {
    if (this.pid && pid !== this.pid) return;
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    if (m.id != null && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      else p.resolve(m.result);
      return;
    }
    if (m.id != null) return this.serverRequest(m);
    const pr = m.params || {};
    switch (m.method) {
      case "textDocument/publishDiagnostics":
        this.on.diagnostics(uriToPath(pr.uri), pr.diagnostics || []);
        break;
      case "experimental/serverStatus":
        this.health = pr;
        this.updateStatus();
        break;
      case "$/progress": {
        const v = pr.value || {};
        if (v.kind === "end") this.progress.delete(pr.token);
        else this.progress.set(pr.token, { title: v.title || this.progress.get(pr.token)?.title || "", pct: v.percentage, msg: v.message });
        this.updateStatus();
        break;
      }
      case "window/showMessage":
        if ((pr.type || 4) <= 2) this.on.message(`${this.label}: ${pr.message}`);
        break;
    }
  }

  updateStatus() {
    const busy = [...this.progress.values()];
    const h = this.health;
    if (busy.length) {
      const b = busy[busy.length - 1];
      this.setStatus(`${b.title || "working"}${b.pct != null ? " " + b.pct + "%" : ""}`.toLowerCase(), true, false, b.msg || "");
    } else if (h && h.quiescent === false) this.setStatus("indexing", true);
    else if (h) this.setStatus(h.health === "error" ? "error" : h.health === "warning" ? "ready, with warnings" : "ready", false, h.health === "error", h.message || "");
    else this.setStatus("ready");
  }

  serverRequest(m) {
    if (m.method === "workspace/applyEdit") {
      return Promise.resolve(this.on.applyEdit?.(m.params.edit)).then((ok) => this.send({ id: m.id, result: { applied: ok !== false } }));
    }
    if (m.method === "workspace/inlayHint/refresh") this.on.refreshHints?.(this);
    // Settings the server asks for by section ("css", "html.format"…), from the spec's `settings`.
    const pick = (section) => (section ? section.split(".").reduce((o, k) => (o == null ? o : o[k]), this.settings) : this.settings) ?? null;
    const result = m.method === "workspace/configuration" ? (m.params?.items || []).map((it) => pick(it.section)) : null;
    this.send({ id: m.id, result });
  }

  // ----- documents -----
  open(path, text, languageId) {
    const uri = pathToUri(path);
    this.versions.set(uri, 1);
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
  }
  change(path, text, languageId) {
    const uri = pathToUri(path);
    if (!this.versions.has(uri)) return this.open(path, text, languageId);
    const v = this.versions.get(uri) + 1;
    this.versions.set(uri, v);
    this.notify("textDocument/didChange", { textDocument: { uri, version: v }, contentChanges: [{ text }] });
  }
  saved(path) { this.notify("textDocument/didSave", { textDocument: { uri: pathToUri(path) } }); }
  close(path) {
    const uri = pathToUri(path);
    if (!this.versions.delete(uri)) return;
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }
  at(path, doc, off) { return { textDocument: { uri: pathToUri(path) }, position: toPos(doc, off) }; }
}

// Snippet text like `foo(${1:x}, $2)$0` → plain text plus where the cursor goes.
export function unsnippet(s) {
  let out = "", first = null, firstN = Infinity, end = null;
  const stop = (n) => {
    if (n === 0) { if (end == null) end = out.length; }
    else if (n < firstN) { firstN = n; first = out.length; }
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { out += s[++i]; continue; }
    if (c === "$") {
      let m = /^\$(\d+)/.exec(s.slice(i));
      if (m) { stop(+m[1]); i += m[0].length - 1; continue; }
      m = /^\$\{(\d+)(?::((?:[^}\\]|\\.)*))?\}/.exec(s.slice(i));
      if (m) {
        stop(+m[1]);
        const body = (m[2] || "").replace(/\\(.)/g, "$1").replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{?\d+\}?/g, "");
        if (+m[1] !== 0 || body) out += body;
        i += m[0].length - 1;
        continue;
      }
      m = /^\$\{(\d+)\|([^|]*)\|\}/.exec(s.slice(i));
      if (m) { stop(+m[1]); out += m[2].split(",")[0]; i += m[0].length - 1; continue; }
    }
    out += c;
  }
  return { text: out, cursor: first ?? end ?? out.length };
}

const KIND = { 2: "method", 3: "function", 4: "function", 5: "property", 6: "variable", 7: "class", 8: "interface", 9: "namespace", 10: "property", 12: "constant", 13: "enum", 14: "keyword", 15: "text", 20: "enum", 21: "constant", 22: "class", 23: "type", 25: "type" };
export const completionType = (k) => KIND[k] || "text";
