#!/usr/bin/env bash
# Builds the coordinator as a self-contained folder for AGENCY.app: os/sidecar/dist/agency-coordinator/.
# PyInstaller --onedir (not --onefile: no unpacking on every launch, and every binary can be code-signed).
# Measures size and cold-start time and writes them to os/sidecar/dist/measurements.json.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
PYTHON="${PYTHON:-python3}"
VENV=.venv

if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -c "$ROOT/backend/constraints.txt" -r "$ROOT/backend/requirements.txt"
"$VENV/bin/python" -m pip install --quiet -r requirements-build.txt

rm -rf build dist
"$VENV/bin/pyinstaller" --noconfirm --clean --log-level WARN \
  --onedir --name agency-coordinator \
  --paths "$ROOT/backend" \
  --collect-submodules agency \
  --collect-submodules uvicorn \
  --hidden-import anthropic \
  --exclude-module tkinter --exclude-module pytest --exclude-module mypy \
  ${TARGET_ARCH:+--target-arch "$TARGET_ARCH"} \
  ${CODESIGN_IDENTITY:+--codesign-identity "$CODESIGN_IDENTITY"} \
  entry.py

BIN=dist/agency-coordinator/agency-coordinator
"$BIN" --selftest
"$VENV/bin/python" measure.py "$BIN" > dist/measurements.json
cat dist/measurements.json
