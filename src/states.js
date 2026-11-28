// The States panel: while a Lust program runs from Ledger, each thing with a state of its own (by
// its variable or field name, and its class) and the option it's in now, updated as it changes,
// with the last few changes timed. The feed comes from `lust run` (LUST_STATES; states.rs in
// src-tauri reads it); statesfeed.js keeps the model.
//
// Ledger asks Lust for the states only once this panel has been opened in the window, so programs
// run at full speed for everyone who never looks. Run brings Output to the front as always; the
// States tab keeps up behind it.
import { on as listen } from "./win.js";
import { newStates, applyLines, shownThings, label, fmtTime, changeText, status } from "./statesfeed.js";

// How long a changed row stays tinted, fading out (ms).
const GLOW = 1400;

export function initStates(app) {
  const { S, esc } = app;
  const el = document.getElementById("states");
  // `watch`: the panel has been opened, so Lust runs are asked for their states.
  let watch = false;
  // The last Lust run: its id, whether it was asked, whether it's still going, whether the
  // last of its feed has been read.
  let cur = null;
  let m = newStates();
  const hot = new Map(); // id → when it last changed (performance.now())
  let timer = 0;

  const showing = () => S.panel && S.ptab === "states";
  function soon() {
    if (timer || !showing()) return;
    timer = setTimeout(() => { timer = 0; render(); }, 80);
  }

  function render() {
    if (!el) return;
    const st = status(m, { ran: !!cur, watching: !!cur?.asked, running: !!cur?.running, done: !!cur?.done });
    const now = performance.now();
    for (const [id, t] of hot) if (now - t > GLOW) hot.delete(id);
    const { list, more } = shownThings(m);
    const listed = m.started && cur?.asked;
    const row = (t) => {
      const h = hot.get(t.id);
      const glow = h != null ? ` st-hot" style="animation-delay:-${Math.round(now - h)}ms` : "";
      return `<div class="st-row${glow}" title="${esc(`${t.cls}${t.name ? " " + t.name : ""}: ${t.opt}, since ${fmtTime(t.at).slice(1)}`)}"><span class="st-name">${t.name ? esc(t.name) : `<span class="hint">${esc(label(t))}</span>`}</span><span class="st-cls">${esc(t.cls)}</span><span class="st-opt">${esc(t.opt)}</span></div>`;
    };
    const change = (c) => c.kind === "skipped"
      ? `<li class="st-skip"><span class="st-when">${fmtTime(c.ms)}</span><span class="st-what">${esc(changeText(c))}</span></li>`
      : `<li class="st-${c.kind}"><span class="st-when">${fmtTime(c.ms)}</span><span class="st-who">${esc(c.who)}</span><span class="st-what">${esc(changeText(c))}</span></li>`;
    el.innerHTML = `<div class="tbar"><span class="tsum st-sum${st.kind === "live" ? " st-live" : ""}">${esc(st.text)}</span><span class="sp"></span>${m.lust ? `<span class="hint">Lust ${esc(m.lust)}</span>` : ""}</div>
      ${listed ? `<div class="st-body">
        <section class="st-things" aria-label="Things and their states">
          ${list.length ? `<div class="st-row st-headrow" aria-hidden="true"><span>Name</span><span>Class</span><span>State</span></div>${list.map(row).join("")}${more ? `<p class="hint st-more">…and ${more.toLocaleString("en")} more</p>` : ""}` : ""}
        </section>
        <section class="st-changes" aria-label="Last changes">
          <div class="st-head">Last changes</div>
          ${m.changes.length ? `<ol>${m.changes.slice().reverse().map(change).join("")}</ol>` : `<p class="hint">None yet.</p>`}
        </section>
      </div>` : ""}`;
  }

  listen("states-lines", (e) => {
    if (!cur || e.payload.run !== cur.run) return;
    const changed = applyLines(m, e.payload.lines || []);
    const now = performance.now();
    for (const id of changed) hot.set(id, now);
    soon();
    if (changed.size) setTimeout(soon, GLOW + 50); // the tint goes, even with nothing else changing
  });
  listen("states-done", (e) => {
    if (!cur || e.payload.run !== cur.run) return;
    cur.done = true;
    soon();
  });
  app.taskDoneHooks.push(() => {
    if (!cur || cur.run !== S.run || !cur.running) return;
    cur.running = false;
    cur.done = true; // the feed's last lines (states-done) come before task-done
    soon();
  });

  app.panelTabs.states = {
    btn: "ptStates", els: ["states"],
    shown: () => { watch = true; render(); },
    focus: () => el?.focus(),
  };
  // The tab shows for Lust projects, and for as long as it has a run to show.
  const tab = () => { const b = document.getElementById("ptStates"); if (b) b.hidden = app.taskKind() !== "lust" && !cur; };
  app.activeHooks.push(tab);
  app.folderHooks?.push?.(() => { cur = null; m = newStates(); hot.clear(); tab(); if (showing()) render(); });
  tab();
  app.command("states.show", "States: show what state each thing in the running Lust program is in", [], () => { tab(); document.getElementById("ptStates").hidden = false; app.focusPanel("states"); });

  return {
    // Whether a Lust run should ask for its states.
    wants: () => watch,
    // A Lust run started: `asked` says whether it was asked for its states.
    started(run, asked) {
      cur = { run, asked, running: true, done: false };
      m = newStates();
      hot.clear();
      tab();
      if (showing()) render();
    },
  };
}
