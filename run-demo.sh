#!/bin/sh
set -eu
SYNAPSE_PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SYNAPSE_PROJECT_DIR/.venv/bin/python" "$SYNAPSE_PROJECT_DIR/scripts/demo.py" "$@"
