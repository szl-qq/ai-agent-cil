@echo off
rem ============================================================
rem  Agent CLI launcher -- run "cli" from any terminal.
rem
rem  The launcher lives inside the project so it can locate the
rem  entry script relative to itself. There is no hard-coded
rem  absolute path, so the repo stays portable.
rem
rem  To get a global "cli" command, add this folder to PATH:
rem  run install-cli.cmd in the project root.
rem ============================================================
setlocal EnableExtensions

set "ENTRY=%~dp0..\bin\agent.mjs"

if not exist "%ENTRY%" (
    echo [ERROR] Agent CLI entry not found: "%ENTRY%"
    echo         This launcher must stay inside the agent-cli project folder.
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH. Install Node 18.17 or newer.
    exit /b 1
)

rem Remember the current console code page. Running a .cmd from an
rem existing shell executes inside that shell, so changing the code
rem page here would leak back into the user's terminal.
set "OLDCP="
for /f "tokens=2 delims=:" %%a in ('chcp') do set "OLDCP=%%a"
set "OLDCP=%OLDCP: =%"

rem UTF-8 for correct Chinese output and input.
chcp 65001 >nul 2>nul

node "%ENTRY%" %*
set "CODE=%ERRORLEVEL%"

if defined OLDCP chcp %OLDCP% >nul 2>nul

exit /b %CODE%
