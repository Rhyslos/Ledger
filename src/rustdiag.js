// cargo's messages (check, build, clippy, test, run) as Problems, so a Rust project shows its
// errors and warnings in the editor and the Problems panel even without rust-analyzer:
//
//   error[E0599]: no method named `foo` found for struct `Counter` in the current scope
//     --> src/main.rs:29:53
//
// The message comes first, the place on a line after it.

const HEAD = /^(error|warning)(?:\[([A-Z]\d{4})\])?: (.+)$/;
const AT = /^\s*--> (.+?):(\d+):(\d+)\s*$/;
// Lines that look like a message but aren't one about the code.
const NOT_CODE = /^(warning|error): (`[^`]+` \((?:lib|bin|test|example)[^)]*\) generated|could not compile|unused manifest key|build failed|aborting due|\d+ warnings? emitted|Compiling|Finished|test failed|Some errors have)/;

/** Feeds cargo's output a line at a time; `take()` gives { path (relative to the crate) -> [diag] }. */
export function cargoDiags() {
  let head = null;
  const found = new Map();
  return {
    line(text) {
      // A message and its place can arrive together, as one piece of output with line breaks.
      if (text.includes("\n")) { for (const l of text.split(/\r?\n/)) this.line(l); return; }
      const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
      const h = HEAD.exec(plain);
      if (h) { head = NOT_CODE.test(plain) ? null : { sev: h[1] === "error" ? 1 : 2, code: h[2] || "", msg: h[3] }; return; }
      const a = head && AT.exec(plain);
      if (!a) return;
      const line = +a[2] - 1, ch = +a[3] - 1;
      const list = found.get(a[1]) || [];
      const d = { range: { start: { line, character: ch }, end: { line, character: ch + 1 } }, severity: head.sev, code: head.code, message: head.msg + (head.code ? ` (${head.code})` : ""), source: "cargo" };
      if (!list.some((x) => x.message === d.message && x.range.start.line === line && x.range.start.character === ch)) list.push(d);
      found.set(a[1], list);
      head = null; // only the first place is the message's own
    },
    take() { return found; },
  };
}
