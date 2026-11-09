@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WordLab

where node >nul 2>nul
if errorlevel 1 goto NONODE

node "scripts\start.mjs"
goto END

:NONODE
echo.
echo   [X] Node.js not found.
echo       Please install Node.js LTS (20.19+ or 22.12+) from https://nodejs.org/
echo       then double-click this file again.
echo.
pause
exit /b 1

:END
echo.
pause
