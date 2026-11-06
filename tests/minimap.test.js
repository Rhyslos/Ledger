// The minimap's arithmetic: what it shows and where the shaded part sits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { geometry } from "../src/minimap.js";

test("a short file: the whole picture, the shaded part where the screen is", () => {
  const g = geometry({ lines: 100, scrollTop: 0, viewH: 600, docH: 2000, mapH: 600 });
  assert.equal(g.total, 200); // 2 pixels a line
  assert.equal(g.offset, 0);
  assert.equal(g.sliderTop, 0);
  assert.equal(g.sliderH, 60); // 600 of 2000 is 30% of 200 pixels
  const end = geometry({ lines: 100, scrollTop: 1400, viewH: 600, docH: 2000, mapH: 600 });
  assert.equal(end.sliderTop, 140); // at the bottom: 200 - 60
});

test("a long file: the picture scrolls with the editor", () => {
  const lines = 4000, docH = 4000 * 20, viewH = 600, mapH = 600;
  const top = geometry({ lines, scrollTop: 0, viewH, docH, mapH });
  assert.deepEqual([top.offset, top.sliderTop, top.first], [0, 0, 0]);
  const end = geometry({ lines, scrollTop: docH - viewH, viewH, docH, mapH });
  assert.equal(end.offset, 8000 - 600); // the picture's end lines up with the minimap's
  assert.equal(Math.round(end.sliderTop + end.sliderH), 600);
  const mid = geometry({ lines, scrollTop: (docH - viewH) / 2, viewH, docH, mapH });
  assert.ok(mid.sliderTop > 250 && mid.sliderTop < 300);
});
