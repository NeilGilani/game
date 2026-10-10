"""Memory tree request and response models.

JSON field names follow ``os/contracts/src/memory.ts`` (camelCase). Everything a surface sends
is validated, and anything that looks like a secret is refused before it can be stored.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

NodeKind = Literal["area", "routine", "task", "choice", "entity", "phrase"]
Surface = Literal["home", "food", "call", "talk", "keyboard", "papers", "shopping", "apps", "browse"]
Outcome = Literal["chosen", "rejected", "completed", "abandoned"]
GrantScope = Literal["everyday", "everything"]

SURFACES: tuple[str, ...] = ("home", "food", "call", "talk", "keyboard", "papers", "shopping", "apps", "browse")
POSITIVE_OUTCOMES = frozenset({"chosen", "completed"})

MAX_DEPTH = 8
MAX_LABEL = 120
MAX_ATTRIBUTES = 20

# Attribute names that would hold a secret. AGENCY never stores passwords, one-time codes or card numbers.
SECRET_KEY = re.compile(
    r"pass(word|code|phrase)?|pwd|otp|2fa|mfa|one[-_ ]?time|verification[-_ ]?code|cvv|cvc|card[-_ ]?(number|no)|"
    r"^pin$|ssn|social[-_ ]?security|secret|token|api[-_ ]?key",
    re.IGNORECASE,
)
DIGITS = re.compile(r"\d")


def _luhn(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def looks_like_card_number(text: str) -> bool:
    digits = "".join(DIGITS.findall(text))
    if not 13 <= len(digits) <= 19:
        return False
    # Only digits, spaces and dashes: a formatted number, not a sentence that happens to contain digits.
    if re.fullmatch(r"[\d\s-]+", text.strip()) is None:
        return False
    return _luhn(digits)


def clean_path(value: list[str]) -> list[str]:
    cleaned = [" ".join(part.split()) for part in value]
    if any(not part for part in cleaned):
        raise ValueError("Each step of the path needs a name.")
    if any(len(part) > MAX_LABEL for part in cleaned):
        raise ValueError(f"Names are limited to {MAX_LABEL} characters.")
    if any(looks_like_card_number(part) for part in cleaned):
        raise ValueError("That looks like a card number. AGENCY never stores card numbers.")
    return cleaned


def check_attributes(value: dict[str, str]) -> dict[str, str]:
    if len(value) > MAX_ATTRIBUTES:
        raise ValueError(f"At most {MAX_ATTRIBUTES} details per selection.")
    for key, item in value.items():
        if not key or len(key) > 40 or len(item) > 200:
            raise ValueError("Details need a short name (40 characters) and value (200 characters).")
    return value


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class SelectionEventIn(CamelModel):
    path: list[str] = Field(min_length=1, max_length=MAX_DEPTH)
    surface: Surface
    outcome: Outcome
    at: str | None = None
    attributes: dict[str, str] = Field(default_factory=dict)

    @field_validator("path")
    @classmethod
    def _clean_path(cls, value: list[str]) -> list[str]:
        return clean_path(value)

    @field_validator("attributes")
    @classmethod
    def _check_attributes(cls, value: dict[str, str]) -> dict[str, str]:
        return check_attributes(value)


class OnboardingAnswer(CamelModel):
    path: list[str] = Field(min_length=1, max_length=MAX_DEPTH)
    surface: Surface
    attributes: dict[str, str] = Field(default_factory=dict)
    # Optional context the person gave: "Friday" / "evening".
    weekday: int | None = Field(default=None, ge=0, le=6)
    daypart: Literal["morning", "midday", "afternoon", "evening", "night"] | None = None

    @field_validator("path")
    @classmethod
    def _clean_path(cls, value: list[str]) -> list[str]:
        return clean_path(value)

    @field_validator("attributes")
    @classmethod
    def _check_attributes(cls, value: dict[str, str]) -> dict[str, str]:
        return check_attributes(value)


class OnboardingRequest(CamelModel):
    answers: list[OnboardingAnswer] = Field(min_length=1, max_length=50)


class NodePatch(CamelModel):
    label: str | None = Field(default=None, min_length=1, max_length=MAX_LABEL)
    pinned: bool | None = None
    hidden: bool | None = None
    sensitive: bool | None = None


class ForgetAllRequest(CamelModel):
    # The interface asks first; the coordinator still refuses an accidental empty request.
    confirm: bool = False


class MemorySettings(CamelModel):
    half_life_days: float = Field(default=30.0, ge=1.0, le=365.0)
    private_mode: bool = False
    learning_paused: bool = False
    summaries_enabled: bool = False
    usual_window: int = Field(default=5, ge=3, le=10)
    usual_min: int = Field(default=3, ge=2, le=10)
    timezone: str | None = Field(default=None, max_length=64)


class ChoiceOptionIn(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    id: str = Field(min_length=1, max_length=120)
    label: str = Field(min_length=1, max_length=200)


class ChoiceQuestionIn(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    id: str = Field(min_length=1, max_length=120)
    prompt: str = Field(max_length=400)
    options: list[ChoiceOptionIn] = Field(min_length=2, max_length=12)


class PrefillRequest(CamelModel):
    # Where in the tree the task lives, e.g. ["food", "delivery"].
    path: list[str] = Field(min_length=1, max_length=MAX_DEPTH)
    question: ChoiceQuestionIn


class SummaryRequest(CamelModel):
    # sha256 of the exact facts shown in the preview; any change needs a new preview.
    facts_hash: str = Field(min_length=64, max_length=64)


class GrantRequest(CamelModel):
    caregiver: str = Field(min_length=1, max_length=60)
    scope: GrantScope = "everyday"
    days: int = Field(default=7, ge=1, le=90)
    # The person confirmed this exact grant in the interface.
    confirm: bool = False
