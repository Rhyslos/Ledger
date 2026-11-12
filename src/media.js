// Media files in their own tab: audio (MP3, WAV, OGG, Opus, FLAC, M4A, AAC) with a waveform to
// click or drag through, video (MP4, WebM, MOV, OGV, MKV where the system can play it), and fonts
// (TTF, OTF, WOFF, WOFF2) as sample text. Audio keeps playing while you work in other tabs; the
// status bar shows what's playing (click it to go back). Space plays and pauses, ← and → skip 5
// seconds, L loops. Formats the system can't play offer your default app instead.
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";

export const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|flac|m4a|aac|weba)$/i;
export const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|mkv)$/i;
export const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
// Documents and archives Ledger doesn't show itself: a card with what it is and a button that opens
// it in the app your system uses (instead of a page of bytes).
export const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|epub|zip|7z|rar|tar|tgz|gz|bz2|xz)$/i;
const DOC_KIND = { pdf: "PDF document", doc: "Word document", docx: "Word document", xls: "Excel workbook", xlsx: "Excel workbook", ppt: "PowerPoint presentation", pptx: "PowerPoint presentation", odt: "OpenDocument text", ods: "OpenDocument spreadsheet", odp: "OpenDocument presentation", rtf: "Rich text document", epub: "E-book", zip: "ZIP archive", "7z": "7-Zip archive", rar: "RAR archive", tar: "Tar archive", tgz: "Compressed tar archive", gz: "Gzip archive", bz2: "Bzip2 archive", xz: "XZ archive" };
export const MEDIA_EXT = new RegExp(`(${[AUDIO_EXT, VIDEO_EXT, FONT_EXT].map((r) => r.source.slice(0, -1)).join("|")})$`, "i");
const MIME = {
  mp3: "audio/mpeg", wav: "audio/wav", wave: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", weba: "audio/webm",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg", mkv: "video/x-matroska",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
};
const PEAKS = 1600; // waveform columns, drawn to fit
const SAMPLE = "The quick brown fox jumps over the lazy dog";

/** "3:07", or "1:02:09" past an hour. */
export function clock(s) {
  if (!Number.isFinite(s) || s < 0) return "–:––";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Title, artist and album from an MP3's ID3v2 tag (v2.3 and v2.4), or {}. */
export function id3(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return {};
  const ver = b[3], syncsafe = (i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];
  const end = Math.min(b.length, 10 + syncsafe(6));
  const want = { TIT2: "title", TPE1: "artist", TALB: "album" }, out = {};
  let i = 10;
  if (b[5] & 0x40) i += ver === 4 ? syncsafe(10) : ((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) + 4; // extended header
  while (i + 10 <= end && b[i]) {
    const id = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    const size = ver === 4 ? syncsafe(i + 4) : (b[i + 4] << 24) | (b[i + 5] << 16) | (b[i + 6] << 8) | b[i + 7];
    if (size <= 0 || i + 10 + size > end) break;
    if (want[id]) {
      const enc = b[i + 10], body = b.subarray(i + 11, i + 10 + size);
      const label = enc === 1 || enc === 2 ? "utf-16" + (enc === 2 ? "be" : "") : enc === 3 ? "utf-8" : "latin1";
      const text = new TextDecoder(label).decode(body).replace(/\0+$/, "").split("\0")[0].replace(/^﻿/, "").trim();
      if (text) out[want[id]] = text;
    }
    i += 10 + size;
  }
  return out;
}

/** min/max pairs for each of n columns across all channels (values -1..1). */
export function peaks(channels, n = PEAKS) {
  const len = channels[0]?.length || 0, out = new Float32Array(n * 2);
  if (!len) return out;
  const per = len / n;
  for (let c = 0; c < n; c++) {
    const a = Math.floor(c * per), z = Math.max(a + 1, Math.floor((c + 1) * per));
    let lo = 0, hi = 0;
    // Long files: look at up to 2,000 samples per column, which is plenty for the picture.
    const stride = Math.max(1, Math.floor((z - a) / 2000));
    for (const ch of channels) for (let i = a; i < z && i < len; i += stride) { const v = ch[i]; if (v < lo) lo = v; else if (v > hi) hi = v; }
    out[c * 2] = lo; out[c * 2 + 1] = hi;
  }
  return out;
}

export function initMedia(app) {
  const { esc, invoke, base, S } = app;
  const el = document.getElementById("mediapage");
  const items = new Map(); // tab key -> { path, kind, url, size, err, node (audio/video), wave, info, tags, font }
  let shown = null;
  const keyOf = (path) => "@media:" + app.norm(path);
  const extOf = (p) => (p.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  const kindOf = (p) => (AUDIO_EXT.test(p) ? "audio" : VIDEO_EXT.test(p) ? "video" : FONT_EXT.test(p) ? "font" : "doc");
  const sizeText = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");

  // What's playing, in the status bar while you're elsewhere.
  const st = document.createElement("button");
  st.id = "stMedia";
  st.hidden = true;
  st.onclick = () => { const k = playingKey(); if (k) app.activate(k); };
  document.getElementById("stLive")?.before(st);
  const playingKey = () => [...items].find(([, it]) => it.node && !it.node.paused)?.[0];
  function status() {
    const k = playingKey(), it = k && items.get(k);
    st.hidden = !it || (S.active === k);
    if (!st.hidden) { st.textContent = `♪ ${it.tags?.title || base(it.path)} · ${clock(it.node.currentTime)}`; st.title = "Playing. Click to go to it."; }
  }
  setInterval(() => { if (playingKey() || !st.hidden) status(); }, 500);

const STREAM_AUDIO = 64 * 1024 * 1024; // bigger audio plays from disk, without a waveform

  /** A URL that plays the file straight from disk, a piece at a time (Tauri's asset protocol,
   *  allowed for media files only), or null where there's none (the browser test page). */
  const streamUrl = (path) => { try { return convertFileSrc(path); } catch { return null; } };

  async function load(it) {
    if (it.kind === "doc") {
      it.size = (await invoke("file_sizes", { paths: [it.path] }).catch(() => [null]))[0];
      it.err = it.size == null ? "That file isn't there any more." : null;
      return;
    }
    // Video, and very long audio: streamed, so any size plays and memory stays free.
    if (it.kind === "video" || it.kind === "audio") {
      const size = (await invoke("file_sizes", { paths: [it.path] }).catch(() => [null]))[0];
      const url = (it.kind === "video" || size > STREAM_AUDIO) && streamUrl(it.path);
      if (url) {
        if (it.url && !it.stream) URL.revokeObjectURL(it.url);
        Object.assign(it, { url, stream: true, size, err: size == null ? "That file isn't there any more." : null });
        if (it.kind === "audio") { it.tags = {}; it.wave = "none"; }
        if (it.node) { const t = it.node.currentTime; it.node.src = url; it.node.load(); it.node.currentTime = t; }
        return;
      }
    }
    try {
      const got = await invoke("read_bytes", { path: it.path });
      const bytes = got instanceof ArrayBuffer ? got : new Uint8Array(got).buffer;
      if (it.url && !it.stream) URL.revokeObjectURL(it.url);
      it.stream = false;
      it.size = bytes.byteLength;
      it.err = null;
      it.url = URL.createObjectURL(new Blob([bytes], { type: MIME[extOf(it.path)] || "application/octet-stream" }));
      if (it.kind === "audio") {
        it.tags = /mp3$/i.test(it.path) ? id3(bytes) : {};
        it.wave = null;
        decode(it, bytes);
      } else if (it.kind === "font") {
        it.family = "lg-font-" + Math.random().toString(36).slice(2);
        const face = new FontFace(it.family, bytes);
        await face.load();
        document.fonts.add(face);
        it.font = face;
      }
      if (it.node) { const t = it.node.currentTime; it.node.src = it.url; it.node.currentTime = t; }
    } catch (e) { it.err = String(e?.message || e); }
  }
  /** The waveform, worked out in the background; drawn when it's ready. */
  async function decode(it, bytes) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const buf = await ctx.decodeAudioData(bytes.slice(0));
      ctx.close?.();
      const ch = [];
      for (let i = 0; i < buf.numberOfChannels; i++) ch.push(buf.getChannelData(i));
      it.wave = peaks(ch);
      it.info = { rate: buf.sampleRate, channels: buf.numberOfChannels, duration: buf.duration };
    } catch { it.wave = "none"; }
    if (items.get(shown) === it) { drawInfo(it); drawWave(it); }
  }

  async function openMedia(path, opts = {}) {
    const key = keyOf(path);
    if (!items.has(key)) { const it = { path: app.norm(path), kind: kindOf(path) }; items.set(key, it); await load(it); }
    app.addTab(key);
    if (!opts.background) app.activate(key);
    return true;
  }

  function infoText(it) {
    const parts = [];
    const d = it.node?.duration || it.info?.duration;
    if (it.kind !== "font" && Number.isFinite(d)) parts.push(clock(d));
    if (it.kind === "video" && it.node?.videoWidth) parts.push(`${it.node.videoWidth} × ${it.node.videoHeight}`);
    if (it.info) {
      parts.push(`${(it.info.rate / 1000).toFixed(1).replace(/\.0$/, "")} kHz`, it.info.channels === 1 ? "mono" : it.info.channels === 2 ? "stereo" : it.info.channels + " channels");
      if (it.size && d) parts.push(`~${Math.round((it.size * 8) / d / 1000)} kbps`);
    }
    if (it.size != null) parts.push(sizeText(it.size));
    parts.push(extOf(it.path).toUpperCase());
    return parts.join(" · ");
  }
  const drawInfo = (it) => { const i = el.querySelector(".img-info"); if (i) i.textContent = infoText(it); };

  function draw() {
    const it = items.get(shown);
    if (!it) { el.innerHTML = ""; return; }
    const bar = `<div class="img-bar">
        <b title="${esc(it.path)}">${esc(base(it.path))}</b>
        <span class="img-info">${esc(infoText(it))}</span>
        <span class="sp"></span>
        ${it.kind === "audio" ? `<label class="chk" title="Play it again from the start when it ends (L)"><input type="checkbox" data-act="loop"${it.loop ? " checked" : ""}> Loop</label>
        <select class="btn" data-act="rate" title="Speed" aria-label="Speed">${[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => `<option value="${r}"${(it.rate || 1) === r ? " selected" : ""}>${r}×</option>`).join("")}</select>` : ""}
        ${it.kind === "doc" ? "" : `<button class="btn" data-act="system" title="Open it in the app your system uses for ${esc(extOf(it.path).toUpperCase())} files">Open in default app</button>`}
        <button class="btn" data-act="reload" title="Load the file again">Reload</button>
      </div>`;
    let stage;
    if (it.err) stage = `<div class="db-msg db-err">${esc(it.err)}</div>`;
    else if (it.kind === "doc") {
      const ext = extOf(it.path);
      stage = `<div class="media-doc">
        <div class="media-doc-icon">${app.fileIcon ? app.fileIcon(it.path) : ""}</div>
        <div class="media-title">${esc(base(it.path))}</div>
        <div class="media-sub">${esc(DOC_KIND[ext] || ext.toUpperCase() + " file")}${it.size != null ? " · " + sizeText(it.size) : ""}</div>
        <p class="media-keys">Ledger doesn't show this kind of file itself; the app your system uses for it does.</p>
        <div class="media-doc-acts">
          <button class="btn primary" data-act="system">Open in default app</button>
          <button class="btn" data-act="reveal">Show in File Explorer</button>
          <button class="btn" data-act="hex">Look at the bytes</button>
        </div>
      </div>`;
    }
    else if (it.kind === "font") {
      const sample = esc(it.sample ?? SAMPLE);
      stage = `<div class="media-font" style="font-family:'${it.family}'">
        <input class="media-sample" data-act="sample" value="${sample}" aria-label="Sample text" spellcheck="false" style="font-family:'${it.family}'">
        ${[12, 16, 24, 36, 48, 72].map((s) => `<div class="media-size"><span>${s}</span><p style="font-size:${s}px">${sample}</p></div>`).join("")}
        <p class="media-glyphs">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 !?&amp;@#%(){}[]&lt;&gt;=+-*/.,;:'"</p>
      </div>`;
    } else if (it.kind === "video") stage = `<div class="media-video"></div>`;
    else {
      const t = it.tags || {};
      stage = `<div class="media-audio">
        <div class="media-title">${esc(t.title || base(it.path).replace(/\.[^.]+$/, ""))}</div>
        <div class="media-sub">${esc([t.artist, t.album].filter(Boolean).join(" — "))}</div>
        <div class="media-wave" data-act="seek" title="Click or drag to move through it"><canvas></canvas><i class="media-head"></i></div>
        <div class="media-row">
          <button class="media-play" data-act="play" aria-label="Play"></button>
          <span class="media-time"></span>
          <span class="sp"></span>
          <label class="media-vol" title="Volume">Vol <input type="range" min="0" max="1" step="0.01" value="${it.volume ?? 1}" data-act="volume" aria-label="Volume"></label>
        </div>
        <p class="media-keys">Space plays and pauses · ← → skip 5 seconds · L loops · it keeps playing in other tabs</p>
      </div>`;
    }
    el.innerHTML = `<div class="img-view">${bar}<div class="img-stage media-stage" tabindex="0" aria-label="${esc(base(it.path))}">${stage}</div></div>`;
    if (!it.err && it.kind !== "font" && it.kind !== "doc") attach(it);
  }

  /** The <audio> or <video> stays the same element across redraws, so playback carries on. */
  function attach(it) {
    if (!it.node) {
      const n = document.createElement(it.kind);
      n.preload = "metadata";
      n.src = it.url;
      if (it.kind === "video") n.controls = true;
      n.addEventListener("loadedmetadata", () => { if (items.get(shown) === it) drawInfo(it); });
      n.addEventListener("timeupdate", () => tick(it));
      n.addEventListener("play", () => { for (const o of items.values()) if (o !== it && o.node && !o.node.paused) o.node.pause(); tick(it); status(); });
      n.addEventListener("pause", () => { tick(it); status(); });
      n.addEventListener("ended", () => { tick(it); status(); });
      n.addEventListener("error", () => {
        if (!it.url) return;
        it.err = `Ledger can't play this ${extOf(it.path).toUpperCase()} file: the system has no decoder for how it was encoded. "Open in default app" plays it in your usual player.`;
        it.node = null;
        if (items.get(shown) === it) draw();
      });
      it.node = n;
    }
    it.node.loop = !!it.loop;
    it.node.playbackRate = it.rate || 1;
    it.node.volume = it.volume ?? 1;
    if (it.kind === "video") el.querySelector(".media-video").append(it.node);
    else { drawWave(it); tick(it); }
  }

  function tick(it) {
    if (items.get(shown) !== it || it.kind !== "audio") return;
    const n = it.node, d = n?.duration;
    const t = el.querySelector(".media-time"), head = el.querySelector(".media-head"), play = el.querySelector(".media-play");
    if (t) t.textContent = `${clock(n?.currentTime || 0)} / ${clock(d)}`;
    if (play) { const on = n && !n.paused; play.classList.toggle("on", on); play.setAttribute("aria-label", on ? "Pause" : "Play"); play.title = on ? "Pause (Space)" : "Play (Space)"; }
    const frac = d ? n.currentTime / d : 0;
    if (head) head.style.left = frac * 100 + "%";
    if (it.wave && it.wave !== "none") paintWave(it, frac);
  }
  function drawWave(it) {
    const box = el.querySelector(".media-wave");
    if (!box) return;
    box.classList.toggle("flat", it.wave === "none");
    box.classList.toggle("waiting", !it.wave);
    paintWave(it, it.node?.duration ? it.node.currentTime / it.node.duration : 0);
  }
  function paintWave(it, frac) {
    const cv = el.querySelector(".media-wave canvas");
    if (!cv || !it.wave || it.wave === "none") return;
    const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const cs = getComputedStyle(cv), played = cs.getPropertyValue("--played").trim() || "#2f6db0", rest = cs.getPropertyValue("--rest").trim() || "#999";
    const cols = Math.max(1, Math.floor(w / 3)), mid = h / 2, n = it.wave.length / 2;
    for (let x = 0; x < cols; x++) {
      // Each 3-pixel column: the loudest of the peaks under it.
      const a = Math.floor((x / cols) * n), z = Math.max(a + 1, Math.floor(((x + 1) / cols) * n));
      let lo = 0, hi = 0;
      for (let i = a; i < z; i++) { lo = Math.min(lo, it.wave[i * 2]); hi = Math.max(hi, it.wave[i * 2 + 1]); }
      const top = mid - Math.max(1, hi * mid * 0.95), bot = mid - Math.min(-1, lo * mid * 0.95);
      c.fillStyle = (x + 0.5) / cols <= frac ? played : rest;
      c.fillRect(x * 3, top, 2, bot - top);
    }
  }

  const toggle = (it) => { if (!it?.node) return; if (it.node.paused) it.node.play().catch((e) => app.toast(String(e?.message || e))); else it.node.pause(); };
  const skip = (it, s) => { if (it?.node && Number.isFinite(it.node.duration)) it.node.currentTime = Math.min(it.node.duration, Math.max(0, it.node.currentTime + s)); };

  el.addEventListener("click", (ev) => {
    const it = items.get(shown);
    if (!it) return;
    const a = ev.target.closest("[data-act]")?.dataset.act;
    if (a === "play") toggle(it);
    else if (a === "loop") { it.loop = ev.target.checked; if (it.node) it.node.loop = it.loop; }
    else if (a === "system") openPath(it.path).catch((e) => app.toast("Couldn't open it: " + (e?.message || e)));
    else if (a === "reload") { it.wave = null; load(it).then(draw); }
    else if (a === "reveal") revealItemInDir(it.path).catch((e) => app.toast(String(e)));
    else if (a === "hex") app.openHex?.(it.path);
  });
  el.addEventListener("change", (ev) => {
    const it = items.get(shown);
    if (it && ev.target.dataset.act === "rate") { it.rate = Number(ev.target.value); if (it.node) it.node.playbackRate = it.rate; }
  });
  el.addEventListener("input", (ev) => {
    const it = items.get(shown);
    if (!it) return;
    if (ev.target.dataset.act === "volume") { it.volume = Number(ev.target.value); if (it.node) it.node.volume = it.volume; }
    if (ev.target.dataset.act === "sample") { it.sample = ev.target.value; for (const p of el.querySelectorAll(".media-size p")) p.textContent = it.sample; }
  });
  // Click or drag on the waveform to move through the track.
  el.addEventListener("mousedown", (ev) => {
    const box = ev.target.closest(".media-wave"), it = items.get(shown);
    if (!box || ev.button !== 0 || !it?.node) return;
    ev.preventDefault();
    const go = (e) => {
      const r = box.getBoundingClientRect(), d = it.node.duration;
      if (Number.isFinite(d)) it.node.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * d;
      tick(it);
    };
    go(ev);
    const up = () => { removeEventListener("mousemove", go); removeEventListener("mouseup", up); };
    addEventListener("mousemove", go);
    addEventListener("mouseup", up);
  });
  el.addEventListener("keydown", (ev) => {
    const it = items.get(shown);
    if (!it || it.kind === "font" || ev.ctrlKey || ev.altKey || ev.metaKey || ev.target.matches("input, select")) return;
    if (ev.key === " " || ev.key === "k") toggle(it);
    else if (ev.key === "ArrowLeft") skip(it, -5);
    else if (ev.key === "ArrowRight") skip(it, 5);
    else if (ev.key === "Home") { if (it.node) it.node.currentTime = 0; }
    else if ((ev.key === "l" || ev.key === "L") && it.kind === "audio") { it.loop = !it.loop; if (it.node) it.node.loop = it.loop; const cb = el.querySelector('[data-act="loop"]'); if (cb) cb.checked = it.loop; }
    else return;
    ev.preventDefault();
  });
  new ResizeObserver(() => { const it = items.get(shown); if (it?.kind === "audio") tick(it); }).observe(el);

  // A file Ledger writes or that changes on disk: load it again.
  app.saveHooks.push((path) => {
    const it = items.get(keyOf(path));
    if (it) load(it).then(() => { if (shown === keyOf(path)) draw(); });
  });

  app.pages.push({
    el,
    match: (k) => k.startsWith("@media:"),
    render: (k) => {
      const again = shown === k;
      shown = k;
      const it = items.get(k);
      if (!it) { el.innerHTML = ""; return; }
      if (!again || !el.firstChild) draw();
      status();
      if (!again) requestAnimationFrame(() => el.querySelector(".media-stage")?.focus({ preventScroll: true }));
    },
    label: (k) => base(items.get(k)?.path || k.slice(7)),
    dot: "img",
    focus: () => el.querySelector(".media-stage")?.focus({ preventScroll: true }),
    close: (k) => {
      const it = items.get(k);
      if (it) {
        it.node?.pause();
        if (it.node) it.node.src = "";
        if (it.font) document.fonts.delete(it.font);
        if (it.url && !it.stream) URL.revokeObjectURL(it.url);
      }
      items.delete(k);
      if (shown === k) shown = null;
      status();
    },
  });
  app.openers.push((path, opts) => {
    const p = String(path);
    if (p.startsWith("@media:")) return openMedia(p.slice(7), opts);
    if (!opts.asText && (MEDIA_EXT.test(p) || DOC_EXT.test(p)) && !p.startsWith("@")) return openMedia(p, opts);
    return null;
  });
  app.openMedia = openMedia;
  app.command("media.playPause", "Media: play or pause what's playing (or the media tab in front)", [], () => {
    const k = items.has(S.active) ? S.active : playingKey() || [...items.keys()].find((x) => items.get(x).node);
    toggle(items.get(k));
  }, { alias: "audio music sound mp3 pause" });
}
