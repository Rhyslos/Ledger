# Ledger

A Windows code editor for Rust, C#, Godot, web projects (HTML, CSS, JavaScript, TypeScript, React, Tailwind), Lua and our own language Lust, built with Tauri. It borrows the look of Meisner's Ledger: a side bar on the left, open files as tabs, the editor, and a thin status bar (along the bottom or the top, your choice). Everything can be done from the keyboard.

**Ledger has no AI in it, and never will.** No assistant, no chat panel, no generated code, nothing sent off to a model. It's an editor: what's in your files is what you wrote.

To change the name, see [Renaming](#renaming).

## What it does

- **Rust**: run, check, test and Clippy with cargo; live errors, completions, hover docs, go to definition, rename, quick fixes and formatting through rust-analyzer.
- **C#**: build, run and test with dotnet; the same editor features through a C# language server (csharp-ls by default).
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
- **Tests panel**: finds Rust, C# and Lust tests, runs all of them, the failed ones, a file or one test, shows the output live while they run (with a Stop button), shows each failure's message and line, and marks results next to each test in the editor. **Tests: create a test for this file** gets you started.
- **Bookmarks**: Ctrl Alt K marks a line (a blue ribbon by its number), Ctrl Alt L and Ctrl Alt J go to the next and previous, **Bookmarks: list** shows them all. They're kept for next time.
- **Overview ruler**: errors, warnings, search matches, Git changes and bookmarks are marked along the scrollbar, so you can see where they are in a long file.
- **TODO panel**: every `TODO`, `FIXME`, `HACK`, `XXX` and `BUG` comment in the folder, grouped by file and filtered by word, in the bottom panel. The words are tinted in the editor too.
- **Zen mode**: Ctrl Alt Z hides everything but the editor and goes full screen; the same key brings it all back.
- **Local history**: every save keeps a copy (the last 50 per file, in Ledger's own folder, not your project), plus the file as it was before you started editing. **Local history: this file's saved versions** (or right-click a file) shows any of them next to the file now, with **Restore this version**. Works in folders without Git.
- **Indentation**: each file is indented the way it already is (2 spaces, 4, tabs), shown in the status bar; click it to change it for that file. Enter, Emmet and Prettier follow it.
- **Editor**: tabs, split editor (Ctrl \\), search and replace (Ctrl F), multiple cursors, folding, coloured bracket pairs, indent guides, sticky scroll (the line that opens the current function or block stays pinned at the top), problems list, clickable file:line links in build output, back and forward through your jumps, a warning when a file you're editing changes on disk.
- **Getting around**: find all references (Shift F12), an Outline of the open file (Ctrl Shift O), symbol search (type @ or # in Ctrl E), parameter hints while you type a call.
- **Debugging**: breakpoints (F9), start with Shift F9, step with F10, F11 and Shift F11, continue with F5. Variables, watches, call stack and a debug console. Rust uses codelldb, C# and Godot use netcoredbg; Ledger downloads them the first time you need them.
- **Run and Debug links**: ▶ Run test and Debug above each Rust and C# test and above `main`.
- **Terminal**: real PowerShell terminals in the bottom panel (Ctrl ` shows one, Ctrl T opens a new one).
- **Git**: changed files are coloured in the explorer, changed lines are marked next to the line numbers, a side-by-side diff view, and a Source control view to stage, commit, pull and push (Ctrl Shift G).
  - **Branches**: click the branch in the status bar (or in Source control) to switch, make a new one, merge one in or delete one. If switching would lose changes, Ledger offers to stash them first.
  - **Stashes**: put changes aside (Source control's ⋯ menu, or **Git: stash changes**) and click one in the Stashes list to pop it back, apply it, see what's in it or drop it.
  - **Merge conflicts**: each conflict gets **Keep yours**, **Keep theirs**, **Keep both** and **Compare** above it, with the two sides tinted; Alt F7 goes to the next one. Source control shows the merge in progress: which files still have conflicts, **Stage the resolved files** and **Abort the merge**, with Git's merge message ready in the commit box. Ledger won't commit a file that still has conflict markers without asking, and **Commit all** asks before adding files Git doesn't track yet.
  - **Blame**: the cursor's line shows who last changed it, when, and the commit message, faintly at its end; click it to see what that commit changed. **Git: blame on/off**, or Settings › Git.
- **Dependencies**: in Cargo.toml and .csproj files, the newest version of each package shows at the end of its line; click it to update.
- **Snippets**: your own, per language, in snippets.json (Settings › Editing › Edit snippets).
- **Tabs**: clicking through files in the explorer reuses one preview tab (in italics) until you edit, save or pin it. Right-click a tab to pin it, or to close the saved tabs or all of them.
- **File icons** for every kind of file and common folders (Material Icon Theme; Settings › Appearance turns them off).
- **Installing languages**: Settings › Languages installs Node.js, Lua, Rust, the .NET SDK, Git, Lust and the language servers with one click.
- **Explorer menu**: "Open with Ledger" when you right-click a file or folder in Windows (Settings › Windows turns it off).
- **Updates**: Ledger checks for a new version on start, downloads it in the background and shows **Restart to update**.
- **Settings** on Ctrl P: theme, fonts, status bar position, tab size, wrapping, format on save, auto save, editor extras, tool paths, terminal shell, debuggers, Godot setup, and every Ledger command's shortcut can be changed.

Each window has one folder open. Ctrl Shift N opens another window (or Ctrl Enter on a recent folder on the start page), each with its own program, language servers, debugger and terminals. Open a project folder (with `Cargo.toml`, a `.sln`/`.csproj`, `project.godot` or `package.json`), or a folder that holds several projects, like a course folder with one project per lesson. Run, Build and Test always use the project of the file you have open; its name shows at the left of the status bar. New project (in the command list) can create the project inside the open folder.

- **Program input**: while your program runs, an **Input** box appears under the output. Type a line and press Enter, and it reaches `read_line` or `Console.ReadLine`. Ctrl I jumps to it; **End input** closes the program's input.
- **Stop** (Shift F5) ends the program too, including endless loops. While debugging it ends the debug session.
- **Type hints**: the types and parameter names the language servers work out (Rust, C#, TypeScript, Lua) show in grey, like `count: usize`. They aren't part of your file. Turn them off in Settings or with **Toggle type hints**.

## Building the .exe

Two ways. Both put the same two files in a `release` folder:

- `Ledger_0.1.<n>_x64-setup.exe`, an installer (adds a Start menu entry, installs for your user only, no admin needed).
- `Ledger-portable.exe`, the program itself. It runs from anywhere and needs nothing else on Windows 11.

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
- **C#**: install the [.NET 10 SDK](https://dotnet.microsoft.com/download) (csharp-ls runs on it; your projects can still target .NET 8), then `dotnet tool install --global csharp-ls`

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
| Ctrl Shift E | Explorer (arrows move, Right/Left open/close folders, Enter opens, a click or Space shows the file in a preview tab and stays in the explorer, F2 renames, Delete recycles, Shift F10 menu, type to jump) |
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

## Trusting a folder (restricted mode)

Opening a downloaded project shouldn't run its code. The first time Ledger opens a folder with a project or a Git repository in it, it asks whether you trust the code in it, like VS Code does. Until you do, the folder is in **restricted mode** (shown as **Restricted** in the status bar; click it to trust the folder):

- You can read, edit, search, format and commit as usual. HTML, CSS, JSON and TypeScript help work, with the computer's own TypeScript rather than the project's.
- Run, Build, Test and Debug ask for trust first, since they run the project's code.
- Rust, C# and Lua analysis wait: rust-analyzer runs build scripts and reads the project's `.cargo/config`, csharp-ls runs MSBuild, and the Lua server loads plugins.
- The project's own Tailwind and Prettier aren't used (Ledger's built-in Prettier is).
- Git runs with the repository's hooks switched off, and not at all if the repository's settings would start other programs (filters, textconv, includes and the like).

Lust checking works in restricted mode, since `lust check` only reads the code. Projects you make in Ledger are trusted. **Trust this folder, or go back to restricted mode** in the command list changes your answer. Ledger's backend enforces all this (src-tauri/src/trust.rs), not just the interface.

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

With `set VITE_DEBUG=1` first, the app's console output also shows in the terminal. `npm test` runs the tests in `tests/` (plain Node, nothing to install).

```
index.html            the window: explorer, tabs, editor, settings page, panel, status bar
src/main.js           editor, split panes, explorer, tabs, palette, tasks, keyboard commands, Godot launch handling
src/nav.js            references, outline, symbol search, parameter hints, Run/Debug links
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
