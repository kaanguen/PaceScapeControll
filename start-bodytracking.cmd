@echo off
rem Double-click starter: PaceScape Control server plus Femto Bolt body tracking.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-bodytracking.ps1" %*
echo.
pause
