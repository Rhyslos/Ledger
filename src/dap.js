// A small Debug Adapter Protocol client. The adapter (codelldb for Rust,
// netcoredbg for C# and Godot) runs as a child process; the Rust side frames
// its stdio exactly like a language server's, under the pipe id "dap".
import { invoke } from "@tauri-apps/api/core";
import { pipeClients, ensureListening } from "./lsp.js";

export class Dap {
  /** on: { event(name, body), exit(why), request(msg) } */
  constructor(on) {
    this.on = on;
    this.seq = 0;
    this.pending = new Map();
    this.pid = null;
    this.alive = false;
    this.early = [];
  }

  async start(exe, args, cwd) {
    pipeClients.set("dap", this);
    await ensureListening();
    const r = await invoke("lsp_start", { id: "dap", root: cwd, exe, args, probe: false });
    this.pid = r.pid;
    this.exe = r.exe;
    this.alive = true;
    for (const m of this.early.splice(0)) if (m.pid === this.pid) (m.exit ? this.exited(m) : this.receive(m));
    return r;
  }

  async stop() {
    this.alive = false;
    for (const [, p] of this.pending) p.reject(new Error("The debugger stopped."));
    this.pending.clear();
    try { await invoke("lsp_stop", { id: "dap" }); } catch {}
    if (pipeClients.get("dap") === this) pipeClients.delete("dap");
  }

  exited(p) {
    if (!this.pid) { this.early.push({ ...p, exit: true }); return; }
    if (p.pid !== this.pid || !this.alive) return;
    this.alive = false;
    for (const [, r] of this.pending) r.reject(new Error("The debugger stopped."));
    this.pending.clear();
    this.on.exit(String(p.stderr || "").trim());
  }

  send(obj) {
    return invoke("lsp_send", { id: "dap", msg: JSON.stringify(obj) }).catch(() => {});
  }

  request(command, args = {}, timeoutMs = 0) {
    if (!this.alive) return Promise.reject(new Error("The debugger isn't running."));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject, command });
      if (timeoutMs) setTimeout(() => { if (this.pending.delete(seq)) reject(new Error(`${command} took too long.`)); }, timeoutMs);
      this.send({ seq, type: "request", command, arguments: args });
    });
  }

  receive(p) {
    if (!this.pid) { this.early.push(p); return; }
    if (p.pid !== this.pid) return;
    let m;
    try { m = JSON.parse(p.msg); } catch { return; }
    if (m.type === "response") {
      const r = this.pending.get(m.request_seq);
      if (!r) return;
      this.pending.delete(m.request_seq);
      if (m.success) r.resolve(m.body || {});
      else r.reject(new Error(m.body?.error?.format ? fill(m.body.error.format, m.body.error.variables) : m.message || `${r.command} failed`));
    } else if (m.type === "event") {
      this.on.event(m.event, m.body || {});
    } else if (m.type === "request") {
      // Reverse requests (runInTerminal, startDebugging): not supported here.
      const handled = this.on.request?.(m);
      if (!handled) this.send({ seq: ++this.seq, type: "response", request_seq: m.seq, command: m.command, success: false, message: "Not supported by Ledger" });
    }
  }
}

const fill = (fmt, vars = {}) => fmt.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
