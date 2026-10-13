"""What a paired phone may send. Everything is validated before it is stored or applied."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..lifeline.models import Contact

# A pairing code is six digits: easy to read off the Mac and type on a phone if the camera can't scan the QR code.
PAIR_CODE = re.compile(r"^\d{6}$")
# Photos arrive as small data URLs (the phone shrinks them first). Kept well under the request limit.
PHOTO = re.compile(r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$")
MAX_PHOTO_CHARS = 1_400_000  # about 1 MB of picture
URL = re.compile(r"^https?://[^\s/$.?#][^\s]*$", re.IGNORECASE)

ChangeKind = Literal["contacts", "details", "phrases", "favourites", "papers_folder", "safety"]


def _clean(text: str) -> str:
    """One line of plain text: control characters out, spaces squeezed."""
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", text)).strip()


class PairRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=6, max_length=6)
    name: str = Field(min_length=1, max_length=40, description="Who carries this phone, e.g. Jordan")
    contact_id: str | None = Field(default=None, pattern=r"^[a-z0-9_]{2,40}$")

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = _clean(v)
        if not v:
            raise ValueError("Type your name.")
        return v


class LinkRequest(BaseModel):
    """Which Lifeline contact this phone belongs to (so it can open that person's alert links)."""

    model_config = ConfigDict(extra="forbid")

    contact_id: str | None = Field(default=None, pattern=r"^[a-z0-9_]{2,40}$")


class ContactsChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contacts: list[Contact] = Field(max_length=8)


class Details(BaseModel):
    """The person's details for forms (Papers). Mirrors os/tasks/src/profile.ts; the Mac keeps them."""

    model_config = ConfigDict(extra="forbid")

    fullName: str = Field(default="", max_length=200)  # noqa: N815 - the Mac's own field names
    preferredName: str = Field(default="", max_length=200)  # noqa: N815
    dateOfBirth: str = Field(default="", max_length=200)  # noqa: N815
    phone: str = Field(default="", max_length=200)
    email: str = Field(default="", max_length=200)
    line1: str = Field(default="", max_length=200)
    line2: str = Field(default="", max_length=200)
    city: str = Field(default="", max_length=200)
    region: str = Field(default="", max_length=200)
    postalCode: str = Field(default="", max_length=200)  # noqa: N815


class DetailsChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    details: Details


class PhrasesChange(BaseModel):
    """The carers' phrase list for Talk: replaces the whole list each time."""

    model_config = ConfigDict(extra="forbid")

    phrases: list[str] = Field(max_length=60)

    @field_validator("phrases")
    @classmethod
    def _phrases(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for p in v:
            p = _clean(p)[:120]
            if p and p not in out:
                out.append(p)
        return out


class Favourite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=60)
    url: str = Field(min_length=4, max_length=500)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        v = v.strip()
        if re.match(r"^[a-z][a-z0-9+.-]*:(?!\d)", v, re.IGNORECASE) and not re.match(r"^https?://", v, re.IGNORECASE):
            raise ValueError("Only web addresses (http or https) can be favourites.")
        if not re.match(r"^[a-z]+://", v, re.IGNORECASE):
            v = "https://" + v
        if not URL.match(v):
            raise ValueError("That doesn't look like a web address, for example bbc.co.uk.")
        return v

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        v = _clean(v)
        if not v:
            raise ValueError("Give the site a name.")
        return v


class FavouritesChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    favourites: list[Favourite] = Field(max_length=24)


class PapersFolderChange(BaseModel):
    """Only the two folders that need no file dialog. Picking any other folder is done at the Mac."""

    model_config = ConfigDict(extra="forbid")

    folder: Literal["papers", "downloads"]


class SafetyChange(BaseModel):
    """The Lifeline safety settings a carer may set from a phone. Consent and contacts' permission stay at the Mac."""

    model_config = ConfigDict(extra="forbid")

    watch: bool = Field(description="Watch over me: alert if the screen goes silent")
    checkin_interval_min: int = Field(ge=0, le=480)
    alert_on_signal_unavailable: bool
    ack_timeout_s: int = Field(ge=10, le=300)
    watchdog_timeout_s: int = Field(ge=15, le=600)


class NoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=2000)

    @field_validator("text")
    @classmethod
    def _text(cls, v: str) -> str:
        v = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", v).strip()
        if not v:
            raise ValueError("Write something first.")
        return v


class MacNoteRequest(NoteRequest):
    author: str = Field(default="", max_length=40)


class MessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(default="", max_length=280)
    photo: str | None = Field(default=None, max_length=MAX_PHOTO_CHARS)

    @field_validator("text")
    @classmethod
    def _text(cls, v: str) -> str:
        return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", v).strip()

    @field_validator("photo")
    @classmethod
    def _photo(cls, v: str | None) -> str | None:
        if v is None or v == "":
            return None
        if not PHOTO.match(v):
            raise ValueError("Send a JPEG, PNG or WebP photo.")
        return v


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allow: bool


class Applied(BaseModel):
    """The Mac reports what happened when it applied a change that lives on the Mac."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    reason: str = Field(default="", max_length=200)


class Presence(BaseModel):
    """What the person's screen says about itself, for the phone's "AGENCY is running" line."""

    model_config = ConfigDict(extra="forbid")

    battery_level: float | None = Field(default=None, ge=0, le=1)
    charging: bool | None = None


class EnableRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
