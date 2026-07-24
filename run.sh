#!/bin/bash
# ─── DocMasker — Start Script ───────────────────────────────────────────────
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/venv"
PYTHON="$VENV/bin/python3"
UVICORN="$VENV/bin/uvicorn"

# Check tesseract
if ! command -v tesseract &>/dev/null; then
  echo "⚠  tesseract not found. Installing via pacman..."
  echo "   Run: sudo pacman -S tesseract tesseract-data-eng"
  echo "   Then re-run this script."
  exit 1
fi

echo ""
echo "  ██████╗  ██████╗  ██████╗"
echo "  ██╔══██╗██╔═══██╗██╔════╝"
echo "  ██║  ██║██║   ██║██║"
echo "  ██║  ██║██║   ██║██║"
echo "  ██████╔╝╚██████╔╝╚██████╗"
echo "  ╚═════╝  ╚═════╝  ╚═════╝"
echo ""
echo "  DocMasker — PII Redaction Engine"
echo "  ────────────────────────────────"
echo "  → http://localhost:8000"
echo ""

cd "$DIR"
"$UVICORN" backend.main:app --host 0.0.0.0 --port 8000 --reload
