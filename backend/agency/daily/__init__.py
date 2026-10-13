"""Daily living: the person's day (schedule and care routines) and non-urgent requests to a carer.

Separate from Lifeline's emergency path on purpose: a request here never escalates, never repeats, never
calls anyone and never asks for emergency services. It reaches one chosen carer through Lifeline's existing
channels (a simulated phone, or a real text when the coordinator has Twilio), only after the person or a
helper turned that on.
"""

from .api import build_routers

__all__ = ["build_routers"]
