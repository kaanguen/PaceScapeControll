# Starts the PaceScape Control server and the Femto Bolt body tracking viewer (--dashboard --avatar).
# Compatible with Windows PowerShell 5.1. Usage: start-bodytracking.cmd [-BodyTrackingExe <path>] [-NoDashboardStream]

[CmdletBinding()]
param(
    # Path to PaceScapeBodyTrackingTest.exe. Defaults to $env:PACESCAPE_BODYTRACKING_EXE or the sibling build folder.
    [string]$BodyTrackingExe = $env:PACESCAPE_BODYTRACKING_EXE,
    # Sends only avatar poses, without the RGB live image for the dashboard.
    [switch]$NoDashboardStream,
    # Starts only the server, for example without a camera attached.
    [switch]$ServerOnly
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$port = 8787
if ($env:PORT) { $port = [int]$env:PORT }
$baseUrl = "http://127.0.0.1:$port"

function Stop-WithMessage([string]$message) {
    Write-Host ''
    Write-Host $message -ForegroundColor Red
    exit 1
}

function Test-Server {
    try {
        $response = Invoke-WebRequest -Uri "$baseUrl/" -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Stop-WithMessage 'Node.js 22 oder neuer fehlt. Installieren von https://nodejs.org und das Fenster neu öffnen.'
}
$nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) {
    Stop-WithMessage "Node.js $nodeMajor ist zu alt. Benötigt wird Version 22 oder neuer."
}

# 2. Dependencies (first start after cloning)
if (-not (Test-Path -LiteralPath (Join-Path $repo 'node_modules\ws'))) {
    Write-Host 'Installiere Abhängigkeiten (npm ci) ...'
    Push-Location $repo
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'npm ci ist fehlgeschlagen.' }
    }
    finally {
        Pop-Location
    }
}

# 3. Body tracking EXE (checked before starting anything)
$exe = $null
if (-not $ServerOnly) {
    # An explicitly configured path must be valid; never fall back silently to a different build.
    if ($BodyTrackingExe) {
        $candidates = @($BodyTrackingExe)
    }
    else {
        $candidates = @(Join-Path (Split-Path -Parent $repo) 'PaceScapeBodyTrackingTest\build\bin\Release\PaceScapeBodyTrackingTest.exe')
    }
    foreach ($candidate in $candidates) {
        if ((Test-Path -LiteralPath $candidate) -and (Get-Item -LiteralPath $candidate).Length -gt 0) {
            $exe = (Resolve-Path -LiteralPath $candidate).Path
            break
        }
    }
    if (-not $exe) {
        Stop-WithMessage ("PaceScapeBodyTrackingTest.exe nicht gefunden (oder leer). Gesucht:`n  " + ($candidates -join "`n  ") +
            "`nDas Projekt neben diesen Ordner legen und mit build.ps1 bauen, oder den Pfad angeben:" +
            "`n  start-bodytracking.cmd -BodyTrackingExe 'C:\Pfad\PaceScapeBodyTrackingTest.exe'" +
            "`nNur den Server starten: start-bodytracking.cmd -ServerOnly")
    }
}

# 4. Server (reused if already running)
if (Test-Server) {
    Write-Host "Server läuft bereits auf Port $port und wird weiterverwendet."
    Write-Host 'Hinweis: Nach Server-Updates diesen Server beenden und das Skript neu starten.' -ForegroundColor Yellow
}
else {
    Write-Host "Starte PaceScape Control auf Port $port ..."
    Start-Process -FilePath 'cmd.exe' -WorkingDirectory $repo -ArgumentList '/k', 'title PaceScape Control Server && npm start'
    $deadline = (Get-Date).AddSeconds(20)
    while (-not (Test-Server)) {
        if ((Get-Date) -gt $deadline) {
            Stop-WithMessage "Server antwortet nicht auf $baseUrl. Fehlermeldung im Server-Fenster prüfen (Port belegt?)."
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Host 'Server bereit.'
}

# 5. Body tracking in its own window, started from its folder so the Orbbec runtime DLLs are found
if ($exe) {
    $exeArguments = '--avatar'
    if (-not $NoDashboardStream) { $exeArguments = '--dashboard --avatar' }
    Write-Host "Starte Body Tracking ($exeArguments) ..."
    Start-Process -FilePath 'cmd.exe' -WorkingDirectory (Split-Path -Parent $exe) `
        -ArgumentList '/k', "title PaceScape Body Tracking && `"$exe`" $exeArguments"
}

Start-Process "http://localhost:$port"
Write-Host ''
Write-Host "Dashboard: http://localhost:$port" -ForegroundColor Green
Write-Host 'Beenden: Server- und Body-Tracking-Fenster schließen (bzw. Strg+C).'
Write-Host 'Unity-Vorschau: PaceScape > Body-Tracking-Vorschau > Empfang starten.'
Write-Host 'Meldet die Kamera "libusb device(s) are all unavailable": Kamera ab- und wieder anstecken, Skript erneut starten.'
