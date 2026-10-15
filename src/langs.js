// Every file type Ledger knows: how to highlight it, which language server
// (if any) understands it, and what colour its dot is in the explorer.
import { StreamLanguage, LanguageSupport, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Tag } from "@lezer/highlight";
import { Prec } from "@codemirror/state";
import { rust, rustLanguage } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { csharp, clike } from "@codemirror/legacy-modes/mode/clike";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { python } from "@codemirror/legacy-modes/mode/python";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
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

// ----- Lust (.lust) -----
// Lust is our own language: C#'s skeleton, a Lua accent, and checks written as
// questions (`is hp 0? then { } or { }`).
//
// Lust has its own quiet colours rather than the shared theme: the words that
// give a program its shape (class, object, state, has, method…) in the logo's
// red, questions and loops in a lighter red, comments green, text and numbers
// sand, punctuation grey, and everything else plain.
const LUST_CONTROL = "is then or either loop stop skip give";
const LUST_DEFINE = "class object method do has state new like";
const LUST_MODULE = "send fetch get end save load saved";
const LUST_TYPES = "int float string truth array cArray map";
const LUST_BUILTINS = "print wait random ask readText writeText";
const lustSet = (s) => new Set(s.split(" "));
const LK = { control: lustSet(LUST_CONTROL), define: lustSet(LUST_DEFINE), module: lustSet(LUST_MODULE), types: lustSet(LUST_TYPES), builtins: lustSet(LUST_BUILTINS) };

const LT = {
  structure: Tag.define(),  // class object state has method do like new send fetch get end
  flow: Tag.define(),       // is then or either loop stop skip give not in ?
  name: Tag.define(),       // the name being declared: class Player, method hurt
  type: Tag.define(),       // int float string truth array cArray
  value: Tag.define(),      // "text", 42, true, nothing
  comment: Tag.define(),
  punct: Tag.define(),
  plain: Tag.define(),
};
const lustStyle = HighlightStyle.define([
  { tag: LT.structure, color: "var(--lust-red)", fontWeight: "600" },
  { tag: LT.flow, color: "var(--lust-flow)" },
  { tag: LT.name, color: "var(--ink)", fontWeight: "600" },
  { tag: LT.type, color: "var(--lust-type)" },
  { tag: LT.value, color: "var(--lust-value)" },
  { tag: LT.comment, color: "var(--lust-comment)", fontStyle: "italic" },
  { tag: LT.punct, color: "var(--lust-punct)" },
  { tag: LT.plain, color: "var(--ink)" },
]);

const lustMode = {
  name: "lust",
  // depth: open { and [ for indenting. def: the next name is being defined
  // ("type" after class/object, "fn" after method/do). after: the last
  // punctuation that matters for the next word (":" or ".").
  startState: () => ({ depth: 0, def: null, after: null }),
  copyState: (s) => ({ ...s }),
  tokenTable: { lustStructure: LT.structure, lustFlow: LT.flow, lustName: LT.name, lustType: LT.type, lustValue: LT.value, lustComment: LT.comment, lustPunct: LT.punct, lustPlain: LT.plain },
  token(stream, st) {
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "lustComment"; }
    const after = st.after;
    st.after = null;
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "lustValue";
    if (stream.match(/^\d+(?:\.\d+)?/)) return "lustValue";
    const w = stream.match(/^[A-Za-z_]\w*/);
    if (w) {
      const word = w[0];
      if (after === ":" || after === ".") return "lustPlain";
      if (word === "true" || word === "nothing") return "lustValue";
      if (word === "not" || word === "in") return "lustFlow";
      if (LK.control.has(word)) return "lustFlow";
      if (LK.define.has(word)) { st.def = word === "class" || word === "object" ? "type" : word === "method" || word === "do" ? "fn" : null; return "lustStructure"; }
      if (LK.module.has(word)) return "lustStructure";
      if (LK.types.has(word)) return "lustType";
      if (st.def === "type") { st.def = null; return "lustName"; }
      const call = stream.match(/^\s*\(/, false);
      if (st.def === "fn" && call) { st.def = null; return "lustName"; }
      return "lustPlain";
    }
    const ch = stream.next();
    if (ch === "{" || ch === "[") { st.depth++; st.def = null; return "lustPunct"; }
    if (ch === "}" || ch === "]") { st.depth = Math.max(0, st.depth - 1); return "lustPunct"; }
    if (ch === "(" || ch === ")") { st.def = null; return "lustPunct"; }
    if (ch === "?") return "lustFlow";
    if (ch === ":" || ch === ".") { st.after = ch; return "lustPunct"; }
    if (ch === ";" || ch === ",") { st.def = null; return "lustPunct"; }
    return "lustPunct";
  },
  indent(st, textAfter, cx) {
    return Math.max(0, st.depth - (/^\s*[}\]]/.test(textAfter) ? 1 : 0)) * cx.unit;
  },
  languageData: {
    commentTokens: { line: "//" },
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
  { label: "true", type: "constant" }, { label: "not true", type: "constant" }, { label: "nothing", type: "constant" },
  snip("class ${Name} {\n\thas {\n\t\t${}\n\t}\n}", { label: "class", detail: "blueprint, made with new", type: "class" }),
  snip("object ${Name} {\n\thas {\n\t\t${}\n\t}\n}", { label: "object", detail: "one ready-made thing", type: "class" }),
  snip("has {\n\t${int}[${name} ${0}];\n}", { label: "has", detail: "fields", type: "text" }),
  snip("method ${name}(${}) {\n\t${}\n}", { label: "method", detail: "belongs to a class or object", type: "function" }),
  snip("do ${name}(${}) {\n\t${}\n}", { label: "do", detail: "function", type: "function" }),
  snip("is ${value} ${check}? then {\n\t${}\n}", { label: "is", detail: "question check", type: "text" }),
  snip("is ${value} ${check}? then {\n\t${}\n} or {\n\t${}\n}", { label: "is … or", detail: "question check with fallback", type: "text" }),
  snip("either ${check}? ${yes} or ${no}", { label: "either", detail: "one-line check", type: "text" }),
  snip("loop {\n\t${}\n}", { label: "loop", detail: "forever, until stop", type: "text" }),
  snip("loop ${3} {\n\t${}\n}", { label: "loop times", detail: "repeat", type: "text" }),
  snip("loop (${check}) {\n\t${}\n}", { label: "loop while", detail: "while true", type: "text" }),
  snip("loop (${type} ${item} in ${list}) {\n\t${}\n}", { label: "loop in", detail: "each item", type: "text" }),
  snip("state = [${idle}, ${busy}];", { label: "state", detail: "this file's state", type: "text" }),
  snip("cArray(${string name}) ${bag} = [];", { label: "cArray", detail: "connected array", type: "type" }),
  snip("fetch ${file}:${Thing};", { label: "fetch", detail: "bring in", type: "keyword" }),
  snip("get ${file}:${thing};", { label: "get", detail: "bring in one", type: "keyword" }),
]);

// ----- the table -----
const legacy = (mode, data) => {
  const lang = StreamLanguage.define(mode);
  return data ? [lang, lang.data.of(data)] : lang;
};

export const LANGS = {
  rust: { name: "Rust", dot: "rs", server: "rust", languageId: "rust", ext: () => [rust(), rustLanguage.data.of({ closeBrackets: { brackets: ["(", "[", "{", '"'] } })] },
  csharp: { name: "C#", dot: "cs", server: "csharp", languageId: "csharp", ext: () => legacy(csharp, { closeBrackets: { brackets: ["(", "[", "{", '"', "'"] }, commentTokens: { line: "//", block: { open: "/*", close: "*/" } } }) },
  gdshader: { name: "Godot shader", dot: "shader", ext: () => new LanguageSupport(StreamLanguage.define(gdshaderMode)), complete: gdshaderCompletions },
  lust: { name: "Lust", dot: "lust", ext: () => [new LanguageSupport(StreamLanguage.define(lustMode)), Prec.high(syntaxHighlighting(lustStyle))], complete: lustCompletions },
  gdscript: { name: "GDScript", dot: "gd", ext: () => legacy(python, { commentTokens: { line: "#" } }) },
  godot: { name: "Godot resource", dot: "godot", ext: () => legacy(godotResource) },
  toml: { name: "TOML", dot: "toml", ext: () => legacy(toml) },
  json: { name: "JSON", dot: "json", ext: () => json() },
  markdown: { name: "Markdown", dot: "md", ext: () => markdown() },
  xml: { name: "XML", dot: "xml", ext: () => legacy(xml, { commentTokens: { block: { open: "<!--", close: "-->" } } }) },
  yaml: { name: "YAML", dot: "cfg", ext: () => legacy(yaml) },
  ini: { name: "INI", dot: "cfg", ext: () => legacy(properties) },
  powershell: { name: "PowerShell", dot: "cfg", ext: () => legacy(powerShell) },
  text: { name: "Plain text", dot: "other", ext: () => [] },
};

const BY_EXT = {
  rs: "rust", cs: "csharp", csx: "csharp", lust: "lust", gdshader: "gdshader", gdshaderinc: "gdshader", gd: "gdscript",
  tscn: "godot", tres: "godot", godot: "godot", import: "godot", cfg: "ini", ini: "ini", editorconfig: "ini",
  toml: "toml", json: "json", md: "markdown",
  csproj: "xml", fsproj: "xml", props: "xml", targets: "xml", slnx: "xml", xml: "xml", resx: "xml", xaml: "xml", config: "xml", svg: "xml",
  yml: "yaml", yaml: "yaml", ps1: "powershell", psm1: "powershell",
};

export function langOf(path) {
  const b = String(path).split(/[\\/]/).pop();
  if (b === "Cargo.lock") return "toml";
  if (b === ".editorconfig") return "ini";
  const e = (b.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  return BY_EXT[e] || "text";
}

/** Dot colour for the explorer and tabs. */
export function dotOf(path) {
  const b = String(path).split(/[\\/]/).pop();
  if (b === "Cargo.lock") return "lock";
  if (b === "project.godot") return "godot";
  if (/\.(sln|slnx|csproj)$/i.test(b)) return "proj";
  const l = langOf(path);
  if (b.startsWith(".") && l === "text") return "cfg";
  return LANGS[l].dot;
}
