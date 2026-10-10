#!/usr/bin/env bash
# AGENCY coordinator setup for a Raspberry Pi 4 (Raspberry Pi OS Bookworm, 64-bit).
#
# Run on the Pi, from the repository root:
#   bash deploy/pi/setup.sh
#
# What it does:
#   1. installs python3-venv if needed (apt, asks for sudo)
#   2. creates backend/.venv and installs backend/requirements.txt
#   3. writes /etc/agency/agency.env with a fresh access token (only if it doesn't exist)
#   4. installs and starts the agency-coordinator systemd service on port 8000
#
# Safe to run again: it keeps an existing env file (and token) and database.
set -euo pipefail

# Running as root (e.g. in a container): no sudo needed.
if [ "$(id -u)" = "0" ]; then
  sudo() { "$@"; }
fi
# AGENCY_SKIP_SYSTEMD=1 installs everything but starts the coordinator directly instead of
# through systemd (used to test this script in an arm64 Debian container without systemd).
SKIP_SYSTEMD="${AGENCY_SKIP_SYSTEMD:-0}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_USER="${SUDO_USER:-${USER:-$(id -un)}}"
ENV_DIR=/etc/agency
ENV_FILE="$ENV_DIR/agency.env"
DATA_DIR="$REPO/backend/data"

echo "AGENCY coordinator setup"
echo "  repository: $REPO"
echo "  user:       $SERVICE_USER"

if ! python3 -c "import sys; assert sys.version_info >= (3, 11)" 2>/dev/null; then
  echo "Python 3.11 or newer is required (Raspberry Pi OS Bookworm ships 3.11)." >&2
  exit 1
fi

if ! python3 -m venv --help >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y python3-venv
fi

python3 -m venv "$REPO/backend/.venv"
"$REPO/backend/.venv/bin/pip" install --timeout 60 --retries 10 --upgrade pip || true
"$REPO/backend/.venv/bin/pip" install --timeout 60 --retries 10 -c "$REPO/backend/constraints.txt" -r "$REPO/backend/requirements.txt"
mkdir -p "$DATA_DIR"

if [ ! -f "$ENV_FILE" ]; then
  sudo mkdir -p "$ENV_DIR"
  TOKEN="$("$REPO/backend/.venv/bin/python" -c 'import secrets; print(secrets.token_urlsafe(24))')"
  sudo tee "$ENV_FILE" >/dev/null <<ENV
# AGENCY coordinator settings (Raspberry Pi). Keep this file private: it holds the token.
AGENCY_HOST=0.0.0.0
AGENCY_PORT=8000
AGENCY_NODE_ROLE=raspberry-pi
AGENCY_DB_PATH=$DATA_DIR/agency.db
AGENCY_API_TOKEN=$TOKEN
# The MacBook's browser origin, only needed if the Mac talks to the Pi directly (not via the Vite proxy).
AGENCY_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173
# Presenter controls for the hackathon demo (fault injection, reset). Set to 0 for everyday use.
AGENCY_DEMO_CONTROLS=1
AGENCY_REASONING=auto
# GEMINI_API_KEY=   # optional: enables cloud reasoning (Google Gemini); AGENCY works fully without it
ENV
  sudo chmod 600 "$ENV_FILE"
  sudo chown "$SERVICE_USER" "$ENV_FILE"
  echo "Created $ENV_FILE with a new access token."
else
  echo "Keeping existing $ENV_FILE."
fi

if [ "$SKIP_SYSTEMD" = "1" ]; then
  echo "Skipping systemd; starting the coordinator directly for a smoke test."
  (set -a; . "$ENV_FILE"; set +a; cd "$REPO/backend" && nohup .venv/bin/python -m agency >/tmp/agency-coordinator.log 2>&1 &)
else
  sed -e "s#@REPO@#$REPO#g" -e "s#@USER@#$SERVICE_USER#g" "$REPO/deploy/pi/agency-coordinator.service" \
    | sudo tee /etc/systemd/system/agency-coordinator.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now agency-coordinator.service
fi

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if curl -fsS http://127.0.0.1:8000/api/health; then
  echo
  echo "Coordinator is running."
  echo "Access token (enter it in AGENCY Settings on the MacBook):"
  sudo grep '^AGENCY_API_TOKEN=' "$ENV_FILE" | cut -d= -f2-
  echo "Pi address(es): $(hostname -I 2>/dev/null || true) / $(hostname).local"
else
  echo "The service did not answer. Check: sudo journalctl -u agency-coordinator -n 50" >&2
  [ "$SKIP_SYSTEMD" = "1" ] && cat /tmp/agency-coordinator.log >&2
  exit 1
fi
