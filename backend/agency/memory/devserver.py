"""The coordinator with the memory router mounted, for development and end-to-end tests until
``main.py`` mounts it (see os/memory/INTEGRATION_REQUEST.md):

    cd backend && .venv/bin/uvicorn agency.memory.devserver:app --port 8000
"""

from __future__ import annotations

from ..main import create_app

# main.py mounts the memory router now; kept so existing commands keep working.
app = create_app()
