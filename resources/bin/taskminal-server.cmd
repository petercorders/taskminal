@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if defined TASKMINAL_CLI_NODE if defined TASKMINAL_SERVER_JS if exist "%TASKMINAL_CLI_NODE%" (
  "%TASKMINAL_CLI_NODE%" "%TASKMINAL_SERVER_JS%" %*
  exit /b
)
if exist "%~dp0..\..\Taskminal.exe" (
  "%~dp0..\..\Taskminal.exe" "%~dp0..\app.asar\out\main\server.js" %*
  exit /b
)
if exist "%~dp0..\..\node_modules\electron\dist\electron.exe" (
  "%~dp0..\..\node_modules\electron\dist\electron.exe" "%~dp0..\..\out\main\server.js" %*
  exit /b
)
echo taskminal-server: Taskminal executable was not found. 1>&2
exit /b 1
