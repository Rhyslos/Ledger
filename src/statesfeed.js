// The States panel's model: what `lust run` says about each thing with a state of its own (Lust's
// states feed, one JSON object per line), kept as the things still going and the last few changes.
// No page or Tauri here, so the tests can run it.
//
// The lines, as Lust 2.0.0-alpha.101 writes them (version 1):
//   {"ev":"start","v":1,"lust":"2.0.0-alpha.101"}
//   {"ev":"made","ms":3,"id":1,"class":"Hero","name":"scout","opt":"Calm"}   (name only when known)
//   {"ev":"set","ms":1240,"id":1,"from":"Calm","opt":"Battle.Melee"}
//   {"ev":"end","ms":2210,"id":1,"how":"state"}       ("state": ended with its owner's state; "gone": let go)
//   {"ev":"skipped","ms":2250,"n":4180}             (too many changes to list one by one)
//   {"ev":"stop","ms":3000}

export const FEED_VERSION = 1;
// Changes listed, newest first.
export const KEEP_CHANGES = 12;
// Things listed; past this many, the panel says how many more there are.
export const SHOW_THINGS = 500;

export function newStates() {
  return { started: false, stopped: false, lust: "", newer: false, things: new Map(), changes: [], ms: 0, skipped: 0, made: 0 };
}

// One line of the feed as an event, or null for one Ledger can't read (a broken or unknown line
// is left out, never an error).
export function parseLine(text) {
  if (typeof text !== "string" || !text.startsWith("{")) return null;
  let ev;
  try { ev = JSON.parse(text); } catch { return null; }
  if (!ev || typeof ev !== "object" || typeof ev.ev !== "string") return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const str = (v) => (typeof v === "string" ? v : null);
  const ms = num(ev.ms) ?? 0;
  switch (ev.ev) {
    case "start": return { ev: "start", v: num(ev.v) ?? 0, lust: str(ev.lust) ?? "" };
    case "made": {
      const id = num(ev.id), cls = str(ev.class), opt = str(ev.opt);
      return id == null || cls == null || opt == null ? null : { ev: "made", ms, id, cls, name: str(ev.name) || "", opt };
    }
    case "set": {
      const id = num(ev.id), opt = str(ev.opt);
      return id == null || opt == null ? null : { ev: "set", ms, id, from: str(ev.from) ?? "", opt };
    }
    case "end": {
      const id = num(ev.id);
      return id == null ? null : { ev: "end", ms, id, how: ev.how === "state" ? "state" : "gone" };
    }
    case "skipped": return { ev: "skipped", ms, n: num(ev.n) ?? 0 };
    case "stop": return { ev: "stop", ms };
    default: return null;
  }
}

// Applies one event. Gives back the id of the thing it changed, if any (the panel tints its row).
export function apply(m, e) {
  if (!e) return null;
  if (e.ms > m.ms) m.ms = e.ms;
  const note = (c) => { m.changes.push(c); if (m.changes.length > KEEP_CHANGES) m.changes.splice(0, m.changes.length - KEEP_CHANGES); };
  switch (e.ev) {
    case "start":
      m.started = true; m.lust = e.lust; m.newer = e.v > FEED_VERSION;
      return null;
    case "made": {
      const t = { id: e.id, cls: e.cls, name: e.name, opt: e.opt, at: e.ms };
      m.things.set(e.id, t);
      m.made++;
      note({ ms: e.ms, id: e.id, who: label(t), kind: "made", opt: e.opt });
      return e.id;
    }
    case "set": {
      const t = m.things.get(e.id);
      if (!t) return null;
      const from = e.from || t.opt;
      t.opt = e.opt; t.at = e.ms;
      note({ ms: e.ms, id: e.id, who: label(t), kind: "set", from, opt: e.opt });
      return e.id;
    }
    case "end": {
      const t = m.things.get(e.id);
      if (!t) return null;
      m.things.delete(e.id);
      note({ ms: e.ms, id: e.id, who: label(t), kind: "end", how: e.how, opt: t.opt });
      return null;
    }
    case "skipped":
      m.skipped += e.n;
      if (e.n > 0) note({ ms: e.ms, kind: "skipped", n: e.n });
      return null;
    case "stop":
      m.stopped = true;
      return null;
  }
  return null;
}

// Applies a batch of lines. Gives back the ids that changed.
export function applyLines(m, lines) {
  const changed = new Set();
  for (const l of lines) { const id = apply(m, parseLine(l)); if (id != null) changed.add(id); }
  return changed;
}

// What the panel calls a thing: its variable or field name, or its class and number.
export function label(t) {
  return t.name || `${t.cls} ${t.id}`;
}

// The time since the program started: +0.05s, +1.24s, +12.3s, +2:05.1.
export function fmtTime(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `+${s.toFixed(2)}s`;
  if (s < 60) return `+${s.toFixed(1)}s`;
  const min = Math.floor(s / 60), rest = s - min * 60;
  return `+${min}:${rest.toFixed(1).padStart(4, "0")}`;
}

// A change in words, for the list: "Calm → Battle.Melee", "made, in Calm", "ended with its owner's state".
export function changeText(c) {
  switch (c.kind) {
    case "made": return `made, in ${c.opt}`;
    case "set": return `${c.from} → ${c.opt}`;
    case "end": return c.how === "state" ? `ended with its owner's state (was ${c.opt})` : `let go (was ${c.opt})`;
    case "skipped": return `${c.n.toLocaleString("en")} more ${c.n === 1 ? "change" : "changes"}, too fast to list`;
  }
  return "";
}

// The things in the order they were made, at most SHOW_THINGS of them.
export function shownThings(m) {
  const all = [...m.things.values()];
  return { list: all.slice(0, SHOW_THINGS), more: Math.max(0, all.length - SHOW_THINGS) };
}

// What the panel says above (or instead of) the list.
//   watching: the run was started with the feed asked for; running: it hasn't ended; done: Ledger
//   has read the last of its feed.
export function status(m, { watching, running, done, ran }) {
  if (!ran) return { kind: "idle", text: "Run a Lust program (F5) to see each thing with a state of its own and the option it's in, as it changes." };
  if (!watching) return { kind: "unasked", text: running ? "This run started before the States panel was opened, so Lust isn't sending its states. Run it again (F5) to watch them." : "The last run started before the States panel was opened. Run it again (F5) to watch its states." };
  if (!m.started) {
    if (done) return { kind: "old", text: "This Lust doesn't send states. Lust 2.0.0-alpha.101 or newer does: update it in Settings › Lust." };
    return { kind: "waiting", text: "Starting…" };
  }
  const n = m.things.size;
  const count = `${n} ${n === 1 ? "thing" : "things"} with a state of ${n === 1 ? "its" : "their"} own`;
  if (m.newer) return { kind: "newer", text: `${count}. This Lust sends more than Ledger knows: update Ledger to see all of it.` };
  if (running) return { kind: "live", text: n ? count : "Nothing with a state of its own has been made yet." };
  return { kind: "ended", text: n ? `${count} when the program ended.` : m.made ? "The program ended; nothing with a state of its own was still going." : "The program ended without making anything with a state of its own." };
}
