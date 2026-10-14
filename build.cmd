@echo off
rem Double-click to build the installer and a portable .exe into the release folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
if errorlevel 1 (
  echo.
  echo The build stopped with an error. See the messages above.
)
pause
