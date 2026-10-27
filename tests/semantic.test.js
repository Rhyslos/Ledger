// Semantic tokens: the server's relative numbers turned into editor ranges and classes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Text } from "@codemirror/state";
import { decodeTokens, semanticClass } from "../src/semantic.js";

test("token types and modifiers become classes", () => {
  assert.equal(semanticClass("class"), "cm-st-type");
  assert.equal(semanticClass("interface"), "cm-st-iface");
  assert.equal(semanticClass("method", ["static"]), "cm-st-fn cm-st-static");
  assert.equal(semanticClass("property", ["readonly", "static"]), "cm-st-const");
  assert.equal(semanticClass("enumMember"), "cm-st-const");
  assert.equal(semanticClass("keyword"), null); // the grammar colours those
  assert.equal(semanticClass("string"), null);
  assert.equal(semanticClass("class name"), "cm-st-type"); // Roslyn's own names
  assert.equal(semanticClass("field name", ["deprecated"]), "cm-st-field cm-st-deprecated");
});

test("relative positions decode to ranges", () => {
  const doc = Text.of(["class Foo {", "  int Bar() => Baz.Qux;", "}"]);
  const legend = { tokenTypes: ["class", "method", "property", "keyword"], tokenModifiers: ["static"] };
  // Foo (0,6,3,class) · Bar (1,6,3,method) · Baz (same line +9, class) · Qux (+4, property, static)
  const data = [0, 6, 3, 0, 0, 1, 6, 3, 1, 0, 0, 9, 3, 0, 0, 0, 4, 3, 2, 1, 1, 0, 1, 3, 0];
  const got = decodeTokens(doc, data, legend).map((t) => [doc.sliceString(t.from, t.to), t.cls]);
  assert.deepEqual(got, [["Foo", "cm-st-type"], ["Bar", "cm-st-fn"], ["Baz", "cm-st-type"], ["Qux", "cm-st-prop cm-st-static"]]);
  assert.deepEqual(decodeTokens(doc, [9, 0, 3, 0, 0], legend), []); // past the end: ignored
});

import { groupAt } from "../src/msbuild.js";
test("MSBuild completion knows which group the cursor is in", () => {
  assert.equal(groupAt('<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <'), "PropertyGroup");
  assert.equal(groupAt("<Project><PropertyGroup></PropertyGroup><ItemGroup><Pa"), "ItemGroup");
  assert.equal(groupAt("<Project><ItemGroup /><"), "Project");
});

import { parseEditorConfig, propsFor, settingsFrom, globToRegExp } from "../src/editorconfig.js";
test(".editorconfig sections and globs", () => {
  const c = parseEditorConfig("root = true\n[*]\nindent_style = space\nindent_size = 2\n[*.{cs,csx}]\nindent_size = 4\nend_of_line = crlf\n[Makefile]\nindent_style = tab\n");
  assert.equal(c.root, true);
  assert.deepEqual(settingsFrom(propsFor(c, "src/Program.cs")), { indent: { tabs: false, size: 4 }, eol: "\r\n", trim: false, finalNewline: null });
  assert.deepEqual(settingsFrom(propsFor(c, "web/app.js")).indent, { tabs: false, size: 2 });
  assert.equal(settingsFrom(propsFor(c, "Makefile")).indent.tabs, true);
  assert.ok(globToRegExp("src/**/*.json").test("src/a/b/c.json"));
  assert.ok(globToRegExp("src/**/*.json").test("src/c.json"));
  assert.ok(!globToRegExp("*.cs").test("a.csx"));
});
