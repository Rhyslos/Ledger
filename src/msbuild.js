// Completion in MSBuild files (.csproj, .props, .targets, Directory.Build.*): the properties and
// items people set by hand, their usual values, and the attributes items take.
const PROPS = {
  TargetFramework: "The .NET version the project builds for (net8.0, net9.0…)",
  TargetFrameworks: "Several, separated by ; (net8.0;net9.0)",
  OutputType: "Exe, WinExe or Library",
  Nullable: "enable: warn about possible nulls",
  ImplicitUsings: "enable: the usual using lines are added for you",
  LangVersion: "C# version (latest, preview, 12…)",
  RootNamespace: "The namespace new files start in",
  AssemblyName: "The name of the .exe or .dll",
  Version: "The project's version (1.0.0)",
  Authors: "", Company: "", Description: "", Copyright: "",
  TreatWarningsAsErrors: "true: a warning stops the build",
  WarningsAsErrors: "These warnings stop the build (CS8600;CS8602)",
  NoWarn: "These warnings aren't shown (CS1591)",
  GenerateDocumentationFile: "true: write the /// comments to an XML file",
  InvariantGlobalization: "true: no culture data (smaller, the same everywhere)",
  PublishSingleFile: "true: publish as one .exe",
  SelfContained: "true: include .NET itself when publishing",
  RuntimeIdentifier: "The platform to publish for (win-x64…)",
  PublishTrimmed: "true: leave out unused code when publishing",
  PublishAot: "true: compile ahead of time to native code",
  UseWPF: "true: a WPF app", UseWindowsForms: "true: a Windows Forms app",
  ApplicationIcon: "The .ico the .exe shows",
  UserSecretsId: "Where dotnet user-secrets keeps this project's secrets",
  IsPackable: "false: dotnet pack skips this project",
  PackageId: "", PackageVersion: "", PackageReadmeFile: "", PackageLicenseExpression: "",
  ManagePackageVersionsCentrally: "true: versions live in Directory.Packages.props",
  EnableDefaultCompileItems: "false: only the files you list are compiled",
  AllowUnsafeBlocks: "true: allow unsafe code", Optimize: "", DebugType: "portable, embedded or none",
  Platforms: "AnyCPU;x64", PlatformTarget: "AnyCPU, x64, x86 or arm64",
  EnableNETAnalyzers: "", AnalysisLevel: "latest, latest-recommended, latest-all", AnalysisMode: "",
  EnforceCodeStyleInBuild: "true: .editorconfig style rules count in builds",
  IsTestProject: "", BlazorWebAssemblyLoadAllGlobalizationData: "", SpaRoot: "",
};
const ITEMS = {
  PackageReference: "A NuGet package: Include and Version",
  ProjectReference: "Another project in your solution: Include=\"..\\Other\\Other.csproj\"",
  PackageVersion: "A version, in Directory.Packages.props",
  Using: "A global using: Include=\"System.Text.Json\"",
  Compile: "", None: "", Content: "", EmbeddedResource: "", Folder: "",
  InternalsVisibleTo: "Include=\"MyProject.Tests\"",
  FrameworkReference: "Include=\"Microsoft.AspNetCore.App\"",
  Reference: "A plain .dll",
};
const VALUES = {
  TargetFramework: ["net10.0", "net9.0", "net8.0", "net8.0-windows", "net9.0-windows", "net10.0-windows", "netstandard2.0", "netstandard2.1", "net48"],
  OutputType: ["Exe", "WinExe", "Library"],
  Nullable: ["enable", "disable", "warnings", "annotations"],
  ImplicitUsings: ["enable", "disable"],
  LangVersion: ["latest", "preview", "default", "13", "12", "11", "10"],
  RuntimeIdentifier: ["win-x64", "win-arm64", "win-x86", "linux-x64", "osx-arm64"],
  PlatformTarget: ["AnyCPU", "x64", "x86", "arm64"],
  DebugType: ["portable", "embedded", "none"],
  AnalysisLevel: ["latest", "latest-recommended", "latest-all", "preview"],
};
const BOOLS = new Set(["TreatWarningsAsErrors", "GenerateDocumentationFile", "InvariantGlobalization", "PublishSingleFile", "SelfContained", "PublishTrimmed", "PublishAot", "UseWPF", "UseWindowsForms", "IsPackable", "ManagePackageVersionsCentrally", "EnableDefaultCompileItems", "AllowUnsafeBlocks", "Optimize", "EnableNETAnalyzers", "EnforceCodeStyleInBuild", "IsTestProject"]);
const ATTRS = { PackageReference: ["Include", "Version", "PrivateAssets", "IncludeAssets", "ExcludeAssets"], PackageVersion: ["Include", "Version"], ProjectReference: ["Include"], Using: ["Include", "Alias", "Static"], "*": ["Include", "Update", "Remove", "Condition"] };

/** Which group the cursor is in: "PropertyGroup", "ItemGroup" or the project itself. */
export function groupAt(text) {
  const open = [...text.matchAll(/<(\/?)(PropertyGroup|ItemGroup|Target)\b[^>]*?(\/?)>/g)];
  const stack = [];
  for (const m of open) {
    if (m[3]) continue;
    if (m[1]) stack.pop(); else stack.push(m[2]);
  }
  return stack[stack.length - 1] || "Project";
}

export function msbuildComplete(ctx) {
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 20000), ctx.pos);
  // <TargetFramework>net|  : the property's usual values.
  const val = /<(\w+)>([\w.;-]*)$/.exec(before);
  if (val && (VALUES[val[1]] || BOOLS.has(val[1]))) {
    const list = BOOLS.has(val[1]) ? ["true", "false"] : VALUES[val[1]];
    return { from: ctx.pos - val[2].length, options: list.map((v) => ({ label: v, type: "constant" })), validFor: /^[\w.;-]*$/ };
  }
  // <PackageReference Inc|  : the attributes an item takes.
  const attr = /<(\w+)\s+(?:[\w:]+="[^"]*"\s+)*(\w*)$/.exec(before);
  if (attr && !/^(PropertyGroup|ItemGroup|Project|Target)$/.test(attr[1])) {
    const list = ATTRS[attr[1]] || ATTRS["*"];
    return { from: ctx.pos - attr[2].length, options: list.map((a) => ({ label: a, type: "property", boost: a === "Include" ? 2 : 0, apply: (view, c, from, to) => view.dispatch({ changes: { from, to, insert: `${a}=""` }, selection: { anchor: from + a.length + 2 } }) })) };
  }
  // <Tar|  : elements that belong where the cursor is.
  const el = /<(\w*)$/.exec(before);
  if (!el && !ctx.explicit) return null;
  const word = el ? el[1] : "";
  const group = groupAt(before);
  let options;
  if (group === "PropertyGroup") options = Object.entries(PROPS).map(([k, d]) => ({ label: k, type: "property", detail: d, apply: `${k}>$</${k}>` }));
  else if (group === "ItemGroup") options = Object.entries(ITEMS).map(([k, d]) => ({ label: k, type: "class", detail: d, apply: k === "PackageReference" || k === "PackageVersion" ? `${k} Include="" Version="" />` : `${k} Include="" />` }));
  else options = ["PropertyGroup", "ItemGroup", "Target", "Import"].map((k) => ({ label: k, type: "keyword", apply: k === "Import" ? `${k} Project="" />` : k }));
  // "$" in apply marks where the cursor goes: CodeMirror has no such thing for plain strings, so
  // apply as a function.
  options = options.map((o) => ({
    ...o,
    apply: (view, completion, from, to) => {
      const text = o.apply.replace("$", "");
      const caret = o.apply.includes("$") ? from + o.apply.indexOf("$") : text.indexOf('""') >= 0 ? from + text.indexOf('""') + 1 : from + text.length;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: caret } });
    },
  }));
  return { from: ctx.pos - word.length, options, validFor: /^\w*$/ };
}
