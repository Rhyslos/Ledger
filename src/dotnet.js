// .NET: the Solution view (projects, their packages, references and launch profiles), the startup
// project, Debug or Release, the framework, dotnet watch, the NuGet page, new projects from every
// dotnet template, build errors in Problems, and dotnet format.
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/** The project files a .sln or .slnx lists, as paths relative to its folder. */
export function slnProjects(text) {
  const out = [];
  for (const m of text.matchAll(/^Project\("\{[^}]+\}"\)\s*=\s*"[^"]*",\s*"([^"]+\.(?:cs|fs|vb)proj)"/gm)) out.push(m[1]);
  for (const m of text.matchAll(/<Project\s+Path="([^"]+\.(?:cs|fs|vb)proj)"/g)) out.push(m[1]);
  return out.map((p) => p.replace(/\\/g, "/"));
}
/** `rel` resolved against folder `dir` (forward slashes, .. handled). */
export function resolve(dir, rel) {
  const parts = (/^([A-Za-z]:|\/)/.test(rel) ? rel : dir + "/" + rel).split("/");
  const out = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p !== "." && p !== "") out.push(p); else if (!out.length && p === "") out.push(""); }
  return out.join("/");
}
/** What Ledger shows of a project file: frameworks, output type, packages, references… */
export function parseProject(text) {
  const tag = (name) => [...text.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((m) => m[1].trim());
  const items = (name) => [...text.matchAll(new RegExp(`<${name}\\s+([^>]*?)(/?)>`, "g"))].map((m) => {
    const attr = (a) => new RegExp(`\\b${a}="([^"]*)"`).exec(m[1])?.[1];
    let version = attr("Version");
    if (!version && !m[2]) { const end = text.indexOf(`</${name}>`, m.index); const inner = end > 0 ? text.slice(m.index, end) : ""; version = /<Version>([^<]*)<\/Version>/.exec(inner)?.[1]; }
    return { include: attr("Include") || attr("Update") || "", version: version || "" };
  }).filter((x) => x.include);
  const tfms = [...tag("TargetFramework"), ...tag("TargetFrameworks").flatMap((t) => t.split(";"))].map((t) => t.trim()).filter(Boolean);
  const sdk = /<Project\s[^>]*Sdk="([^"]+)"/.exec(text)?.[1] || "";
  let outputType = tag("OutputType")[0] || "";
  if (!outputType && /Microsoft\.NET\.Sdk\.(Web|Worker|BlazorWebAssembly|Razor)/.test(sdk)) outputType = "Exe";
  return {
    tfms: [...new Set(tfms)], outputType, sdk,
    packages: items("PackageReference").map((p) => ({ id: p.include, version: p.version })),
    refs: items("ProjectReference").map((p) => p.include.replace(/\\/g, "/")),
    frameworks: items("FrameworkReference").map((p) => p.include),
    test: /Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest/i.test(text) || tag("IsTestProject")[0] === "true",
    secrets: tag("UserSecretsId")[0] || "",
    ef: /Microsoft\.EntityFrameworkCore/.test(text),
    wpf: tag("UseWPF")[0] === "true", winforms: tag("UseWindowsForms")[0] === "true",
  };
}
/** MSBuild's file(line,col): error CODE: message [project] lines. */
export function parseBuildLine(line) {
  const m = /^\s*(?:\d+>)?(.+?)\((\d+)(?:,(\d+))?(?:,(\d+),(\d+))?\)\s*:\s*(error|warning)\s+([A-Za-z]+\d+)\s*:\s*(.*?)(?:\s+\[[^\]]+\])?\s*$/.exec(line);
  if (!m || /^\s*$/.test(m[1])) return null;
  const l = +m[2] - 1, c = m[3] ? +m[3] - 1 : 0, el = m[4] ? +m[4] - 1 : l, ec = m[5] ? +m[5] - 1 : c + 1;
  return { path: m[1].trim(), diag: { range: { start: { line: l, character: c }, end: { line: el, character: ec } }, severity: m[6] === "error" ? 1 : 2, code: m[7], message: m[8] } };
}

// The templates most projects start from; the rest come from dotnet new list.
const TEMPLATES = [
  ["console", "Console app"], ["classlib", "Class library"], ["webapi", "ASP.NET Core Web API"], ["blazor", "Blazor web app"],
  ["webapp", "ASP.NET Core Razor Pages"], ["mvc", "ASP.NET Core MVC"], ["web", "ASP.NET Core empty"], ["worker", "Worker service"],
  ["grpc", "gRPC service"], ["blazorwasm", "Blazor WebAssembly (stand-alone)"], ["wpf", "WPF app (Windows)"], ["winforms", "Windows Forms app (Windows)"],
  ["xunit", "xUnit test project"], ["nunit", "NUnit test project"], ["mstest", "MSTest test project"], ["razorclasslib", "Razor class library"],
];

export function initDotnet(app) {
  const { S, $, esc, prefs } = app;
  const state = () => { if (!S.root) return {}; prefs.dotnet ||= {}; return (prefs.dotnet[S.root] ||= {}); };
  const keep = () => app.savePrefs();
  const project = () => (S.ctx?.dotnet ? S.ctx : null);
  const need = () => {
    const P = project();
    if (!P) app.toast("Open a file from a C# project first (one with a .csproj or .sln).");
    return P;
  };
  const readText = async (p) => { try { return (await invoke("read_file", { path: p })).replace(/^﻿/, ""); } catch { return null; } };
  const looseJson = (t) => JSON.parse(t.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || "").replace(/,(\s*[}\]])/g, "$1"));

  // ---------- the model: solution, projects, packages, references, launch profiles ----------
  let model = null, loading = null;
  async function load() {
    if (!S.root) { model = null; return null; }
    if (loading) return loading;
    loading = (async () => {
      const files = S.files || (await app.loadFiles?.(), S.files) || [];
      const sln = files.find((f) => /\.slnx?$/i.test(f) && app.parent(f) === S.root) || files.find((f) => /\.slnx?$/i.test(f));
      let paths = [];
      if (sln) { const t = await readText(sln); if (t) paths = slnProjects(t).map((r) => resolve(app.parent(sln), r)); }
      if (!paths.length) paths = files.filter((f) => /\.csproj$/i.test(f)).slice(0, 80);
      // Central package versions (Directory.Packages.props at the top).
      const central = new Map();
      const props = files.find((f) => /(^|\/)Directory\.Packages\.props$/i.test(f));
      if (props) { const t = await readText(props); for (const m of (t || "").matchAll(/<PackageVersion\s+Include="([^"]+)"\s+Version="([^"]+)"/g)) central.set(m[1].toLowerCase(), m[2]); }
      const projects = (await Promise.all(paths.map(async (path) => {
        const t = await readText(path);
        if (t == null) return { path, name: app.base(path).replace(/\.\w+proj$/i, ""), dir: app.parent(path), missing: true, tfms: [], packages: [], refs: [], frameworks: [], profiles: [] };
        const p = parseProject(t), dir = app.parent(path);
        for (const pk of p.packages) if (!pk.version) pk.version = central.get(pk.id.toLowerCase()) || "";
        let profiles = [];
        const ls = await readText(dir + "/Properties/launchSettings.json");
        if (ls) { try { profiles = Object.entries(looseJson(ls).profiles || {}).filter(([, v]) => !v.commandName || v.commandName === "Project").map(([name, v]) => ({ name, url: (v.applicationUrl || "").split(";")[0], urls: v.applicationUrl || "", launchBrowser: !!v.launchBrowser, launchUrl: v.launchUrl || "", args: v.commandLineArgs || "", env: v.environmentVariables || {} })); } catch {} }
        return { path, name: app.base(path).replace(/\.\w+proj$/i, ""), dir, ...p, refs: p.refs.map((r) => resolve(dir, r)), profiles };
      }))).sort((a, b) => a.name.localeCompare(b.name));
      model = { sln, projects, central: !!props, centralFile: props };
      loading = null;
      return model;
    })();
    return loading;
  }
  const projOf = (path) => model?.projects.find((p) => p.path === path);
  const runnable = (p) => p && !p.missing && /exe|winexe/i.test(p.outputType || "") && !p.test;

  // ---------- run options: startup project, configuration, framework, profile, watch ----------
  function opts(P) {
    const s = state();
    const startup = s.startup && model?.projects.some((p) => p.path === s.startup) ? s.startup : model?.projects.filter(runnable).length === 1 && P?.sln ? model.projects.find(runnable).path : null;
    return { startup, config: s.config || "Debug", framework: s.framework || null, profile: s.profile || null, watch: !!s.watch };
  }
  app.dotnetHooks.opts = (P) => opts(P);
  async function pickStartup() {
    await load();
    const list = (model?.projects || []).filter(runnable);
    if (!list.length) { app.toast("No project here makes a program to run (OutputType Exe)."); return false; }
    const cur = state().startup;
    const i = await app.choose("Startup project: the one Run and Debug start", list.map((p) => p.name + (p.path === cur ? "  (now)" : "") + "  ·  " + app.rel(p.dir)), true, { sel: Math.max(0, list.findIndex((p) => p.path === cur)) });
    if (i == null || i < 0) return false;
    state().startup = list[i].path;
    if (!list[i].profiles.some((pr) => pr.name === state().profile)) delete state().profile;
    keep(); paint();
    return true;
  }
  app.dotnetHooks.pickStartup = pickStartup;
  async function pickProfile() {
    await load();
    const p = projOf(opts(project()).startup) || projOf(project()?.csproj);
    if (!p?.profiles.length) { app.toast("This project has no launch profiles (Properties/launchSettings.json)."); return; }
    const names = ["(the first one, as dotnet run does)", ...p.profiles.map((pr) => pr.name + (pr.url ? "  ·  " + pr.url : ""))];
    const i = await app.choose(`Launch profile for ${p.name}`, names, true);
    if (i == null || i < 0) return;
    if (i === 0) delete state().profile; else state().profile = p.profiles[i - 1].name;
    keep(); paint();
  }
  async function pickFramework() {
    await load();
    const all = [...new Set((model?.projects || []).flatMap((p) => p.tfms))];
    if (all.length < 2) { app.toast(all.length ? `Every project targets ${all[0]}.` : "No target frameworks found."); return; }
    const i = await app.choose("Framework to build and run for", ["(each project's own)", ...all], true);
    if (i == null || i < 0) return;
    if (i === 0) delete state().framework; else state().framework = all[i - 1];
    keep(); paint();
  }
  function toggleConfig() { state().config = opts().config === "Debug" ? "Release" : "Debug"; keep(); paint(); app.toast(`Builds are ${state().config} builds now.`); }
  function toggleWatch() { state().watch = !state().watch; keep(); paint(); app.toast(state().watch ? "Run uses dotnet watch: saving a file updates the running program (hot reload)." : "Run uses dotnet run."); }

  // ---------- status bar ----------
  const stEl = document.createElement("button");
  stEl.id = "stDotnet"; stEl.className = "seg plain"; stEl.hidden = true;
  stEl.title = "C# project: startup project, Debug or Release, framework, launch profile";
  $("stTasks")?.after(stEl);
  stEl.addEventListener("click", () => menu(stEl));
  function menu(el) {
    const o = opts(project()), r = el.getBoundingClientRect();
    app.showMenu(r.left, r.top - 180, [
      { label: `Startup project: ${projOf(o.startup)?.name || "the open file's"}…`, run: pickStartup },
      { label: `Configuration: ${o.config} (switch to ${o.config === "Debug" ? "Release" : "Debug"})`, run: toggleConfig },
      { label: `Framework: ${o.framework || "each project's own"}…`, run: pickFramework },
      { label: `Launch profile: ${o.profile || "the first"}…`, run: pickProfile },
      { label: o.watch ? "Run with dotnet run (no hot reload)" : "Run with dotnet watch (hot reload)", run: toggleWatch },
    ]);
  }
  function paintStatus() {
    const P = project();
    stEl.hidden = !P;
    if (!P) return;
    const o = opts(P), sp = projOf(o.startup);
    stEl.textContent = [o.config, o.framework, sp && model.projects.length > 1 ? sp.name : null, o.watch ? "watch" : null].filter(Boolean).join(" · ");
  }

  // ---------- the Solution view ----------
  const box = $("solution"), openSet = new Set();
  let selKey = null;
  function rowHtml(key, depth, label, sub, opts2 = {}) {
    return `<button class="node${selKey === key ? " sel" : ""}${opts2.cls ? " " + opts2.cls : ""}" role="treeitem" aria-level="${depth + 1}" ${opts2.expanded != null ? `aria-expanded="${opts2.expanded}"` : ""} tabindex="${selKey === key ? 0 : -1}" data-sk="${esc(key)}" style="padding-left:${8 + depth * 14}px">${opts2.expanded != null ? `<span class="chev${opts2.expanded ? " open" : ""}"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : '<span class="chev"></span>'}${opts2.icon || ""}<span class="lbl">${esc(label)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}${opts2.badge || ""}</button>`;
  }
  function paint() {
    paintStatus();
    $("vbSolution").hidden = !(model?.projects.length);
    if (!box || app.sideView !== "solution") return;
    const hadFocus = box.contains(document.activeElement) ? document.activeElement.dataset.sk : null;
    if (!model) { box.innerHTML = '<p class="hint" style="padding:10px 14px">Loading…</p>'; return; }
    if (!model.projects.length) { box.innerHTML = `<div style="padding:10px 14px;display:grid;gap:8px"><p class="hint" style="margin:0">No .NET projects in this folder.</p><div class="bar"><button class="btn primary" data-sa="new">New .NET project…</button></div></div>`; return; }
    const o = opts(project());
    const rows = [];
    for (const p of model.projects) {
      const k = "p|" + p.path, open = openSet.has(k);
      const kind = p.missing ? "missing" : [p.tfms.join(", "), p.test ? "tests" : /exe/i.test(p.outputType || "") ? (/winexe/i.test(p.outputType) ? "app" : "program") : "library"].filter(Boolean).join(" · ");
      rows.push(rowHtml(k, 0, p.name, kind, { expanded: open, icon: app.fileIcon(p.path), badge: o.startup === p.path ? '<span class="startup" title="Startup project: Run and Debug start this one">▶</span>' : "" }));
      if (!open) continue;
      const groups = [["pk", `Packages`, p.packages.map((x) => [x.id, x.version])], ["pr", "Projects", p.refs.map((r) => [app.base(r).replace(/\.\w+proj$/i, ""), app.rel(r)])], ["fw", "Frameworks", p.frameworks.map((f) => [f, ""])], ["lp", "Launch profiles", p.profiles.map((x) => [x.name, x.url])]];
      for (const [g, label, list] of groups) {
        if (!list.length && g !== "pk" && g !== "pr") continue;
        const gk = `${g}|${p.path}`, gopen = openSet.has(gk);
        rows.push(rowHtml(gk, 1, label, String(list.length), { expanded: gopen }));
        if (gopen) for (const [name, sub] of list) rows.push(rowHtml(`${g}i|${p.path}|${name}`, 2, name, sub, { cls: g === "lp" && o.profile === name ? "on" : "" }));
      }
    }
    box.innerHTML = `<div class="side-head"><b>${esc(model.sln ? app.base(model.sln).replace(/\.slnx?$/i, "") : "PROJECTS")}</b>
      <button class="ibtn" data-sa="new" title="New project${model.sln ? " in the solution" : ""}" aria-label="New project">+</button>
      ${model.sln ? '<button class="ibtn" data-sa="addexisting" title="Add an existing project to the solution" aria-label="Add an existing project">⊕</button>' : '<button class="ibtn" data-sa="mksln" title="Make a solution with these projects" aria-label="Make a solution">⊞</button>'}
      <button class="ibtn" data-sa="refresh" title="Refresh" aria-label="Refresh">↻</button></div>
      <div class="sol-opts"><button class="glink" data-sa="config">${esc(o.config)}</button>${o.framework ? ` · <button class="glink" data-sa="fw">${esc(o.framework)}</button>` : ""} · <button class="glink" data-sa="watch">${o.watch ? "dotnet watch" : "dotnet run"}</button>${o.profile ? ` · <button class="glink" data-sa="profile">${esc(o.profile)}</button>` : ""}</div>
      <nav class="tree" role="tree" aria-label="Projects">${rows.join("")}</nav>`;
    const target = (hadFocus && box.querySelector(`[data-sk="${CSS.escape(hadFocus)}"]`)) || null;
    if (target) target.focus();
    else if (!box.querySelector('.node[tabindex="0"]')) box.querySelector(".node")?.setAttribute("tabindex", "0");
  }
  const reload = async () => { model = null; loading = null; await load(); paint(); };
  app.sideViews.solution = {
    btn: "vbSolution", el: "vSolution",
    render: () => { paint(); if (!model) load().then(paint); },
    focus: () => (box.querySelector('.node[tabindex="0"]') || box.querySelector(".node"))?.focus(),
  };
  app.folderHooks.push(() => { model = null; loading = null; openSet.clear(); selKey = null; setTimeout(() => load().then(paint), 300); });
  app.saveHooks.push((path) => { if (/\.(csproj|fsproj|props|targets|slnx?)$|launchSettings\.json$/i.test(path)) reload(); });
  app.activeHooks.push(() => paintStatus());

  // dotnet steps for one project, then the view refreshes.
  const steps = (label, args, cwd, after) => app.startSteps([{ label, program: "dotnet", args, cwd }], async () => { await reload(); await app.refreshTree?.(); after?.(); });
  function act(key, how) {
    const [kind, path, name] = key.split("|"), p = projOf(path);
    if (kind === "p") { if (how === "open") app.openFile(path); else { openSet.has(key) ? openSet.delete(key) : openSet.add(key); paint(); } return; }
    if (["pk", "pr", "fw", "lp"].includes(kind)) { openSet.has(key) ? openSet.delete(key) : openSet.add(key); paint(); return; }
    if (kind === "pki") { openNuget(path, name); return; }
    if (kind === "pri") { const r = p?.refs.find((x) => app.base(x).replace(/\.\w+proj$/i, "") === name); if (r) app.openFile(r); return; }
    if (kind === "lpi") { state().profile = name; if (!state().startup) state().startup = path; keep(); paint(); app.toast(`Run uses the ${name} profile.`); }
  }
  function contextMenu(key, x, y) {
    const [kind, path, name] = key.split("|"), p = projOf(path);
    if (!p) return;
    if (kind === "p") app.showMenu(x, y, [
      ...(runnable(p) ? [{ label: "Set as startup project", run: () => { state().startup = p.path; keep(); paint(); } }, { label: "Run this project", run: () => steps("dotnet run", ["run", "--project", p.path, ...cfgArgs()], p.dir) }] : []),
      { label: "Build", run: () => steps("dotnet build", ["build", p.path, "-nologo", ...cfgArgs()], p.dir) },
      ...(p.test ? [{ label: "Test", run: () => steps("dotnet test", ["test", p.path, "-nologo", ...cfgArgs()], p.dir) }] : []),
      { label: "Clean", run: () => steps("dotnet clean", ["clean", p.path, "-nologo"], p.dir) },
      "-",
      { label: "Manage NuGet packages…", run: () => openNuget(p.path) },
      { label: "Add a project reference…", run: () => addReference(p) },
      ...(p.secrets || /web|worker/i.test(p.sdk) ? [{ label: "Edit user secrets…", run: () => app.dotnetHooks.secrets?.(p) }] : []),
      ...(p.ef ? [{ label: "EF Core: add a migration…", run: () => app.dotnetHooks.addMigration?.(p) }, { label: "EF Core: update the database…", run: () => app.dotnetHooks.updateDatabase?.(p) }] : []),
      "-",
      { label: "Open the project file", run: () => app.openFile(p.path) },
      { label: "Publish…", run: () => app.dotnetHooks.publish?.(p) },
      ...(model.sln ? ["-", { label: "Remove from the solution", danger: true, run: () => steps("dotnet sln remove", ["sln", model.sln, "remove", p.path], app.parent(model.sln)) }] : []),
    ]);
    else if (kind === "pki") app.showMenu(x, y, [
      { label: "Show in NuGet", run: () => openNuget(path, name) },
      { label: "Update to the newest version", run: () => steps("dotnet add package", ["add", path, "package", name], p.dir) },
      { label: "Remove", danger: true, run: () => steps("dotnet remove package", ["remove", path, "package", name], p.dir) },
    ]);
    else if (kind === "pri") app.showMenu(x, y, [
      { label: "Open", run: () => act(key, "open") },
      { label: "Remove the reference", danger: true, run: () => { const r = p.refs.find((q) => app.base(q).replace(/\.\w+proj$/i, "") === name); if (r) steps("dotnet remove reference", ["remove", path, "reference", r], p.dir); } },
    ]);
    else if (kind === "pk") app.showMenu(x, y, [{ label: "Manage NuGet packages…", run: () => openNuget(path) }]);
    else if (kind === "pr") app.showMenu(x, y, [{ label: "Add a project reference…", run: () => addReference(p) }]);
  }
  const cfgArgs = () => { const o = opts(); return [...(o.config !== "Debug" ? ["-c", o.config] : []), ...(o.framework ? ["-f", o.framework] : [])]; };
  async function addReference(p) {
    await load();
    const others = model.projects.filter((q) => q.path !== p.path && !p.refs.includes(q.path));
    if (!others.length) { app.toast("There's no other project to reference."); return; }
    const i = await app.choose(`${p.name} uses which project?`, others.map((q) => q.name + "  ·  " + app.rel(q.dir)), true, { filter: true });
    if (i == null || i < 0) return;
    steps("dotnet add reference", ["add", p.path, "reference", others[i].path], p.dir);
  }
  box?.addEventListener("click", (e) => {
    const a = e.target.closest("[data-sa]")?.dataset.sa;
    if (a === "refresh") return reload();
    if (a === "new") return newProject();
    if (a === "addexisting") return addExisting();
    if (a === "mksln") return makeSolution();
    if (a === "config") return toggleConfig();
    if (a === "fw") return pickFramework();
    if (a === "watch") return toggleWatch();
    if (a === "profile") return pickProfile();
    const n = e.target.closest("[data-sk]");
    if (!n) return;
    selKey = n.dataset.sk;
    act(selKey, e.detail >= 2 ? "open" : "toggle");
  });
  box?.addEventListener("contextmenu", (e) => { const n = e.target.closest("[data-sk]"); if (!n) return; e.preventDefault(); selKey = n.dataset.sk; contextMenu(selKey, e.clientX, e.clientY); });
  box?.addEventListener("keydown", (e) => {
    const n = e.target.closest("[data-sk]"), k = app.keyString(e);
    if (!n) return;
    const nodes = [...box.querySelectorAll("[data-sk]")], i = nodes.indexOf(n);
    const go = (x) => { if (!x) return; nodes.forEach((y) => (y.tabIndex = y === x ? 0 : -1)); selKey = x.dataset.sk; x.focus(); };
    if (k === "Down") go(nodes[i + 1]);
    else if (k === "Up") go(nodes[i - 1]);
    else if (k === "Right" && n.getAttribute("aria-expanded") === "false") act(n.dataset.sk);
    else if (k === "Left" && n.getAttribute("aria-expanded") === "true") act(n.dataset.sk);
    else if (k === "Enter") act(n.dataset.sk, n.getAttribute("aria-expanded") != null ? "toggle" : "open");
    else if (k === "Shift+F10" || k === "ContextMenu") { const r = n.getBoundingClientRect(); contextMenu(n.dataset.sk, r.left + 24, r.bottom); }
    else if (k === "Esc") app.focusZone("editor");
    else return;
    e.preventDefault();
  });

  // ---------- solutions and projects ----------
  async function makeSolution() {
    await load();
    if (!model?.projects.length) return;
    const name = (await app.promptText("Name of the solution", app.base(S.root).replace(/[^\w.-]/g, "_"), ""))?.trim();
    if (!name) return;
    app.startSteps([
      { label: "dotnet new sln", program: "dotnet", args: ["new", "sln", "-n", name, "-o", S.root], cwd: S.root },
      { label: "dotnet sln add", program: "dotnet", args: ["sln", app.join(S.root, name + ".sln"), "add", ...model.projects.map((p) => p.path)], cwd: S.root },
    ], async () => { await app.refreshTree?.(); await reload(); });
  }
  async function addExisting() {
    await load();
    const inSln = new Set(model.projects.map((p) => p.path));
    const others = (S.files || []).filter((f) => /\.(cs|fs|vb)proj$/i.test(f) && !inSln.has(f));
    if (!others.length) { app.toast("Every project in this folder is in the solution already."); return; }
    const i = await app.choose("Add which project to the solution?", others.map((f) => app.rel(f)), true, { filter: true });
    if (i == null || i < 0) return;
    steps("dotnet sln add", ["sln", model.sln, "add", others[i]], app.parent(model.sln));
  }
  async function moreTemplates() {
    const r = await invoke("run_capture", { cwd: ".", program: "dotnet", args: ["new", "list"], timeoutMs: 60000 }).catch(() => null);
    const lines = (r?.out || "").split("\n");
    const head = lines.findIndex((l) => /Template Name\s+Short Name/.test(l));
    if (head < 0) return [];
    const short = lines[head].indexOf("Short Name"), lang = lines[head].indexOf("Language");
    return lines.slice(head + 2).filter((l) => l.trim()).map((l) => [l.slice(short, lang > 0 ? lang : undefined).trim().split(",")[0], l.slice(0, short).trim()]).filter(([s]) => s);
  }
  // A new project from a dotnet template, in the open folder (and its solution) or anywhere.
  async function newProject() {
    let list = TEMPLATES.slice();
    let i = await app.choose("New .NET project", [...list.map(([s, n]) => `${n}  ·  ${s}`), "Another template…"], true, { filter: true });
    if (i == null || i < 0) return;
    if (i === list.length) {
      app.toast("Reading the installed templates…");
      list = await moreTemplates();
      if (!list.length) { app.toast("Couldn't list the templates (dotnet new list)."); return; }
      i = await app.choose("Template", list.map(([s, n]) => `${n}  ·  ${s}`), true, { filter: true });
      if (i == null || i < 0) return;
    }
    const [tpl, title] = list[i];
    const name = (await app.promptText(`New ${title}: its name`, "", "e.g. MyApp.Api"))?.trim();
    if (!name) return;
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) { app.toast("Use letters, numbers, . - and _, starting with a letter."); return; }
    let where = S.root;
    const pickDir = async () => { const { open } = await import("@tauri-apps/plugin-dialog"); const d = await open({ directory: true, multiple: false, title: "Where should the project go?" }); return d ? app.norm(String(d)) : null; };
    if (where) {
      const sub = await app.choose(`Where should ${name} go?`, [`${app.base(where)}/${name}`, `${app.base(where)}/src/${name}`, "Somewhere else…"], true);
      if (sub == null || sub < 0) return;
      if (sub === 1) where = app.join(where, "src");
      if (sub === 2) where = await pickDir();
    } else where = await pickDir();
    if (!where) return;
    const outside = !S.root || !app.isUnder(app.join(where, name), S.root);
    const dir = app.join(where, name);
    await load();
    const proj = app.join(dir, name + ".csproj");
    const stepsList = [{ label: `dotnet new ${tpl}`, program: "dotnet", args: ["new", tpl, "-n", name, "-o", dir], cwd: where }];
    if (model?.sln && !outside) stepsList.push({ label: "dotnet sln add", program: "dotnet", args: ["sln", model.sln, "add", proj], cwd: app.parent(model.sln) });
    app.startSteps(stepsList, async () => {
      // The file to start in: Program.cs, or the first .cs the template made.
      const files = ((await invoke("list_files", { root: dir }).catch(() => [])) || []).map(app.norm);
      const first = files.find((f) => /\/Program\.cs$/i.test(f)) || files.find((f) => /\.cs$/i.test(f));
      if (outside) { if (await app.openFolder(dir)) { if (first) app.openFile(first); } return; }
      await app.refreshTree?.();
      await reload();
      if (first) app.openFile(first);
      app.toast(`Made ${name}${model?.sln ? ` and added it to ${app.base(model.sln)}` : ""}.`, 5000);
    });
  }
  app.dotnetHooks.newProject = newProject;

  // ---------- NuGet ----------
  const nuget = { el: $("nugetpage"), key: null, tab: "browse", q: "", pre: false, results: [], busy: false, sel: null, versions: [], latest: new Map(), err: "" };
  const keyOf = (proj) => "@nuget:" + proj;
  async function openNuget(proj, focus) {
    await load();
    const key = keyOf(proj);
    nuget.key = key;
    if (focus) { nuget.tab = "installed"; selectPackage(focus); }
    app.addTab(key);
    app.activate(key);
    if (nuget.tab === "updates" || nuget.tab === "installed") checkLatest(projOf(proj));
  }
  const api = async (url) => JSON.parse(await invoke("http_get", { url }));
  async function search() {
    const q = nuget.q.trim();
    nuget.busy = true; nuget.err = ""; drawNuget();
    try {
      const r = await api(`https://azuresearch-usnc.nuget.org/query?q=${encodeURIComponent(q)}&take=40&prerelease=${nuget.pre}&semVerLevel=2.0.0`);
      if (q !== nuget.q.trim()) return;
      nuget.results = (r.data || []).map((d) => ({ id: d.id, version: d.version, description: d.description || "", downloads: d.totalDownloads || 0, verified: !!d.verified, authors: [].concat(d.authors || []).join(", ") }));
    } catch (e) { nuget.err = "Couldn't reach nuget.org: " + e; nuget.results = []; }
    nuget.busy = false;
    drawNuget();
  }
  async function versionsOf(id) {
    try { return ((await api(`https://api.nuget.org/v3-flatcontainer/${id.toLowerCase()}/index.json`)).versions || []).reverse(); } catch { return []; }
  }
  const stable = (v) => !/-/.test(v);
  async function checkLatest(p) {
    if (!p) return;
    await Promise.all(p.packages.map(async (pk) => { if (nuget.latest.has(pk.id)) return; const vs = await versionsOf(pk.id); nuget.latest.set(pk.id, vs.find(stable) || vs[0] || ""); }));
    drawNuget();
  }
  async function selectPackage(id) {
    nuget.sel = id;
    nuget.versions = [];
    drawNuget();
    nuget.versions = await versionsOf(id);
    if (nuget.sel === id) drawNuget();
  }
  const cmp = (a, b) => { const pa = a.split(/[.-]/), pb = b.split(/[.-]/); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = parseInt(pa[i] || "0", 10), y = parseInt(pb[i] || "0", 10); if (x !== y) return x - y; } return 0; };
  const fmtN = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n));
  function drawNuget() {
    const el = nuget.el, proj = nuget.key?.slice(7), p = projOf(proj);
    if (!el || S.active !== nuget.key) return;
    if (!p) { el.innerHTML = '<p class="empty" style="padding:20px">That project isn\'t in this folder any more.</p>'; return; }
    const have = new Map(p.packages.map((x) => [x.id.toLowerCase(), x.version]));
    const updates = p.packages.filter((x) => nuget.latest.get(x.id) && x.version && cmp(nuget.latest.get(x.id), x.version) > 0);
    let list;
    if (nuget.tab === "browse") list = nuget.results.map((r) => ({ id: r.id, version: r.version, note: `${fmtN(r.downloads)} downloads${r.verified ? " · ✓ verified owner" : ""}`, desc: r.description }));
    else if (nuget.tab === "installed") list = p.packages.map((x) => ({ id: x.id, version: x.version || "(central)", note: nuget.latest.get(x.id) && x.version && cmp(nuget.latest.get(x.id), x.version) > 0 ? `${nuget.latest.get(x.id)} is out` : "", desc: "" }));
    else list = updates.map((x) => ({ id: x.id, version: `${x.version} → ${nuget.latest.get(x.id)}`, note: "", desc: "" }));
    const sel = nuget.sel, selHave = sel && have.get(sel.toLowerCase());
    const selInfo = nuget.results.find((r) => r.id === sel);
    const vers = nuget.versions.filter((v) => nuget.pre || stable(v));
    el.innerHTML = `<div class="nuget">
      <div class="diffhead"><b>NuGet · ${esc(p.name)}</b><span class="sp"></span>
        <span class="ntabs" role="tablist">${[["browse", "Browse"], ["installed", `Installed ${p.packages.length}`], ["updates", `Updates${updates.length ? " " + updates.length : ""}`]].map(([k, l]) => `<button class="btn${nuget.tab === k ? " primary" : ""}" data-nt="${k}" role="tab" aria-selected="${nuget.tab === k}">${l}</button>`).join("")}</span>
        <button class="btn" data-na="vuln" title="dotnet list package --vulnerable">Known vulnerabilities</button>
        ${nuget.tab === "updates" && updates.length ? '<button class="btn" data-na="updateall">Update all</button>' : ""}</div>
      ${nuget.tab === "browse" ? `<div class="nsearch"><input type="search" id="nugetQ" placeholder="Search nuget.org (e.g. Serilog, Dapper)" value="${esc(nuget.q)}" spellcheck="false" aria-label="Search nuget.org"><label class="chk"><input type="checkbox" data-na="pre"${nuget.pre ? " checked" : ""}> Prereleases</label></div>` : ""}
      ${model.central ? `<p class="hint" style="padding:0 18px">Versions are kept in ${esc(app.rel(model.centralFile))} (central package management); dotnet add package updates it.</p>` : ""}
      <div class="nbody"><div class="nlist" role="listbox">${nuget.busy ? '<p class="empty" style="padding:14px">Searching…</p>' : nuget.err ? `<p class="empty bad" style="padding:14px">${esc(nuget.err)}</p>` : list.length ? list.map((x) => `<div class="nrow${sel === x.id ? " on" : ""}" role="option" tabindex="-1" data-np="${esc(x.id)}"><b>${esc(x.id)}</b> <span class="hint">${esc(x.version)}</span>${have.has(x.id.toLowerCase()) && nuget.tab === "browse" ? ' <span class="nhave">installed</span>' : ""}${x.note ? `<div class="hint">${esc(x.note)}</div>` : ""}${x.desc ? `<div class="ndesc">${esc(x.desc.slice(0, 220))}</div>` : ""}</div>`).join("") : `<p class="empty" style="padding:14px">${nuget.tab === "browse" ? (nuget.q ? "Nothing found." : "Type to search nuget.org.") : nuget.tab === "updates" ? "Everything is up to date." : "No packages yet."}</p>`}</div>
        <div class="ndetail">${sel ? `<h3>${esc(sel)}</h3>${selInfo ? `<p>${esc(selInfo.description)}</p><p class="hint">${esc(selInfo.authors)}</p>` : ""}
          <p class="hint">${selHave ? `In ${esc(p.name)}: ${esc(selHave || "(central)")}` : `Not in ${esc(p.name)} yet.`}</p>
          <div class="bar"><select id="nugetV" aria-label="Version">${vers.slice(0, 80).map((v) => `<option${v === selHave ? " selected" : ""}>${esc(v)}</option>`).join("") || "<option>newest</option>"}</select>
          <button class="btn primary" data-na="install">${selHave ? "Change version" : "Install"}</button>${selHave ? '<button class="btn" data-na="remove">Remove</button>' : ""}</div>
          <p><button class="glink" data-na="site">Open on nuget.org</button></p>` : '<p class="hint">Pick a package to see its versions.</p>'}</div></div></div>`;
  }
  let nugetT = 0;
  nuget.el?.addEventListener("input", (e) => { if (e.target.id === "nugetQ") { nuget.q = e.target.value; clearTimeout(nugetT); nugetT = setTimeout(search, 350); } });
  nuget.el?.addEventListener("keydown", (e) => { if (e.target.id === "nugetQ" && e.key === "Enter") { clearTimeout(nugetT); search(); } });
  nuget.el?.addEventListener("change", (e) => { if (e.target.dataset?.na === "pre") { nuget.pre = e.target.checked; if (nuget.q) search(); else drawNuget(); } });
  nuget.el?.addEventListener("click", async (e) => {
    const p = projOf(nuget.key?.slice(7));
    const t = e.target.closest("[data-nt]");
    if (t) { nuget.tab = t.dataset.nt; if (nuget.tab !== "browse") checkLatest(p); drawNuget(); return; }
    const r = e.target.closest("[data-np]");
    if (r) { selectPackage(r.dataset.np); return; }
    const a = e.target.closest("[data-na]")?.dataset.na;
    if (!a || !p) return;
    const v = $("nugetV")?.value;
    if (a === "install") steps("dotnet add package", ["add", p.path, "package", nuget.sel, ...(v && v !== "newest" ? ["--version", v] : [])], p.dir, () => { nuget.latest.delete(nuget.sel); drawNuget(); });
    if (a === "remove") steps("dotnet remove package", ["remove", p.path, "package", nuget.sel], p.dir, drawNuget);
    if (a === "site") openUrl(`https://www.nuget.org/packages/${encodeURIComponent(nuget.sel)}`).catch(() => {});
    if (a === "updateall") {
      const ups = p.packages.filter((x) => nuget.latest.get(x.id) && x.version && cmp(nuget.latest.get(x.id), x.version) > 0);
      app.startSteps(ups.map((x) => ({ label: `update ${x.id}`, program: "dotnet", args: ["add", p.path, "package", x.id, "--version", nuget.latest.get(x.id)], cwd: p.dir })), async () => { await reload(); drawNuget(); });
    }
    if (a === "vuln") steps("dotnet list package --vulnerable", ["list", p.path, "package", "--vulnerable", "--include-transitive"], p.dir);
  });
  app.pages.push({ el: nuget.el, match: (k) => k.startsWith("@nuget:"), render: (k) => { nuget.key = k; drawNuget(); if (nuget.tab === "browse" && !nuget.results.length && !nuget.q) setTimeout(() => $("nugetQ")?.focus(), 0); }, label: (k) => "NuGet · " + (projOf(k.slice(7))?.name || app.base(k.slice(7))), dot: "proj" });

  // ---------- build errors in Problems ----------
  let buildRun = null;
  app.outputHooks.push((text, label) => {
    if (!/^dotnet (build|run|test|watch)/.test(label || "")) return;
    const hit = parseBuildLine(text.replace(/\x1b\[[0-9;]*m/g, ""));
    if (!hit) return;
    buildRun ||= new Map();
    const list = buildRun.get(hit.path) || [];
    // MSBuild repeats each one in the summary at the end.
    if (!list.some((d) => d.code === hit.diag.code && d.range.start.line === hit.diag.range.start.line && d.message === hit.diag.message)) list.push(hit.diag);
    buildRun.set(hit.path, list);
  });
  app.taskDoneHooks.push((label) => {
    if (!/^dotnet (build|run|test|watch)/.test(label || "")) return;
    app.setBuildProblems(buildRun || new Map());
    buildRun = null;
  });

  // ---------- open the browser for web apps (launchBrowser in the profile) ----------
  let opened = false;
  app.outputHooks.push((text, label) => {
    if (!/^dotnet (run|watch)/.test(label || "") || opened) return;
    const m = /Now listening on:\s*(https?:\/\/\S+)/.exec(text);
    if (!m) return;
    const P = project(), o = opts(P), p = projOf(o.startup) || projOf(P?.csproj);
    const prof = p?.profiles.find((x) => x.name === o.profile) || p?.profiles[0];
    if (!prof?.launchBrowser) return;
    opened = true;
    const url = /^https?:\/\//i.test(prof.launchUrl) ? prof.launchUrl : m[1].replace("://[::]", "://localhost").replace("://0.0.0.0", "://localhost").replace(/\/$/, "") + (prof.launchUrl ? "/" + prof.launchUrl.replace(/^\//, "") : "");
    openUrl(url).catch(() => {});
  });
  app.taskDoneHooks.push(() => { opened = false; });

  // ---------- commands ----------
  app.command("dotnet.solution", "C#: show the Solution view", [], () => app.showSideView("solution", true), { alias: "projects solution explorer" });
  app.command("dotnet.startup", "C#: set the startup project", [], pickStartup, { alias: "run project" });
  app.command("dotnet.config", "C#: switch Debug / Release", [], toggleConfig, { alias: "configuration release debug" });
  app.command("dotnet.framework", "C#: pick the target framework", [], pickFramework, { alias: "tfm net8 net9" });
  app.command("dotnet.profile", "C#: pick the launch profile", [], pickProfile, { alias: "launchSettings https http" });
  app.command("dotnet.watch", "C#: run with dotnet watch (hot reload) on/off", [], toggleWatch, { alias: "hot reload" });
  app.command("dotnet.nuget", "C#: manage NuGet packages", [], async () => { const P = need(); if (!P) return; await load(); const p = projOf(P.csproj) || model?.projects[0]; if (p) openNuget(p.path); }, { alias: "nuget packages add package" });
  app.command("dotnet.newProject", "C#: new project from a dotnet template", [], newProject, { alias: "dotnet new template webapi blazor mvc wpf" });
  app.command("dotnet.addReference", "C#: add a project reference", [], async () => { const P = need(); if (!P) return; await load(); const p = projOf(P.csproj); if (p) addReference(p); }, { alias: "reference" });
  app.command("dotnet.restore", "C#: restore packages (dotnet restore)", [], () => { const P = need(); if (P) steps("dotnet restore", ["restore", P.sln || P.csproj], P.dir); }, { alias: "restore nuget" });
  app.command("dotnet.clean", "C#: clean (dotnet clean)", [], () => { const P = need(); if (P) steps("dotnet clean", ["clean", P.sln || P.csproj, "-nologo"], P.dir); });

  // ----- formatting with dotnet format (code style and whitespace from .editorconfig) -----
  app.command("dotnet.formatProject", "C#: format the project (dotnet format)", [], async () => {
    const P = need();
    if (!P) return;
    await app.saveAll();
    app.startSteps([{ label: "dotnet format", program: "dotnet", args: ["format", P.sln || P.csproj], cwd: P.dir }], () => app.reloadClean());
  }, { alias: "dotnet format code style whitespace editorconfig" });
  app.command("dotnet.formatFile", "C#: format this file (dotnet format)", [], async () => {
    const P = need(), path = S.active;
    if (!P || !/\.cs$/i.test(path || "")) { if (P) app.toast("Open a .cs file first."); return; }
    await app.save(path);
    app.startSteps([{ label: "dotnet format", program: "dotnet", args: ["format", P.sln || P.csproj, "--include", path], cwd: P.dir }], () => app.reloadClean());
  }, { alias: "dotnet format" });

  app.dotnet = { load, get model() { return model; }, projOf, opts, steps, need, runnable };
  setTimeout(() => load().then(paint), 1500);
}
