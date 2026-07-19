@echo off
setlocal
cd /d "%~dp0"

set "DOTNET=%LOCALAPPDATA%\dotnet\dotnet.exe"
if not exist "%DOTNET%" set "DOTNET=dotnet"

call npm run build
if errorlevel 1 exit /b 1
call npm run win:sync-ui
if errorlevel 1 exit /b 1

"%DOTNET%" build "win\MyDesktopCalendar\MyDesktopCalendar.csproj" -c Release
if errorlevel 1 exit /b 1

start "" "win\MyDesktopCalendar\bin\Release\net8.0-windows\MyDesktopCalendar.exe"
