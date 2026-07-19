@echo off
setlocal EnableExtensions
cd /d "%~dp0"

:: Windows 방화벽 인바운드 허용 (관리자 권한)
::   allow-firewall-inbound.bat              — ..\.env 의 PORT 또는 3010
::   allow-firewall-inbound.bat 3010         — 포트 지정
::   allow-firewall-inbound.bat 3010 -Remove — 해당 규칙 삭제

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 관리자 권한으로 다시 실행합니다...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process -LiteralPath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs -ArgumentList @('%*')"
  exit /b
)

set "PS1=%~dp0allow-firewall-inbound.ps1"
if not exist "%PS1%" (
  echo [오류] allow-firewall-inbound.ps1 을 찾을 수 없습니다:
  echo   %PS1%
  pause
  exit /b 1
)

if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
) else if /i "%~1"=="-Remove" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Remove
) else if /i "%~2"=="-Remove" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Port %~1 -Remove
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Port %~1
)

set "ERR=%errorlevel%"
echo.
pause
exit /b %ERR%
