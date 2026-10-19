# SynthSkin Studio - Project Setup Script (Windows PowerShell)
# Run this once after cloning to set up all dependencies.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  SynthSkin Studio - Environment Setup" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan

# -- Node.js dependencies --
Write-Host ""
Write-Host "[1/3] Installing npm dependencies..." -ForegroundColor Yellow
npm install

# -- Python virtual environment --
Write-Host ""
Write-Host "[2/3] Setting up Python virtual environment..." -ForegroundColor Yellow
Push-Location python

if (-not (Test-Path ".venv")) {
    python -m venv .venv
    Write-Host "  Created .venv" -ForegroundColor Green
} else {
    Write-Host "  .venv already exists, skipping creation" -ForegroundColor Gray
}

& .\.venv\Scripts\python.exe -m pip install --upgrade pip -q
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt -q
Write-Host "  Python dependencies installed" -ForegroundColor Green

Pop-Location

# -- SAM2 Model --
Write-Host ""
Write-Host "[3/3] SAM2 model checkpoint" -ForegroundColor Yellow
Write-Host "  SAM2 weights are large (~2.4 GB) and not downloaded automatically." -ForegroundColor Gray
Write-Host "  Download manually to python\models\ when you need SAM2 (Phase 2)." -ForegroundColor Gray

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Setup complete! Run:  npm run dev" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
