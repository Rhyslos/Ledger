// .NET: the dotnet commands Ledger runs for C# projects beyond Run, Build and Test.
export function initDotnet(app) {
  const { S } = app;
  const project = () => (S.ctx?.dotnet ? S.ctx : null);
  const need = () => {
    const P = project();
    if (!P) app.toast("Open a file from a C# project first (one with a .csproj or .sln).");
    return P;
  };

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
}
