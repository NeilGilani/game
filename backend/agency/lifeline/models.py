"""Lifeline settings and request models. Everything here is validated before it is stored."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

E164 = re.compile(r"^\+[1-9]\d{6,14}$")

ContactRole = Literal["caregiver", "family", "neighbour", "clinician", "monitoring_service", "other"]
Channel = Literal["demo", "sms", "sms_call"]
AlertKind = Literal["help", "watchdog", "checkin_missed", "signal_unavailable"]
HelpSource = Literal["eye_signal", "help_button", "switch", "test"]

ROLE_LABELS: dict[str, str] = {
    "caregiver": "caregiver",
    "family": "family",
    "neighbour": "neighbour",
    "clinician": "clinician",
    "monitoring_service": "monitoring service",
    "other": "contact",
}


class Contact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9_]{2,40}$")
    name: str = Field(min_length=1, max_length=60)
    role: ContactRole = "caregiver"
    channel: Channel = "demo"
    address: str = Field(default="", max_length=40, description="Phone number (E.164) for sms channels")
    priority: int = Field(default=1, ge=1, le=9, description="1 is contacted first; equal priorities together")
    enabled: bool = True

    @model_validator(mode="after")
    def _phone_for_real_channels(self) -> Contact:
        if self.channel in {"sms", "sms_call"} and not E164.match(self.address.replace(" ", "")):
            raise ValueError(f"{self.name}: a real text or call needs a phone number like +14155550123")
        return self

    @property
    def label(self) -> str:
        return f"{self.name} ({ROLE_LABELS[self.role]})"


class ResponderCard(BaseModel):
    """What a helper or paramedic needs to know about someone who can't speak."""

    model_config = ConfigDict(extra="forbid")

    person_name: str = Field(default="", max_length=60)
    address: str = Field(default="", max_length=200)
    communication: str = Field(default="", max_length=300)
    breathing: str = Field(default="", max_length=300)
    medical: str = Field(default="", max_length=300)
    allergies: str = Field(default="", max_length=200)
    medications: str = Field(default="", max_length=300)
    advance_directive: str = Field(default="", max_length=300)
    notes: str = Field(default="", max_length=300)


class LifelineSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consent: bool = False
    consent_note: str = Field(default="", max_length=200)
    consented_at: str | None = None
    contacts: list[Contact] = Field(default_factory=list, max_length=8)
    cancel_window_s: int = Field(default=8, ge=0, le=30)
    ack_timeout_s: int = Field(default=45, ge=10, le=300)
    watchdog_timeout_s: int = Field(default=30, ge=15, le=600)
    checkin_interval_min: int = Field(default=0, ge=0, le=480)
    checkin_response_s: int = Field(default=90, ge=30, le=600)
    alert_on_signal_unavailable: bool = False
    signal_grace_s: int = Field(default=180, ge=60, le=1800)
    responder: ResponderCard = Field(default_factory=ResponderCard)
    emergency_number: str = Field(default="911", pattern=r"^[0-9]{2,4}$", description="Local emergency number shown to helpers")

    @field_validator("contacts")
    @classmethod
    def _unique_ids(cls, contacts: list[Contact]) -> list[Contact]:
        ids = [c.id for c in contacts]
        if len(ids) != len(set(ids)):
            raise ValueError("contact ids must be unique")
        return contacts

    def enabled_contacts(self) -> list[Contact]:
        return sorted((c for c in self.contacts if c.enabled), key=lambda c: (c.priority, c.name))

    def levels(self) -> list[list[Contact]]:
        """Contacts grouped by priority: each group is one escalation level."""
        groups: dict[int, list[Contact]] = {}
        for c in self.enabled_contacts():
            groups.setdefault(c.priority, []).append(c)
        return [groups[p] for p in sorted(groups)]


class HelpRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: HelpSource = "help_button"
    test: bool = False


class Heartbeat(BaseModel):
    model_config = ConfigDict(extra="forbid")

    signal_ready: bool = False
    camera: str = Field(default="off", max_length=20)
    face_visible: bool = False
    page_visible: bool = True
    input_mode: str = Field(default="pointer", max_length=20)


class MonitoringRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    armed: bool


class CheckinResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str = Field(default="button", max_length=20)
