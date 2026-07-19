#Requires -Version 5.1
<#
.SYNOPSIS
  HTTP URL ACL 등록 (HttpListener http://+:{PORT}/)

.DESCRIPTION
  My Desktop Calendar 웹 서버(LAN/local wildcard bind)에 필요한
  netsh http urlacl 을 추가합니다. 관리자 권한 필요.

  포트: 인자 > 스크립트 옆/프로젝트 루트 .env 의 PORT > 3010
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$User = "Everyone",
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
    Write-Host "관리자 권한이 필요합니다. add-urlacl.bat 로 실행하거나," -ForegroundColor Yellow
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

$url = "http://+:$Port/"

Write-Host "URL ACL: $url"
Write-Host "User   : $User"
Write-Host ""

# Show existing reservation for this URL (if any)
$existing = & netsh http show urlacl url=$url 2>&1 | Out-String
if ($existing -match [regex]::Escape($url)) {
    Write-Host "기존 예약이 있습니다:" -ForegroundColor Cyan
    Write-Host $existing
}

if ($Remove) {
    Write-Host "삭제 중: netsh http delete urlacl url=$url"
    & netsh http delete urlacl url=$url
    if ($LASTEXITCODE -ne 0) {
        Write-Host "삭제 실패 (exit $LASTEXITCODE). 예약이 없을 수 있습니다." -ForegroundColor Yellow
        exit $LASTEXITCODE
    }
    Write-Host "삭제 완료." -ForegroundColor Green
    exit 0
}

Write-Host "추가 중: netsh http add urlacl url=$url user=$User"
& netsh http add urlacl url=$url user=$User
if ($LASTEXITCODE -ne 0) {
    # Already reserved for same user is often exit non-zero — show and continue guidance
    Write-Host "추가 실패 (exit $LASTEXITCODE)." -ForegroundColor Red
    Write-Host "이미 등록되어 있거나 다른 사용자로 예약된 경우일 수 있습니다." -ForegroundColor Yellow
    Write-Host "확인: netsh http show urlacl url=$url"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "완료. 앱을 재시작한 뒤 Start Server (local/Web) 를 사용하세요." -ForegroundColor Green
Write-Host "확인: http://127.0.0.1:$Port/"
exit 0
