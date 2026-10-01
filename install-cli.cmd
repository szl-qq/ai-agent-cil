@echo off
setlocal EnableExtensions
rem ============================================================
rem  Register the "cli" command so it works in any terminal.
rem
rem  Adds this project's shim folder to the USER PATH (not the
rem  system PATH, no admin rights needed, no other app affected).
rem
rem  Uses [Environment]::SetEnvironmentVariable instead of setx:
rem  setx truncates values longer than 1024 characters and, when
rem  fed "%PATH%", it silently merges the system PATH into the
rem  user PATH -- both are real ways to corrupt a PATH.
rem ============================================================
title Install Agent CLI command

set "SHIM=%~dp0shim"

if not exist "%SHIM%\cli.cmd" (
    echo [ERROR] Launcher not found: "%SHIM%\cli.cmd"
    echo         Run this script from the agent-cli project folder.
    goto :done
)

echo.
echo   Agent CLI - install global command
echo   ----------------------------------
echo   Command to add : cli   (and the alias "cil")
echo   Folder         : %SHIM%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $d=$env:SHIM.TrimEnd('\'); $p=[Environment]::GetEnvironmentVariable('Path','User'); if($null -eq $p){$p=''}; $items=@($p.Split(';') | Where-Object { $_ -ne '' }); if($items -contains $d){ Write-Host '  Result         : already registered, nothing changed.' } else { $new=(($items + $d) -join ';'); [Environment]::SetEnvironmentVariable('Path',$new,'User'); Write-Host '  Result         : added to user PATH.' }"

if errorlevel 1 (
    echo.
    echo [ERROR] Failed to update the user PATH. See the message above.
    goto :done
)

echo.
echo   Done. Open a NEW terminal window, then type:
echo.
echo       cli            start the agent interactively
echo       cli -p "hi"    run a single task
echo       cli --help     list all options
echo.
echo   Already-open terminals keep the old PATH until restarted.
echo   To undo, run uninstall-cli.cmd

:done
echo.
echo %cmdcmdline% | findstr /i /c:"/c" >nul && pause
endlocal
