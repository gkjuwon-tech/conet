# Run the ElectroMesh backend natively on Windows so it can actually send
# L2 packets to the physical LAN.
#
# Why this exists:
#   * Docker bridge networking absorbs raw packets — phones never see ARP/DNS.
#   * Docker Desktop's "network_mode: host" runs inside WSL2 and is isolated
#     from the Windows physical adapter; doesn't help us.
#   * Native Windows + admin + Npcap = scapy can sendp() straight out of
#     wlan0/Ethernet and CPD probes from iPhones land on our FakeDNS.
#
# Prereqs (one-time):
#   1. Python 3.12+ on PATH
#   2. Npcap installed (https://npcap.com/) with "WinPcap API-compatible mode"
#   3. postgres + redis running in docker:
#        docker compose up -d postgres redis
#
# Usage (every run):
#   1. Open PowerShell **as Administrator**
#   2. cd <repo>
#   3. powershell -ExecutionPolicy Bypass -File scripts\run-backend-native.ps1

$ErrorActionPreference = "Stop"

# ── 1. Admin check ───────────────────────────────────────────────────────
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object System.Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[FAIL] must be run from an elevated PowerShell." -ForegroundColor Red
    Write-Host "       port 53 (FakeDNS) + port 80 (captive portal) need admin."
    Write-Host ""
    Write-Host "       Open Start menu, type 'PowerShell', right-click → 'Run as administrator',"
    Write-Host "       then: cd '$PSScriptRoot\..'; .\scripts\run-backend-native.ps1"
    exit 1
}

# ── 1b. Firewall rules ───────────────────────────────────────────────────
# Windows Defender Firewall blocks LAN-side inbound on port 80 / 53 by
# default — that's why the LG TV's browser can't reach our captive portal
# even when docker publishes the ports. Add (idempotent) rules so the
# portal is reachable from the physical LAN.
foreach ($r in @(
    @{ Name = "ElectroMesh Portal (HTTP 80/8080)"; Port = "80,8080"; Proto = "TCP" },
    @{ Name = "ElectroMesh FakeDNS (UDP 53)";       Port = "53";      Proto = "UDP" }
)) {
    $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "[*] adding firewall rule: $($r.Name)" -ForegroundColor Cyan
        New-NetFirewallRule -DisplayName $r.Name -Direction Inbound `
            -Protocol $r.Proto -LocalPort ($r.Port -split ",") `
            -Action Allow -Profile Private,Domain | Out-Null
    }
}

# ── 2. Npcap check ───────────────────────────────────────────────────────
$npcap = Test-Path "$env:SystemRoot\System32\Npcap"
if (-not $npcap) {
    Write-Host "[WARN] Npcap not detected in $env:SystemRoot\System32\Npcap" -ForegroundColor Yellow
    Write-Host "       scapy raw-socket sends will fail. Install: https://npcap.com/"
}

# ── 3. Repo paths ────────────────────────────────────────────────────────
$repo    = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $repo "backend"
Set-Location $backend

# ── 4. Stop docker backend (keep postgres/redis) ─────────────────────────
Write-Host "[*] Stopping docker backend (keeping postgres/redis up)..." -ForegroundColor Cyan
docker compose -f "$repo\docker-compose.yml" stop backend 2>$null | Out-Null
docker compose -f "$repo\docker-compose.yml" up -d postgres redis | Out-Null

# ── 5. Free port 8080 if anything else is squatting ──────────────────────
$squat = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
if ($squat) {
    Write-Host "[WARN] something is already listening on :8080 (pid=$($squat.OwningProcess))" -ForegroundColor Yellow
}

# ── 6. Create + activate venv ────────────────────────────────────────────
if (-not (Test-Path ".\.venv\Scripts\Activate.ps1")) {
    Write-Host "[*] Creating .venv (one-time)..." -ForegroundColor Cyan
    python -m venv .venv
}
. .\.venv\Scripts\Activate.ps1

# ── 7. Install backend deps if missing ───────────────────────────────────
$haveUvicorn = $false
try { uvicorn --version *> $null; $haveUvicorn = $true } catch { $haveUvicorn = $false }
if (-not $haveUvicorn) {
    Write-Host "[*] Installing backend dependencies..." -ForegroundColor Cyan
    pip install --upgrade pip | Out-Null
    pip install -e . scapy | Out-Null
}

# ── 8. Env wiring (docker postgres/redis published to localhost) ─────────
$env:EM_DATABASE_URL = "postgresql+psycopg://em:em@127.0.0.1:5432/electromesh"
$env:EM_REDIS_URL    = "redis://127.0.0.1:6379/0"
$env:EM_API_HOST     = "0.0.0.0"
$env:EM_API_PORT     = "8080"
$env:EM_ENV          = "dev"
$env:EM_JWT_SECRET   = "dev-only-secret-change-me"
$env:EM_BUNDLING_SIZE = "1"
$env:EM_BUNDLING_MAX_AGE_SECONDS = "10"
$env:EM_WORKUNIT_REDUNDANCY = "1"
$env:EM_LAN_CLAIM_ACCOUNT_MIN_AGE_SECONDS = "5"
$env:EM_LAN_CLAIM_OTP_TTL_SECONDS = "300"
$env:EM_LAN_CLAIM_DEV_SHOW_OTP = "true"
$env:EM_CORS_ORIGINS = '["*"]'

# ── 9. Migrations + bootstrap ────────────────────────────────────────────
Write-Host "[*] alembic upgrade head" -ForegroundColor Cyan
alembic upgrade head
try { python -m scripts.bootstrap } catch { Write-Host "[*] bootstrap skipped" }

# ── 10. Launch ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[OK] Starting uvicorn under Administrator." -ForegroundColor Green
Write-Host "     8080 = API   53 = FakeDNS   80 = captive portal"
Write-Host "     Ctrl-C to stop. Phones can now actually receive our ARP/DNS."
Write-Host ""
uvicorn app.main:app --host 0.0.0.0 --port 8080
