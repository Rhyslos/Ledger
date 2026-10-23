// Markdown preview: the rendered file beside its editor, in the same pane,
// updating as you type (Ctrl+Shift+V or the Preview button in the status
// bar). GitHub-flavoured Markdown via marked; everything goes through
// DOMPurify first, because a README from anywhere could carry scripts, and
// a script here could reach your files. Local images are loaded from disk,
// code blocks use Ledger's colours, and links open files or the browser.
import { marked } from "marked";
import DOMPurify from "dompurify";
import { EditorView } from "@codemirror/view";

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

export function initMarkdown(app) {
  const { S, invoke } = app;
  const on = new Set(); // markdown files with the preview open
  const images = new Map(); // absolute image path -> blob URL
  const prevs = app.panes.map((P) => {
    const d = document.createElement("div");
    d.className = "mdprev md";
    d.hidden = true;
    d.tabIndex = 0;
    P.el.append(d);
    return d;
  });

  // A status bar button while a Markdown file is in front.
  const btn = document.createElement("button");
  btn.id = "stMd";
  btn.hidden = true;
  btn.onclick = () => toggle();
  document.getElementById("stLive")?.before(btn);

  const isMd = (b) => b && !b.virtual && b.lang === "markdown";
  const showing = (i) => {
    const P = app.panes[i], b = P.key && S.bufs.get(P.key);
    return isMd(b) && on.has(P.key) && !P.host.hidden && (i === 0 || app.split) ? b : null;
  };

  function toggle(path = S.active) {
    if (/^@csv:|\.(csv|tsv|tab|psv)$/i.test(path || "") && app.csvTable) { app.csvTable(path); return; }
    if (!isMd(S.bufs.get(path))) { app.toast("Open a Markdown file to preview it."); return; }
    on.has(path) ? on.delete(path) : on.add(path);
    updateAll();
  }

  function updateAll() {
    app.panes.forEach((P, i) => {
      const b = showing(i);
      P.el.classList.toggle("md-on", !!b);
      prevs[i].hidden = !b;
      if (b) render(i, b, P);
    });
    const b = S.bufs.get(S.active);
    btn.hidden = !isMd(b);
    btn.textContent = on.has(S.active) ? "Hide preview" : "Preview";
    btn.title = "Markdown preview beside the editor (Ctrl+Shift+V)";
  }

  const dir = (p) => p.slice(0, p.lastIndexOf("/"));
  function resolve(base, href) {
    if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith("//")) return null; // a URL, not a file
    const parts = (href.startsWith("/") ? (S.root || "") + href : dir(base) + "/" + href).split("/");
    const out = [];
    for (const s of parts) { if (s === "..") out.pop(); else if (s !== "." && s !== "") out.push(s); }
    return (/^[A-Za-z]:$/.test(out[0]) ? "" : "/") + out.join("/");
  }
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const slug = (t) => t.toLowerCase().trim().replace(/[^\w\- ]+/g, "").replace(/\s/g, "-");

  function render(i, b, P) {
    const el = prevs[i];
    const html = DOMPurify.sanitize(marked.parse(b.state.doc.toString(), { gfm: true, breaks: false }), PURIFY);
    const top = el.scrollTop;
    el.innerHTML = html;
    el.dataset.path = P.key;
    const seen = new Map();
    for (const cb of el.querySelectorAll("input[type=checkbox]")) cb.disabled = true;
    for (const h of el.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      let id = "md-" + slug(h.textContent);
      const n = seen.get(id) || 0;
      seen.set(id, n + 1);
      if (n) id += "-" + n;
      h.id = id;
    }
    for (const code of el.querySelectorAll("pre > code")) {
      const lang = (code.className.match(/language-([\w#+-]+)/)?.[1] || "").toLowerCase();
      if (lang) app.highlightInto?.(code, code.textContent.replace(/\n$/, ""), lang);
    }
    for (const img of el.querySelectorAll("img[src]")) {
      const file = resolve(P.key, safeDecode(img.getAttribute("src")));
      if (!file) continue;
      img.removeAttribute("src");
      if (images.has(file)) { img.src = images.get(file); continue; }
      invoke("read_bytes", { path: file }).then((bytes) => {
        const type = /\.svg$/i.test(file) ? "image/svg+xml" : "";
        const url = URL.createObjectURL(new Blob([bytes], type ? { type } : {}));
        images.set(file, url);
        img.src = url;
      }, () => { img.alt = `(${img.alt || "image"} not found)`; });
    }
    el.scrollTop = top;
    follow(i, P);
  }

  // The preview follows the editor's scroll position.
  const followed = new WeakSet();
  function follow(i, P) {
    const sd = P.view?.scrollDOM;
    if (!sd || followed.has(sd)) return;
    followed.add(sd);
    sd.addEventListener("scroll", () => {
      const el = prevs[i];
      if (el.hidden) return;
      const r = sd.scrollTop / Math.max(1, sd.scrollHeight - sd.clientHeight);
      el.scrollTop = r * (el.scrollHeight - el.clientHeight);
    }, { passive: true });
  }

  prevs.forEach((el) => el.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (/^https?:/i.test(href)) return; // Ledger opens web links in the browser
    ev.preventDefault();
    if (href.startsWith("#")) { el.querySelector(`[id="md-${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({ block: "start" }); return; }
    const file = resolve(el.dataset.path, safeDecode(href.split("#")[0]));
    if (file) app.openFile(file);
  }));

  let t = null;
  app.extraExt.push((path) => EditorView.updateListener.of((u) => {
    if (!u.docChanged || !on.has(path)) return;
    clearTimeout(t);
    t = setTimeout(updateAll, 120);
  }));
  app.activeHooks.push(() => updateAll());
  app.saveHooks.push((path) => { if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path)) { const u = images.get(path); if (u) { URL.revokeObjectURL(u); images.delete(path); updateAll(); } } });
  app.command("markdown.preview", "Markdown: show or hide the preview", "Ctrl+Shift+V", () => toggle());
}
