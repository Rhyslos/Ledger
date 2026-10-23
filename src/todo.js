// The TODO panel: every TODO, FIXME, HACK, XXX and BUG comment in the folder, grouped by file,
// newest list after each save. Click one to go there. The words are also tinted in the editor.
import { ViewPlugin, Decoration, MatchDecorator } from "@codemirror/view";

const WORDS = ["TODO", "FIXME", "HACK", "XXX", "BUG"];
// The word, then ":" "(" or a space, so "todos" or "TODOList" in code don't count.
const LINE = /(?:\/\/|\/\*|#|--|<!--|;|\*)\s*(TODO|FIXME|HACK|XXX|BUG)\b[:(\s]?(.*)$/;

const tint = new MatchDecorator({
  regexp: /(?:\/\/|\/\*|#|--|<!--|;|\*)\s*\b(TODO|FIXME|HACK|XXX|BUG)\b/g,
  decoration: (m, view, pos) => Decoration.mark({ class: "cm-todo-" + (m[1] === "TODO" ? "todo" : "fix") }),
});
const todoTint = ViewPlugin.fromClass(class {
  constructor(v) { this.decorations = tint.createDeco(v); }
  update(u) { this.decorations = tint.updateDeco(u, this.decorations); }
}, { decorations: (v) => v.decorations });

export function initTodo(app) {
  const { S, invoke, esc, rel } = app;
  const el = document.getElementById("todo");
  let items = [], busy = false, again = false, loadedFor = null, filter = "";

  async function scan() {
    if (!S.root) { items = []; render(); return; }
    if (busy) { again = true; return; }
    busy = true;
    try {
      const root = S.root;
      // One search per word (the search is plain text), then keep the lines where it's in a comment.
      const found = (await invoke("find_todos", { root }).catch(() => null)) || [];
      if (root !== S.root) return;
      const seen = new Set();
      items = [];
      for (const h of found) {
        const key = h.path + ":" + h.line;
        if (seen.has(key)) continue;
        const m = LINE.exec(h.text);
        if (!m) continue;
        seen.add(key);
        items.push({ path: app.norm(h.path), line: h.line, word: m[1], text: m[2].replace(/\*\/\s*$|-->\s*$/, "").trim() });
      }
      items.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
      loadedFor = root;
      render();
    } finally {
      busy = false;
      if (again) { again = false; scan(); }
    }
  }

  function render() {
    if (!el) return;
    const shown = filter ? items.filter((t) => t.word === filter) : items;
    const groups = new Map();
    for (const t of shown) { if (!groups.has(t.path)) groups.set(t.path, []); groups.get(t.path).push(t); }
    const count = (w) => items.filter((t) => t.word === w).length;
    el.innerHTML = `<div class="tbar">
        ${["", ...WORDS].filter((w) => !w || count(w)).map((w) => `<button class="btn${filter === w ? " on" : ""}" data-tf="${w}">${w || "All"} <span class="tcount">${w ? count(w) : items.length}</span></button>`).join("")}
        <span class="sp"></span>
        <button class="ibtn" data-trefresh title="Look again" aria-label="Look again"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></button>
      </div>
      ${shown.length ? [...groups].map(([file, ts]) => `<div class="tfile" title="${esc(file)}">${app.fileIcon(file)}<span>${esc(rel(file))}</span><span class="tcount">${ts.length}</span></div>
        ${ts.map((t) => `<div class="prob todo-row" tabindex="-1" data-tp="${esc(t.path)}" data-tl="${t.line}"><span class="todo-word todo-${t.word === "TODO" ? "todo" : "fix"}">${t.word}</span><span class="todo-text">${esc(t.text) || '<span class="hint">(nothing after it)</span>'}</span><span class="todo-at">${t.line + 1}</span></div>`).join("")}`).join("")
        : `<p class="hint" style="padding:10px">${S.root ? "No TODO, FIXME, HACK, XXX or BUG comments in this folder." : "Open a folder to see its TODO comments."}</p>`}`;
  }

  el?.addEventListener("click", (e) => {
    const f = e.target.closest("[data-tf]");
    if (f) { filter = f.dataset.tf; render(); return; }
    if (e.target.closest("[data-trefresh]")) { scan(); return; }
    const r = e.target.closest("[data-tp]");
    if (r) app.openFile(r.dataset.tp, { line: +r.dataset.tl, character: 0 });
  });
  el?.addEventListener("keydown", (e) => {
    const rows = [...el.querySelectorAll("[data-tp]")], i = rows.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus(); }
    else if (e.key === "Enter" && i >= 0) rows[i].click();
  });

  app.panelTabs.todo = {
    btn: "ptTodo", els: ["todo"],
    shown: () => { if (loadedFor !== S.root) scan(); else render(); },
    focus: () => (el.querySelector("[data-tp]") || el.querySelector(".btn"))?.focus(),
  };
  let timer = 0;
  app.saveHooks.push(() => { if (loadedFor) { clearTimeout(timer); timer = setTimeout(scan, 400); } });
  app.folderHooks?.push?.(() => { loadedFor = null; items = []; if (S.panel && S.ptab === "todo") scan(); });
  app.extraExt.push(() => todoTint);
  app.command("todo.show", "TODO: show the TODO comments in this folder", [], () => app.focusPanel("todo"));
}
