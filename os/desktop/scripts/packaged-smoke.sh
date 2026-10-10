#!/usr/bin/env bash
# Launches a packaged AGENCY.app headlessly-ish (test mode, throwaway data) and waits until its bundled
# coordinator reports ready in the log. Fails if it doesn't within 60 s.
set -euo pipefail
APP="$1"
DATA="$(mktemp -d)"
LOG="$DATA/run.log"
AGENCY_TEST=1 AGENCY_SKIP_ONBOARDING=1 AGENCY_USER_DATA="$DATA/ud" "$APP/Contents/MacOS/AGENCY" >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  if grep -q "coordinator ready" "$LOG"; then
    grep -E "INFO|WARN|ERROR" "$LOG" | head -20
    codesign --verify --deep --strict "$APP" && echo "codesign --verify: ok"
    exit 0
  fi
  sleep 0.5
done
echo "Packaged app did not start its coordinator in 60 s:" >&2
cat "$LOG" >&2
exit 1
