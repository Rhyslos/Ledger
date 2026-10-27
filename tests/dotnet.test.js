// .NET helpers: solution files, project files, build errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { slnProjects, resolve, parseProject, parseBuildLine } from "../src/dotnet.js";

test("solution files list their projects", () => {
  const sln = 'Microsoft Visual Studio Solution File\nProject("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Api", "src\\Api\\Api.csproj", "{1}"\nEndProject\nProject("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "src", "src", "{2}"\nEndProject\n';
  assert.deepEqual(slnProjects(sln), ["src/Api/Api.csproj"]);
  assert.deepEqual(slnProjects('<Solution>\n  <Folder Name="/src/">\n    <Project Path="src/Web/Web.csproj" />\n  </Folder>\n</Solution>'), ["src/Web/Web.csproj"]);
  assert.equal(resolve("C:/code/app", "../lib/Lib.csproj"), "C:/code/lib/Lib.csproj");
  assert.equal(resolve("/home/me/app", "./src/A.csproj"), "/home/me/app/src/A.csproj");
});

test("project files: frameworks, packages, references", () => {
  const p = parseProject(`<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup><TargetFrameworks>net8.0;net9.0</TargetFrameworks><UserSecretsId>abc</UserSecretsId></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Serilog" Version="4.0.0" />
    <PackageReference Include="Dapper"><Version>2.1.35</Version></PackageReference>
    <ProjectReference Include="..\\Lib\\Lib.csproj" />
  </ItemGroup>
</Project>`);
  assert.deepEqual(p.tfms, ["net8.0", "net9.0"]);
  assert.equal(p.outputType, "Exe"); // web projects run
  assert.deepEqual(p.packages, [{ id: "Serilog", version: "4.0.0" }, { id: "Dapper", version: "2.1.35" }]);
  assert.deepEqual(p.refs, ["../Lib/Lib.csproj"]);
  assert.equal(p.secrets, "abc");
});

test("MSBuild error lines", () => {
  const e = parseBuildLine("C:\\code\\App\\Program.cs(12,17): error CS1002: ; expected [C:\\code\\App\\App.csproj]");
  assert.equal(e.path, "C:\\code\\App\\Program.cs");
  assert.deepEqual(e.diag.range.start, { line: 11, character: 16 });
  assert.equal(e.diag.severity, 1);
  assert.equal(e.diag.code, "CS1002");
  assert.equal(e.diag.message, "; expected");
  assert.equal(parseBuildLine("/home/me/App/A.cs(3,5,3,9): warning CS0168: The variable 'x' is declared but never used [/home/me/App/App.csproj]").diag.range.end.character, 8);
  assert.equal(parseBuildLine("Build succeeded."), null);
});
