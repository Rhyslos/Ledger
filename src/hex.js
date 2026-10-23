// Hex view for binary files: offset, sixteen bytes in hex, and the same bytes as text. Files that
// aren't text open here instead of failing, and "Open as hex" shows any file this way. Only the
// rows on screen are drawn, so files of many megabytes scroll smoothly. Read-only.
const ROW = 16, ROW_H = 20;
// Chromium can't make an element taller than about 33 million pixels (1.7 million rows, 26 MB):
// past that the scrollbar stands for a scaled position, and rows are placed from it.
const MAX_H = 15_000_000;

const hex2 = (n) => n.toString(16).padStart(2, "0");
const printable = (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·");

export function initHex(app) {
  const { S, esc, base, invoke } = app;
  const el = document.getElementById("hexpage");
  const files = new Map(); // key -> { path, bytes, err, sel }
  let shown = null;
  const keyOf = (path) => "@hex:" + app.norm(path);
  const cur = () => files.get(shown);

  async function load(f) {
    try { f.bytes = new Uint8Array(await invoke("read_bytes", { path: f.path })); f.err = null; }
    catch (e) { f.err = String(e); }
  }
  async function openHex(path = S.active, opts = {}) {
    path = String(path || "").replace(/^@hex:/, "");
    if (!path || path.startsWith("@")) { app.toast("Open a file first."); return false; }
    const key = keyOf(path);
    if (!files.has(key)) { files.set(key, { path: app.norm(path), sel: -1 }); await load(files.get(key)); }
    app.addTab(key);
    if (!opts.background) app.activate(key);
    return true;
  }
  const size = (n) => (n < 1024 ? n + " bytes" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");

  function frame() {
    const f = cur();
    if (!f || !el) return;
    if (f.err) { el.innerHTML = `<p class="hint" style="padding:16px">Can't show ${esc(base(f.path))}: ${esc(f.err)}</p>`; return; }
    const n = f.bytes.length, rows = Math.ceil(n / ROW);
    el.innerHTML = `<div class="hex-view">
      <div class="img-bar">
        <b title="${esc(f.path)}">${esc(base(f.path))}</b>
        <span class="img-info">${size(n)} · binary, read-only</span>
        <span class="sp"></span>
        <span class="hex-at" aria-live="polite"></span>
        <input class="hex-go" placeholder="Go to offset (0x1F0 or 496)" aria-label="Go to offset" spellcheck="false">
      </div>
      <div class="hex-head"><span class="hex-off">Offset</span><span class="hex-bytes">${Array.from({ length: ROW }, (_, i) => hex2(i).toUpperCase()).join(" ")}</span><span class="hex-text">Text</span></div>
      <div class="hex-scroll" tabindex="0"><div class="hex-space" style="height:${Math.min(rows * ROW_H, MAX_H)}px"><div class="hex-rows"></div></div></div>
    </div>`;
    const sc = el.querySelector(".hex-scroll");
    sc.addEventListener("scroll", paint, { passive: true });
    paint();
    info();
  }
  // The end of the scrollbar has to reach the last row, so the scale leaves out one screen.
  const scale = (f, ch) => { const total = Math.ceil(f.bytes.length / ROW) * ROW_H; return total <= MAX_H ? 1 : (total - ch) / (MAX_H - ch); };
  function paint() {
    const f = cur(), sc = el?.querySelector(".hex-scroll");
    if (!f?.bytes || !sc) return;
    const ratio = scale(f, sc.clientHeight), top = sc.scrollTop * ratio; // where the view is in the full, unscaled list
    const first = Math.max(0, Math.floor(top / ROW_H) - 5), count = Math.ceil(sc.clientHeight / ROW_H) + 10;
    const out = [], b = f.bytes, digits = Math.max(8, b.length.toString(16).length);
    for (let r = first; r < Math.min(first + count, Math.ceil(b.length / ROW)); r++) {
      const o = r * ROW, hex = [], txt = [];
      for (let i = 0; i < ROW; i++) {
        const at = o + i;
        if (at >= b.length) { hex.push('<i class="hx-pad">  </i>'); continue; }
        const s = at === f.sel ? " hx-sel" : "";
        hex.push(`<i data-o="${at}" class="${b[at] === 0 ? "hx-0" : b[at] >= 0x20 && b[at] < 0x7f ? "hx-p" : "hx-b"}${s}">${hex2(b[at])}</i>`);
        txt.push(`<i data-o="${at}" class="${s.trim()}">${esc(printable(b[at]))}</i>`);
      }
      out.push(`<div class="hex-row" style="top:${sc.scrollTop + r * ROW_H - top}px"><span class="hex-off">${o.toString(16).padStart(digits, "0").toUpperCase()}</span><span class="hex-bytes">${hex.join(" ")}</span><span class="hex-text">${txt.join("")}</span></div>`);
    }
    el.querySelector(".hex-rows").innerHTML = out.join("");
  }
  function info() {
    const f = cur(), at = el?.querySelector(".hex-at");
    if (!f || !at) return;
    if (f.sel < 0 || f.sel >= (f.bytes?.length || 0)) { at.textContent = "Click a byte to see its offset and value"; return; }
    const v = f.bytes[f.sel];
    at.textContent = `Offset 0x${f.sel.toString(16).toUpperCase()} (${f.sel}) · 0x${hex2(v).toUpperCase()} = ${v}${v >= 0x20 && v < 0x7f ? ` “${String.fromCharCode(v)}”` : ""}`;
  }
  function select(o, scroll) {
    const f = cur();
    if (!f?.bytes) return;
    f.sel = Math.max(0, Math.min(f.bytes.length - 1, o));
    if (scroll) {
      const sc = el.querySelector(".hex-scroll"), ratio = scale(f, sc.clientHeight), y = Math.floor(f.sel / ROW) * ROW_H, top = sc.scrollTop * ratio;
      if (y < top || y > top + sc.clientHeight - ROW_H) sc.scrollTop = (y - sc.clientHeight / 3) / ratio;
    }
    paint(); info();
  }
  el?.addEventListener("mousedown", (e) => { const i = e.target.closest("[data-o]"); if (i) select(+i.dataset.o); });
  el?.addEventListener("mouseover", (e) => {
    const i = e.target.closest("[data-o]");
    el.querySelectorAll(".hx-hover").forEach((x) => x.classList.remove("hx-hover"));
    if (i) el.querySelectorAll(`[data-o="${i.dataset.o}"]`).forEach((x) => x.classList.add("hx-hover"));
  });
  el?.addEventListener("keydown", (e) => {
    const f = cur();
    if (!f?.bytes) return;
    if (e.target.matches(".hex-go")) {
      if (e.key === "Enter") { const v = e.target.value.trim(), o = /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10); if (!isNaN(o)) { select(o, true); el.querySelector(".hex-scroll").focus(); } }
      return;
    }
    const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -ROW, ArrowDown: ROW }[e.key];
    if (d && f.sel >= 0) { e.preventDefault(); select(f.sel + d, true); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); select(0, true); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); select(f.bytes.length - 1, true); }
  });
  app.saveHooks.push((path) => { const f = files.get(keyOf(path)); if (f) load(f).then(() => { if (shown === keyOf(path)) frame(); }); });

  app.pages.push({
    el,
    match: (k) => k.startsWith("@hex:"),
    render: (k) => {
      const again = shown === k;
      shown = k;
      const f = files.get(k);
      if (!f) { el.innerHTML = ""; return; }
      if (!f.bytes && !f.err) load(f).then(frame); else if (!again || !el.querySelector(".hex-scroll")) frame();
      if (!again) requestAnimationFrame(() => el.querySelector(".hex-scroll")?.focus({ preventScroll: true }));
    },
    label: (k) => base(files.get(k)?.path || k.slice(5)) + " · hex",
    dot: "other",
    focus: () => el.querySelector(".hex-scroll")?.focus({ preventScroll: true }),
    close: (k) => { files.delete(k); if (shown === k) shown = null; },
  });
  app.openers.push((path, opts) => (String(path).startsWith("@hex:") ? openHex(path, opts) : null));
  app.openHex = openHex;
  app.command("file.hex", "Open as hex (the file's bytes)", [], () => openHex(S.active?.startsWith("@") ? String(S.active).replace(/^@[a-z]+:/, "") : S.active));
}
