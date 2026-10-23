// Image viewer: PNG, JPEG, GIF (animated), WebP, SVG, AVIF, BMP and ICO open in
// their own tab. Fit to the window or zoom (Ctrl+wheel, + and -, 0 for fit,
// 1 for actual size, or click the image), a checkerboard behind transparent
// parts, and a pixel-art mode that keeps sprites sharp when zoomed in.
// SVGs can also be opened as code; saving that code refreshes the preview.

export const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|apng|jfif)$/i;
const MIME = { png: "image/png", apng: "image/apng", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon" };
const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

export function initImages(app) {
  const { esc, invoke, base } = app;
  const el = document.getElementById("imgpage");
  const imgs = new Map(); // tab key -> { path, url, size, w, h, zoom ("fit" or a number), err }
  let shown = null;

  const keyOf = (path) => "@img:" + app.norm(path);
  const extOf = (p) => (p.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  const cur = () => imgs.get(shown);
  const pixel = () => app.prefs.imgPixel === true;

  async function load(im) {
    try {
      const bytes = await invoke("read_bytes", { path: im.path });
      if (im.url) URL.revokeObjectURL(im.url);
      im.url = URL.createObjectURL(new Blob([bytes], { type: MIME[extOf(im.path)] || "application/octet-stream" }));
      im.size = bytes.byteLength;
      im.err = null;
    } catch (e) { im.err = String(e); }
  }

  async function openImage(path, opts = {}) {
    const key = keyOf(path);
    if (!imgs.has(key)) { imgs.set(key, { path: app.norm(path), zoom: "fit" }); await load(imgs.get(key)); }
    app.addTab(key);
    if (!opts.background) app.activate(key);
    return true;
  }

  function sizeText(n) {
    return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
  }

  function draw() {
    const im = cur();
    if (!im) return;
    const svg = extOf(im.path) === "svg";
    const z = im.zoom === "fit" ? "" : Math.round(im.zoom * 100) + "%"; // Fit: filled in with the size it ends up at
    el.innerHTML = `<div class="img-view">
      <div class="img-bar">
        <b title="${esc(im.path)}">${esc(base(im.path))}</b>
        <span class="img-info">${im.w ? `${im.w} × ${im.h} px · ` : ""}${im.size != null ? sizeText(im.size) : ""} · ${esc(extOf(im.path).toUpperCase())}</span>
        <span class="sp"></span>
        <button class="btn" data-act="out" title="Zoom out (-)" aria-label="Zoom out">−</button>
        <span class="img-zoom">${z}</span>
        <button class="btn" data-act="in" title="Zoom in (+)" aria-label="Zoom in">+</button>
        <button class="btn${im.zoom === "fit" ? " primary" : ""}" data-act="fit" title="Fit to the window (0)">Fit</button>
        <button class="btn${im.zoom === 1 ? " primary" : ""}" data-act="actual" title="Actual size (1)">1:1</button>
        <label class="chk" title="Keep pixels sharp when zoomed in, for pixel art and sprites"><input type="checkbox" data-act="pixel"${pixel() ? " checked" : ""}> Pixel art</label>
        ${svg ? `<button class="btn" data-act="code">Edit code</button>` : ""}
        <button class="btn" data-act="reload" title="Load the file again">Reload</button>
      </div>
      <div class="img-stage" tabindex="0" aria-label="${esc(base(im.path))}">${im.err
        ? `<div class="db-msg db-err">${esc(im.err)}</div>`
        : `<img class="img-img${im.zoom === "fit" ? " fit" : ""}${pixel() ? " pixel" : ""}" src="${im.url}" alt="${esc(base(im.path))}" draggable="false"${im.zoom !== "fit" && im.w ? ` style="width:${im.w * im.zoom}px;height:${im.h * im.zoom}px"` : ""}>`}
      </div>
    </div>`;
    const img = el.querySelector(".img-img");
    // In Fit, show the size it actually ends up at.
    const label = () => { const zl = el.querySelector(".img-zoom"); if (zl && img && im.zoom === "fit" && im.w && img.clientWidth) zl.textContent = Math.round((img.clientWidth / im.w) * 100) + "%"; };
    requestAnimationFrame(label);
    if (img) img.onload = () => {
      if (im.w === img.naturalWidth && im.h === img.naturalHeight) return;
      im.w = img.naturalWidth; im.h = img.naturalHeight;
      draw();
    };
  }

  function setZoom(im, z, anchor) {
    const stage = el.querySelector(".img-stage"), img = el.querySelector(".img-img");
    // Keep the point under the mouse (or the middle) in place while zooming.
    let fx = 0.5, fy = 0.5, px = stage.clientWidth / 2, py = stage.clientHeight / 2;
    if (img && anchor) {
      const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
      fx = (anchor.x - r.left) / r.width; fy = (anchor.y - r.top) / r.height;
      px = anchor.x - s.left; py = anchor.y - s.top;
    }
    im.zoom = z;
    draw();
    if (z === "fit") return;
    const st = el.querySelector(".img-stage"), ni = el.querySelector(".img-img");
    if (!ni) return;
    st.scrollLeft = ni.offsetLeft + fx * ni.offsetWidth - px;
    st.scrollTop = ni.offsetTop + fy * ni.offsetHeight - py;
    st.focus({ preventScroll: true });
  }
  const shownZoom = (im) => {
    if (im.zoom !== "fit") return im.zoom;
    const img = el.querySelector(".img-img");
    return img && im.w ? img.clientWidth / im.w : 1;
  };
  const step = (im, dir, anchor) => {
    const z = shownZoom(im);
    const next = dir > 0 ? STEPS.find((s) => s > z + 1e-6) ?? STEPS.at(-1) : [...STEPS].reverse().find((s) => s < z - 1e-6) ?? STEPS[0];
    setZoom(im, next, anchor);
  };

  el.addEventListener("click", (ev) => {
    const im = cur();
    if (!im) return;
    const a = ev.target.closest("[data-act]")?.dataset.act;
    if (a === "in") step(im, 1);
    else if (a === "out") step(im, -1);
    else if (a === "fit") setZoom(im, "fit");
    else if (a === "actual") setZoom(im, 1);
    else if (a === "pixel") { app.prefs.imgPixel = ev.target.checked; app.savePrefs(); draw(); }
    else if (a === "code") app.openFile(im.path, null, { asText: true });
    else if (a === "reload") load(im).then(draw);
    else if (ev.target.matches(".img-img")) setZoom(im, im.zoom === "fit" ? 1 : "fit", { x: ev.clientX, y: ev.clientY });
  });
  el.addEventListener("wheel", (ev) => {
    const im = cur();
    if (!im || !(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    step(im, ev.deltaY < 0 ? 1 : -1, { x: ev.clientX, y: ev.clientY });
  }, { passive: false });
  el.addEventListener("keydown", (ev) => {
    const im = cur();
    if (!im || ev.ctrlKey || ev.altKey || ev.metaKey || ev.target.matches("input")) return;
    const k = ev.key;
    if (k === "+" || k === "=") step(im, 1);
    else if (k === "-") step(im, -1);
    else if (k === "0") setZoom(im, "fit");
    else if (k === "1") setZoom(im, 1);
    else return;
    ev.preventDefault();
  });

  // Saving an SVG's code (or any image Ledger writes) refreshes its preview.
  app.saveHooks.push((path) => {
    const im = imgs.get(keyOf(path));
    if (im) load(im).then(() => { if (shown === keyOf(path)) draw(); });
  });

  app.pages.push({
    el,
    match: (k) => k.startsWith("@img:"),
    render: (k) => {
      const again = shown === k;
      shown = k;
      const im = imgs.get(k);
      if (!im) { el.innerHTML = ""; return; }
      if (!im.url && !im.err) load(im).then(draw); else draw();
      if (!again) requestAnimationFrame(() => el.querySelector(".img-stage")?.focus({ preventScroll: true }));
    },
    label: (k) => base(imgs.get(k)?.path || k.slice(5)),
    dot: "img",
    focus: () => el.querySelector(".img-stage")?.focus({ preventScroll: true }),
    close: (k) => { const im = imgs.get(k); if (im?.url) URL.revokeObjectURL(im.url); imgs.delete(k); if (shown === k) shown = null; },
  });
  app.openImage = openImage;
}
