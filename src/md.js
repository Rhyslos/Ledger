// Markdown preview: the rendered file, either instead of its editor (Ctrl+Shift+V, "Preview" in the
// status bar) or beside it (Ctrl+Alt+V), updating as you type. Settings › Editing › Markdown can open
// Markdown files either way. GitHub-flavoured Markdown via marked, plus footnotes and GitHub's
// > [!NOTE] alerts; everything goes through DOMPurify first, because a README from anywhere could
// carry scripts, and a script here could reach your files. Local images load from disk, code blocks
// use Ledger's colours, links open files or the browser, and the preview keeps to the editor's
// place (by source line, both ways). Double-click the preview to edit that spot.
import DOMPurify from "dompurify";
import { EditorView } from "@codemirror/view";
import { toHtml } from "./mdrender.js";

// The preview lives in Ledger's own page, so a README mustn't be able to restyle or cover the app:
// no <style>, style attributes, forms or buttons, class names only for code-block languages, and
// ids from the file are prefixed so they can't clash with Ledger's own.
const PURIFY = {
  ADD_ATTR: ["target"],
  FORBID_TAGS: ["style", "form", "button", "textarea", "select", "option", "iframe", "object", "embed", "dialog"],
  FORBID_ATTR: ["style"],
  SANITIZE_NAMED_PROPS: true,
};
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "class" && !/^language-[\w#+-]+$/.test(data.attrValue)) data.keepAttr = false;
});
DOMPurify.addHook("uponSanitizeElement", (node, data) => {
  // Task lists ([x] done) are the only inputs a preview needs: read-only checkboxes.
  if (data.tagName === "input" && node.getAttribute?.("type") !== "checkbox") node.parentNode?.removeChild(node);
});

// > [!NOTE] and friends, as GitHub shows them.
const ALERTS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };
function alerts(root) {
  for (const q of root.querySelectorAll("blockquote")) {
    const p = q.firstElementChild;
    if (p?.tagName !== "P") continue;
    const first = p.firstChild;
    const m = first?.nodeType === 3 && /^\s*\[!(note|tip|important|warning|caution)\][ \t]*\n?/i.exec(first.data);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    first.data = first.data.slice(m[0].length);
    if (p.firstChild?.nodeName === "BR") p.firstChild.remove();
    if (!p.textContent.trim() && !p.querySelector("img")) p.remove();
    q.classList.add("md-alert", "md-alert-" + kind);
    const title = document.createElement("p");
    title.className = "md-alert-title";
    title.textContent = ALERTS[kind];
    q.prepend(title);
  }
}

export function initMarkdown(app) {
  const { S, invoke, settings } = app;
  const mode = new Map(); // markdown file -> "only" (preview instead of the editor) or "side"
  const opened = new Set(); // files Settings › Markdown has had its say on
  const images = new Map(); // absolute image path -> blob URL
  const anchors = app.panes.map(() => []); // per pane: [{ line, el }] in order
  const prevs = app.panes.map((P, i) => {
    const d = document.createElement("div");
    d.className = "mdprev md";
    d.hidden = true;
    d.tabIndex = 0;
    P.el.append(d);
    d.addEventListener("scroll", () => fromPreview(i), { passive: true });
    d.addEventListener("dblclick", (e) => editAt(i, e));
    return d;
  });

  // Status bar: "Preview" (or "Edit") and "Side by side" while a Markdown file is in front.
  const btn = document.createElement("button");
  btn.id = "stMd";
  btn.hidden = true;
  btn.onclick = () => toggle(S.active, "only");
  const side = document.createElement("button");
  side.id = "stMdSide";
  side.hidden = true;
  side.onclick = () => toggle(S.active, "side");
  document.getElementById("stLive")?.before(btn, side);

  const isMd = (b) => b && !b.virtual && b.lang === "markdown";
  const paneShows = (i) => !app.panes[i].host.hidden && (i === 0 || app.split);
  const showing = (i) => {
    const P = app.panes[i], b = P.key && S.bufs.get(P.key);
    return isMd(b) && mode.has(P.key) && paneShows(i) ? b : null;
  };

  /** Preview only, or beside the editor; the same again goes back to just the editor. */
  function toggle(path = S.active, want = "only") {
    if (/^@csv:|\.(csv|tsv|tab|psv)$/i.test(path || "") && app.csvTable) { app.csvTable(path); return; }
    if (!isMd(S.bufs.get(path))) { app.toast("Open a Markdown file to preview it."); return; }
    const i = paneOf(path), was = mode.get(path);
    const line = i < 0 ? null : was === "only" ? previewLine(i) : editorLine(i);
    if (was === want) mode.delete(path); else mode.set(path, want);
    updateAll();
    if (i < 0 || line == null) return;
    // Keep your place across the switch.
    if (mode.get(path) === "only") toPreviewLine(i, line);
    else if (was === "only") { toEditorLine(i, line); if (!mode.has(path)) app.panes[i].view?.focus(); }
    else if (mode.has(path)) toPreviewLine(i, line);
  }
  const paneOf = (path) => app.panes.findIndex((P, i) => P.key === path && paneShows(i));

  function updateAll() {
    app.panes.forEach((P, i) => {
      const b = showing(i), m = b && mode.get(P.key);
      P.el.classList.toggle("md-on", !!b);
      P.el.classList.toggle("md-only", m === "only");
      prevs[i].hidden = !b;
      if (b) render(i, b, P);
    });
    const b = S.bufs.get(S.active), m = mode.get(S.active);
    btn.hidden = side.hidden = !isMd(b);
    btn.textContent = m === "only" ? "Edit" : "Preview";
    btn.title = m === "only" ? "Back to the Markdown source (Ctrl+Shift+V)" : "Show this file as it will look (Ctrl+Shift+V)";
    side.textContent = m === "side" ? "Close preview" : "Side by side";
    side.title = m === "side" ? "Just the editor again (Ctrl+Alt+V)" : "The editor and the preview next to each other (Ctrl+Alt+V)";
  }

  const dir = (p) => p.slice(0, p.lastIndexOf("/"));
  function resolve(base, href) {
    if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith("//")) return null; // a URL, not a file
    const parts = (href.startsWith("/") ? (S.root || "") + href : dir(base) + "/" + href).split("/");
    const out = [];
    for (const s of parts) { if (s === "..") out.pop(); else if (s !== "." && s !== "") out.push(s); }
    const unc = !href.startsWith("/") && base.startsWith("//"); // a network share keeps its //server
    return (unc ? "//" : /^[A-Za-z]:$/.test(out[0]) ? "" : "/") + out.join("/");
  }
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const slug = (t) => t.toLowerCase().trim().replace(/[^\w\- ]+/g, "").replace(/\s/g, "-");

  function render(i, b, P) {
    const el = prevs[i];
    const { html, lines } = toHtml(b.state.doc.toString());
    const top = el.scrollTop;
    el.innerHTML = DOMPurify.sanitize(html, PURIFY);
    el.dataset.path = P.key;

    // Which element each source block became, for keeping the two sides level.
    const tpl = document.createElement("template");
    const list = [];
    let k = 0;
    const kids = el.children;
    for (const ln of lines) {
      let n = ln.count;
      if (n == null) { tpl.innerHTML = DOMPurify.sanitize(ln.raw, PURIFY); n = tpl.content.children.length; }
      for (let j = 0; j < n && k < kids.length; j++, k++) if (j === 0) list.push({ line: ln.line, el: kids[k] });
    }
    anchors[i] = list;

    const seen = new Map();
    for (const cb of el.querySelectorAll("input[type=checkbox]")) { cb.disabled = true; cb.closest("li")?.classList.add("md-task"); }
    for (const h of el.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      let id = "md-" + slug(h.textContent);
      const n = seen.get(id) || 0;
      seen.set(id, n + 1);
      if (n) id += "-" + n;
      h.id = id;
    }
    el.querySelector("section[data-footnotes]")?.classList.add("md-footnotes");
    alerts(el);
    for (const code of el.querySelectorAll("pre > code")) {
      const lang = (code.className.match(/language-([\w#+-]+)/)?.[1] || "").toLowerCase();
      const text = code.textContent.replace(/\n$/, "");
      if (lang) app.highlightInto?.(code, text, lang);
      const copy = document.createElement("button");
      copy.className = "md-copy";
      copy.type = "button";
      copy.textContent = "Copy";
      copy.title = "Copy this code";
      copy.onclick = () => app.copy?.(text);
      code.parentElement.append(copy);
    }
    for (const img of el.querySelectorAll("img[src]")) {
      const file = resolve(P.key, safeDecode(img.getAttribute("src")));
      if (!file) { img.onerror = () => { img.alt = `(${img.alt || "image"} didn't load)`; img.classList.add("md-broken"); }; continue; }
      img.removeAttribute("src");
      if (images.has(file)) { img.src = images.get(file); continue; }
      invoke("read_bytes", { path: file }).then((bytes) => {
        const type = /\.svg$/i.test(file) ? "image/svg+xml" : "";
        const url = URL.createObjectURL(new Blob([bytes], type ? { type } : {}));
        images.set(file, url);
        // Keep the 100 images used last; the rest give their memory back.
        while (images.size > 100) { const [k2, u] = images.entries().next().value; URL.revokeObjectURL(u); images.delete(k2); }
        img.src = url;
      }, () => { img.alt = `(${img.alt || "image"} not found)`; img.classList.add("md-broken"); });
    }
    el.scrollTop = top;
    follow(i, P);
  }

  // ----- keeping the editor and the preview level, by source line -----
  const quiet = app.panes.map(() => ({ editor: 0, preview: 0 })); // ignore the scroll we caused
  const yOf = (el, root) => el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;

  /** The (fractional) source line at the top of the editor. */
  function editorLine(i) {
    const v = app.panes[i].view;
    if (!v) return null;
    const sd = v.scrollDOM;
    const h = sd.getBoundingClientRect().top - v.documentTop; // the scroller's top, in document heights
    const blk = v.lineBlockAtHeight(Math.max(0, h));
    return v.state.doc.lineAt(blk.from).number + Math.max(0, Math.min(1, (h - blk.top) / Math.max(1, blk.height)));
  }
  function toEditorLine(i, line) {
    const v = app.panes[i].view;
    if (!v) return;
    const doc = v.state.doc, n = Math.min(doc.lines, Math.max(1, Math.floor(line)));
    const blk = v.lineBlockAt(doc.line(n).from);
    const pad = v.documentTop - v.scrollDOM.getBoundingClientRect().top + v.scrollDOM.scrollTop;
    quiet[i].editor = performance.now();
    v.scrollDOM.scrollTop = blk.top + (line - n) * blk.height + pad;
  }
  /** The (fractional) source line at the top of the preview. */
  function previewLine(i) {
    const el = prevs[i], list = anchors[i];
    if (!list.length) return 1;
    const y = el.scrollTop + 1;
    let a = 0;
    while (a + 1 < list.length && yOf(list[a + 1].el, el) <= y) a++;
    const cur = list[a], next = list[a + 1];
    const y0 = yOf(cur.el, el), y1 = next ? yOf(next.el, el) : el.scrollHeight;
    const l1 = next ? next.line : app.panes[i].view?.state.doc.lines + 1 || cur.line + 1;
    return cur.line + Math.max(0, Math.min(1, (y - y0) / Math.max(1, y1 - y0))) * (l1 - cur.line);
  }
  function toPreviewLine(i, line) {
    const el = prevs[i], list = anchors[i];
    if (!list.length || el.hidden) return;
    let a = 0;
    while (a + 1 < list.length && list[a + 1].line <= line) a++;
    const cur = list[a], next = list[a + 1];
    let y;
    if (line < cur.line) y = 0;
    else {
      const y0 = yOf(cur.el, el), y1 = next ? yOf(next.el, el) : el.scrollHeight - el.clientHeight;
      const l1 = next ? next.line : (app.panes[i].view?.state.doc.lines || cur.line) + 1;
      y = y0 + ((line - cur.line) / Math.max(1, l1 - cur.line)) * (y1 - y0);
    }
    quiet[i].preview = performance.now();
    el.scrollTop = Math.max(0, y - parseFloat(getComputedStyle(el).paddingTop || 0));
  }

  const followed = new WeakSet();
  function follow(i, P) {
    const sd = P.view?.scrollDOM;
    if (!sd || followed.has(sd)) return;
    followed.add(sd);
    sd.addEventListener("scroll", () => {
      const key = app.panes[i].key;
      if (prevs[i].hidden || mode.get(key) !== "side" || performance.now() - quiet[i].editor < 120) return;
      // At the very end, the preview is at its end too.
      if (sd.scrollTop + sd.clientHeight >= sd.scrollHeight - 2) { quiet[i].preview = performance.now(); prevs[i].scrollTop = prevs[i].scrollHeight; return; }
      const line = editorLine(i);
      if (line != null) toPreviewLine(i, line);
    }, { passive: true });
  }
  function fromPreview(i) {
    if (mode.get(app.panes[i].key) !== "side" || performance.now() - quiet[i].preview < 120) return;
    toEditorLine(i, previewLine(i));
  }

  /** Double-click the preview: edit that spot (the preview stays open beside the editor if it was). */
  function editAt(i, e) {
    if (e.target.closest("a, button, input, summary")) return;
    const el = prevs[i], list = anchors[i], P = app.panes[i];
    const y = yOf(e.target.nodeType === 1 ? e.target : e.target.parentElement, el);
    let a = -1;
    while (a + 1 < list.length && yOf(list[a + 1].el, el) <= y + 1) a++;
    const line = a >= 0 ? list[a].line : 1;
    if (mode.get(P.key) === "only") toggle(P.key, "only");
    const v = P.view;
    if (!v) return;
    const pos = v.state.doc.line(Math.min(v.state.doc.lines, line)).from;
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 40 }) });
    v.focus();
  }

  prevs.forEach((el) => el.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (/^https?:/i.test(href)) return; // Ledger opens web links in the browser
    ev.preventDefault();
    if (href.startsWith("#")) {
      const id = CSS.escape(safeDecode(href.slice(1)));
      el.querySelector(`[id="md-${id}"], [id="user-content-${id}"], [id="${id}"]`)?.scrollIntoView({ block: "start" });
      return;
    }
    const file = resolve(el.dataset.path, safeDecode(href.split("#")[0]));
    if (file) app.openFile(file);
  }));

  let t = null;
  app.extraExt.push((path) => EditorView.updateListener.of((u) => {
    if (!u.docChanged || !mode.has(path)) return;
    clearTimeout(t);
    t = setTimeout(updateAll, 120);
  }));
  app.activeHooks.push((key) => {
    // Settings › Markdown: how a Markdown file opens, the first time it comes to the front.
    const b = S.bufs.get(key);
    if (isMd(b) && !opened.has(key)) {
      opened.add(key);
      const want = settings.markdownOpen === "preview" ? "only" : settings.markdownOpen === "side" ? "side" : null;
      if (want && !mode.has(key)) mode.set(key, want);
    }
    updateAll();
  });
  app.saveHooks.push((path) => { if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path)) { const u = images.get(path); if (u) { URL.revokeObjectURL(u); images.delete(path); updateAll(); } } });
  app.command("markdown.preview", "Markdown: show the preview instead of the source (or the source again)", "Ctrl+Shift+V", () => toggle(S.active, "only"));
  app.command("markdown.previewSide", "Markdown: show the preview beside the source", "Ctrl+Alt+V", () => toggle(S.active, "side"), { alias: "split side by side" });
}
