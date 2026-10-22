// Every file type Ledger knows: how to highlight it, which language server
// (if any) understands it, and what colour its dot is in the explorer.
import { StreamLanguage, LanguageSupport, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Tag, tags as t } from "@lezer/highlight";
import { Prec } from "@codemirror/state";
import { rust, rustLanguage } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { sCSS, less } from "@codemirror/legacy-modes/mode/css";
import { webColours, legacyCssColours } from "./webcolours.js";
import { tailwindSwatches } from "./tailwind.js";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { clike } from "@codemirror/legacy-modes/mode/clike";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { python } from "@codemirror/legacy-modes/mode/python";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { snippetCompletion as snip, completeFromList } from "@codemirror/autocomplete";

const words = (s) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map((w) => [w, true]));

// ----- Godot shading language -----
const GD_KEYWORDS = "shader_type render_mode uniform varying const struct in out inout flat smooth lowp mediump highp if else for while do switch case default break continue return discard instance global group_uniforms";
const GD_TYPES = "void bool bvec2 bvec3 bvec4 int ivec2 ivec3 ivec4 uint uvec2 uvec3 uvec4 float vec2 vec3 vec4 mat2 mat3 mat4 sampler2D isampler2D usampler2D sampler2DArray isampler2DArray usampler2DArray sampler3D isampler3D usampler3D samplerCube samplerCubeArray samplerExternalOES";
const GD_FUNCS = "radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh pow exp exp2 log log2 sqrt inversesqrt abs sign floor trunc round roundEven ceil fract mod modf min max clamp mix step smoothstep isnan isinf floatBitsToInt floatBitsToUint intBitsToFloat uintBitsToFloat length distance dot cross normalize reflect refract faceforward matrixCompMult outerProduct transpose determinant inverse lessThan greaterThan lessThanEqual greaterThanEqual equal notEqual any all not textureSize texture textureProj textureLod textureProjLod textureGrad textureProjGrad texelFetch textureQueryLod textureQueryLevels dFdx dFdy fwidth packHalf2x16 unpackHalf2x16 packUnorm2x16 unpackUnorm2x16 packSnorm2x16 unpackSnorm2x16 packUnorm4x8 unpackUnorm4x8 packSnorm4x8 unpackSnorm4x8 bitfieldExtract bitfieldInsert bitfieldReverse bitCount findLSB findMSB fma frexp ldexp";
const GD_HINTS = "source_color hint_range hint_normal hint_default_white hint_default_black hint_default_transparent hint_anisotropy hint_roughness_r hint_roughness_g hint_roughness_b hint_roughness_a hint_roughness_normal hint_roughness_gray hint_screen_texture hint_depth_texture hint_normal_roughness_texture filter_nearest filter_linear filter_nearest_mipmap filter_linear_mipmap filter_nearest_mipmap_anisotropic filter_linear_mipmap_anisotropic repeat_enable repeat_disable instance_index";
const GD_TYPES_SHADER = "spatial canvas_item particles sky fog";
const GD_RENDER_MODES = "blend_mix blend_add blend_sub blend_mul blend_premul_alpha unshaded light_only skip_vertex_transform world_vertex_coords cull_back cull_front cull_disabled depth_draw_opaque depth_draw_always depth_draw_never depth_prepass_alpha depth_test_disabled diffuse_burley diffuse_lambert diffuse_lambert_wrap diffuse_toon specular_schlick_ggx specular_toon specular_disabled shadows_disabled ambient_light_disabled vertex_lighting wireframe fog_disabled particle_trails alpha_to_coverage";
const GD_BUILTINS = "TIME PI TAU E VERTEX NORMAL TANGENT BINORMAL UV UV2 COLOR POINT_SIZE MODELVIEW_MATRIX MODEL_MATRIX VIEW_MATRIX INV_VIEW_MATRIX PROJECTION_MATRIX INV_PROJECTION_MATRIX INSTANCE_ID INSTANCE_CUSTOM VIEWPORT_SIZE FRAGCOORD FRONT_FACING ALBEDO ALPHA ALPHA_SCISSOR_THRESHOLD METALLIC SPECULAR ROUGHNESS RIM RIM_TINT CLEARCOAT CLEARCOAT_ROUGHNESS ANISOTROPY ANISOTROPY_FLOW SSS_STRENGTH AO AO_LIGHT_AFFECT EMISSION NORMAL_MAP NORMAL_MAP_DEPTH BACKLIGHT DEPTH SCREEN_UV POINT_COORD TEXTURE TEXTURE_PIXEL_SIZE SCREEN_PIXEL_SIZE NORMAL_TEXTURE SPECULAR_SHININESS SPECULAR_SHININESS_TEXTURE LIGHT LIGHT_COLOR LIGHT_POSITION LIGHT_DIRECTION LIGHT_ENERGY LIGHT_VERTEX SHADOW_VERTEX LIGHT_PASS AT_LIGHT_PASS CANVAS_MATRIX SCREEN_MATRIX VELOCITY ACTIVE CUSTOM INDEX LIFETIME DELTA NUMBER RESTART EMISSION_TRANSFORM TRANSFORM RANDOM_SEED EYEDIR SKY_COORDS POSITION QUARTER_RES_COLOR HALF_RES_COLOR RADIANCE AT_CUBEMAP_PASS AT_HALF_RES_PASS AT_QUARTER_RES_PASS WORLD_POSITION OBJECT_POSITION UVW SIZE SDF DENSITY EXPOSURE";

const gdshaderMode = clike({
  name: "gdshader",
  keywords: words(GD_KEYWORDS),
  types: words(GD_TYPES),
  builtin: words(GD_FUNCS + " " + GD_HINTS),
  atoms: words("true false " + GD_BUILTINS + " " + GD_RENDER_MODES + " " + GD_TYPES_SHADER),
  blockKeywords: words("if else for while do switch struct"),
  defKeywords: words("struct"),
  typeFirstDefinitions: true,
  multiLineStrings: false,
  indentSwitch: false,
  hooks: {
    "#": (stream) => { stream.skipToEnd(); return "meta"; },
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } }, indentOnInput: /^\s*[{}]$/ },
});

const gdshaderCompletions = completeFromList([
  ...GD_KEYWORDS.split(" ").map((l) => ({ label: l, type: "keyword" })),
  ...GD_TYPES.split(" ").map((l) => ({ label: l, type: "type" })),
  ...GD_FUNCS.split(" ").map((l) => ({ label: l, type: "function", apply: l + "()", detail: "built-in" })),
  ...GD_HINTS.split(" ").map((l) => ({ label: l, type: "property", detail: "hint" })),
  ...GD_BUILTINS.split(" ").map((l) => ({ label: l, type: "constant", detail: "built-in" })),
  ...GD_RENDER_MODES.split(" ").map((l) => ({ label: l, type: "enum", detail: "render mode" })),
  ...GD_TYPES_SHADER.split(" ").map((l) => ({ label: l, type: "enum", detail: "shader type" })),
  snip("void vertex() {\n\t${}\n}", { label: "vertex", detail: "function", type: "function" }),
  snip("void fragment() {\n\t${}\n}", { label: "fragment", detail: "function", type: "function" }),
  snip("void light() {\n\t${}\n}", { label: "light", detail: "function", type: "function" }),
  snip("uniform ${float} ${name} : hint_range(${0.0}, ${1.0}) = ${0.5};", { label: "uniform range", detail: "snippet", type: "text" }),
  snip("uniform vec4 ${color} : source_color = vec4(${1.0});", { label: "uniform color", detail: "snippet", type: "text" }),
  snip("uniform sampler2D ${tex} : ${source_color}, ${filter_linear_mipmap};", { label: "uniform texture", detail: "snippet", type: "text" }),
]);

// ----- Godot scenes and resources (.tscn, .tres, project.godot) -----
const godotResource = {
  name: "godot",
  startState: () => ({ header: false }),
  token(stream, st) {
    if (stream.sol()) st.header = false;
    if (stream.eatSpace()) return null;
    if (stream.match(/^;.*/)) return "comment";
    if (stream.sol() && stream.eat("[")) { st.header = true; stream.match(/^[\w\/]+/); return "keyword"; }
    if (st.header && stream.eat("]")) return "bracket";
    if (stream.match(/^&?"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i)) return "number";
    if (stream.match(/^(?:true|false|null)\b/)) return "atom";
    if (stream.match(/^[A-Z]\w*(?=\()/)) return "type";
    if (stream.match(/^[\w\/:.\-]+(?=\s*=)/)) return st.header ? "attribute" : "property";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: ";" } },
};

// ----- Lust (.lst, .lsc) -----
// Lust is our own language (github.com/Rhyslos/Lust). .lst files become real programs,
// .lsc files are LustScript, which becomes Lua. Old .lust files (Lust 1) are coloured the same.
//
// Lust always uses the quiet colours (which every language can use too, with
// Settings › Code colours): the words that give a program its shape (class,
// object, has, method…) in the logo's red, states in marine green (the word
// state and a state's name; its options stay plain), classes (names with a
// capital) in a soft blue, objects (Game:start(), Farm.gold, Maths:sqrt) in orange, types muted,
// questions and loops in a lighter red, comments green, text and numbers sand, punctuation grey,
// the rest plain. Structure, states and the names being declared are a touch heavier (500), never fully bold.
// In a view, the pieces of the screen (column, text, button…) share the classes' blue, since your own
// pieces are classes too, and the style words in [ ] are muted like types.
const LUST_CONTROL = "is then or either loop stop skip return try error like keep";
const LUST_DEFINE = "class object node assembly schema database route method hook has new create";
const LUST_MODULE = "fetch get pass end save load saved lua view style native";
const LUST_TYPES = "int float string bool array cMap map";
const LUST_BUILTINS = "print wait ask";
const LUST_OBJECTS = "Maths Files Time Json Web Random";
const LUST_PIECES = "column row stack scroll space text button input checkbox slider image every";
const LUST_STYLES = "pad padX padY padTop padRight padBottom padLeft gap width height grow minWidth maxWidth minHeight maxHeight size tiny small large huge weight bold muted strike nowrap color background round pill border borderWidth shadow opacity left center right top middle bottom spread subtle hover placeholder from to step cover disabled title fill";
const lustSet = (s) => new Set(s.split(" "));
// Colours a view can use: [blue], background gray1, color red7…
const LUST_COLOURS = ["black", "white", ..."gray red orange yellow green teal blue indigo purple pink".split(" ").flatMap((c) => [c, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => c + n)])].join(" ");
// The standard library and the methods on text and arrays (Lust's src/stdlib.rs), for completing after Maths:, name: and name.
const LUST_LIB = {
  Maths: ["abs(x)", "min(a, b)", "max(a, b)", "clamp(x, low, high)", "round(x)", "floor(x)", "ceil(x)", "sqrt(x)", "sin(x)", "cos(x)", "tan(x)", "power(x, p)"],
  Files: ["read(path)", "write(path, text)", "append(path, text)", "exists(path)", "remove(path)", "list(folder)", "makeFolder(path)"],
  Time: ["now()", "clock()", "date()", "time()", "addDays(date, n)", "daysBetween(from, to)", "weekday(date)", "isDate(text)"],
  Json: ["write(value)", "pretty(value)", "read(text)"],
  Web: ["get(url)", "post(url, body)", "serve(port)", "request(kind, path, body)", "fail(code, message)"],
};
const LUST_TEXT = ["contains(text)", "startsWith(text)", "endsWith(text)", "find(text)", "replace(old, new)", "replaceAll(pattern, new)", "split(by)", "slice(from, to)", "matches(pattern)", "findAll(pattern)", "capture(pattern)"];
const LUST_ARRAY = ["join(between)", "has(value)", "find(value)", "remove(value)", "sort()", "reverse()"];
const LUST_CONVERT = ["text()", "int()", "float()", "upper()", "lower()", "trim()"];
const libOption = (sig, detail) => {
  const name = sig.slice(0, sig.indexOf("(")), args = sig.slice(name.length + 1, -1);
  let n = 0;
  return snip(name + "(" + (args ? args.split(", ").map((a) => "${" + ++n + ":" + a + "}").join(", ") : "") + ")", { label: name, detail: detail + " · " + sig, type: "method" });
};
const LIB_OPTIONS = Object.fromEntries(Object.entries(LUST_LIB).map(([o, l]) => [o, l.map((s) => libOption(s, o))]));
const VALUE_OPTIONS = [...LUST_TEXT.map((s) => libOption(s, "text")), ...LUST_ARRAY.map((s) => libOption(s, "array"))];
const CONVERT_OPTIONS = LUST_CONVERT.map((s) => libOption(s, "turns it into"));
/** After Maths: (and the other built-in objects), a value's : or its . — the library, methods and conversions. */
function lustMembers(ctx) {
  const lib = ctx.matchBefore(/\b(Maths|Files|Time|Json|Web):\w*$/);
  if (lib) return { from: lib.from + lib.text.indexOf(":") + 1, options: LIB_OPTIONS[lib.text.slice(0, lib.text.indexOf(":"))], validFor: /^\w*$/ };
  const val = ctx.matchBefore(/(?:\b[a-z_]\w*|[)\]"])[:.]\w*$/);
  if (!val) return null;
  const at = val.text.search(/[:.]\w*$/);
  return { from: val.from + at + 1, options: val.text[at] === "." ? CONVERT_OPTIONS : VALUE_OPTIONS, validFor: /^\w*$/ };
}

const LK = { control: lustSet(LUST_CONTROL), define: lustSet(LUST_DEFINE), module: lustSet(LUST_MODULE), types: lustSet(LUST_TYPES), builtins: lustSet(LUST_BUILTINS), objects: lustSet(LUST_OBJECTS), pieces: lustSet(LUST_PIECES) };

const LT = {
  structure: Tag.define(),  // class object node state has method hook new fetch get pass end …
  flow: Tag.define(),       // is then or either loop stop skip return try error not in ?
  name: Tag.define(),       // the name being declared: class Player, method hurt
  type: Tag.define(),       // int float string bool array cMap map
  value: Tag.define(),      // "text", 42, true, nothing
  comment: Tag.define(),
  punct: Tag.define(),
  plain: Tag.define(),
  state: Tag.define(),      // state, and a state's name where it's declared
  cls: Tag.define(),        // classes: names that start with a capital (Player, new Player)
  obj: Tag.define(),        // objects: object Game, and Game:start() or Farm.gold
};
const lustStyle = HighlightStyle.define([
  { tag: LT.structure, color: "var(--lust-red)", fontWeight: "500" },
  { tag: LT.flow, color: "var(--lust-flow)" },
  { tag: LT.name, color: "var(--ink)", fontWeight: "500" },
  { tag: LT.state, color: "var(--lust-state)", fontWeight: "500" },
  { tag: LT.cls, color: "var(--lust-class)" },
  { tag: LT.obj, color: "var(--lust-object)" },
  { tag: LT.type, color: "var(--lust-type)" },
  { tag: LT.value, color: "var(--lust-value)" },
  { tag: LT.comment, color: "var(--lust-comment)", fontStyle: "italic" },
  { tag: LT.punct, color: "var(--lust-punct)" },
  { tag: LT.plain, color: "var(--ink)" },
]);

const lustMode = {
  name: "lust",
  // depth: open { and [ for indenting. def: the next name is being defined
  // ("type" after class, "obj" after object/node/assembly/database, "fn" after method). after:
  // the last punctuation that matters for the next word (":" or "."). opts: the depth of a state's
  // [ options ] while inside them. block: inside a --[[ comment ]] that goes over several lines.
  // styled: a [ ] coming up holds styles (after view, a piece, or style name =). styles: the depths
  // of the style lists we're in (hover:[ … ] nests one). styleWord: the next word names a style.
  startState: () => ({ depth: 0, def: null, after: null, opts: null, block: false, styled: false, styles: [], styleWord: false }),
  copyState: (s) => ({ ...s, styles: [...s.styles] }),
  tokenTable: { lustStructure: LT.structure, lustFlow: LT.flow, lustName: LT.name, lustType: LT.type, lustValue: LT.value, lustComment: LT.comment, lustPunct: LT.punct, lustPlain: LT.plain, lustState: LT.state, lustClass: LT.cls, lustObject: LT.obj },
  token(stream, st) {
    if (st.block) {
      if (stream.skipTo("]]")) { stream.match("]]"); st.block = false; } else stream.skipToEnd();
      return "lustComment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("--[[")) {
      if (stream.skipTo("]]")) stream.match("]]"); else { stream.skipToEnd(); st.block = true; }
      return "lustComment";
    }
    if (stream.match("//") || stream.match("--")) { stream.skipToEnd(); return "lustComment"; }
    // lua { … } in LustScript: the Lua inside is shown as it is.
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "lustValue";
    const after = st.after;
    st.after = null;
    if (stream.match(/^\d+(?:\.\d+)?/)) return "lustValue";
    const w = stream.match(/^[A-Za-z_]\w*/);
    if (w) {
      const word = w[0];
      // Inside a style list, the first word after [ or , is the style's name.
      if (st.styles.length && st.styles[st.styles.length - 1] === st.depth) {
        if (st.styleWord) { st.styleWord = false; return "lustType"; }
        if (word === "true" || word === "false" || word === "nothing") return "lustValue";
        if (LK.control.has(word) || word === "not") return "lustFlow";
        return "lustPlain";
      }
      // style card = [pad 16, round];
      if (st.def === "style") { st.def = null; st.styled = true; return "lustName"; }
      if (word === "style" && after == null) { st.def = "style"; return "lustStructure"; }
      if (word === "view" && after == null) { st.styled = true; return "lustStructure"; }
      // A piece of the screen starts its line: column [gap 8] {, text name [muted];, every 1.0 { … }
      const lineStart = stream.string.slice(0, stream.start).trim() === "";
      if (lineStart && after == null && LK.pieces.has(word) && !stream.match(/^\s*[=(.:,]/, false)) { st.styled = true; return "lustClass"; }
      // Your own piece: TodoRow [width 300] { label = task };
      if (lineStart && /^[A-Z]/.test(word) && stream.match(/^\s*\[/, false)) { st.styled = true; return "lustClass"; }
      // States: state Mood = [Calm, Busy [Rushed]];  state is Mood.Calm;
      if (word === "state") { st.def = "state"; return "lustState"; }
      if (st.opts != null && st.depth >= st.opts) return "lustPlain";   // the options themselves stay plain
      if (st.def === "state" && word === "is") { st.def = "stateIs"; return "lustFlow"; }
      if (st.def === "state" && (word === "in" || word === "not" || LK.control.has(word))) st.def = null;
      else if (st.def === "state") return "lustState";
      if (st.def === "stateIs") return "lustPlain";   // state is Mood.Calm: plain, like the options
      if (after === ":" || after === ".") return "lustPlain";
      if (word === "true" || word === "false" || word === "nothing") return "lustValue";
      if (word === "not" || word === "in") return "lustFlow";
      // A route's get, post, put and delete, and get "file":thing, are followed by a path.
      if (["get", "post", "put", "delete"].includes(word) && stream.match(/^\s*"/, false)) return "lustStructure";
      if (LK.control.has(word)) return "lustFlow";
      if (LK.define.has(word)) {
        st.def = word === "class" || word === "schema" ? "type" : ["object", "node", "assembly", "database"].includes(word) ? "obj" : word === "method" ? "fn" : null;
        return "lustStructure";
      }
      if (LK.module.has(word)) return "lustStructure";
      if (LK.types.has(word)) return "lustType";
      if (LK.objects.has(word)) return "lustObject";
      if (st.def === "type") { st.def = null; return "lustClass"; }      // class Player
      if (st.def === "obj") { st.def = null; return "lustObject"; }      // object Game, node Cave
      if (/^[A-Z]/.test(word)) {
        // An object is used directly (Game:start(), Farm.gold); a class only as a type (Player ada = new Player).
        return stream.match(/^\s*[:.]/, false) ? "lustObject" : "lustClass";
      }
      const call = stream.match(/^\s*\(/, false);
      if (st.def === "fn" && call) { st.def = null; return "lustName"; }
      return "lustPlain";
    }
    const ch = stream.next();
    const inStyles = st.styles.length && st.styles[st.styles.length - 1] === st.depth;
    if (ch === "{" || ch === "[") {
      st.depth++;
      if (ch === "[" && st.def === "state" && st.opts == null) st.opts = st.depth;
      if (ch === "[" && (st.styled || inStyles)) { st.styles.push(st.depth); st.styleWord = true; }
      if (ch === "{") st.styled = false;
      st.def = null;
      return "lustPunct";
    }
    if (ch === "}" || ch === "]") {
      if (st.styles.length && st.styles[st.styles.length - 1] === st.depth) st.styles.pop();
      st.depth = Math.max(0, st.depth - 1);
      if (st.opts != null && st.depth < st.opts) st.opts = null;
      if (ch === "]" && !st.styles.length) st.styled = false;
      return "lustPunct";
    }
    if (ch === "," && inStyles) { st.styleWord = true; return "lustPunct"; }
    if (ch === "(" || ch === ")") { st.def = null; return "lustPunct"; }
    if (ch === "?") return "lustFlow";
    if (ch === ":" || ch === ".") { st.after = ch; return "lustPunct"; }
    if (ch === ";" || ch === ",") { st.def = null; if (ch === ";") st.styled = false; return "lustPunct"; }
    return "lustPunct";
  },
  indent(st, textAfter, cx) {
    return Math.max(0, st.depth - (/^\s*[}\]]/.test(textAfter) ? 1 : 0)) * cx.unit;
  },
  languageData: {
    commentTokens: { line: "--", block: { open: "--[[", close: "]]" } },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
    indentOnInput: /^\s*[}\]]$/,
  },
};

const lustCompletions = completeFromList([
  ...LUST_CONTROL.split(" ").map((l) => ({ label: l, type: "keyword" })),
  ...LUST_DEFINE.split(" ").map((l) => ({ label: l, type: "keyword" })),
  ...LUST_MODULE.split(" ").map((l) => ({ label: l, type: "keyword" })),
  ...LUST_TYPES.split(" ").map((l) => ({ label: l, type: "type" })),
  ...LUST_BUILTINS.split(" ").map((l) => ({ label: l, type: "function", apply: l + "()", detail: "built-in" })),
  ...LUST_OBJECTS.split(" ").map((l) => ({ label: l, type: "class", detail: "built-in object" })),
  ...LUST_PIECES.split(" ").map((l) => ({ label: l, type: "keyword", detail: "piece of a view" })),
  ...LUST_STYLES.split(" ").filter((l) => !LK.pieces.has(l)).map((l) => ({ label: l, type: "property", detail: "style" })),
  ...LUST_COLOURS.split(" ").map((l) => ({ label: l, type: "constant", detail: "colour", boost: -1 })),
  { label: "true", type: "constant" }, { label: "false", type: "constant" }, { label: "nothing", type: "constant" },
  snip("Random[${1}, ${6}]", { label: "Random", detail: "a random number from the first to the second", type: "function" }),
  snip("class ${Name} {\n\thas {\n\t\t${string} ${name} = ${\"\"};\n\t}\n\n\tmethod ${hello}() {\n\t\t${}\n\t}\n}", { label: "class", detail: "blueprint, made with new", type: "class" }),
  snip("object ${Name} {\n\thas {\n\t\t${int} ${count} = ${0};\n\t}\n}", { label: "object", detail: "one ready-made thing", type: "class" }),
  snip("node ${Room} {\n\thas {\n\t\t${}\n\t}\n\n\tmethod onOpen() {\n\t\t${}\n\t}\n\n\tmethod onClose() {\n\t\t${}\n\t}\n}", { label: "node", detail: "opens and closes; closing ends what it made", type: "class" }),
  snip("assembly ${Loot} {\n\tcreate ${Item} {\n\t\t${name} = ${\"Potion\"};\n\t}\n}", { label: "assembly", detail: "ready-filled things: Loot:create(Item)", type: "class" }),
  snip("has {\n\t${int} ${name} = ${0};\n}", { label: "has", detail: "fields", type: "text" }),
  snip("method ${name}(${}) {\n\t${}\n}", { label: "method", detail: "does something", type: "function" }),
  snip("method ${int} ${name}(${}) {\n\treturn ${0};\n}", { label: "method …", detail: "gives something back", type: "function" }),
  snip("method ${float} ${name}(${}) native;", { label: "method native", detail: "its body is in the program Lust is part of", type: "function" }),
  snip("hook ${int}(${int n}) ${name} = new hook {\n\t${}\n};", { label: "hook", detail: "a method kept in a variable", type: "function" }),
  snip("is ${value} == ${0}? then {\n\t${}\n}", { label: "is", detail: "question check", type: "text" }),
  snip("is ${value} == ${0}? then {\n\t${}\n} or {\n\t${}\n}", { label: "is … or", detail: "question check with fallback", type: "text" }),
  snip("either ${check}? ${yes} or ${no}", { label: "either", detail: "one-line check", type: "text" }),
  snip("loop {\n\t${}\n}", { label: "loop", detail: "forever, until stop", type: "text" }),
  snip("loop ${3} {\n\t${}\n}", { label: "loop times", detail: "repeat", type: "text" }),
  snip("loop (${check}) {\n\t${}\n}", { label: "loop while", detail: "while true", type: "text" }),
  snip("loop (${int} ${item} in ${list}) {\n\t${}\n}", { label: "loop in", detail: "each item", type: "text" }),
  snip("try {\n\t${}\n} error (string ${message}) {\n\t${print(message);}\n}", { label: "try", detail: "carry on if something goes wrong", type: "text" }),
  snip("state ${Mood} = [${Calm}, ${Busy}];", { label: "state", detail: "a list of options", type: "text" }),
  snip("keep ${thing} in ${place};", { label: "keep", detail: "hold onto something made in a state", type: "keyword" }),
  snip("save ${game} = [${Things}];", { label: "save", detail: "what to keep between runs", type: "keyword" }),
  snip("is saved ${game}? then {\n\tload ${game};\n}", { label: "load", detail: "load it if it was saved", type: "keyword" }),
  snip("pass ${Thing};", { label: "pass", detail: "share with other files", type: "keyword" }),
  snip("fetch \"${folder/file}\":${Thing};", { label: "fetch", detail: "bring in a class, object or state", type: "keyword" }),
  snip("get \"${folder/file}\":${method};", { label: "get", detail: "bring in a method", type: "keyword" }),
  snip("cMap(${int id}, ${string name}) ${bag} = [];", { label: "cMap", detail: "rows found by their key", type: "type" }),
  snip("database ${Shop} in \"${shop.db}\" {\n\tcMap(${string name}, ${float price}) ${items};\n}", { label: "database", detail: "tables kept in a file", type: "class" }),
  snip("schema ${NewUser} {\n\thas {\n\t\t${string name};\n\t}\n}", { label: "schema", detail: "the shape of data coming in", type: "class" }),
  snip("route \"${/api}\" {\n\tget \"${/hello/:who}\" => ${hello};\n}", { label: "route", detail: "answer web requests", type: "keyword" }),
  // Views: windows drawn by Lust.
  snip("assembly ${App} {\n\thas {\n\t\t${int} ${count} = ${0};\n\t}\n\n\tview [title \"${My app}\", width ${480}, height ${360}] {\n\t\tcolumn [gap 12, pad 24] {\n\t\t\t${}\n\t\t}\n\t}\n}\n\n${App}:open();", { label: "app", detail: "an assembly with a window, opened", type: "class" }),
  snip("view {\n\tcolumn [gap ${8}] {\n\t\t${}\n\t}\n}", { label: "view", detail: "what the screen shows", type: "keyword" }),
  snip("column [gap ${8}] {\n\t${}\n}", { label: "column", detail: "pieces top to bottom", type: "keyword" }),
  snip("row [gap ${8}] {\n\t${}\n}", { label: "row", detail: "pieces side by side", type: "keyword" }),
  snip("scroll [gap ${4}] {\n\t${}\n}", { label: "scroll", detail: "a column that scrolls", type: "keyword" }),
  snip("text ${\"Hello\"};", { label: "text", detail: "words on the screen", type: "keyword" }),
  snip("button \"${Start}\" [${blue}] {\n\t${}\n}", { label: "button", detail: "runs its block when clicked", type: "keyword" }),
  snip("input ${name} [placeholder \"${Your name}\"];", { label: "input", detail: "a text box bound to a field", type: "keyword" }),
  snip("checkbox ${done};", { label: "checkbox", detail: "ticks a bool field", type: "keyword" }),
  snip("slider ${volume} [from ${0}, to ${100}];", { label: "slider", detail: "drags a number field", type: "keyword" }),
  snip("image \"${picture.png}\" [width ${120}];", { label: "image", detail: "a PNG or JPEG", type: "keyword" }),
  snip("every ${1.0} {\n\t${}\n}", { label: "every", detail: "runs again and again while shown", type: "keyword" }),
  snip("style ${card} = [${pad 16, round, shadow}];", { label: "style", detail: "a named set of styles", type: "keyword" }),
]);

// ----- C# -----
// C#'s own colouring, made to read calmly: declarations and control flow in the
// keyword colours, the many modifiers (public, static, readonly…) faded back,
// your classes and types in the class colour, built-in types (int, string) muted,
// and properties, which are PascalCase too, left plain so the class colour means
// something. Tokens use the shared tags, so Settings › Code colours applies.
const CS_DECL = words("class struct interface enum record namespace using delegate event operator implicit explicit new");
const CS_MOD = words("public private protected internal static readonly const override virtual abstract sealed partial async extern unsafe volatile required init get set add remove params ref out in file scoped");
const CS_FLOW = words("if else for foreach while do switch case default break continue return throw try catch finally await yield goto when lock checked unchecked fixed is as typeof sizeof nameof stackalloc with and or not");
const CS_BUILTIN = words("bool byte sbyte char decimal double float int uint long ulong short ushort object string void var dynamic nint nuint");
const CS_CONST = words("true false null");
const csTable = {
  csDecl: t.definitionKeyword, csMod: t.modifier, csFlow: t.controlKeyword, csBuiltin: t.standard(t.typeName),
  csClass: t.className, csFn: t.function(t.variableName), csString: t.string, csNumber: t.number, csConst: t.bool,
  csComment: t.lineComment, csMeta: t.meta, csThis: t.self, csPunct: t.punctuation, csPlain: t.variableName,
};
const csMode = {
  name: "csharp",
  // in: an unfinished comment or string carried to the next line ("comment", "verbatim", "raw").
  // after: the last word or dot that matters for the next word. attr: inside [Attributes].
  startState: () => ({ in: null, after: null, attr: 0, decl: false, depth: 0 }),
  copyState: (s) => ({ ...s }),
  tokenTable: csTable,
  token(stream, st) {
    if (st.in === "comment") { if (stream.skipTo("*/")) { stream.next(); stream.next(); st.in = null; } else stream.skipToEnd(); return "csComment"; }
    if (st.in === "verbatim") { while (!stream.eol()) { if (stream.next() === '"') { if (stream.eat('"')) continue; st.in = null; break; } } return "csString"; }
    if (st.in === "raw") { if (stream.skipTo('"""')) { stream.match('"""'); stream.match(/^"*/); st.in = null; } else stream.skipToEnd(); return "csString"; }
    if (stream.sol() && stream.match(/^\s*#\w+/)) { stream.skipToEnd(); return "csMeta"; }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "csComment"; }
    if (stream.match("/*")) { st.in = "comment"; if (stream.skipTo("*/")) { stream.next(); stream.next(); st.in = null; } else stream.skipToEnd(); return "csComment"; }
    if (stream.match(/^\$*"""/)) { st.in = "raw"; if (stream.skipTo('"""')) { stream.match('"""'); st.in = null; } else stream.skipToEnd(); return "csString"; }
    if (stream.match(/^(\$@|@\$|@)"/)) { st.in = "verbatim"; while (!stream.eol()) { if (stream.next() === '"') { if (stream.eat('"')) continue; st.in = null; break; } } return "csString"; }
    if (stream.match(/^\$?"(?:[^"\\]|\\.)*"?/)) return "csString";
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "csString";
    if (stream.match(/^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[fFdDmMuUlL]*/)) return "csNumber";
    const w = stream.match(/^@?[A-Za-z_]\w*/);
    if (w) {
      const word = w[0];
      const after = st.after;
      st.after = word;
      if (st.attr) return "csMeta";
      if (after === "using" || (after === "." && st.usingLine)) { st.usingLine = true; return "csPlain"; }   // using System.Text;
      if (after === "." || after === "?.") {
        if (stream.match(/^\s*\(/, false)) return "csFn";
        return stream.match(/^\s*</, false) ? "csClass" : "csPlain";
      }
      if (CS_CONST[word]) return "csConst";
      if (word === "this" || word === "base") return "csThis";
      if (CS_BUILTIN[word]) return "csBuiltin";
      if (CS_DECL[word]) { st.decl = word !== "using" && word !== "new"; return "csDecl"; }
      if (CS_MOD[word]) return "csMod";
      if (CS_FLOW[word]) return "csFlow";
      const call = stream.match(/^\s*\(/, false);
      const upper = /^@?[A-Z]/.test(word) && !/^[A-Z0-9_]+$/.test(word.replace(/^@/, "")) || /^[A-Z]$/.test(word);
      if (st.decl) { st.decl = false; return "csClass"; }        // class Player, enum Status
      if (after === "new" && upper) return "csClass";            // new Player()
      if (call) return "csFn";                                    // Attack(), take()
      if (!upper) return "csPlain";
      // A capitalised name is a type when a name, <, . or [ follows (Player p, List<Item>,
      // Status.Dead, Item[]), or after : or < (class Player : Character, List<Item>).
      // Otherwise it's a property or field (Hp -= 1, Name { get; }), and stays plain.
      if (after === ":" || after === "<" || after === ",<" || stream.match(/^\s*(?:[A-Za-z_@.[]|<(?![=<])|\?\s*[A-Za-z_])/, false)) return "csClass";
      return "csPlain";
    }
    const ch = stream.next();
    st.after = ch === "." ? "." : ch === ":" ? ":" : ch === "<" ? "<" : ch === "," && st.after === "<" ? ",<" : null;
    if (ch === "?" && stream.eat(".")) { st.after = "?."; return "csPunct"; }
    if (ch === "{") st.depth++;
    if (ch === "}") st.depth = Math.max(0, st.depth - 1);
    if (ch === "[") {
      // [Serializable], [Header("x")]: an attribute when it starts the line
      if (st.attr) st.attr++;
      else if (/^\s*$/.test(stream.string.slice(0, stream.pos - 1)) && stream.match(/^\s*[A-Za-z]/, false)) { st.attr = 1; return "csMeta"; }
      return "csPunct";
    }
    if (ch === "]" && st.attr) { st.attr--; return "csMeta"; }
    if (st.attr) return "csMeta";
    if (ch === "{" || ch === ";" || ch === "(") { st.decl = false; st.usingLine = false; }
    return "csPunct";
  },
  indent: (st, textAfter, cx) => Math.max(0, st.depth - (/^\s*}/.test(textAfter) ? 1 : 0)) * cx.unit,
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", '"', "'"] },
    indentOnInput: /^\s*}$/,
  },
};

// ----- the table -----
const legacy = (mode, data) => {
  const lang = StreamLanguage.define(mode);
  return data ? [lang, lang.data.of(data)] : lang;
};

export const LANGS = {
  rust: { name: "Rust", dot: "rs", server: "rust", languageId: "rust", ext: () => [rust(), rustLanguage.data.of({ closeBrackets: { brackets: ["(", "[", "{", '"'] } })] },
  csharp: { name: "C#", dot: "cs", server: "csharp", languageId: "csharp", ext: () => new LanguageSupport(StreamLanguage.define(csMode)) },
  gdshader: { name: "Godot shader", dot: "shader", ext: () => new LanguageSupport(StreamLanguage.define(gdshaderMode)), complete: gdshaderCompletions },
  lust: { name: "Lust", dot: "lust", ext: () => [new LanguageSupport(StreamLanguage.define(lustMode)), Prec.high(syntaxHighlighting(lustStyle))], complete: (ctx) => lustMembers(ctx) || lustCompletions(ctx) },
  gdscript: { name: "GDScript", dot: "gd", ext: () => legacy(python, { commentTokens: { line: "#" } }) },
  godot: { name: "Godot resource", dot: "godot", ext: () => legacy(godotResource) },
  javascript: { name: "JavaScript", dot: "js", server: "web", tailwind: true, languageId: "javascript", ext: () => [javascript(), webColours(), tailwindSwatches()] },
  jsx: { name: "JavaScript React", dot: "js", server: "web", tailwind: true, languageId: "javascriptreact", ext: () => [javascript({ jsx: true }), webColours(), tailwindSwatches()] },
  typescript: { name: "TypeScript", dot: "ts", server: "web", tailwind: true, languageId: "typescript", ext: () => [javascript({ typescript: true }), webColours(), tailwindSwatches()] },
  tsx: { name: "TypeScript React", dot: "ts", server: "web", tailwind: true, languageId: "typescriptreact", ext: () => [javascript({ jsx: true, typescript: true }), webColours(), tailwindSwatches()] },
  html: { name: "HTML", dot: "html", server: "html", tailwind: true, languageId: "html", ext: () => [html(), webColours(), tailwindSwatches()] },
  css: { name: "CSS", dot: "css", server: "css", tailwind: true, languageId: "css", ext: () => [css(), webColours(), tailwindSwatches()] },
  scss: { name: "SCSS", dot: "css", server: "css", languageId: "scss", ext: () => [legacy(sCSS, { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } }), legacyCssColours()] },
  less: { name: "Less", dot: "css", server: "css", languageId: "less", ext: () => [legacy(less, { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } }), legacyCssColours()] },
  lua: { name: "Lua", dot: "lua", server: "lua", languageId: "lua", ext: () => legacy(lua, { commentTokens: { line: "--", block: { open: "--[[", close: "]]" } }, closeBrackets: { brackets: ["(", "[", "{", '"', "'"] } }) },
  luau: { name: "Luau", dot: "lua", languageId: "luau", ext: () => legacy(lua, { commentTokens: { line: "--", block: { open: "--[[", close: "]]" } }, closeBrackets: { brackets: ["(", "[", "{", '"', "'"] } }) },
  toml: { name: "TOML", dot: "toml", ext: () => legacy(toml) },
  json: { name: "JSON", dot: "json", server: "json", languageId: "json", ext: () => json() },
  jsonc: { name: "JSON with comments", dot: "json", server: "json", languageId: "jsonc", ext: () => json() },
  markdown: { name: "Markdown", dot: "md", ext: () => markdown() },
  xml: { name: "XML", dot: "xml", ext: () => legacy(xml, { commentTokens: { block: { open: "<!--", close: "-->" } } }) },
  yaml: { name: "YAML", dot: "cfg", ext: () => legacy(yaml) },
  ini: { name: "INI", dot: "cfg", ext: () => legacy(properties) },
  powershell: { name: "PowerShell", dot: "cfg", ext: () => legacy(powerShell) },
  text: { name: "Plain text", dot: "other", ext: () => [] },
};

const BY_EXT = {
  rs: "rust", cs: "csharp", csx: "csharp", lust: "lust", lst: "lust", lsc: "lust", gdshader: "gdshader", gdshaderinc: "gdshader", gd: "gdscript",
  tscn: "godot", tres: "godot", godot: "godot", import: "godot", cfg: "ini", ini: "ini", editorconfig: "ini",
  lua: "lua", luau: "luau", rockspec: "lua", toml: "toml", json: "json", jsonc: "jsonc", md: "markdown",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  html: "html", htm: "html", vue: "html", svelte: "html", astro: "html", css: "css", scss: "scss", sass: "scss", less: "less",
  csproj: "xml", fsproj: "xml", props: "xml", targets: "xml", slnx: "xml", xml: "xml", resx: "xml", xaml: "xml", config: "xml", svg: "xml",
  yml: "yaml", yaml: "yaml", ps1: "powershell", psm1: "powershell",
};

export function langOf(path) {
  const b = String(path).split(/[\\/]/).pop();
  if (b === "Cargo.lock") return "toml";
  if (b === ".editorconfig") return "ini";
  // JSON that allows comments (TypeScript, ESLint, Babel and editor configs).
  if (/^(tsconfig|jsconfig)(\..*)?\.json$|^\.(eslintrc|babelrc|swcrc)(\.json)?$|^devcontainer\.json$|^\.luarc\.json$/i.test(b)) return "jsonc";
  const e = (b.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  return BY_EXT[e] || "text";
}

/** Dot colour for the explorer and tabs. */
export function dotOf(path) {
  const b = String(path).split(/[\\/]/).pop();
  if (b === "Cargo.lock") return "lock";
  if (b === "project.godot") return "godot";
  if (/\.(sln|slnx|csproj)$/i.test(b)) return "proj";
  if (/\.(db|sqlite|sqlite3|db3|s3db)$/i.test(b)) return "db";
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|apng|jfif)$/i.test(b)) return "img";
  // Each kind of Lust file has its own icon: Lt (.lst, and Lust 1's .lust), Ls (.lsc), Lq (.lql).
  if (/\.lsc$/i.test(b)) return "lustscript";
  if (/\.lql$/i.test(b)) return "lustql";
  const l = langOf(path);
  if (b.startsWith(".") && l === "text") return "cfg";
  return LANGS[l].dot;
}
