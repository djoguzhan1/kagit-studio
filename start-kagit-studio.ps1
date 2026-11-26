# KÂĞIT Studio — 1-Tık Tam Üretim Başlatıcı (RTX GPU AI Sunucusu + Stüdyo Arayüzü)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $Root "server\kagit_ai_pipeline"
$VenvPython = Join-Path $BackendDir ".venv\Scripts\python.exe"

Write-Host "==========================================================" -ForegroundColor Yellow
Write-Host "  KÂĞIT 2.5D Film & Animasyon Stüdyosu Başlatılıyor..." -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Yellow

if (-not (Test-Path $VenvPython)) {
    Write-Host "[1/3] Python AI sanal ortamı oluşturuluyor..." -ForegroundColor Cyan
    Push-Location $BackendDir
    python -m venv .venv --system-site-packages
    .\.venv\Scripts\pip.exe install fastapi "uvicorn[standard]" python-multipart edge-tts
    Pop-Location
}

if (-not (Test-Path (Join-Path $Root "dist\index.html"))) {
    Write-Host "[2/3] Frontend üretim paketi derleniyor (npm run build)..." -ForegroundColor Cyan
    Push-Location $Root
    npm run build
    Pop-Location
}

Write-Host "[3/3] Gerçek GPU/FFmpeg/Gemini AI Sunucusu + KÂĞIT Stüdyo açılıyor..." -ForegroundColor Green
Write-Host "  -> Stüdyo & API: http://localhost:8090" -ForegroundColor White
Write-Host "  -> Sağlık Kontrolü: http://localhost:8090/health" -ForegroundColor Gray
Write-Host "  Durdurmak için CTRL+C tuşuna basın." -ForegroundColor DarkGray

Start-Job -ScriptBlock {
    Start-Sleep -Seconds 2
    Start-Process "http://localhost:8090"
} | Out-Null

Push-Location $BackendDir
& $VenvPython -m uvicorn app:app --host 127.0.0.1 --port 8090
Pop-Location
