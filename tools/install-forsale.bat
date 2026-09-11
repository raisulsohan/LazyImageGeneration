@echo off
setlocal
title Lazy-Image Installer

echo ============================================================
echo   Lazy-Image  -  After Effects ^& Premiere Pro
echo ============================================================
echo.
echo Please close After Effects and Premiere Pro before continuing.
echo.
pause
echo.

echo [1 of 2] Enabling Adobe extension support...
for %%V in (9 10 11 12 13 14 15 16 17 18 19 20 21 22) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
)
echo          done.
echo.

set "EXT_DIR=%APPDATA%\Adobe\CEP\extensions\com.gimage.aftereffects"

echo [2 of 2] Installing the panel...
if exist "%EXT_DIR%" rmdir /S /Q "%EXT_DIR%" >nul 2>&1
mkdir "%EXT_DIR%" >nul 2>&1
if not exist "%EXT_DIR%" goto failed

xcopy "%~dp0CSXS" "%EXT_DIR%\CSXS\" /E /I /Y >nul
if errorlevel 1 goto failed
xcopy "%~dp0client" "%EXT_DIR%\client\" /E /I /Y >nul
if errorlevel 1 goto failed
xcopy "%~dp0host" "%EXT_DIR%\host\" /E /I /Y >nul
if errorlevel 1 goto failed
echo          done.
echo.

echo ============================================================
echo   Installation complete.
echo.
echo   Open After Effects or Premiere Pro, then go to:
echo       Window  ^>  Extensions  ^>  Lazy-Image
echo.
echo   The panel will show a Machine ID. Email it to
echo       lettertosohan@gmail.com
echo   to receive your activation key.
echo ============================================================
echo.
pause
exit /b 0

:failed
echo.
echo ------------------------------------------------------------
echo   Installation FAILED.
echo.
echo   Close After Effects and Premiere Pro, then right-click
echo   install.bat and choose "Run as administrator".
echo.
echo   If it still fails, email lettertosohan@gmail.com
echo ------------------------------------------------------------
echo.
pause
exit /b 1
