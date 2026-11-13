@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if defined TASKMINAL_CLI_NODE if defined TASKMINAL_CLI_JS if exist "%TASKMINAL_CLI_NODE%" (
  "%TASKMINAL_CLI_NODE%" "%TASKMINAL_CLI_JS%" %*
  exit /b
)
if exist "%~dp0..\..\Taskminal.exe" (
  "%~dp0..\..\Taskminal.exe" "%~dp0..\app.asar\out\main\cli.js" %*
  exit /b
)
if exist "%~dp0..\..\node_modules\electron\dist\electron.exe" (
  "%~dp0..\..\node_modules\electron\dist\electron.exe" "%~dp0..\..\out\main\cli.js" %*
  exit /b
)
echo taskminal: Taskminal executable was not found. 1>&2
exit /b 1
