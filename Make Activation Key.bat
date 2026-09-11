@echo off
setlocal
title Lazy-Image - Make an activation key
cd /d "%~dp0"

echo ============================================================
echo    Lazy-Image  -  Make an activation key
echo ============================================================
echo.
echo  Paste the two things the buyer emailed you.
echo.

set "EMAIL="
set /p "EMAIL=  Buyer's email address  : "
if not defined EMAIL goto missing

set "MACHINE="
set /p "MACHINE=  Machine ID             : "
if not defined MACHINE goto missing

echo.
echo ------------------------------------------------------------
node "tools\make-license.js" "%EMAIL%" "%MACHINE%"
if errorlevel 2 goto limit
goto done

:limit
echo.
set "ANSWER="
set /p "ANSWER=  This buyer is over the limit. Give them one anyway? (y/n) : "
if /i not "%ANSWER%"=="y" goto done
echo.
node "tools\make-license.js" "%EMAIL%" "%MACHINE%" --force
goto done

:missing
echo.
echo   Both the email address and the Machine ID are needed.

:done
echo.
pause
