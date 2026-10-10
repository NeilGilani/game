"""The coordinator with the memory router mounted, for development and end-to-end tests until
``main.py`` mounts it (see os/memory/INTEGRATION_REQUEST.md):

    cd backend && .venv/bin/uvicorn agency.memory.devserver:app --port 8000
"""

from __future__ import annotations

from ..main import create_app
from .api import memory_router

app = create_app()
app.include_router(memory_router())
