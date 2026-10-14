# Builds the Windows installer and a portable .exe on this PC.
# Run build.cmd (double-click it), or: powershell -ExecutionPolicy Bypass -File build.ps1
#
# Installs anything missing first (Node.js, Rust, the C++ build tools) using winget.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
# Adds folders from the system and user PATH (where fresh installs land) to this
# window's PATH. Keeps what's already there, so Node from nvm, fnm, Volta or
# Scoop is still found.
function Refresh-Path {
  $parts = @($env:Path -split ";") +
           @([Environment]::GetEnvironmentVariable("Path", "Machine") -split ";") +
           @([Environment]::GetEnvironmentVariable("Path", "User") -split ";") +
           @("$env:USERPROFILE\.cargo\bin", "$env:ProgramFiles\nodejs")
  $env:Path = (($parts | Where-Object { $_ -and $_.Trim() }) | Select-Object -Unique) -join ";"
}
function Found($what, $cmd) {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue
  if ($c) { Write-Host ("  {0}: found ({1})" -f $what, $c.Source) -ForegroundColor DarkGray }
  return [bool]$c
}
function Winget-Install($id, $extra = @()) {
  if (-not (Have winget)) {
    throw "winget isn't available, so $id can't be installed automatically. Install it by hand and run this again."
  }
  Write-Host "Installing $id (this can take a few minutes)..." -ForegroundColor Cyan
  winget install --id $id -e --accept-source-agreements --accept-package-agreements @extra
  Refresh-Path
}

Refresh-Path
Write-Host "Checking what's installed..." -ForegroundColor Cyan

# 1. Microsoft C++ build tools (Rust needs the linker on Windows).
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$hasVC = $false
if (Test-Path $vswhere) {
  $hasVC = [bool](& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
}
if ($hasVC) { Write-Host "  C++ build tools: found" -ForegroundColor DarkGray }
else {
  Write-Host "  C++ build tools: missing. Rust needs Microsoft's linker on Windows, so they're installed now." -ForegroundColor Yellow
  Winget-Install "Microsoft.VisualStudio.2022.BuildTools" @("--override", "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended")
}

# 2. Rust.
if (-not (Found "Rust" cargo)) {
  Winget-Install "Rustlang.Rustup"
  if (Have rustup) { rustup default stable }
}
if (-not (Have cargo)) { throw "Rust was installed but isn't on PATH yet. Close this window and run build.cmd again." }

# 3. Node.js.
if (-not (Found "Node.js" npm)) { Winget-Install "OpenJS.NodeJS.LTS" }
if (-not (Have npm)) { throw "Node.js was installed but isn't on PATH yet. Close this window and run build.cmd again." }

# 4. Build. The first build compiles a lot of Rust and takes several minutes.
Write-Host "Installing JavaScript packages..." -ForegroundColor Cyan
if (Test-Path "package-lock.json") { npm ci } else { npm install }
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

Write-Host "Building (the first time takes a while)..." -ForegroundColor Cyan
npm run tauri build
if ($LASTEXITCODE -ne 0) { throw "The build failed. The messages above say why." }

& (Join-Path $PSScriptRoot "scripts\collect.ps1")
