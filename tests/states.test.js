// The States panel's model: reading lust run's states feed (Lust's src/states.rs).
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { newStates, parseLine, apply, applyLines, label, fmtTime, changeText, shownThings, status, KEEP_CHANGES, SHOW_THINGS } from "../src/statesfeed.js";

// What Lust alpha 101 writes for a hero who fights and rests, with a torch that ends with Battle.
const FEED = [
  '{"ev":"start","v":1,"lust":"2.0.0-alpha.101"}',
  '{"ev":"made","ms":0,"id":1,"class":"Hero","name":"scout","opt":"Calm"}',
  '{"ev":"made","ms":1,"id":2,"class":"Hero","opt":"Battle.Melee"}',
  '{"ev":"set","ms":1240,"id":1,"from":"Calm","opt":"Battle.Melee"}',
  '{"ev":"made","ms":1241,"id":3,"class":"Torch","name":"torch","opt":"Off"}',
  '{"ev":"set","ms":1242,"id":3,"from":"Off","opt":"On"}',
  '{"ev":"set","ms":2000,"id":1,"from":"Battle.Melee","opt":"Calm"}',
  '{"ev":"end","ms":2000,"id":3,"how":"state"}',
  '{"ev":"stop","ms":2100}',
];

test("a run's feed becomes the things still going, and the changes", () => {
  const m = newStates();
  const changed = applyLines(m, FEED);
  assert.deepEqual([...changed].sort(), [1, 2, 3]);
  assert.equal(m.started, true);
  assert.equal(m.stopped, true);
  assert.equal(m.lust, "2.0.0-alpha.101");
  assert.deepEqual([...m.things.values()].map((t) => [label(t), t.cls, t.opt]), [["scout", "Hero", "Calm"], ["Hero 2", "Hero", "Battle.Melee"]]);
  const last = m.changes.at(-1);
  assert.equal(last.kind, "end");
  assert.equal(changeText(last), "ended with its owner's state (was On)");
  assert.equal(changeText(m.changes.find((c) => c.kind === "set")), "Calm → Battle.Melee");
  assert.equal(m.changes.at(-2).who, "scout");
});

test("only the last few changes are kept", () => {
  const m = newStates();
  apply(m, parseLine('{"ev":"made","ms":0,"id":1,"class":"Lamp","name":"lamp","opt":"Off"}'));
  for (let i = 1; i <= 50; i++) apply(m, parseLine(`{"ev":"set","ms":${i},"id":1,"from":"${i % 2 ? "Off" : "On"}","opt":"${i % 2 ? "On" : "Off"}"}`));
  assert.equal(m.changes.length, KEEP_CHANGES);
  assert.equal(m.changes.at(-1).ms, 50);
  assert.equal(m.things.get(1).opt, "Off");
});

test("broken, unknown and half-written lines are left out", () => {
  for (const bad of ["", "hello", "{", '{"ev":3}', '{"ev":"made","id":1}', '{"ev":"set","opt":"A"}', '{"ev":"end"}', '{"ev":"later","id":1}', "[1,2]", "null", '{"ev":"made","id":-1,"class":"A","opt":"B"}', null, 42]) {
    assert.equal(parseLine(bad), null, String(bad));
  }
  const m = newStates();
  // A change to a thing Ledger never heard of (its made line was lost) changes nothing.
  assert.equal(apply(m, parseLine('{"ev":"set","ms":5,"id":9,"from":"A","opt":"B"}')), null);
  assert.equal(apply(m, parseLine('{"ev":"end","ms":5,"id":9,"how":"gone"}')), null);
  assert.equal(m.changes.length, 0);
});

test("any text at all never throws", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pieces = ['{"ev":"', "made", "set", "end", '","id":', "1", '"class":"', '"opt":"', "}", ",", '"', "\\", "é", "\n", "ms", ":", "-", "1e309"];
  const m = newStates();
  for (let i = 0; i < 5000; i++) {
    let s = "";
    for (let j = 0, n = Math.floor(rnd() * 12); j < n; j++) s += pieces[Math.floor(rnd() * pieces.length)];
    apply(m, parseLine(s));
  }
  assert.ok(m.changes.length <= KEEP_CHANGES);
});

test("a flood of changes too fast to list says how many", () => {
  const m = newStates();
  applyLines(m, [
    '{"ev":"start","v":1,"lust":"x"}',
    '{"ev":"made","ms":0,"id":1,"class":"Lamp","name":"lamp","opt":"Off"}',
    '{"ev":"skipped","ms":50,"n":4180}',
    '{"ev":"set","ms":50,"id":1,"from":"Off","opt":"On"}',
  ]);
  assert.equal(m.skipped, 4180);
  assert.equal(changeText(m.changes.find((c) => c.kind === "skipped")), "4,180 more changes, too fast to list");
  assert.equal(m.things.get(1).opt, "On");
});

test("times read as seconds since the program started", () => {
  assert.equal(fmtTime(0), "+0.00s");
  assert.equal(fmtTime(1240), "+1.24s");
  assert.equal(fmtTime(12345), "+12.3s");
  assert.equal(fmtTime(125100), "+2:05.1");
  assert.equal(fmtTime(-5), "+0.00s");
});

test("a long list stops at SHOW_THINGS and says how many more", () => {
  const m = newStates();
  for (let i = 1; i <= SHOW_THINGS + 3; i++) apply(m, parseLine(`{"ev":"made","ms":0,"id":${i},"class":"Ant","opt":"Walk"}`));
  const { list, more } = shownThings(m);
  assert.equal(list.length, SHOW_THINGS);
  assert.equal(more, 3);
});

test("the panel explains itself before, during and after a run", () => {
  const m = newStates();
  assert.equal(status(m, { ran: false }).kind, "idle");
  assert.equal(status(m, { ran: true, watching: false, running: true }).kind, "unasked");
  assert.equal(status(m, { ran: true, watching: true, running: true, done: false }).kind, "waiting");
  // An older Lust ignores LUST_STATES: the run ends with no feed at all.
  assert.equal(status(m, { ran: true, watching: true, running: false, done: true }).kind, "old");
  assert.match(status(m, { ran: true, watching: true, running: false, done: true }).text, /alpha\.101/);
  applyLines(m, FEED.slice(0, 3));
  assert.equal(status(m, { ran: true, watching: true, running: true }).text, "2 things with a state of their own");
  applyLines(m, FEED.slice(3));
  assert.equal(status(m, { ran: true, watching: true, running: false, done: true }).text, "2 things with a state of their own when the program ended.");
  // A newer feed than Ledger knows still shows what it can.
  const n = newStates();
  apply(n, parseLine('{"ev":"start","v":2,"lust":"3.0"}'));
  apply(n, parseLine('{"ev":"made","ms":0,"id":1,"class":"A","opt":"B"}'));
  assert.equal(status(n, { ran: true, watching: true, running: true }).kind, "newer");
});
