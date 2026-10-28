# Ledger

A Windows code editor for Rust, C#, Godot, web projects (HTML, CSS, JavaScript, TypeScript, React, Tailwind), Lua and our own language Lust, built with Tauri. It borrows the look of Meisner's Ledger: a side bar on the left, open files as tabs, the editor, and a thin status bar (along the bottom or the top, your choice). Everything can be done from the keyboard.

**Ledger has no AI in it, and never will.** No assistant, no chat panel, no generated code, nothing sent off to a model. It's an editor: what's in your files is what you wrote.

To change the name, see [Renaming](#renaming).

## What it does

- **Rust**: run, check, test and Clippy with cargo; live errors, completions, hover docs, go to definition, rename, quick fixes and formatting through rust-analyzer.
- **C#**: build, run and test with dotnet; the same editor features through a C# language server: csharp-ls, or Microsoft's Roslyn (the one VS Code uses), picked in Settings › C# and .NET. Names are coloured by what they are (types, methods, properties, constants) from what the server knows, and the other uses of the name under the cursor are marked. Go to implementation (Ctrl F12), go to type definition, callers and what a method calls (Shift Alt H), base and derived types. Snippets like `prop`, `ctor`, `cw`, `foreach`, `try` and test methods. The project's `.editorconfig` sets indentation and line endings, and **C#: format the project** runs `dotnet format`. Razor (`.razor`, `.cshtml`) and XAML are highlighted, and `.csproj`, `.props` and `.targets` files complete properties, items and their usual values.
- **.NET solutions**: the **Solution** view (in the side bar when the folder has .NET projects) lists the solution's projects with their packages, project references, frameworks and launch profiles. Right-click a project to run, build, test, clean or publish it, set it as the startup project, manage its NuGet packages or add a reference; **+** makes a new project from any dotnet template (console, class library, Web API, Blazor, MVC, Razor Pages, worker, gRPC, WPF, Windows Forms, the test frameworks, and every other installed template) and adds it to the solution. The status bar picks the startup project, Debug or Release, the framework, the launch profile and `dotnet watch` (hot reload). Web apps open in the browser when their launch profile says so. Build errors and warnings go to Problems and into the editor.
- **ASP.NET Core and EF Core**: **C#: edit user secrets** opens the project's `secrets.json` (setting up `dotnet user-secrets` first if needed), and **C#: trust the HTTPS development certificate** runs `dotnet dev-certs https --trust`. `.http` files get a ▶ Send request link above each request, with `@variables`, `{{$guid}}`-style values and the environments in `http-client.env.json` (**HTTP: pick the environment**); the response opens in a tab beside it. The **EF Core** commands add, list and remove migrations, update the database (to the newest, a named one, or back to 0) and write the SQL script, installing `dotnet-ef` when it's missing. **C#: publish…** makes a framework-dependent or self-contained build for Windows, Linux or macOS, as a folder or one file (trimmed if you like), then shows it in File Explorer.
- **NuGet**: a page per project to search nuget.org, see versions, install, change or remove packages, see updates (and update all), and list known vulnerabilities; central package management (`Directory.Packages.props`) is respected.
- **Godot**: Play builds the C# project, then starts the game with its output in the panel. Play scene runs the open `.tscn`. Godot can open scripts in Ledger at the right line, and shaders (`.gdshader`) get highlighting and completion for Godot's shading language. Scene and resource files are highlighted too.
- **Lust**: our own language, [Lust 2](https://github.com/Rhyslos/Lust). `.lst` programs and `.lsc` LustScript files get highlighting, completions, snippets and their own icons: **Lt** for programs, **Ls** for LustScript and **Lq** for LustQL (old `.lust` files get Lt too). Views are coloured too: the pieces of the screen (`column`, `text`, `button`…) in the classes' blue and the style words in `[ ]` muted, with snippets for each piece. Inside a piece's `[ ]`, completion offers only the style words that fit that piece (the window's settings on `view [ ]`, `placeholder` only on `input`, `from`/`to`/`step` only on `slider`…), colours after `color`, `background` and `border`, and the styles your file names. Colours show a little square of their real colour, in the list and next to colour words and `"#hex"` colours in `[ ]`, and hovering a style word or a piece explains it with an example. **New project › Lust program** asks whether to start with a window (with a piece of it in `ui/`). **Run** (F5) runs the open file with `lust run`, with the Input box for `ask`; **Check** and **Build** use `lust check` and `lust build`. Lust runs from the project's folder (the one with `main.lst`), so programs split over several files work, and clicking a mistake opens the right file. Every time you save, Ledger checks the file quietly and its mistakes show up in Problems and as squiggles. Ledger needs `lust.exe`: **Install Lust** in Settings › Lust builds it from the Lust repo with Rust (or set the path to one you have). Building programs needs Rust. The installer makes `.lst`, `.lsc`, `.lql` and `.lust` files open in Ledger, each with its own icon in File Explorer.
- **Web**: HTML, CSS (SCSS, Less), JavaScript and TypeScript with React, in Ledger's colours. Completions, errors and go to definition through the TypeScript, HTML, CSS and JSON language servers; Tailwind classes complete (with colour swatches) from the project's own Tailwind. `package.json` projects run their `dev`/`start` script with F5, Build, Test and Lint use their scripts, and **Scripts…** runs any of them. A single `.js` or `.ts` file runs with Node.
- **Live Server**: **Go Live** in the status bar serves the folder and reloads the browser on save (CSS changes swap in without a reload). Settings › Web picks the browser and port.
- **Lua**: highlighting, Run with F5, and the Lua language server (with a Lua version setting).
- **New project**: website, Vite (React, Vue, Svelte, Preact, Solid, Lit, Qwik, vanilla) and Next.js through their own create commands, in TypeScript or JavaScript, with Tailwind if you want it; Node.js, Lua, Lust, LustScript, Rust and C# projects too.
- **Database viewer**: `.db` and `.sqlite` files open in a tab: tables and views, a grid with sorting, search and filters, the structure of each table, a SQL tab with completion and history, editing with review before saving, export to CSV or JSON. While its tab is in front, it updates when another program writes to the file. New SQLite databases from the explorer's right-click menu.
- **Images**: PNG, JPEG, GIF, WebP, SVG, AVIF, BMP and ICO open in a viewer with zoom, a transparency checkerboard and a pixel-art mode; SVGs can be edited as code.
- **Colour picker**: every colour in code (`#hex`, `rgb()`, `hsl()`, Godot's `Color()`) gets a small swatch; click it for a colour wheel (circle or triangle inside) or a detailed hexagon grid with CMYK, an alpha slider, Hex and RGB fields, the colours already in the file and your saved colours. The code changes as you pick, written the way it was (`#abc` stays short, `rgb()` stays `rgb()`). **Pick a colour** puts a new one at the cursor.
- **Emmet** in HTML, JSX and CSS: type `ul>li.item*3`, `div.card>h2+p`, `!` for a whole page, or `m10`, `df`, `p10-20` in CSS, then Tab. The suggestion list shows what it becomes. Tab only expands where an abbreviation makes sense, so it still indents everywhere else.
- **Prettier**: Format (Shift Alt F, or on save) uses the project's own Prettier for JavaScript, TypeScript, HTML, CSS, JSON, Markdown and YAML, with its `.prettierrc` and `.prettierignore`, or Ledger's built-in Prettier when the project has none. Settings › Editing can hand formatting back to the language servers.
- **Markdown preview**: Ctrl Shift V shows the rendered file beside the editor while you type.
- **CSV and TSV**: each column in its own colour, and Ctrl Shift V shows the file as a table with a fixed header row, sorting by any column and a filter; double-click a row to jump to it in the text.
- **Hex view**: binary files open as offset, bytes and text instead of failing, with go to offset; **Open as hex** (right-click a file) shows any file that way.
- **Text encodings**: opens and saves UTF-8, UTF-16 (PowerShell 5 output, .reg exports) and old Windows-1252 files in the encoding they came in; the status bar shows which, and **Convert this file to UTF-8** switches it.
- **Tests panel**: finds Rust, C# and Lust tests, runs all of them, the failed ones, a file or one test, shows the output live while they run (with a Stop button), shows each failure's message and line, and marks results next to each test in the editor. Filter by name or by category (`Category=Fast`, from `[Trait]`, `[Category]` and `[TestCategory]`), see what each C# test printed, debug a C# test, and **Coverage** runs the C# tests with coverlet and marks the lines that ran (green) and didn't (red). **Tests: create a test for this file** gets you started.
- **Bookmarks**: Ctrl Alt K marks a line (a blue ribbon by its number), Ctrl Alt L and Ctrl Alt J go to the next and previous, **Bookmarks: list** shows them all. They're kept for next time.
- **Overview ruler**: errors, warnings, search matches, Git changes and bookmarks are marked along the scrollbar, so you can see where they are in a long file.
- **TODO panel**: every `TODO`, `FIXME`, `HACK`, `XXX` and `BUG` comment in the folder, grouped by file and filtered by word, in the bottom panel. The words are tinted in the editor too.
- **Zen mode**: Ctrl Alt Z hides everything but the editor and goes full screen; the same key brings it all back.
- **Local history**: every save keeps a copy (the last 50 per file, in Ledger's own folder, not your project), plus the file as it was before you started editing. **Local history: this file's saved versions** (or right-click a file) shows any of them next to the file now, with **Restore this version**. Works in folders without Git.
- **Indentation**: each file is indented the way it already is (2 spaces, 4, tabs), shown in the status bar; click it to change it for that file. Enter, Emmet and Prettier follow it.
- **Editor**: tabs, split editor (Ctrl \\), find and replace in the file (Ctrl F, Ctrl H; match case, whole word, regular expressions, "3 of 20"), multiple cursors (Ctrl Alt Up/Down, Ctrl Shift L for every match), select line (Ctrl L), sort, de-duplicate and change the case of lines from the command list, folding, coloured bracket pairs, indent guides, sticky scroll (the line that opens the current function or block stays pinned at the top), problems list, clickable file:line links in build output, back and forward through your jumps, a warning when a file you're editing changes on disk.
- **Search in files** (Ctrl Shift F): a Search view with match case, whole word, regular expressions, files to include and leave out, and replace in files (Ctrl Shift H) with a preview first. Replace one match or one file from its hover buttons, or leave it out of the list. Results open in the preview tab. Unsaved changes in open files are searched as they are.
- **Getting around**: find all references (Shift F12), an Outline of the open file (Ctrl Shift O; a Markdown file's headings), symbol search (type @ or # in Ctrl E), `file:line` in Ctrl E jumps to the line, recently opened files first, parameter hints while you type a call. The explorer follows the file you're in (Settings › Editing › Explorer).
- **Debugging**: breakpoints (F9), start with Shift F9, step with F10, F11 and Shift F11, continue with F5. Variables, watches, call stack and a debug console. Pause on unhandled exceptions (the default), on every thrown one, or never (**Debug: pause on exceptions**). **Debug: attach to a running program** picks a process. C# debugging starts the startup project with its launch profile's variables, arguments and addresses. Rust uses codelldb, C# and Godot use netcoredbg; Ledger downloads them the first time you need them.
- **Run and Debug links**: ▶ Run test and Debug above each Rust and C# test and above `main`, and ▶ Send request in `.http` files.
- **Terminal**: real PowerShell terminals in the bottom panel (Ctrl ` shows one, Ctrl T opens a new one).
- **Git**: changed files are coloured in the explorer, changed lines are marked next to the line numbers, a side-by-side diff view, and a Source control view to stage, commit, pull and push (Ctrl Shift G); hover a changed file for open, discard and stage buttons. **History** (in the ⋯ menu, or "Git: history") lists the branch's commits; click one to see what it changed. Typing a new name in the branch picker offers to create it. Ctrl+clicking a line's blame (or "Git: show this line's commit") shows that commit: who, when, the whole message and the other files it changed. A stash's "Show what's in it" compares each of its files.
  - **Branches**: click the branch in the status bar (or in Source control) to switch, make a new one, merge one in or delete one. If switching would lose changes, Ledger offers to stash them first.
  - **Stashes**: put changes aside (Source control's ⋯ menu, or **Git: stash changes**) and click one in the Stashes list to pop it back, apply it, see what's in it or drop it.
  - **Merge conflicts**: each conflict gets **Keep yours**, **Keep theirs**, **Keep both** and **Compare** above it, with the two sides tinted; Alt F7 goes to the next one. Source control shows the merge in progress: which files still have conflicts, **Stage the resolved files** and **Abort the merge**, with Git's merge message ready in the commit box. Ledger won't commit a file that still has conflict markers without asking, and **Commit all** asks before adding files Git doesn't track yet.
  - **Blame**: the cursor's line shows who last changed it, when, and the commit message, faintly at its end; Ctrl+click it to see what that commit changed (a plain click just places the cursor). **Git: blame on/off**, or Settings › Git.
- **Dependencies**: in Cargo.toml and .csproj files, the newest version of each package shows at the end of its line; click it to update.
- **Snippets**: your own, per language, in snippets.json (Settings › Editing › Edit snippets).
- **Tabs**: clicking through files in the explorer reuses one preview tab (in italics) until you edit, save or pin it. Diffs, the CSV table and the hex view open the same way. When there are more tabs than fit, the edges fade and a list of every open tab sits at the right end. Right-click a tab to pin it, copy its path, show it in the explorer, open it to the side, or close the tabs to its right, the saved ones or all of them.
- **File icons** for every kind of file and common folders (Material Icon Theme; Settings › Appearance turns them off).
- **Installing languages**: Settings › Languages installs Node.js, Lua, Rust, the .NET SDK, Git, Lust and the language servers with one click.
- **.NET tools**: Settings › C# and .NET lists the installed SDKs and runtimes, installs the .NET 8, 9 or 10 SDK side by side, lists and installs workloads (MAUI, Android, iOS, WebAssembly tools), and installs `dotnet-ef`. When a folder opens, Ledger warns if its `global.json` pins an SDK that isn't installed (and offers it), offers `dotnet tool restore` for a project's own tools, and runs `dotnet restore` in a trusted folder so the language server and the first build find every package. Go to definition reaches into NuGet packages and the framework: their source through Source Link when the package has it, decompiled when not, opened read-only.
- **Explorer menu**: "Open with Ledger" when you right-click a file or folder in Windows (Settings › Windows turns it off).
- **Updates**: Ledger checks for a new version on start, downloads it in the background and shows **Restart to update**.
- **Settings** on Ctrl P: theme, fonts, status bar position, tab size, wrapping, format on save, auto save, editor extras, tool paths, terminal shell, debuggers, Godot setup, and every Ledger command's shortcut can be changed.

Each window has one folder open. Ctrl Shift N opens another window (or Ctrl Enter on a recent folder on the start page), each with its own program, language servers, debugger and terminals. Open a project folder (with `Cargo.toml`, a `.sln`/`.csproj`, `project.godot` or `package.json`), or a folder that holds several projects, like a course folder with one project per lesson. Run, Build and Test always use the project of the file you have open; its name shows at the left of the status bar. New project (in the command list) can create the project inside the open folder.

- **Program input**: while your program runs, an **Input** box appears under the output. Type a line and press Enter, and it reaches `read_line` or `Console.ReadLine`. Ctrl I jumps to it; **End input** closes the program's input.
- **Stop** (Shift F5) ends the program too, including endless loops. While debugging it ends the debug session.
- **Type hints**: the types and parameter names the language servers work out (Rust, C#, TypeScript, Lua) show in grey, like `count: usize`. They aren't part of your file. Turn them off in Settings or with **Toggle type hints**.

## Building the .exe

Two ways. Both put the same files in a `release` folder:

- `Ledger_0.1.<n>_x64-setup.exe`, an installer (adds a Start menu entry, installs for your user only, no admin needed).
- `Ledger-portable.exe`, the program itself. It runs from anywhere and needs nothing else on Windows 11.
- `ledger-cli.exe`, the `ledger` terminal command. The installer includes it; with the portable exe, keep it in the same folder for `ledger` to work in Ledger's terminal.

### On your PC

Double-click **`build.cmd`**. It installs anything missing using winget (Node.js, Rust, and Microsoft's C++ build tools, which Rust needs to link programs on Windows), then builds. The C++ tools ask for permission once. The first build takes about 10 minutes; later ones are much faster.

If it says something was installed but isn't on PATH yet, close the window and run `build.cmd` again.

### On GitHub (nothing to install)

1. Make a free GitHub account and a new repository, then upload this folder to it (GitHub Desktop is the easiest way).
2. The **Windows build** workflow in `.github/workflows` runs on every push to main and publishes a numbered release (`0.1.<run>`) under **Releases**, which installed copies of Ledger pick up as an update. Pull requests are built too, without publishing, so a broken build shows before merging. Publishing needs the repository secret `TAURI_SIGNING_PRIVATE_KEY` (the key that signs updates).

You can also start it by hand from the Actions tab (**Run workflow**).

## Tools to install for language features

Building and running only need what you already use (Rust for Rust projects, the .NET SDK for C#, Godot for Godot). For live errors, completions and the rest:

- **Rust**: `rustup component add rust-analyzer rust-src`
- **C#**: install the [.NET 10 SDK](https://dotnet.microsoft.com/download) (csharp-ls runs on it; your projects can still target .NET 8), then `dotnet tool install --global csharp-ls`. Settings › C# and .NET does both with buttons.

Settings › Languages has install buttons for these and the rest (web servers, Lua, Lust), and shows which tools it found.

- **Debugging**: nothing to install by hand. The first time you press Shift F9, Ledger offers to download codelldb (Rust, about 40 MB) or netcoredbg (C# and Godot, about 10 MB) from GitHub into its own folder. Settings › Debugging has the same buttons, and takes your own copies if you prefer.
- **Git**: install [Git for Windows](https://git-scm.com/download/win) for the Git features. Pushing to GitHub signs in through Git's own window the first time.

## Using it with Godot

1. In Ledger, open Settings (Ctrl P), go to **Godot** and pick your Godot `.exe` (the .NET build for C# projects). That's what Play uses.
2. The same section shows the exact values to paste into Godot, with Copy buttons. In Godot, open **Editor › Editor Settings** (turn on **Advanced Settings** if you don't see these):
   - **Dotnet › Editor**: set **External Editor** to **Custom**, then **Custom Exec Path** = the path to `Ledger.exe` and **Custom Exec Path Args** = `{project} --goto0 {file}:{line}:{col}`
   - **Text Editor › External** (for GDScript and other text files): turn on **Use External Editor**, then **Exec Path** = the path to `Ledger.exe` and **Exec Flags** = `{project} --goto {file}:{line}:{col}`

   The two settings differ on purpose: Godot counts lines from 0 in the C# one and from 1 in the other.
3. Double-click a script in Godot. If Ledger is already open, the file opens in that window at the right line.

Godot keeps shaders in its own editor, so open `.gdshader` files from Ledger's explorer.

You can launch Ledger the same way from a terminal: `Ledger.exe C:\Games\MyGame --goto C:\Games\MyGame\Player.cs:42`

## Keyboard

Every command is in the command list (Ctrl Shift P or F1) with its shortcut. Change any of them in Settings › Keyboard shortcuts. The editor's own keys (Ctrl Z, Ctrl D, Ctrl / and the like) are fixed. Settings has a search box at the top.

| Key | Does |
| --- | --- |
| Ctrl P | Settings |
| Ctrl E | Go to file |
| Ctrl T | New terminal |
| Ctrl Shift P, F1 | All commands |
| Ctrl Shift F / Ctrl Shift H | Search / replace in files |
| Ctrl F / Ctrl H | Find / replace in this file |
| Ctrl L | Select the line |
| Ctrl Shift L | Select every match of the selection |
| Ctrl Alt Up / Down | Add a cursor above / below |
| Ctrl Shift Enter | New line above |
| Ctrl G | Go to line |
| F6 / Shift F6 | Move between explorer, editor, panel and status bar |
| Ctrl Shift E | Explorer (arrows move, Right/Left open/close folders, Enter opens, a click or Space shows the file in a preview tab and stays in the explorer, F2 renames, Delete recycles, Ctrl X / Ctrl C / Ctrl V move and copy files, Shift F10 menu, type to jump) |
| Ctrl Shift R | Show the current file in the explorer |
| Esc | Back to the editor from the explorer, panel or status bar |
| F5 / Shift F5 | Run or Play (Continue while debugging) / stop |
| Shift F9 / F9 | Start debugging / breakpoint on this line |
| F10 / F11 / Shift F11 | Step over / into / out (while debugging) |
| Ctrl Shift F5 | Restart debugging |
| Pause | Pause the program being debugged |
| Ctrl Shift F10 / Ctrl Shift F9 | Run / debug the test (or main) at the cursor |
| Ctrl F5 | Play the open scene (Godot) |
| Ctrl Shift B | Build |
| Ctrl Alt T | Run tests |
| Ctrl Alt C | Check (Rust) |
| F8 / Shift F8 | Next / previous problem, with its message |
| Ctrl K | Show info at the cursor (type, docs, errors) |
| Ctrl I | Type input for the running program |
| Ctrl . | Quick fixes and refactors |
| F12 | Go to definition (Ctrl+click works too) |
| Shift F12 | Find all references |
| Ctrl Shift O | Outline of this file |
| Ctrl Alt O | Go to a symbol anywhere |
| Ctrl Shift Space | Parameter hints |
| Alt Left / Alt Right | Go back / forward |
| F2 | Rename symbol |
| Shift Alt F | Format file |
| Ctrl Space | Completions |
| Ctrl Tab, Ctrl PageDown / PageUp | Next / previous tab |
| Ctrl 1 to Ctrl 9 | Go to tab (9 is the last) |
| Ctrl W / Ctrl Shift T | Close tab / reopen closed tab |
| Ctrl S / Ctrl Alt S | Save / save all |
| Ctrl N / Ctrl Alt N | New file / new folder |
| Ctrl O | Open folder |
| Ctrl J | Toggle panel |
| Ctrl ` / Ctrl T | Terminal / new terminal (Ctrl Shift ` works too) |
| Ctrl Shift E / G / D | Files / Source control / Debug in the side bar |
| Ctrl \\ / Ctrl Shift \\ | Split the editor (again: switch side) / close the split |
| Alt F5 / Shift Alt F5 | Next / previous changed lines (also F7 in a comparison) |
| Ctrl Shift N / Ctrl Shift W | New window / close window |
| Ctrl Shift M / Ctrl Shift U | Problems / output |
| Ctrl B | Toggle explorer |
| Alt Z | Wrap long lines on or off |
| Ctrl Shift V | Markdown preview, or a CSV file as a table |
| Ctrl Alt K / Ctrl Alt L / Ctrl Alt J | Bookmark this line / next / previous |
| Ctrl Alt Z | Zen mode |
| Alt F7 / Shift Alt F7 | Next / previous merge conflict |
| Tab | Expand an Emmet abbreviation (HTML, JSX, CSS) |
| Ctrl + / Ctrl - / Ctrl 0 | Editor text size |

In dialogs, arrow keys move and Enter picks; in short choice dialogs the number keys pick directly, and long ones (branches, bookmarks) have a box to type in.

In a terminal, Ctrl+letter keys go to the shell (Ctrl C, Ctrl R…), except Ctrl P, Ctrl T, Ctrl J and Ctrl B. Function keys, Ctrl Shift and Ctrl Alt shortcuts always reach Ledger; F6 or Ctrl ` gets you out.

## App icon

Ledger's icon is the red L> in `src-tauri/app-icons/ledger-plain.svg`. To change it, replace that file (and `app-icon.png`), run `npx tauri icon src-tauri/app-icons/ledger-plain.svg -o src-tauri/icons`, and rebuild.

## Renaming

```
npm run rename -- "New Name"
```

This changes the window title, the Start menu entry, the installer, the program (`NewName.exe`) and this README. Settings stay where they are. Then rebuild.

## The `ledger` command

Ledger's terminal (Ctrl \`) has a `ledger` command. It works in that terminal only, where it can talk to the Ledger window it belongs to. Most of it is also in the command list (Ctrl Shift P, "Ledger: …"), which types the command into a terminal for you. `ledger help` lists everything.

**Packages**

- `ledger audit` finds every Rust, npm and .NET project under the folder and checks the packages they use against [OSV.dev](https://osv.dev), the open database that collects the RustSec, GitHub and other security advisories. That covers the packages you listed and the ones they pull in.
  - **What it shows:** each problem's severity (critical, high, moderate, low), the version that fixes it, and the package that pulls it in. It also lists newer versions of your own packages, either safe (same major version) or a new major. Rust's "unmaintained" and "unsound" notices show too.
  - **Runtimes:** it flags a .NET runtime or Node.js on your computer that's missing security fixes or is out of support.
  - **In the editor:** the problems also go into Problems and onto the package lines in `Cargo.toml`, `package.json` and `.csproj`.
  - **Safe anywhere:** it only reads files (`Cargo.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `obj/project.assets.json`), so it works in restricted mode.
  - **Options:** `--json` is for scripts. `--prod` leaves out packages that are only for development. It fails (exit code 1) when it finds security problems, so it can be used as a check before a release.
- `ledger audit fix` moves each affected package to the lowest version that fixes it, using `cargo update`, `npm install`/`npm audit fix` (or yarn and pnpm), and `dotnet add package`.
  - **Afterwards:** it builds and runs the tests. If they fail, everything goes back the way it was, and it tries the changes one at a time to name the one that broke it.
  - **New majors:** fixes that need a new major version (which can need code changes) are listed but left alone unless you add `--major`.
  - **Options:** `--dry-run` shows the plan without changing anything. `--no-check` skips the build and tests.
- `ledger update` does the same for ordinary updates: the safe ones, or every one with `--major`.
- `ledger licenses` lists the licence of every package, marking copyleft ones (GPL, AGPL) and file-level copyleft ones (MPL, LGPL). It reads them from your package caches where it can. It's a guide, not legal advice.

**Your project**

- `ledger src/main.rs:12` opens a file at a line in the window; `ledger .` opens the folder.
- `ledger run`, `build`, `test` and `check` run what F5 and the buttons run, with the same startup project, Debug or Release, framework and launch profile, in the terminal. Anything after `--` goes to the program.
- `ledger trust` and `ledger untrust` set restricted mode for the folder.
- `ledger history <file>` lists the file's saved versions. `--show N` prints one; `--restore N` puts it back in the editor.
- `ledger self-update` updates Ledger.

**Tools**

- `ledger new <kind> <name>` makes a project: rust, rust-lib, console, classlib, webapi, blazor and every other dotnet template, react, vue, svelte and the other Vite templates, next, node, website, lua, lust and lust-app. `ledger new --list` shows them.
- `ledger doctor` checks what's installed against what the folder needs (SDKs, Rust, Node, the language servers, debuggers, `global.json`). `--fix` installs what's missing.
- `ledger clean` deletes build output: `target` next to `Cargo.toml`, `bin` and `obj` next to a .NET project, `node_modules` next to `package.json`. It shows the sizes and asks first.
- `ledger todo` lists every TODO, FIXME and HACK note. `ledger stats` counts lines of code per language.

Like Run, `ledger audit fix`, `ledger update`, `ledger run` and the rest that run a project's code only work in a trusted folder. Making a project inside a restricted folder is refused too.

## Trusting a folder (restricted mode)

Opening a downloaded project shouldn't run its code. The first time Ledger opens a folder with a project or a Git repository in it, it asks whether you trust the code in it, like VS Code does. Until you do, the folder is in **restricted mode** (shown as **Restricted** in the status bar; click it to trust the folder):

- You can read, edit, search, format and commit as usual. HTML, CSS, JSON and TypeScript help work, with the computer's own TypeScript rather than the project's.
- Run, Build, Test and Debug ask for trust first, since they run the project's code.
- Rust, C# and Lua analysis wait: rust-analyzer runs build scripts and reads the project's `.cargo/config`, csharp-ls runs MSBuild, and the Lua server loads plugins.
- The project's own Tailwind and Prettier aren't used (Ledger's built-in Prettier is).
- Git runs with the repository's hooks switched off and only ordinary remotes allowed, and not at all if the repository's settings hold anything other than plain data (filters, textconv, includes, pagers, credential helpers and the like). Ledger asks Git itself for those settings, so worktrees and unusual layouts are read the way Git reads them.
- Making a project inside the folder asks for trust too, since `dotnet new` and `npm create` read the folder's settings. Installing tools from Settings always runs in your home folder.

Lust checking works in restricted mode, since `lust check` only reads the code. Projects you make in Ledger are trusted, unless you make them inside a folder you haven't trusted. **Trust this folder, or go back to restricted mode** in the command list changes your answer. Ledger's backend enforces all this (src-tauri/src/trust.rs), not just the interface.

## Things to know

- Running saves all open files first.
- Deleting from the explorer moves files to the Recycle Bin.
- Programs run without a console window. They read input from the Input box while they run.
- Files with a byte-order mark or Windows line endings keep them when saved.
- If the status bar shows a language server with a warning or error, click it to read why.
- Programs started with the debugger can't read typed input (`read_line`); use Run or the terminal for those.

## Working on Ledger itself

```
npm install
npm run tauri dev
```

With `set VITE_DEBUG=1` first, the app's console output also shows in the terminal. `npm test` runs the tests in `tests/` (plain Node, nothing to install).

```
index.html            the window: explorer, tabs, editor, settings page, panel, status bar
src/main.js           editor, split panes, explorer, tabs, palette, tasks, keyboard commands, Godot launch handling
src/nav.js            references, outline (Markdown headings too), symbol search, parameter hints, Run/Debug links
src/lspmore.js        server colours (semantic tokens), same-symbol marks, implementation, type definition, call and type hierarchies
src/semantic.js       semantic tokens to editor classes
src/dotnet.js         .NET commands beyond Run, Build and Test
src/dotnettools.js    user secrets, the dev certificate, .http requests, EF Core and Publish
src/httpfile.js       reading .http files and http-client.env.json
src/coverage.js       reading coverage reports (Cobertura)
src/dotnetsdk.js      installed SDKs, runtimes and workloads; global.json's SDK rules
src/msbuild.js        completion in .csproj, .props and .targets
src/editorconfig.js   .editorconfig sections and what they set
src/search.js         the Search view: search and replace in files
src/findbar.js        the find and replace bar in the editor
src/editcmds.js       editing commands: select line, add cursors, sort lines, change case and more
src/editorx.js        bracket colours, indent guides, sticky scroll
src/terminal.js       the terminal panel (xterm.js)
src/git.js            git status, change bars, diff page, Source control view, branches, stashes
src/gitmore.js        merge conflict buttons and blame
src/dap.js            the debugger protocol client
src/debugger.js       breakpoints, debug sessions, the Debug view and console
src/deps.js           newest-version hints in Cargo.toml and .csproj
src/snippets.js       your snippets.json
src/win.js            per-window events
src/settings.js       settings file and the settings page
src/keys.js           shortcut parsing and the remappable keymap
src/langs.js          file types, highlighting, Godot shader and scene support, Lust
src/luststyles.js     Lust views: the pieces, style words and colours (one line each), and where the cursor is
src/lustview.js       Lust views in the editor: style completion, colour swatches, hover help
src/webcolours.js     HTML, CSS and JavaScript colours
src/tailwind.js       Tailwind class completion
src/db.js             the database tab (with src-tauri/src/db.rs)
src/image.js          the image viewer
src/md.js             Markdown preview
src/colour.js         colour swatches and the colour picker
src/emmet.js          Emmet abbreviations
src/prettier.js       formatting web files with Prettier
src/marks.js          bookmarks and the overview ruler
src/todo.js           the TODO panel
src/csv.js            CSV columns and the table view
src/hex.js            the hex view
src/history.js        local history
src-tauri/src/trust.rs restricted mode: what an untrusted folder may run
src-tauri/src/cli_link.rs  how the `ledger` command reaches its window, and putting it on the terminals' PATH
src-tauri/src/bin/ledger-cli.rs  the `ledger` command (its parts are in src-tauri/src/cli/)
src/cli.js            the window's side of the `ledger` command, and its entries in the command list
src-tauri/src/job.rs  child processes end with Ledger (a Windows Job Object)
src/tests.js          the Tests panel
src/icons.js          file icons (public/fileicons, made by scripts/fileicons.mjs)
src/scaffold.js       Vite and Next.js projects
src/update.js         updates
src/assets/lust-*.svg the Lust file icons (Lt, Ls, Lq)
src/lsp.js            the language server client (rust-analyzer, csharp-ls, TypeScript, HTML, CSS, JSON, Lua)
src/ansi.js           build output colours and clickable file:line links
src/style.css         colours and layout; light and dark tokens are at the top
src-tauri/src/lib.rs  files, running cargo/dotnet/Godot, language servers and debuggers, terminals, git, downloads, windows
src-tauri/src/live.rs Live Server
src-tauri/windows/hooks.nsh  installer steps: Lust file icons, "Open with Ledger"
build.ps1, build.cmd  local Windows build
scripts/              rename and collect helpers
tests/                tests for npm test
```
