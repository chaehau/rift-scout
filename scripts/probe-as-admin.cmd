@echo off
setlocal
rem Run lcu-probe.mjs with administrator rights (the CN client usually runs at a higher integrity level).
net session >nul 2>&1
if %errorlevel% neq 0 (
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  )
  exit /b
)
cd /d "%~dp0.."
set OUT=%TEMP%\lcu-probe.log
node scripts\lcu-probe.mjs %* > "%OUT%" 2>&1
type "%OUT%"
echo.
echo Log saved to %OUT%
pause
