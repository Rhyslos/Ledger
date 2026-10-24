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
    // Hover buttons on a file or a match: replace just that, or drop it from the list.
    const acts = (repl, drop) => `<span class="sacts">${st.showRepl ? `<span class="ga" data-sx="repl" title="${repl}" aria-hidden="true">⇄</span>` : ""}<span class="ga" data-sx="drop" title="${drop}" aria-hidden="true">×</span></span>`;
    const toggle = (id, on, label, title) => `<button class="stog${on ? " on" : ""}" id="${id}" aria-pressed="${on}" title="${title}">${label}</button>`;
    box.innerHTML = `<div class="sform">
        <div class="srow1"><button class="ibtn sexp" id="srShowRepl" aria-expanded="${st.showRepl}" title="Replace">${st.showRepl ? "▾" : "▸"}</button>
          <div class="sinput"><input id="srQ" placeholder="Search" value="${esc(st.q)}" spellcheck="false" aria-label="Search in files">
            ${toggle("srCase", st.kase, "Aa", "Match case (Alt C)")}${toggle("srWord", st.word, "<u>ab</u>", "Whole word (Alt W)")}${toggle("srRe", st.regex, ".*", "Regular expression (Alt R)")}</div></div>
        ${st.showRepl ? `<div class="srow1"><span class="sexp"></span><div class="sinput"><input id="srR" placeholder="Replace" value="${esc(st.repl)}" spellcheck="false" aria-label="Replace with"><button class="btn" id="srAll" ${r?.hits?.length ? "" : "disabled"} title="Replace every match below">Replace all</button></div></div>` : ""}
        <input id="srInc" placeholder="Files to look in (e.g. src, *.ts)" value="${esc(st.inc)}" spellcheck="false" aria-label="Files to look in">
        <input id="srExc" placeholder="Files to leave out (e.g. dist, *.min.js)" value="${esc(st.exc)}" spellcheck="false" aria-label="Files to leave out">
      </div>
      <div class="ssum">${st.busy ? "Searching…" : st.err ? `<span class="bad">${esc(st.err)}</span>` : r ? (r.hits.length ? `${r.hits.length}${r.truncated ? "+" : ""} result${r.hits.length === 1 ? "" : "s"} in ${groups.size} file${groups.size === 1 ? "" : "s"}${r.truncated ? " (the first 5000)" : ""}` : "No results.") : S.root ? "" : "Open a folder to search in it."}</div>
      <div class="sres" role="tree">${[...groups].map(([p, hs]) => {
        const shut = st.collapsed.has(p);
        return `<div class="sfile${shut ? " shut" : ""}" data-sp="${esc(p)}" role="treeitem" aria-expanded="${!shut}" tabindex="-1" title="${esc(rel(p))}">${app.fileIcon(p)}<span class="lbl">${esc(app.base(p))}</span><span class="sub">${esc(rel(p).slice(0, -app.base(p).length).replace(/\/$/, ""))}</span>${acts("Replace in this file", "Leave this file out of the results")}<span class="tcount">${hs.length}</span></div>`
          + (shut ? "" : hs.map((h) => {
            const t = h.text, a = Math.max(0, h.col - 40);
            const pre = (a > 0 ? "…" : "") + t.slice(a, h.col).replace(/^\s+/, ""), mid = t.slice(h.col, h.col + h.len), post = t.slice(h.col + h.len, h.col + h.len + 120);
            return `<div class="shit" role="treeitem" tabindex="-1" data-sp="${esc(p)}" data-sl="${h.line}" data-sc="${h.col}" data-sn="${h.len}">${acts("Replace this match", "Leave this match out")}<span class="sln">${h.line + 1}</span><span class="stx">${esc(pre)}<mark>${esc(mid)}</mark>${st.showRepl && st.repl !== "" ? `<ins>${esc(previewRepl(mid))}</ins>` : ""}${esc(post)}</span></div>`;
          }).join(""));
      }).join("")}</div>`;
    // The results are one Tab stop (arrows move inside), so the keyboard can reach them.
    const first = box.querySelector(".sres [tabindex]");
    if (first) first.tabIndex = 0;
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

  // Each hit's replacement: the pattern run again at exactly that spot in its line (so lookarounds
  // and anchors see the same line), and only there. Null when the match isn't there any more.
  function replacer() {
    const base = pattern(), re = new RegExp(base.source, base.flags.replace("g", "") + "y");
    return (line, h) => {
      if (!st.regex) { const t = line.substr(h.col, h.len); return (st.kase ? t === st.q : t.toLowerCase() === st.q.toLowerCase()) ? st.repl : null; }
      re.lastIndex = h.col;
      const m = re.exec(line);
      if (!m || m.index !== h.col || m[0].length !== h.len) return null;
      re.lastIndex = h.col;
      const out = line.replace(re, st.repl);
      return out.slice(h.col, h.col + out.length - line.length + h.len);
    };
  }
  // Replaces exactly the matches listed in the results, nothing the list didn't show: a pattern
  // like [^;]* can't run on past the end of its line.
  async function replaceAll(only) {
    const r = only ? { hits: only } : st.res;
    if (!r?.hits.length) return;
    const files = [...new Set(r.hits.map((h) => norm(h.path)))];
    const c = only ? "Replace all" : await app.choose(`Replace ${r.hits.length} match${r.hits.length === 1 ? "" : "es"} in ${files.length} file${files.length === 1 ? "" : "s"} with “${st.repl}”? Open files change in the editor (undo works); the others are saved right away, with their old text kept in Local history.`, ["Replace all", "Cancel"]);
    if (c !== "Replace all") return;
    let rep;
    try { rep = replacer(); } catch (e) { toast(String(e)); return; }
    let done = 0, failed = 0, moved = 0;
    const gone = new Map(); // replaced hit -> how much longer its line got
    for (const p of files) {
      const hits = r.hits.filter((h) => norm(h.path) === p).sort((a, b) => b.line - a.line || b.col - a.col); // right to left
      const b = S.bufs.get(p);
      if (b) {
        if (b.ro) continue;
        const doc = b.state.doc, changes = [];
        for (const h of hits) {
          if (h.line >= doc.lines) { moved++; continue; }
          const l = doc.line(h.line + 1), out = rep(l.text, h);
          if (out == null) { moved++; continue; }
          changes.push({ from: l.from + h.col, to: l.from + h.col + h.len, insert: out });
          gone.set(h, out.length - h.len);
        }
        if (changes.length) { app.dispatchBuf(p, { changes: changes.reverse(), userEvent: "input.replace" }); done += changes.length; }
        continue;
      }
      try {
        const f = await invoke("read_text", { path: p });
        const parts = f.text.split(/(\r?\n)/); // lines at even indexes, their endings between
        let n = 0;
        for (const h of hits) {
          const i = h.line * 2, line = parts[i];
          const out = line == null ? null : rep(line, h);
          if (out == null) { moved++; continue; }
          parts[i] = line.slice(0, h.col) + out + line.slice(h.col + h.len);
          gone.set(h, out.length - h.len);
          n++;
        }
        if (n) {
          await invoke("history_add", { path: p, text: f.text }).catch(() => {}); // so Local history can bring it back
          await invoke("write_file", { path: p, contents: parts.join(""), encoding: f.encoding });
          done += n;
        }
      } catch { failed++; }
    }
    toast(`Replaced ${done} match${done === 1 ? "" : "es"}${moved ? `; ${moved} weren't there any more and were left alone` : ""}${failed ? `; ${failed} file${failed === 1 ? "" : "s"} couldn't be changed` : ""}.`, 5000);
    app.reloadClean?.();
    // Like VS Code: what was replaced leaves the list (rather than searching again, which can
    // find the new text too), and matches after it on the same line move along.
    if (st.res) {
      const left = st.res.hits.filter((h) => !gone.has(h)).map((h) => {
        let col = h.col;
        for (const [g, d] of gone) if (norm(g.path) === norm(h.path) && g.line === h.line && g.col < h.col) col += d;
        return col === h.col ? h : { ...h, col };
      });
      st.res = { ...st.res, hits: left };
      draw();
    }
  }

  box?.addEventListener("input", (e) => {
    const id = e.target.id;
    if (id === "srQ") { st.q = e.target.value; soon(); }
    else if (id === "srR") {
      const had = st.repl !== "";
      st.repl = e.target.value; remember();
      // Only the previews change: update them in place rather than redrawing thousands of rows.
      if (had && st.repl !== "") for (const row of box.querySelectorAll(".shit")) { const ins = row.querySelector("ins"), m = row.querySelector("mark"); if (ins && m) ins.textContent = previewRepl(m.textContent); }
      else draw(true);
    }
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
    const x = e.target.closest("[data-sx]");
    if (x && st.res) {
      const row = x.closest(".sfile, .shit"), p = row.dataset.sp;
      const mine = row.matches(".sfile") ? (h) => norm(h.path) === p : (h) => norm(h.path) === p && h.line === +row.dataset.sl && h.col === +row.dataset.sc;
      const picked = st.res.hits.filter(mine);
      if (x.dataset.sx === "drop") { st.res = { ...st.res, hits: st.res.hits.filter((h) => !mine(h)) }; draw(); }
      else replaceAll(picked);
      return;
    }
    const f = e.target.closest(".sfile");
    if (f) { const p = f.dataset.sp; st.collapsed.has(p) ? st.collapsed.delete(p) : st.collapsed.add(p); draw(); return; }
    const h = e.target.closest(".shit");
    if (h) { go(h); if (e.detail >= 2) app.keepTab?.(h.dataset.sp); } // a double-click keeps the tab
  });
  function go(h) {
    const line = +h.dataset.sl, col = +h.dataset.sc, len = +h.dataset.sn;
    box.querySelectorAll(".shit.on").forEach((x) => x.classList.remove("on"));
    h.classList.add("on");
    app.openFile(h.dataset.sp, { line, character: col }, { keepFocus: true, preview: true }).then(() => {
      const v = app.view, b = S.bufs.get(h.dataset.sp);
      if (!v || !b) return;
      const from = Math.min(v.state.doc.line(Math.min(line + 1, v.state.doc.lines)).from + col, v.state.doc.length);
      v.dispatch({ selection: { anchor: from, head: Math.min(from + len, v.state.doc.length) }, scrollIntoView: true });
    });
  }
  box?.addEventListener("keydown", (e) => {
    const k = app.keyString(e);
    // The find bar's toggles: Alt C, Alt W, Alt R.
    const tog = { "Alt+C": "kase", "Alt+W": "word", "Alt+R": "regex" }[k];
    if (tog) { e.preventDefault(); st[tog] = !st[tog]; search(); return; }
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
  // Go to file passes what was typed there (Ctrl Shift F from Ctrl E).
  app.searchFor = (text) => { st.q = text; app.showSideView("search", true); draw(); search(); const q = document.getElementById("srQ"); q?.focus(); q?.setSelectionRange(text.length, text.length); };
  app.command("search.files", "Search in files", "Ctrl+Shift+F", () => {
    const v = app.view;
    const sel = S.bufs.has(S.active) && v ? v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to).split("\n")[0] : "";
    if (sel) st.q = sel;
    app.showSideView("search", true);
    if (sel) search();
  });
  app.command("search.replace", "Replace in files", "Ctrl+Shift+H", () => { st.showRepl = true; app.showSideView("search", true); });
}
