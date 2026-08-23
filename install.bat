@echo off
echo Lazy-Image — After Effects Installer
echo ====================================
echo.

echo Enabling PlayerDebugMode in registry for CSXS.9 through CSXS.13...
reg add "HKCU\Software\Adobe\CSXS.9" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul
reg add "HKCU\Software\Adobe\CSXS.10" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul
reg add "HKCU\Software\Adobe\CSXS.13" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul
echo PlayerDebugMode enabled.
echo.

echo Creating directory junction for the extension...
set EXT_DIR=%APPDATA%\Adobe\CEP\extensions\com.gimage.aftereffects
if exist "%EXT_DIR%" rmdir "%EXT_DIR%"
mkdir "%APPDATA%\Adobe\CEP\extensions" 2>nul
mklink /J "%EXT_DIR%" "%~dp0"
echo.

echo Success! Extension has been installed correctly.
echo সফল! এক্সটেনশন সঠিকভাবে ইনস্টল করা হয়েছে।
echo.
pause
