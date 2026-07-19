#Requires -Version 5.1
<#
.SYNOPSIS
  Windows 방화벽 인바운드 규칙 — My Desktop Calendar HTTP 포트 허용

.DESCRIPTION
  LAN(Start Server Web / HOSTNAME=0.0.0.0) 접속을 위해 TCP 인바운드를 엽니다.
  관리자 권한 필요.

  포트: 인자 > 프로젝트 루트 .env 의 PORT > 3010
  규칙 이름: My Desktop Calendar HTTP ({PORT})
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-PortFromDotEnv {
    param([string]$Root)
    $envPath = Join-Path $Root ".env"
    if (-not (Test-Path -LiteralPath $envPath)) { return $null }

    foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) { continue }
        if ($trimmed -match '^(?:PORT|MYCALENDAR_PORT|NEOCALENDAR_PORT)\s*=\s*(.+)$') {
            $raw = $Matches[1].Trim().Trim('"', "'")
            $parsed = 0
            if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0 -and $parsed -lt 65536) {
                return $parsed
            }
        }
    }
    return $null
}

if (-not (Test-IsAdministrator)) {
    Write-Host "관리자 권한이 필요합니다. allow-firewall-inbound.bat 로 실행하거나," -ForegroundColor Yellow
    Write-Host "관리자 PowerShell에서 이 스크립트를 다시 실행하세요." -ForegroundColor Yellow
    exit 1
}

if ($Port -le 0) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $repoRoot = Split-Path -Parent $scriptDir
    $fromEnv = Get-PortFromDotEnv -Root $repoRoot
    if (-not $fromEnv) {
        $fromEnv = Get-PortFromDotEnv -Root $scriptDir
    }
    $Port = if ($fromEnv) { $fromEnv } else { 3010 }
}

$ruleName = "My Desktop Calendar HTTP ($Port)"

Write-Host "방화벽 인바운드: TCP $Port"
Write-Host "규칙 이름      : $ruleName"
Write-Host ""

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($Remove) {
    if (-not $existing) {
        Write-Host "삭제할 규칙이 없습니다: $ruleName" -ForegroundColor Yellow
        exit 0
    }
    Write-Host "삭제 중..."
    Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction Stop
    Write-Host "삭제 완료." -ForegroundColor Green
    exit 0
}

if ($existing) {
    Write-Host "기존 규칙이 있습니다. 포트/프로토콜을 갱신합니다..." -ForegroundColor Cyan
    Set-NetFirewallRule -DisplayName $ruleName -Enabled True -Action Allow -Profile Any -Direction Inbound -ErrorAction Stop
    Get-NetFirewallPortFilter -AssociatedNetFirewallRule $existing |
        Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port -ErrorAction Stop
} else {
    Write-Host "추가 중..."
    New-NetFirewallRule `
        -DisplayName $ruleName `
        -Name "MyDesktopCalendar-HTTP-$Port" `
        -Description "Allow inbound TCP for My Desktop Calendar web server (PORT=$Port)" `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $Port `
        -Profile Any `
        -Enabled True `
        -ErrorAction Stop | Out-Null
}

Write-Host ""
Write-Host "완료. LAN에서 http://<이-PC-IP>:$Port/ 로 접속할 수 있습니다." -ForegroundColor Green
Write-Host "확인: Get-NetFirewallRule -DisplayName '$ruleName'"
exit 0
