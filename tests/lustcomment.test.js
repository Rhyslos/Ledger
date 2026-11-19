// --- then Tab turns into a block comment, --[[ ]].
import { test } from "node:test";
import assert from "node:assert/strict";
import { startsBlockComment } from "../src/lustview.js";

test("three dashes start a block comment", () => {
  assert.equal(startsBlockComment("---"), true);
  assert.equal(startsBlockComment("    ---"), true);
  assert.equal(startsBlockComment("int hp = 5; ---"), true);
});

test("a longer line of dashes stays dashes", () => {
  assert.equal(startsBlockComment("----"), false);
  assert.equal(startsBlockComment("------------"), false);
});

test("not inside text or an existing comment", () => {
  assert.equal(startsBlockComment('print("---'), false);
  assert.equal(startsBlockComment("-- a note ---"), false);
  assert.equal(startsBlockComment('print("a") ---'), true);
});

test("fewer than three dashes do nothing", () => {
  assert.equal(startsBlockComment("--"), false);
  assert.equal(startsBlockComment(""), false);
});
