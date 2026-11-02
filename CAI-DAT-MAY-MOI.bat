@echo off
chcp 65001 >nul
title Cai dat Phat bai nghe tren may moi
set "DEST=%USERPROFILE%\phat-bai-nghe"
set "WG=--silent --accept-package-agreements --accept-source-agreements"
set "PATH=%PATH%;C:\Program Files\Git\cmd;C:\Program Files\nodejs"
echo ==========================================================
echo   CAI DAT PHAT BAI NGHE  -  thu muc: %DEST%
echo ==========================================================
echo.

echo [1/5] Node.js...
where node >nul 2>nul
if not errorlevel 1 goto node_ok
winget install --id OpenJS.NodeJS.LTS -e %WG%
:node_ok

echo [2/5] Git...
where git >nul 2>nul
if not errorlevel 1 goto git_ok
winget install --id Git.Git -e %WG%
:git_ok

echo [3/5] Cloudflare Tunnel (cloudflared)...
where cloudflared >nul 2>nul
if not errorlevel 1 goto cf_ok
if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" goto cf_ok
winget install --id Cloudflare.cloudflared -e %WG%
:cf_ok

echo [4/5] Tai chuong trinh tu GitHub (co the hien cua so dang nhap GitHub)...
where git >nul 2>nul
if errorlevel 1 goto fail_git
if exist "%DEST%\.git" goto update
git clone https://github.com/vlearn-demospace/phat-bai-nghe.git "%DEST%"
if errorlevel 1 goto fail_clone
goto shortcut
:update
cd /d "%DEST%"
git fetch -q origin main
if errorlevel 1 goto fail_clone
git reset -q --hard origin/main

:shortcut
echo [5/5] Tao loi tat tren Desktop...
powershell -NoProfile -Command "$d=[Environment]::GetFolderPath('Desktop'); $w=New-Object -ComObject WScript.Shell; foreach($p in @(@('Phat bai nghe','MO-CHUONG-TRINH.bat'),@('Cap nhat Phat bai nghe','CAP-NHAT.bat'))){ $s=$w.CreateShortcut($d+'\'+$p[0]+'.lnk'); $s.TargetPath='%DEST%\'+$p[1]; $s.WorkingDirectory='%DEST%'; $s.Save() }"
echo.
echo ==========================================================
echo   XONG. Tren Desktop co 2 loi tat:
echo     - "Phat bai nghe"          : mo chuong trinh
echo     - "Cap nhat Phat bai nghe" : lay ban moi nhat tu GitHub
echo   Neu vua cai Node.js lan dau, hay KHOI DONG LAI may truoc khi dung.
echo ==========================================================
pause
exit /b 0

:fail_git
echo LOI: chua cai duoc Git. Khoi dong lai may roi chay lai file nay.
pause
exit /b 1
:fail_clone
echo LOI: khong tai duoc tu GitHub. Kiem tra mang va tai khoan GitHub co quyen vao repo vlearn-demospace/phat-bai-nghe.
pause
exit /b 1
