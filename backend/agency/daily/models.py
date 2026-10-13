"""Shapes for daily living's "tell my carer": settings and the two-step prepare/send."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ContactId = Field(pattern=r"^[a-z0-9_]{2,40}$")


class DailySettings(BaseModel):
    """Off until the person (or a helper, with them) turns it on."""

    model_config = ConfigDict(extra="forbid")

    notify_enabled: bool = False
    #: The Lifeline contact non-urgent requests go to. None: the first enabled contact.
    carer_id: str | None = Field(default=None, pattern=r"^[a-z0-9_]{2,40}$")
    #: When telling a carer was last turned on (set by the coordinator).
    enabled_at: str | None = None


class PrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: A help request ("I'm cold"), a care routine ("eye drops") or something on the day's schedule.
    kind: Literal["help", "routine", "day"]
    #: The person's words, as chosen on screen. The coordinator adds who it's from and "not urgent".
    text: str = Field(min_length=1, max_length=160)
    contact_id: str | None = Field(default=None, pattern=r"^[a-z0-9_]{2,40}$")


class SendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket: str = Field(min_length=16, max_length=80)
