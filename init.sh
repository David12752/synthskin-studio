#!/usr/bin/env bash
# SynthSkin Studio - Project Setup Script
# Run this once after cloning to set up all dependencies.

set -euo pipefail
cd "$(dirname "$0")"

echo "═══════════════════════════════════════════"
echo "  SynthSkin Studio — Environment Setup"
echo "═══════════════════════════════════════════"

# ── Node.js dependencies ──
echo ""
echo "[1/3] Installing npm dependencies..."
npm install

# ── Python virtual environment ──
echo ""
echo "[2/3] Setting up Python virtual environment..."
cd python

if [ ! -d ".venv" ]; then
    python3 -m venv .venv
    echo "  Created .venv"
else
    echo "  .venv already exists, skipping creation"
fi

# Activate and install
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    source .venv/Scripts/activate
else
    source .venv/bin/activate
fi

pip install --upgrade pip -q
pip install -r requirements.txt -q
echo "  Python dependencies installed"

cd ..

# ── SAM2 Model ──
echo ""
echo "[3/3] SAM2 model checkpoint"
echo "  ⚠  SAM2 weights are large (~2.4 GB) and not downloaded automatically."
echo "  When you need SAM2 (Phase 2), run:"
echo "    python -c \"from segment_anything_2 import sam_model_registry; ...\""
echo "  Or download manually to python/models/"

echo ""
echo "═══════════════════════════════════════════"
echo "  Setup complete! Run:  npm run dev"
echo "═══════════════════════════════════════════"
