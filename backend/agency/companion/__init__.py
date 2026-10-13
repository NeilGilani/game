"""The caregiver's phone companion: pair a phone, set AGENCY up from it, stay close, leave hand-over notes.

The phone talks to its own small server (``server.py``) that listens on the home network only while a helper has
turned the companion on at the Mac. It never sees ``/api``: everything it can do is in this package, behind a
per-device token that the Mac can revoke at any time.
"""

from .api import build_router
from .service import CompanionError, CompanionService

__all__ = ["CompanionError", "CompanionService", "build_router"]
