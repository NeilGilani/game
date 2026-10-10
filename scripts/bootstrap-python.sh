#!/usr/bin/env bash
# Create backend/.venv with Python 3.11+ (macOS's built-in python3 is often 3.9, too old).
# Tries python3.13 / 3.12 / 3.11 / python3, then falls back to uv, which can download Python.
set -euo pipefail
cd "$(dirname "$0")/.."
VENV=backend/.venv

if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "Using existing $VENV ($("$VENV/bin/python" --version))"
  exit 0
fi
rm -rf "$VENV"

for candidate in python3.13 python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
    echo "Creating $VENV with $candidate ($("$candidate" --version))"
    "$candidate" -m venv "$VENV"
    exit 0
  fi
done

if command -v uv >/dev/null 2>&1; then
  echo "No Python 3.11+ found; creating $VENV with uv (downloads Python 3.12 if needed)"
  uv venv --python 3.12 --seed "$VENV"
  exit 0
fi

cat >&2 <<'MSG'
AGENCY needs Python 3.11 or newer for the coordinator.
Install one of these, then run `make setup` again:
  brew install python@3.12
  or: curl -LsSf https://astral.sh/uv/install.sh | sh
MSG
exit 1
