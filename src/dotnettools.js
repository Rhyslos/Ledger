// .NET tools around running a project: user secrets, the HTTPS development certificate, .http
// request files, Entity Framework Core migrations and Publish.
//
// Everything that builds or runs the project goes through startSteps, so restricted mode asks
// first. Installing a tool (dotnet-ef) and trusting the certificate run in your home folder.
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { parseHttpFile, expand, readEnvFile } from "./httpfile.js";
import { parseSdks, globalJsonProblem } from "./dotnetsdk.js";
import { installSdk } from "./settings.js";

export function initDotnetTools(app) {
  const { S, esc, prefs } = app;
  const D = () => app.dotnet;
  const project = () => (S.ctx?.dotnet ? S.ctx : null);
  const need = () => { const P = project(); if (!P) app.toast("Open a file from a C# project first (one with a .csproj or .sln)."); return P; };
  const readText = async (p) => { try { return (await invoke("read_file", { path: p })).replace(/^﻿/, ""); } catch { return null; } };
  /** The project a command is about: the one given, the open file's, or the startup project. */
  async function pick(p, test, what) {
    if (p) return p;
    const P = need();
    if (!P) return null;
    const m = await D().load();
    const own = D().projOf(P.csproj);
    if (own && (!test || test(own))) return own;
    const list = (m?.projects || []).filter((x) => !x.missing && (!test || test(x)));
    if (!list.length) { app.toast(`No project here ${what}.`, 5000); return null; }
    if (list.length === 1) return list[0];
    const i = await app.choose(`Which project?`, list.map((x) => x.name + "  ·  " + app.rel(x.dir)), true);
    return i == null || i < 0 ? null : list[i];
  }
  const run = (steps, done) => app.startSteps(steps, async () => { await D().load?.(); await app.refreshTree?.(); done?.(); });

  // ---------- user secrets ----------
  // Settings kept out of the project (connection strings, API keys): secrets.json in your profile,
  // found by the project's UserSecretsId. ASP.NET Core reads them in Development.
  async function editSecrets(p) {
    p = await pick(p, null, "");
    if (!p) return;
    if (!p.secrets) {
      const c = await app.choose(`${p.name} has no user secrets yet. Set them up? (dotnet user-secrets init adds a UserSecretsId to ${app.base(p.path)})`, ["Set up user secrets", "Cancel"]);
      if (c !== "Set up user secrets") return;
      run([{ label: "dotnet user-secrets init", program: "dotnet", args: ["user-secrets", "init", "--project", p.path], cwd: p.dir }], async () => {
        const t = await readText(p.path);
        const id = /<UserSecretsId>\s*([^<]+?)\s*<\/UserSecretsId>/.exec(t || "")?.[1];
        if (id) openSecrets(id); else app.toast("dotnet user-secrets didn't add an id.", 5000);
      });
      return;
    }
    openSecrets(p.secrets);
  }
  async function openSecrets(id) {
    try { await app.openFile(await invoke("user_secrets_file", { id })); }
    catch (e) { app.toast("Couldn't open the secrets: " + e, 6000); }
  }

  // ---------- the HTTPS development certificate ----------
  function trustCert() {
    app.startSteps([{ label: "dotnet dev-certs https --trust", program: "dotnet", args: ["dev-certs", "https", "--trust"], install: true }],
      () => app.toast("The development certificate is trusted. Restart the browser if it still warns.", 6000));
  }

  // ---------- .http files ----------
  // http-client.env.json (and .user beside it) in the file's folder or one above, up to the root.
  async function envFor(path) {
    for (let d = app.parent(path); d; d = app.parent(d)) {
      const main = await readText(d + "/http-client.env.json");
      if (main != null) {
        const user = await readText(d + "/http-client.env.json.user");
        const a = readEnvFile(main), b = user ? readEnvFile(user) : null;
        const names = [...new Set([...a.names, ...(b?.names || [])])];
        return { dir: d, names, vars: (n) => ({ ...a.vars(n), ...(b ? b.vars(n) : {}) }) };
      }
      if (!S.root || d === S.root || !app.isUnder(d, S.root)) break;
    }
    return null;
  }
  const envName = (env) => { const n = (prefs.httpEnv ||= {})[env.dir]; return env.names.includes(n) ? n : env.names[0]; };
  async function pickEnv() {
    const path = S.active;
    if (!/\.(http|rest)$/i.test(path || "")) { app.toast("Open a .http file first."); return; }
    const env = await envFor(path);
    if (!env?.names.length) { app.toast("No http-client.env.json next to this file (or above it)."); return; }
    const cur = envName(env);
    const i = await app.choose("Environment for .http requests", env.names.map((n) => n + (n === cur ? "  (now)" : "")), true);
    if (i == null || i < 0) return;
    prefs.httpEnv[env.dir] = env.names[i];
    app.savePrefs();
    app.toast(`Requests use the ${env.names[i]} environment.`);
  }
  let sending = 0;
  async function sendHttp(path, index) {
    const b = S.bufs.get(path);
    const text = b ? b.state.doc.toString() : await readText(path);
    const { vars, requests } = parseHttpFile(text || "");
    if (index == null) {
      // The request the cursor is in.
      const line = b && app.view?.state === b.state ? b.state.doc.lineAt(b.state.selection.main.head).number - 1 : 0;
      index = Math.max(0, requests.findLastIndex((r) => r.line <= line));
    }
    const r = requests[index];
    if (!r) { app.toast("No request here. A request starts with a line like GET https://localhost:5001/todos."); return; }
    const env = await envFor(path);
    const ev = env ? env.vars(envName(env)) : {};
    const url = expand(r.url, vars, ev);
    const headers = r.headers.map(([k, v]) => [k, expand(v, vars, ev)]);
    const missing = /\{\{\s*([^}$][^}]*?)\s*\}\}/.exec(url + " " + headers.flat().join(" "));
    if (missing) { app.toast(`{{${missing[1]}}} isn't set: add @${missing[1]} = … above the request${env ? "" : " or an http-client.env.json"}.`, 6000); return; }
    let body = r.body ? expand(r.body, vars, ev) : "";
    // < ./file.json sends that file as the body: only a file inside the open folder, so a .http
    // file can't send your other files (a key from your profile, say) anywhere.
    const from = /^<\s+(.+)$/.exec(body.trim());
    if (from) {
      const file = app.norm(app.isAbs(from[1]) ? from[1] : app.parent(path) + "/" + from[1]).split("/").reduce((a, x) => (x === ".." ? a.slice(0, -1) : x === "." ? a : [...a, x]), []).join("/");
      if (!S.root || !app.isUnder(file, S.root)) { app.toast(`${from[1]} is outside the open folder, so it isn't sent.`, 6000); return; }
      body = await readText(file);
      if (body == null) { app.toast("Couldn't read " + from[1]); return; }
    }
    // A restricted folder chose this address and body: show where it goes before sending.
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url);
    if (!app.trusted() && !local) {
      const c = await app.choose(`Send ${r.method} ${url}${from ? ` with ${from[1]}` : ""}? ${app.base(S.root || "")} is in restricted mode, and the .http file chose this address.`, ["Cancel", "Send it"]);
      if (c !== "Send it") return;
    }
    const n = ++sending;
    app.toast(`${r.method} ${url}…`, 100000);
    let res;
    try { res = await invoke("http_request", { method: r.method, url, headers, body: body || null }); }
    catch (e) { if (n === sending) app.toast(`${r.method} ${url} failed: ${e}`, 8000); return; }
    if (n !== sending) return;
    app.toast(`${res.status} ${res.reason} · ${res.ms} ms`, 2500);
    const type = (res.headers.find(([k]) => /^content-type$/i.test(k))?.[1] || "").toLowerCase();
    let shown = res.body;
    if (/json/.test(type) || /^\s*[[{]/.test(shown)) { try { shown = JSON.stringify(JSON.parse(shown), null, 2); } catch {} }
    const out = `HTTP/1.1 ${res.status} ${res.reason}\n${res.headers.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${shown}\n`;
    const head = `# ${r.method} ${url}${env ? `  (${envName(env)})` : ""} · ${res.ms} ms\n`;
    await app.openVirtual("@http:" + path, head + out, { lang: "http", label: "Response · " + (r.name || app.base(path)) });
  }

  // ---------- Entity Framework Core ----------
  async function haveEf() {
    if (await invoke("tool_info", { name: "dotnet-ef" }).catch(() => null)) return true;
    const c = await app.choose("Entity Framework commands need the dotnet-ef tool, which isn't installed. Install it? (dotnet tool install --global dotnet-ef)", ["Install dotnet-ef", "Cancel"]);
    if (c === "Install dotnet-ef") installEf();
    return false;
  }
  async function installEf(done) {
    const have = await invoke("tool_info", { name: "dotnet-ef" }).catch(() => null);
    app.startSteps([{ label: `dotnet tool ${have ? "update" : "install"} dotnet-ef`, program: "dotnet", args: ["tool", have ? "update" : "install", "--global", "dotnet-ef"], install: true }], async () => {
      await invoke("refresh_path").catch(() => {});
      app.toast("dotnet-ef is installed.");
      done?.();
    });
  }
  /** --project (where the DbContext and Migrations live) and --startup-project (what runs it). */
  async function efTarget(given) {
    const p = await pick(given?.ef ? given : null, (x) => x.ef, "uses Entity Framework Core (a Microsoft.EntityFrameworkCore package)");
    if (!p) return null;
    const o = D().opts(project());
    const start = o.startup && o.startup !== p.path ? ["--startup-project", o.startup] : [];
    return { p, args: ["--project", p.path, ...start, ...(o.config !== "Debug" ? ["--configuration", o.config] : []), ...(o.framework ? ["--framework", o.framework] : [])] };
  }
  async function ef(label, sub, after, given) {
    if (!(await haveEf())) return;
    const t = await efTarget(given);
    if (!t) return;
    const extra = typeof sub === "function" ? await sub(t.p) : sub;
    if (!extra) return;
    run([{ label: "dotnet ef " + label, program: "dotnet", args: ["ef", ...extra, ...t.args], cwd: t.p.dir }], () => after?.(t.p));
  }
  const migrationName = async () => {
    const name = (await app.promptText("Name the migration", "", "AddCustomerEmail"))?.trim();
    if (!name) return null;
    if (!/^[A-Za-z_]\w*$/.test(name)) { app.toast("A migration name is a C# name: letters, digits and _."); return null; }
    return ["migrations", "add", name];
  };
  async function updateDatabase(given) {
    const choice = await app.choose("Update the database", ["To the newest migration", "To a migration I name…", "Undo every migration (to 0)"], true);
    if (choice == null || choice < 0) return;
    if (choice === 0) return ef("database update", ["database", "update"], null, given);
    if (choice === 2) {
      const c = await app.choose("Undo every migration? This drops the tables the migrations made, with their data.", ["Undo them all", "Cancel"]);
      if (c === "Undo them all") ef("database update 0", ["database", "update", "0"], null, given);
      return;
    }
    const name = (await app.promptText("Update the database to which migration?", "", "AddCustomerEmail"))?.trim();
    if (name) ef("database update " + name, ["database", "update", name], null, given);
  }
  async function sqlScript() {
    ef("migrations script", (p) => ["migrations", "script", "--idempotent", "--output", p.dir + "/obj/ledger-migrations.sql"], (p) => app.openFile(p.dir + "/obj/ledger-migrations.sql"));
  }

  // ---------- publish ----------
  async function publish(p) {
    p = await pick(p, (x) => D().runnable(x) || /web/i.test(x.sdk || ""), "makes a program (OutputType Exe) or a web app");
    if (!p) return;
    const how = await app.choose(`Publish ${p.name}`, ["Framework-dependent: small, needs .NET installed where it runs", "Self-contained: includes .NET, runs anywhere of that system"], true);
    if (how == null || how < 0) return;
    const self = how === 1;
    const rids = [["win-x64", "Windows (x64)"], ["win-arm64", "Windows on Arm"], ["linux-x64", "Linux (x64)"], ["linux-arm64", "Linux on Arm"], ["osx-arm64", "macOS (Apple silicon)"], ["osx-x64", "macOS (Intel)"]];
    const ridList = self ? rids : [["", "Any system with .NET (a .dll)"], ...rids];
    const r = await app.choose("For which system?", ridList.map(([id, l]) => l + (id ? "  ·  " + id : "")), true);
    if (r == null || r < 0) return;
    const rid = ridList[r][0];
    const shapes = rid ? (self ? ["A folder of files", "One file", "One file, trimmed (smaller; check it still works: trimming can break reflection)"] : ["A folder of files", "One file"]) : ["A folder of files"];
    const s = shapes.length > 1 ? await app.choose("What should it make?", shapes, true) : 0;
    if (s == null || s < 0) return;
    const single = s >= 1, trimmed = s === 2;
    const out = `${p.dir}/bin/publish/${rid || "portable"}${self ? "-self-contained" : ""}`;
    const args = ["publish", p.path, "-c", "Release", "-o", out, "-nologo",
      ...(rid ? ["-r", rid, "--self-contained", self ? "true" : "false"] : []),
      ...(single ? ["-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true"] : []),
      ...(trimmed ? ["-p:PublishTrimmed=true"] : []),
      ...(D().opts(project()).framework ? ["-f", D().opts(project()).framework] : [])];
    app.startSteps([{ label: "dotnet publish", program: "dotnet", args, cwd: p.dir }], async () => {
      const exe = `${out}/${p.name}${rid.startsWith("win") ? ".exe" : rid ? "" : ".dll"}`;
      const has = await invoke("resolve_path", { path: exe, cwd: out }).catch(() => null);
      app.appendOut?.(`<span class="done">Published to ${esc(app.rel(out))}</span>`);
      revealItemInDir(has ? exe : out).catch(() => {});
    });
  }

  // ---------- when a folder with .NET projects opens ----------
  // global.json pinning an SDK that isn't here, the project's own tools (dotnet tool restore),
  // and NuGet packages (dotnet restore) so the language server and the first build find them.
  let openedFor = null;
  async function onOpen() {
    const root = S.root;
    if (!root || openedFor === root) return;
    openedFor = root;
    await app.loadFiles?.();
    if (S.root !== root) return;
    const files = S.files || [];
    if (!files.some((f) => /\.(csproj|fsproj|slnx?)$/i.test(f))) return;
    const asked = (prefs.dotnetAsked ||= {});
    const gj = await readText(root + "/global.json");
    if (gj != null && S.root === root) {
      const r = await invoke("run_capture", { cwd: ".", program: "dotnet", args: ["--list-sdks"] }).catch(() => null);
      const sdks = r ? parseSdks(r.out) : [];
      const problem = r && globalJsonProblem(gj, sdks);
      if (problem && asked[root + "|sdk"] !== problem.version) {
        asked[root + "|sdk"] = problem.version; app.savePrefs();
        const install = `Install the .NET ${problem.major} SDK`;
        // winget has one package per major version (its newest); a pin to an older feature band of
        // a major that's installed needs that exact SDK from the download page.
        const canWinget = problem.major >= 6 && problem.major <= 10 && !sdks.some((v) => parseInt(v, 10) === problem.major);
        const page = `Open the download page for ${problem.version}`;
        const c = await app.choose(problem.message, canWinget ? [install, "Not now"] : [page, "Not now"]);
        if (c === install) installSdk(problem.major);
        if (c === page) openUrl(`https://dotnet.microsoft.com/download/dotnet/${problem.major}.0`).catch(() => {});
        return; // nothing else works until that SDK is here
      }
    }
    if (!app.trusted() || S.root !== root) return;
    const manifest = files.find((f) => /(^|\/)\.config\/dotnet-tools\.json$/i.test(f) && app.parent(app.parent(f)) === root);
    if (manifest && app.settings.dotnetToolRestore && !asked[root + "|tools"]) {
      let names = [];
      try { names = Object.keys(JSON.parse((await readText(manifest)) || "{}").tools || {}); } catch {}
      asked[root + "|tools"] = true; app.savePrefs();
      const c = await app.choose(`This project uses its own .NET tools${names.length ? ` (${names.slice(0, 5).join(", ")})` : ""}. Restore them? (dotnet tool restore)`, ["Restore them", "Not now"]);
      if (c === "Restore them") app.startSteps([{ label: "dotnet tool restore", program: "dotnet", args: ["tool", "restore"], cwd: root }]);
    }
    if (app.settings.dotnetRestoreOnOpen) restoreQuietly(root);
  }
  async function restoreQuietly(root) {
    const sln = files().find((f) => /\.slnx?$/i.test(f) && app.parent(f) === root);
    const target = sln || (files().filter((f) => /\.csproj$/i.test(f)).length === 1 ? files().find((f) => /\.csproj$/i.test(f)) : null);
    if (!target) return;
    const r = await invoke("run_capture", { cwd: app.parent(target), program: "dotnet", args: ["restore", target, "-nologo", "-v", "m"], timeoutMs: 300000 }).catch((e) => ({ code: -1, out: "", err: String(e) }));
    if (S.root !== root) return;
    if (r.code !== 0) {
      const first = (r.out + "\n" + r.err).split("\n").find((l) => /error/i.test(l)) || r.err.split("\n")[0] || "";
      app.toast("dotnet restore didn't finish: " + first.trim().slice(0, 220), 9000);
      return;
    }
    // Packages arrived after the language server loaded the projects: load them again.
    if (/Restored /.test(r.out)) app.startServer("csharp");
  }
  const files = () => S.files || [];
  app.folderHooks.push(() => setTimeout(() => onOpen().catch(() => {}), 1500));
  app.trustHooks.push((yes) => { if (yes) { openedFor = null; setTimeout(() => onOpen().catch(() => {}), 300); } });

  app.dotnetHooks.secrets = editSecrets;
  app.dotnetHooks.addMigration = (p) => ef("migrations add", migrationName, null, p);
  app.dotnetHooks.updateDatabase = (p) => updateDatabase(p);
  app.dotnetHooks.publish = publish;
  app.dotnetHooks.sendHttp = sendHttp;

  const C = (id, title, fn, alias) => app.command(id, title, [], fn, alias ? { alias } : undefined);
  C("dotnet.secrets", "C#: edit user secrets", () => editSecrets(), "secrets.json usersecrets connection string api key");
  C("dotnet.devCerts", "C#: trust the HTTPS development certificate", trustCert, "dev-certs https certificate localhost ssl");
  C("dotnet.publish", "C#: publish…", () => publish(), "release self-contained single file trimmed win-x64 deploy");
  C("http.send", "HTTP: send the request at the cursor", () => { if (/\.(http|rest)$/i.test(S.active || "")) sendHttp(S.active); else app.toast("Open a .http file first."); }, "rest client request");
  C("http.environment", "HTTP: pick the environment (http-client.env.json)", pickEnv, "rest env");
  C("ef.install", "EF Core: install or update dotnet-ef", () => installEf(), "entity framework tool");
  C("ef.addMigration", "EF Core: add a migration", () => ef("migrations add", migrationName), "entity framework migration");
  C("ef.listMigrations", "EF Core: list migrations", () => ef("migrations list", ["migrations", "list"]), "entity framework");
  C("ef.removeMigration", "EF Core: remove the last migration", () => ef("migrations remove", ["migrations", "remove"]), "entity framework undo migration");
  C("ef.updateDatabase", "EF Core: update the database", () => updateDatabase(), "entity framework migrate apply");
  C("ef.script", "EF Core: SQL script of the migrations", sqlScript, "entity framework sql");

  return { sendHttp, publish, editSecrets };
}
