@echo off
rem Alias for cli -- harmless convenience in case of a typo.
call "%~dp0cli.cmd" %*
exit /b %ERRORLEVEL%
