// Your own snippets, kept in snippets.json next to settings.json. Same shape
// as VS Code's: a language, then named snippets with a prefix and a body.
// They show up in completions when you type the prefix; Tab moves between
// the $1, $2… fields.
import { invoke } from "@tauri-apps/api/core";
import { snippetCompletion } from "@codemirror/autocomplete";

const EXAMPLE = `{
  "rust": {
    "Test function": {
      "prefix": "test",
      "body": ["#[test]", "fn \${1:name}() {", "    $0", "}"],
      "description": "A unit test"
    },
    "Print a value": {
      "prefix": "dbgp",
      "body": "println!(\\"{:?}\\", $1);"
    }
  },
  "csharp": {
    "Godot export": {
      "prefix": "export",
      "body": "[Export] public \${1:float} \${2:Speed} { get; set; } = \${3:1};"
    }
  },
  "*": {}
}
`;

// JSON with comments and trailing commas, like VS Code's own files.
function looseJson(text) {
  const noComments = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || "");
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1"));
}

/** VS Code snippet body → CodeMirror template. */
function template(body, vars) {
  let s = Array.isArray(body) ? body.join("\n") : String(body || "");
  s = s.replace(/\$\{(\d+)\|([^|]*)\|\}/g, (_, n, opts) => `\${${n}:${opts.split(",")[0]}}`); // choices: first one
  s = s.replace(/\$\{?(TM_FILENAME_BASE|TM_FILENAME|TM_DIRECTORY|TM_FILEPATH|CURRENT_YEAR|CLIPBOARD|TM_SELECTED_TEXT)\}?/g, (_, v) => vars[v] ?? "");
  s = s.replace(/\$(\d+)/g, "${$1}");
  s = s.replace(/\$\{0\}/g, "${99}").replace(/\$\{0:/g, "${99:"); // $0 is the last stop
  return s;
}

export function initSnippets(app, settingsFile) {
  const file = () => (settingsFile() ? app.parent(settingsFile()) + "/snippets.json" : null);
  let data = {};
  async function load() {
    const f = file();
    if (!f) return;
    try { data = looseJson(await invoke("read_file", { path: f })); }
    catch (e) { data = {}; if (!/No such file|cannot find|os error 2/i.test(String(e))) app.toast("snippets.json has a mistake in it: " + (e.message || e), 6000); }
  }
  async function edit() {
    const f = file();
    if (!f) return;
    try { await invoke("create_file", { path: f }); await invoke("write_file", { path: f, contents: EXAMPLE }); } catch {}
    await app.openFile(f);
  }
  function source(lang, langId) {
    return (ctx) => {
      const word = ctx.matchBefore(/[\w#@.-]+$/);
      if (!word && !ctx.explicit) return null;
      const groups = [...new Set([data[lang], data[langId], data["*"]])].filter((g) => g && typeof g === "object");
      if (!groups.length) return null;
      const path = app.S.active || "";
      const vars = { TM_FILENAME: app.base(path), TM_FILENAME_BASE: app.base(path).replace(/\.[^.]*$/, ""), TM_DIRECTORY: app.parent(path), TM_FILEPATH: path, CURRENT_YEAR: String(new Date().getFullYear()) };
      const options = [];
      for (const g of groups) for (const [name, sn] of Object.entries(g)) {
        if (!sn || typeof sn !== "object") continue;
        for (const prefix of [].concat(sn.prefix || name)) {
          options.push(snippetCompletion(template(sn.body, vars), { label: prefix, detail: sn.description || name, type: "snippet", boost: 5 }));
        }
      }
      return { from: word ? word.from : ctx.pos, options };
    };
  }
  app.saveHooks.push((path) => { if (file() && path.toLowerCase() === file().toLowerCase()) load().then(() => app.toast("Snippets reloaded")); });
  app.command("snippets.edit", "Edit snippets", [], edit);
  load();
  return { edit, source, load };
}
