// How Ledger's Lust colouring reads a line, word by word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { StringStream } from "@codemirror/language";
import { lustMode } from "../src/langs.js";

function colours(line) {
  const st = lustMode.startState();
  const s = new StringStream(line, 4, 4);
  const out = [];
  while (!s.eol()) {
    const style = lustMode.token(s, st);
    const text = s.current().trim();
    if (text) out.push([text, style]);
    s.start = s.pos;
  }
  return out;
}

test("a thing's own state is set with =, and its option stays plain", () => {
  const c = colours("state = Phase.Calm;");
  assert.deepEqual(c[0], ["state", "lustState"]);
  assert.equal(c.find(([t]) => t === "Phase")[1], "lustPlain");
  assert.equal(c.find(([t]) => t === "Calm")[1], "lustPlain");
});

test("a state's own declaration still colours its name", () => {
  const c = colours("state Phase = [Calm, Battle];");
  assert.deepEqual(c[1], ["Phase", "lustState"]);
});

test("asking about a state is still a question", () => {
  const c = colours("is state == Phase.Calm? then { }");
  assert.deepEqual(c[0], ["is", "lustFlow"]);
});

test("-- starts a comment, and // doesn't any more", () => {
  assert.deepEqual(colours("-- a note"), [["-- a note", "lustComment"]]);
  assert.ok(colours("int a = 1; // not a note").every(([, style]) => style !== "lustComment"));
});
