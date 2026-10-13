"""The day's schedule, care routines and requests to a carer. Everything is validated before it is stored.

Times are the person's local wall-clock times ("14:30"); days are local dates ("2026-10-12"). The coordinator
stores them as given and never converts them: the screen that shows them knows the person's time zone.

Nothing here is clinical. Routines are gentle prompts with times the person or their care team chose; AGENCY
doesn't know about doses, doesn't watch anyone's health and never raises an alarm from them.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
DAY = r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$"
ID = r"^[a-z0-9_-]{2,40}$"
CONTROL = re.compile(r"[\u0000-\u001f\u007f]")

ItemKind = Literal["appointment", "visit", "care", "reminder"]
SetBy = Literal["person", "carer"]
RoutineKind = Literal["reposition", "eye_drops", "mouth_care", "water", "other"]
RequestKind = Literal["help", "routine", "schedule"]
MarkStatus = Literal["done", "later", "clear"]
Reply = Literal["coming", "soon", "cant"]

MAX_ITEMS = 60
MAX_ROUTINES = 12


def clean(text: str) -> str:
    """One line of plain text: no control characters, single spaces."""
    return " ".join(CONTROL.sub(" ", text).split())


class ScheduleItem(BaseModel):
    """Something in the day: an appointment, a visit, a care routine at a set time, or a reminder."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=ID)
    kind: ItemKind = "reminder"
    title: str = Field(min_length=1, max_length=80)
    time: str = Field(pattern=HHMM)
    # A single day, or None for a repeating item.
    date: str | None = Field(default=None, pattern=DAY)
    # Repeating items: 0 = Monday ... 6 = Sunday. Empty with no date: every day.
    days: list[int] = Field(default_factory=list, max_length=7)
    note: str = Field(default="", max_length=200)
    set_by: SetBy = "carer"

    @field_validator("title", "note")
    @classmethod
    def _plain(cls, v: str) -> str:
        return clean(v)

    @field_validator("days")
    @classmethod
    def _days(cls, v: list[int]) -> list[int]:
        if any(d < 0 or d > 6 for d in v):
            raise ValueError("days are 0 (Monday) to 6 (Sunday)")
        return sorted(set(v))

    @model_validator(mode="after")
    def _one_kind_of_when(self) -> ScheduleItem:
        if not self.title:
            raise ValueError("a title is needed")
        if self.date and self.days:
            raise ValueError(f"{self.title}: either a date or repeat days, not both")
        return self


class Routine(BaseModel):
    """A gentle, repeating care prompt the person can do, put off or pass to a carer. Never a clinical alarm."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=ID)
    kind: RoutineKind = "other"
    title: str = Field(min_length=1, max_length=60)
    # How often to ask, in minutes (15 minutes to 12 hours).
    every_min: int = Field(default=120, ge=15, le=720)
    # Only ask between these times (the person's waking hours).
    start: str = Field(default="08:00", pattern=HHMM)
    end: str = Field(default="21:00", pattern=HHMM)
    enabled: bool = True

    @field_validator("title")
    @classmethod
    def _plain(cls, v: str) -> str:
        v = clean(v)
        if not v:
            raise ValueError("a title is needed")
        return v

    @model_validator(mode="after")
    def _window(self) -> Routine:
        if self.start == self.end:
            raise ValueError(f"{self.title}: the start and end times must differ")
        return self


class DailySettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Off until the person or a helper turns it on: requests then only show on screen and can be said aloud.
    carer_notify: bool = False
    # A Lifeline contact id: the one person requests go to.
    carer_id: str | None = Field(default=None, pattern=ID)
    # Say routine prompts out loud when they appear (off: they only show on screen).
    speak_prompts: bool = False


class ItemsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ScheduleItem] = Field(max_length=MAX_ITEMS)

    @field_validator("items")
    @classmethod
    def _unique(cls, items: list[ScheduleItem]) -> list[ScheduleItem]:
        ids = [i.id for i in items]
        if len(ids) != len(set(ids)):
            raise ValueError("item ids must be unique")
        return items


class RoutinesBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    routines: list[Routine] = Field(max_length=MAX_ROUTINES)

    @field_validator("routines")
    @classmethod
    def _unique(cls, routines: list[Routine]) -> list[Routine]:
        ids = [r.id for r in routines]
        if len(ids) != len(set(ids)):
            raise ValueError("routine ids must be unique")
        return routines


class MarkBody(BaseModel):
    """Done, later, or undo, for one item on one day."""

    model_config = ConfigDict(extra="forbid")

    item_id: str = Field(pattern=ID)
    day: str = Field(pattern=DAY)
    status: MarkStatus
    # For "later": when to show it again (local "HH:MM").
    until: str | None = Field(default=None, pattern=HHMM)


class RoutineLaterBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    minutes: int = Field(default=30, ge=5, le=240)


class RequestBody(BaseModel):
    """A non-urgent request to the chosen carer, in the person's own words."""

    model_config = ConfigDict(extra="forbid")

    kind: RequestKind = "help"
    text: str = Field(min_length=1, max_length=160)

    @field_validator("text")
    @classmethod
    def _plain(cls, v: str) -> str:
        v = clean(v)
        if not v:
            raise ValueError("say what you need")
        return v
