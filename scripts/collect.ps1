# Copies the finished installer and the standalone program into .\release.
# Used by build.ps1 and by the GitHub workflow.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$conf = Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$name = if ($conf.mainBinaryName) { $conf.mainBinaryName } else { $conf.productName }

New-Item -ItemType Directory -Force "release" | Out-Null
Get-ChildItem "release" -File | Remove-Item -Force

$installers = Get-ChildItem "src-tauri/target/release/bundle/nsis" -Filter "*.exe" -ErrorAction SilentlyContinue
if (-not $installers) { throw "No installer found in src-tauri/target/release/bundle/nsis. Did the build finish?" }
$installers | Copy-Item -Destination "release"

# The built program: named after mainBinaryName, or after the Cargo package on older Tauri CLIs.
$exe = @("$name.exe", "ledger.exe") | ForEach-Object { "src-tauri/target/release/$_" } | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw "Couldn't find the built .exe in src-tauri/target/release." }
Copy-Item $exe "release/$name-portable.exe"

Write-Host ""
Write-Host "Done. In the release folder:"
Get-ChildItem "release" | ForEach-Object { Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB)) }
