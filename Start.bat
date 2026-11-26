@echo off
setlocal
cd /d "%~dp0" || goto :failed
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24.11 or later from https://nodejs.org/ and open Start.bat again.
  goto :failed
)
node scripts\start.mjs
set "status=%errorlevel%"
if not "%status%"=="0" pause
exit /b %status%

:failed
pause
exit /b 1
