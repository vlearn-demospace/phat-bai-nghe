@echo off
chcp 65001 >nul
title Cap nhat Phat bai nghe tu GitHub
cd /d "%~dp0"
set "REPO=https://github.com/vlearn-demospace/phat-bai-nghe.git"
set "PATH=%PATH%;C:\Program Files\Git\cmd"

where git >nul 2>nul
if not errorlevel 1 goto have_git
echo Chua co Git tren may nay. Dang cai Git...
winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements
set "PATH=%PATH%;C:\Program Files\Git\cmd"
where git >nul 2>nul
if not errorlevel 1 goto have_git
echo LOI: khong cai duoc Git. Tai tai https://git-scm.com/download/win roi chay lai file nay.
pause
exit /b 1

:have_git
if exist ".git" goto fetch
echo Lan dau: noi thu muc nay voi GitHub...
git init -q -b main
git remote add origin "%REPO%"

:fetch
echo Dang tai ban moi nhat tu GitHub...
echo (Lan dau co the hien cua so dang nhap GitHub - dang nhap tai khoan co quyen vao repo.)
git fetch -q origin main
if errorlevel 1 goto fail
git reset -q --hard origin/main
git branch -q --set-upstream-to=origin/main main >nul 2>nul
echo.
echo XONG. Ban hien tai:
git log -1 --format="   %%h  %%ad  %%s" --date=format:"%%d/%%m/%%Y %%H:%%M"
echo Du lieu ky thi (thu muc data, log.txt) duoc giu nguyen.
echo.
pause
exit /b 0

:fail
echo.
echo LOI: khong tai duoc tu GitHub. Kiem tra mang Internet va tai khoan GitHub.
pause
exit /b 1
