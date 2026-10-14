# Ledger

A Windows code editor for Rust, C# and Godot, built with Tauri. It borrows the look of Meisner's Ledger: a side bar on the left, open files as tabs, the editor, and a thin status bar (along the bottom or the top, your choice). Everything can be done from the keyboard.

To change the name, see [Renaming](#renaming).

## What it does

- **Rust**: run, check, test and Clippy with cargo; live errors, completions, hover docs, go to definition, rename, quick fixes and formatting through rust-analyzer.
- **C#**: build, run and test with dotnet; the same editor features through a C# language server (csharp-ls by default).
- **Godot**: Play builds the C# project, then starts the game with its output in the panel. Play scene runs the open `.tscn`. Godot can open scripts in Ledger at the right line, and shaders (`.gdshader`) get highlighting and completion for Godot's shading language. Scene and resource files are highlighted too.
- **Lust**: our own language. `.lust` files get highlighting, completions and snippets (`class`, `is`, `loop`, `either`…), and show the L# icon in the explorer and tabs. The installer makes `.lust` files open in Ledger with the same icon in File Explorer. Running Lust comes with its compiler.
- **Editor**: tabs, split editor (Ctrl \\), search and replace (Ctrl F), multiple cursors, folding, coloured bracket pairs, indent guides, sticky scroll (the line that opens the current function or block stays pinned at the top), problems list, clickable file:line links in build output, back and forward through your jumps, a warning when a file you're editing changes on disk.
- **Getting around**: find all references (Shift F12), an Outline of the open file (Ctrl Shift O), symbol search (type @ or # in Ctrl E), parameter hints while you type a call.
- **Debugging**: breakpoints (F9), start with Shift F9, step with F10, F11 and Shift F11, continue with F5. Variables, watches, call stack and a debug console. Rust uses codelldb, C# and Godot use netcoredbg; Ledger downloads them the first time you need them.
- **Tests**: ▶ Run test and Debug links above each test and above `main`.
- **Terminal**: real PowerShell terminals in the bottom panel (Ctrl ` shows one, Ctrl T opens a new one).
- **Git**: changed files are coloured in the explorer, changed lines are marked next to the line numbers, a side-by-side diff view, and a Source control view to stage, commit, pull and push (Ctrl Shift G).
- **Dependencies**: in Cargo.toml and .csproj files, the newest version of each package shows at the end of its line; click it to update.
- **Snippets**: your own, per language, in snippets.json (Settings › Editing › Edit snippets).
- **Settings** on Ctrl P: theme, fonts, status bar position, tab size, wrapping, format on save, auto save, editor extras, tool paths, terminal shell, debuggers, Godot setup, and every Ledger command's shortcut can be changed.

Each window has one folder open. Ctrl Shift N opens another window (or Ctrl Enter on a recent folder on the start page), each with its own program, language servers, debugger and terminals. Open a project folder (with `Cargo.toml`, a `.sln`/`.csproj`, or `project.godot`), or a folder that holds several projects, like a course folder with one project per lesson. Run, Build and Test always use the project of the file you have open; its name shows at the left of the status bar. New project (in the command list) can create the project inside the open folder.

- **Program input**: while your program runs, an **Input** box appears under the output. Type a line and press Enter, and it reaches `read_line` or `Console.ReadLine`. Ctrl I jumps to it; **End input** closes the program's input.
- **Stop** (Shift F5) ends the program too, including endless loops. While debugging it ends the debug session.
- **Type hints**: the types and parameter names Rust and C# work out show in grey, like `count: usize`. They aren't part of your file. Turn them off in Settings or with **Toggle type hints**.

## Building the .exe

Two ways. Both put the same two files in a `release` folder:

- `Ledger_0.1.0_x64-setup.exe`, an installer (adds a Start menu entry, installs for your user only, no admin needed).
- `Ledger-portable.exe`, the program itself. It runs from anywhere and needs nothing else on Windows 11.

### On your PC

Double-click **`build.cmd`**. It installs anything missing using winget (Node.js, Rust, and Microsoft's C++ build tools, which Rust needs to link programs on Windows), then builds. The C++ tools ask for permission once. The first build takes about 10 minutes; later ones are much faster.

If it says something was installed but isn't on PATH yet, close the window and run `build.cmd` again.

### On GitHub (nothing to install)

1. Make a free GitHub account and a new repository, then upload this folder to it (GitHub Desktop is the easiest way).
2. The **Windows build** workflow in `.github/workflows` runs on every push. Open the **Actions** tab, click the latest run, and download **windows-build** under Artifacts.

You can also start it by hand from the Actions tab (**Run workflow**).

## Tools to install for language features

Building and running only need what you already use (Rust for Rust projects, the .NET SDK for C#, Godot for Godot). For live errors, completions and the rest:

- **Rust**: `rustup component add rust-analyzer rust-src`
- **C#**: install the [.NET 10 SDK](https://dotnet.microsoft.com/download) (csharp-ls runs on it; your projects can still target .NET 8), then `dotnet tool install --global csharp-ls`

Settings has buttons for both, and shows which tools it found.

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

Every command is in the command list (Ctrl Shift P or F1) with its shortcut. Change any of them in Settings › Keyboard shortcuts. The editor's own keys (Ctrl F, Ctrl Z, Ctrl D, Ctrl / and the like) are fixed.

| Key | Does |
| --- | --- |
| Ctrl P | Settings |
| Ctrl E | Go to file |
| Ctrl T | New terminal |
| Ctrl Shift P, F1 | All commands |
| Ctrl Shift F | Search in files |
| Ctrl G | Go to line |
| F6 / Shift F6 | Move between explorer, editor, panel and status bar |
| Ctrl Shift E | Explorer (arrows move, Right/Left open/close folders, Enter opens, Space opens but stays in the explorer, F2 renames, Delete recycles, Shift F10 menu, type to jump) |
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
| Ctrl + / Ctrl - / Ctrl 0 | Editor text size |

In dialogs, arrow keys move and Enter picks; in choice dialogs the number keys pick directly.

In a terminal, Ctrl+letter keys go to the shell (Ctrl C, Ctrl R…), except Ctrl P, Ctrl T, Ctrl J and Ctrl B. Function keys, Ctrl Shift and Ctrl Alt shortcuts always reach Ledger; F6 or Ctrl ` gets you out.

## App icon

Ledger's icon is the red L> in `src-tauri/app-icons/ledger-plain.svg`. To change it, replace that file (and `app-icon.png`), run `npx tauri icon src-tauri/app-icons/ledger-plain.svg -o src-tauri/icons`, and rebuild.

## Renaming

```
npm run rename -- "New Name"
```

This changes the window title, the Start menu entry, the installer, the program (`NewName.exe`) and this README. Settings stay where they are. Then rebuild.

## Things to know

- Running saves all open files first.
- Deleting from the explorer moves files to the Recycle Bin.
- Programs run without a console window. They read input from the Input box while they run.
- Files with a byte-order mark or Windows line endings keep them when saved.
- If the status bar shows a language server with a warning or error, click it to read why.
- Programs started with the debugger can't read typed input (`read_line`); use Run or the terminal for those.
- Debugging C# tests isn't supported; ▶ Run test works for them.

## Working on Ledger itself

```
npm install
npm run tauri dev
```

With `set VITE_DEBUG=1` first, the app's console output also shows in the terminal.

```
index.html            the window: explorer, tabs, editor, settings page, panel, status bar
src/main.js           editor, split panes, explorer, tabs, palette, tasks, keyboard commands, Godot launch handling
src/nav.js            references, outline, symbol search, parameter hints, Run/Debug links
src/editorx.js        bracket colours, indent guides, sticky scroll
src/terminal.js       the terminal panel (xterm.js)
src/git.js            git status, change bars, diff page, Source control view
src/dap.js            the debugger protocol client
src/debugger.js       breakpoints, debug sessions, the Debug view and console
src/deps.js           newest-version hints in Cargo.toml and .csproj
src/snippets.js       your snippets.json
src/win.js            per-window events
src/settings.js       settings file and the settings page
src/keys.js           shortcut parsing and the remappable keymap
src/langs.js          file types, highlighting, Godot shader and scene support, Lust
src/assets/lust.svg   the Lust file icon
src/lsp.js            the language server client (rust-analyzer, csharp-ls)
src/ansi.js           build output colours and clickable file:line links
src/style.css         colours and layout; light and dark tokens are at the top
src-tauri/src/lib.rs  files, running cargo/dotnet/Godot, language servers and debuggers, terminals, git, downloads, windows
src-tauri/windows/hooks.nsh  installer step that gives .lust files the L# icon
build.ps1, build.cmd  local Windows build
scripts/              rename and collect helpers
```
