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

// Snippets that come with Ledger (yours in snippets.json come first and can reuse a prefix).
// C#: the ones Visual Studio users type without thinking.
const BUILTIN = {
  csharp: {
    "Property": { prefix: "prop", body: "public ${1:int} ${2:Name} { get; set; }$0" },
    "Read-only property": { prefix: "propg", body: "public ${1:int} ${2:Name} { get; }$0" },
    "Init-only property": { prefix: "propi", body: "public ${1:int} ${2:Name} { get; init; }$0" },
    "Property with a field": { prefix: "propfull", body: ["private ${1:int} ${2:name};", "", "public $1 ${3:Name}", "{", "    get => $2;", "    set => $2 = value;", "}$0"] },
    "Constructor": { prefix: "ctor", body: ["public ${TM_FILENAME_BASE}($1)", "{", "    $0", "}"] },
    "Console.WriteLine": { prefix: "cw", body: "Console.WriteLine($1);$0" },
    "Main": { prefix: "svm", body: ["static void Main(string[] args)", "{", "    $0", "}"] },
    "if": { prefix: "if", body: ["if (${1:true})", "{", "    $0", "}"] },
    "else": { prefix: "else", body: ["else", "{", "    $0", "}"] },
    "for": { prefix: "for", body: ["for (int ${1:i} = 0; $1 < ${2:length}; $1++)", "{", "    $0", "}"] },
    "for, backwards": { prefix: "forr", body: ["for (int ${1:i} = ${2:length} - 1; $1 >= 0; $1--)", "{", "    $0", "}"] },
    "foreach": { prefix: "foreach", body: ["foreach (var ${1:item} in ${2:items})", "{", "    $0", "}"] },
    "while": { prefix: "while", body: ["while (${1:true})", "{", "    $0", "}"] },
    "do while": { prefix: "do", body: ["do", "{", "    $0", "} while (${1:true});"] },
    "switch": { prefix: "switch", body: ["switch (${1:value})", "{", "    case ${2:x}:", "        $0", "        break;", "    default:", "        break;", "}"] },
    "switch expression": { prefix: "switchx", body: ["${1:value} switch", "{", "    ${2:x} => ${3:result},", "    _ => ${4:other},", "}$0"] },
    "try catch": { prefix: "try", body: ["try", "{", "    $1", "}", "catch (${2:Exception} ${3:ex})", "{", "    $0", "}"] },
    "try finally": { prefix: "tryf", body: ["try", "{", "    $1", "}", "finally", "{", "    $0", "}"] },
    "using": { prefix: "using", body: ["using (${1:var resource = $2})", "{", "    $0", "}"] },
    "lock": { prefix: "lock", body: ["lock (${1:this})", "{", "    $0", "}"] },
    "class": { prefix: "class", body: ["public class ${1:${TM_FILENAME_BASE}}", "{", "    $0", "}"] },
    "interface": { prefix: "interface", body: ["public interface ${1:I${TM_FILENAME_BASE}}", "{", "    $0", "}"] },
    "record": { prefix: "record", body: "public record ${1:Name}(${2:string Value});$0" },
    "struct": { prefix: "struct", body: ["public struct ${1:Name}", "{", "    $0", "}"] },
    "enum": { prefix: "enum", body: ["public enum ${1:Name}", "{", "    ${2:First},", "    $0", "}"] },
    "namespace": { prefix: "namespace", body: "namespace ${1:Name};$0" },
    "async method": { prefix: "asyncm", body: ["public async Task${1:<${2:int}>} ${3:NameAsync}($4)", "{", "    $0", "}"] },
    "method": { prefix: "method", body: ["public ${1:void} ${2:Name}($3)", "{", "    $0", "}"] },
    "xUnit test": { prefix: "fact", body: ["[Fact]", "public void ${1:Name}()", "{", "    $0", "}"] },
    "xUnit theory": { prefix: "theory", body: ["[Theory]", "[InlineData(${1:1})]", "public void ${2:Name}(int ${3:value})", "{", "    $0", "}"] },
    "NUnit test": { prefix: "test", body: ["[Test]", "public void ${1:Name}()", "{", "    $0", "}"] },
    "MSTest test": { prefix: "testm", body: ["[TestMethod]", "public void ${1:Name}()", "{", "    $0", "}"] },
    "Exception class": { prefix: "exception", body: ["public class ${1:My}Exception : Exception", "{", "    public $1Exception(string message) : base(message) { }", "}$0"] },
  },
};

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
      const builtin = BUILTIN[lang] || BUILTIN[langId];
      if (!groups.length && !builtin) return null;
      const path = app.S.active || "";
      const vars = { TM_FILENAME: app.base(path), TM_FILENAME_BASE: app.base(path).replace(/\.[^.]*$/, ""), TM_DIRECTORY: app.parent(path), TM_FILEPATH: path, CURRENT_YEAR: String(new Date().getFullYear()) };
      const options = [];
      for (const g of groups) for (const [name, sn] of Object.entries(g)) {
        if (!sn || typeof sn !== "object") continue;
        for (const prefix of [].concat(sn.prefix || name)) {
          options.push(snippetCompletion(template(sn.body, vars), { label: prefix, detail: sn.description || name, type: "snippet", boost: 5 }));
        }
      }
      // Ledger's own, unless you've made one with the same prefix.
      const mine = new Set(options.map((o) => o.label));
      if (builtin) for (const [name, sn] of Object.entries(builtin)) if (!mine.has(sn.prefix)) options.push(snippetCompletion(template(sn.body, vars), { label: sn.prefix, detail: name, type: "snippet", boost: -1 }));
      return { from: word ? word.from : ctx.pos, options };
    };
  }
  app.saveHooks.push((path) => { if (file() && path.toLowerCase() === file().toLowerCase()) load().then(() => app.toast("Snippets reloaded")); });
  app.command("snippets.edit", "Edit snippets", [], edit);
  load();
  return { edit, source, load };
}
