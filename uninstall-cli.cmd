@echo off
setlocal EnableExtensions
rem ============================================================
rem  Remove the "cli" command from the user PATH.
rem  The project files themselves are left untouched.
rem ============================================================
title Uninstall Agent CLI command

set "SHIM=%~dp0shim"

echo.
echo   Agent CLI - remove global command
echo   ---------------------------------
echo   Folder : %SHIM%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $d=$env:SHIM.TrimEnd('\'); $p=[Environment]::GetEnvironmentVariable('Path','User'); if($null -eq $p){$p=''}; $items=@($p.Split(';') | Where-Object { $_ -ne '' }); if($items -contains $d){ $new=((@($items | Where-Object { $_ -ne $d })) -join ';'); [Environment]::SetEnvironmentVariable('Path',$new,'User'); Write-Host '  Result : removed from user PATH.' } else { Write-Host '  Result : not registered, nothing changed.' }"

if errorlevel 1 (
    echo.
    echo [ERROR] Failed to update the user PATH. See the message above.
    goto :done
)

echo.
echo   Done. Restart any open terminal for it to take effect.

:done
echo.
echo %cmdcmdline% | findstr /i /c:"/c" >nul && pause
endlocal
