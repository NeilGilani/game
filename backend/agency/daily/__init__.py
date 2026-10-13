"""Daily living: non-urgent requests from the person to one chosen carer ("I'm cold", "eye drops, please").

Separate from Lifeline's emergency path: see service.py.
"""

from .api import daily_router

__all__ = ["daily_router"]
