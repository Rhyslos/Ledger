// Media tabs: which files open there, the time display, MP3 tags and the waveform.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { MEDIA_EXT, AUDIO_EXT, VIDEO_EXT, FONT_EXT, clock, id3, peaks } from "../src/media.js";

test("audio, video and fonts open as media; other files don't", () => {
  for (const f of ["a.mp3", "B.MP3", "x.wav", "x.ogg", "x.opus", "x.flac", "x.m4a", "x.aac"]) assert.ok(AUDIO_EXT.test(f) && MEDIA_EXT.test(f), f);
  for (const f of ["x.mp4", "x.webm", "x.mov", "x.mkv"]) assert.ok(VIDEO_EXT.test(f) && MEDIA_EXT.test(f), f);
  for (const f of ["x.ttf", "x.otf", "x.woff", "x.woff2"]) assert.ok(FONT_EXT.test(f) && MEDIA_EXT.test(f), f);
  for (const f of ["x.png", "x.mp3.txt", "mp3", "x.js", "x.md"]) assert.ok(!MEDIA_EXT.test(f), f);
});

test("clock", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(187.9), "3:07");
  assert.equal(clock(3729), "1:02:09");
  assert.equal(clock(NaN), "–:––");
});

function frame(id, text, enc = 3) {
  const body = enc === 1 ? [1, 0xff, 0xfe, ...[...text].flatMap((c) => [c.charCodeAt(0), 0])] : [enc, ...new TextEncoder().encode(text)];
  const n = body.length;
  return [...id].map((c) => c.charCodeAt(0)).concat([n >> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, 0, 0], body);
}
function tag(ver, frames) {
  const body = frames.flat();
  const n = body.length;
  return new Uint8Array([0x49, 0x44, 0x33, ver, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127, ...body]);
}

test("MP3 tags: title, artist and album (UTF-8 and UTF-16)", () => {
  assert.deepEqual(id3(tag(3, [frame("TIT2", "Forest Theme"), frame("TPE1", "Rhys", 1), frame("TALB", "Tests"), frame("TYER", "2026")])), { title: "Forest Theme", artist: "Rhys", album: "Tests" });
  assert.deepEqual(id3(new Uint8Array([1, 2, 3])), {});
  assert.deepEqual(id3(new Uint8Array(20)), {});
});

test("waveform peaks: the lowest and highest sample in each column", () => {
  const ch = new Float32Array([0, 0.5, -0.25, 0, 1, -1, 0.1, 0.2]);
  assert.deepEqual([...peaks([ch], 2)], [-0.25, 0.5, -1, 1]);
  assert.equal(peaks([new Float32Array(0)], 4).length, 8);
});

test("documents and archives get a card, not the hex view; text formats stay text", async () => {
  const { DOC_EXT } = await import("../src/media.js");
  for (const f of ["a.pdf", "B.DOCX", "x.xlsx", "x.pptx", "x.zip", "x.7z", "x.tar.gz", "x.epub"]) assert.ok(DOC_EXT.test(f), f);
  for (const f of ["x.rtf", "x.txt", "x.md", "x.json", "x.csv", "x.svg"]) assert.ok(!DOC_EXT.test(f), f);
});
