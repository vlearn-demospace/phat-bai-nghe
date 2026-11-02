@echo off
chcp 65001 >nul
title Phat bai nghe - GIU CUA SO NAY MO
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Chua cai Node.js. Dang mo trang tai ve...
  echo Cai ban LTS, xong thi bam dup lai file nay.
  start "" https://nodejs.org/
  pause
  exit /b
)
node server.js
pause
