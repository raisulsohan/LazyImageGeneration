@echo off
rem Lazy-Image - removes the panel. The ChatGPT login it saved is removed too,
rem but only if you say so. Images you generated stay where they are.

setlocal EnableExtensions
title Uninstall Lazy-Image
set "EXT_ROOT=%APPDATA%\Adobe\CEP\extensions"
set "DEST=%EXT_ROOT%\com.gimage.aftereffects"
set "DATA=%APPDATA%\LazyImage"

echo Removing the Lazy-Image panel...
echo Close After Effects and Premiere Pro first.
echo.
pause

if not exist "%DEST%" (
  echo The panel was not installed.
  goto :login
)

dir /a:l /b "%EXT_ROOT%" 2>nul | findstr /i /x "com.gimage.aftereffects" >nul
if not errorlevel 1 (rmdir "%DEST%") else (rmdir /s /q "%DEST%")

if exist "%DEST%" (
  echo [!] Could not remove it - After Effects or Premiere Pro is probably still open.
  goto :end
)
echo Removed the panel.

:login
if not exist "%DATA%" goto :done
echo.
echo Lazy-Image also keeps your ChatGPT login in
echo   %DATA%
choice /c YN /m "Remove the saved login as well"
if errorlevel 2 goto :done
rmdir /s /q "%DATA%"
if exist "%DATA%" (
  echo [!] Could not remove it - close any browser window Lazy-Image opened and try again.
) else (
  echo Removed the saved login.
)

:done
echo.
echo Images you generated stay in the chatgptimages folders next to your projects.

:end
echo.
pause
