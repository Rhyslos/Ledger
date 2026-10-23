// Search in files (Ctrl Shift F): a side view with the query, Match case / Whole word / Regular
// expression, which files to look in and which to leave out, and Replace. Results stay until the
// next search, grouped by file with each match highlighted; click one to go there. Replace all
// changes open files in the editor (undo works, save when ready) and writes the others to disk.
// The search itself runs in the backend (search_files in lib.rs), on .gitignore'd folders too.

export function initSearch(app) {
  const { S, invoke, esc, rel, toast, norm } = app;
  const box = document.getElementById("search");
  const st = { q: "", repl: "", regex: false, kase: false, word: false, inc: "", exc: "", res: null, busy: false, err: "", showRepl: false, collapsed: new Set(), seq: 0 };
  try { Object.assign(st, JSON.parse(localStorage.getItem("ledger-search") || "{}"), { res: null, busy: false, err: "" }); st.collapsed = new Set(); } catch {}
  const remember = () => { try { localStorage.setItem("ledger-search", JSON.stringify({ q: st.q, repl: st.repl, regex: st.regex, kase: st.kase, word: st.word, inc: st.inc, exc: st.exc, showRepl: st.showRepl })); } catch {} };

  function draw(keepFocus) {
    if (!box) return;
    const focusId = keepFocus && box.contains(document.activeElement) ? document.activeElement.id : null;
    const caret = focusId ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const r = st.res;
    const groups = new Map();
    for (const h of r?.hits || []) { const p = norm(h.path); if (!groups.has(p)) groups.set(p, []); groups.get(p).push(h); }
    const toggle = (id, on, label, title) => `<button class="stog${on ? " on" : ""}" id="${id}" aria-pressed="${on}" title="${title}">${label}</button>`;
    box.innerHTML = `<div class="sform">
        <div class="srow1"><button class="ibtn sexp" id="srShowRepl" aria-expanded="${st.showRepl}" title="Replace">${st.showRepl ? "▾" : "▸"}</button>
          <div class="sinput"><input id="srQ" placeholder="Search" value="${esc(st.q)}" spellcheck="false" aria-label="Search in files">
            ${toggle("srCase", st.kase, "Aa", "Match case")}${toggle("srWord", st.word, "<u>ab</u>", "Whole word")}${toggle("srRe", st.regex, ".*", "Regular expression")}</div></div>
        ${st.showRepl ? `<div class="srow1"><span class="sexp"></span><div class="sinput"><input id="srR" placeholder="Replace" value="${esc(st.repl)}" spellcheck="false" aria-label="Replace with"><button class="btn" id="srAll" ${r?.hits?.length ? "" : "disabled"} title="Replace every match below">Replace all</button></div></div>` : ""}
        <input id="srInc" placeholder="Files to look in (e.g. src, *.ts)" value="${esc(st.inc)}" spellcheck="false" aria-label="Files to look in">
        <input id="srExc" placeholder="Files to leave out (e.g. dist, *.min.js)" value="${esc(st.exc)}" spellcheck="false" aria-label="Files to leave out">
      </div>
      <div class="ssum">${st.busy ? "Searching…" : st.err ? `<span class="bad">${esc(st.err)}</span>` : r ? (r.hits.length ? `${r.hits.length}${r.truncated ? "+" : ""} result${r.hits.length === 1 ? "" : "s"} in ${groups.size} file${groups.size === 1 ? "" : "s"}${r.truncated ? " (the first 5000)" : ""}` : "No results.") : S.root ? "" : "Open a folder to search in it."}</div>
      <div class="sres" role="tree">${[...groups].map(([p, hs]) => {
        const shut = st.collapsed.has(p);
        return `<div class="sfile${shut ? " shut" : ""}" data-sp="${esc(p)}" role="treeitem" aria-expanded="${!shut}" tabindex="-1" title="${esc(rel(p))}">${app.fileIcon(p)}<span class="lbl">${esc(app.base(p))}</span><span class="sub">${esc(rel(p).slice(0, -app.base(p).length).replace(/\/$/, ""))}</span><span class="tcount">${hs.length}</span></div>`
          + (shut ? "" : hs.map((h) => {
            const t = h.text, a = Math.max(0, h.col - 40);
            const pre = (a > 0 ? "…" : "") + t.slice(a, h.col).replace(/^\s+/, ""), mid = t.slice(h.col, h.col + h.len), post = t.slice(h.col + h.len, h.col + h.len + 120);
            return `<div class="shit" role="treeitem" tabindex="-1" data-sp="${esc(p)}" data-sl="${h.line}" data-sc="${h.col}" data-sn="${h.len}"><span class="sln">${h.line + 1}</span><span class="stx">${esc(pre)}<mark>${esc(mid)}</mark>${st.showRepl && st.repl !== "" ? `<ins>${esc(previewRepl(mid))}</ins>` : ""}${esc(post)}</span></div>`;
          }).join(""));
      }).join("")}</div>`;
    if (focusId) { const el = document.getElementById(focusId); el?.focus(); if (caret && el?.setSelectionRange) el.setSelectionRange(caret[0], caret[1]); }
  }

  function pattern() {
    let src = st.regex ? st.q : st.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (st.word) src = `\\b(?:${src})\\b`;
    return new RegExp(src, st.kase ? "g" : "gi");
  }
  function previewRepl(match) {
    try { return st.regex ? match.replace(new RegExp(pattern().source, pattern().flags.replace("g", "")), st.repl) : st.repl; } catch { return st.repl; }
  }

  let timer = 0;
  async function search() {
    clearTimeout(timer);
    remember();
    if (!S.root || !st.q) { st.res = null; st.err = ""; st.busy = false; draw(true); return; }
    const seq = ++st.seq;
    st.busy = true; st.err = ""; draw(true);
    try {
      const res = await invoke("search_files", { root: S.root, query: st.q, regex: st.regex, caseSensitive: st.kase, wholeWord: st.word, include: st.inc, exclude: st.exc });
      if (seq !== st.seq) return;
      st.res = withOpenFiles(res);
    } catch (e) { if (seq !== st.seq) return; st.err = String(e); st.res = null; }
    st.busy = false;
    draw(true);
  }
  // Files open with unsaved edits are searched as they are in the editor, not as on disk.
  const globRe = (list) => list.split(",").map((x) => x.trim().replace(/^\.\//, "")).filter(Boolean).map((g) => {
    const body = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
    return new RegExp((g.includes("/") ? "^" : "(^|/)") + body.replace(/^\//, "") + "(/|$)", "i");
  });
  function withOpenFiles(res) {
    const dirty = [...S.bufs].filter(([p, b]) => b.dirty && !b.virtual && app.isUnder(p, S.root));
    if (!dirty.length) return res;
    const inc = globRe(st.inc), exc = globRe(st.exc), re = pattern();
    const hits = res.hits.filter((h) => !dirty.some(([p]) => p === norm(h.path)));
    for (const [p, b] of dirty) {
      const r = rel(p);
      if ((inc.length && !inc.some((x) => x.test(r))) || exc.some((x) => x.test(r))) continue;
      for (let n = 1; n <= b.state.doc.lines; n++) {
        const text = b.state.doc.line(n).text;
        for (const m of text.matchAll(re)) if (m[0]) hits.push({ path: p, line: n - 1, col: m.index, len: m[0].length, text: text.slice(0, 400) });
      }
    }
    return { ...res, hits };
  }
  const soon = () => { clearTimeout(timer); timer = setTimeout(search, 250); };

  async function replaceAll() {
    const r = st.res;
    if (!r?.hits.length) return;
    const files = [...new Set(r.hits.map((h) => norm(h.path)))];
    const c = await app.choose(`Replace ${r.hits.length} match${r.hits.length === 1 ? "" : "es"} in ${files.length} file${files.length === 1 ? "" : "s"} with “${st.repl}”? Open files change in the editor (undo works); the others are saved right away.`, ["Replace all", "Cancel"]);
    if (c !== "Replace all") return;
    let re;
    try { re = pattern(); } catch (e) { toast(String(e)); return; }
    let done = 0, failed = 0;
    for (const p of files) {
      const b = S.bufs.get(p);
      if (b) {
        if (b.ro) continue;
        const text = b.state.doc.toString(), changes = [];
        for (const m of text.matchAll(re)) if (m[0]) changes.push({ from: m.index, to: m.index + m[0].length, insert: st.regex ? m[0].replace(new RegExp(re.source, re.flags.replace("g", "")), st.repl) : st.repl });
        if (changes.length) { app.dispatchBuf(p, { changes, userEvent: "input.replace" }); done += changes.length; }
        continue;
      }
      try {
        const f = await invoke("read_text", { path: p });
        let n = 0;
        const out = f.text.replace(re, (...m) => { n++; return st.regex ? m[0].replace(new RegExp(re.source, re.flags.replace("g", "")), st.repl) : st.repl; });
        if (n) { await invoke("write_file", { path: p, contents: out, encoding: f.encoding }); done += n; }
      } catch { failed++; }
    }
    toast(`Replaced ${done} match${done === 1 ? "" : "es"}${failed ? `; ${failed} file${failed === 1 ? "" : "s"} couldn't be changed` : ""}.`, 5000);
    app.reloadClean?.();
    search();
  }

  box?.addEventListener("input", (e) => {
    const id = e.target.id;
    if (id === "srQ") { st.q = e.target.value; soon(); }
    else if (id === "srR") { st.repl = e.target.value; remember(); draw(true); }
    else if (id === "srInc") { st.inc = e.target.value; soon(); }
    else if (id === "srExc") { st.exc = e.target.value; soon(); }
  });
  box?.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b?.id === "srCase") { st.kase = !st.kase; search(); return; }
    if (b?.id === "srWord") { st.word = !st.word; search(); return; }
    if (b?.id === "srRe") { st.regex = !st.regex; search(); return; }
    if (b?.id === "srShowRepl") { st.showRepl = !st.showRepl; remember(); draw(); if (st.showRepl) document.getElementById("srR")?.focus(); return; }
    if (b?.id === "srAll") { replaceAll(); return; }
    const f = e.target.closest(".sfile");
    if (f) { const p = f.dataset.sp; st.collapsed.has(p) ? st.collapsed.delete(p) : st.collapsed.add(p); draw(); return; }
    const h = e.target.closest(".shit");
    if (h) go(h);
  });
  function go(h) {
    const line = +h.dataset.sl, col = +h.dataset.sc, len = +h.dataset.sn;
    box.querySelectorAll(".shit.on").forEach((x) => x.classList.remove("on"));
    h.classList.add("on");
    app.openFile(h.dataset.sp, { line, character: col }, { keepFocus: true }).then(() => {
      const v = app.view, b = S.bufs.get(h.dataset.sp);
      if (!v || !b) return;
      const from = Math.min(v.state.doc.line(Math.min(line + 1, v.state.doc.lines)).from + col, v.state.doc.length);
      v.dispatch({ selection: { anchor: from, head: Math.min(from + len, v.state.doc.length) }, scrollIntoView: true });
    });
  }
  box?.addEventListener("keydown", (e) => {
    const k = app.keyString(e);
    if (e.target.matches("input")) {
      if (k === "Enter" && e.target.id !== "srR") { e.preventDefault(); search(); }
      else if (k === "Enter" && e.target.id === "srR") { e.preventDefault(); replaceAll(); }
      else if (k === "Down") { e.preventDefault(); box.querySelector(".shit, .sfile")?.focus(); }
      else if (k === "Esc") { e.preventDefault(); app.focusZone("editor"); }
      return;
    }
    const rows = [...box.querySelectorAll(".sfile, .shit")], i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    if (k === "Down" || k === "Up") { e.preventDefault(); const n = rows[i + (k === "Down" ? 1 : -1)]; if (n) n.focus(); else if (k === "Up") document.getElementById("srQ")?.focus(); }
    else if (k === "Enter" || k === "Space") { e.preventDefault(); rows[i].click(); }
    else if (k === "Esc") { e.preventDefault(); app.focusZone("editor"); }
  });

  app.sideViews.search = {
    btn: "vbSearch", el: "vSearch",
    render: () => draw(),
    focus: () => { const q = document.getElementById("srQ"); q?.focus(); q?.select(); },
  };
  app.folderHooks.push(() => { st.res = null; st.err = ""; if (app.sideView === "search") draw(); });
  app.command("search.files", "Search in files", "Ctrl+Shift+F", () => {
    const v = app.view;
    const sel = S.bufs.has(S.active) && v ? v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to).split("\n")[0] : "";
    if (sel) st.q = sel;
    app.showSideView("search", true);
    if (sel) search();
  });
  app.command("search.replace", "Replace in files", "Ctrl+Shift+H", () => { st.showRepl = true; app.showSideView("search", true); });
}
