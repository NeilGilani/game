"""Lifeline settings and request models. Everything here is validated before it is stored."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

E164 = re.compile(r"^\+[1-9]\d{6,14}$")

ContactRole = Literal["caregiver", "family", "neighbour", "clinician", "monitoring_service", "other"]
Channel = Literal["demo", "sms", "sms_call"]
AlertKind = Literal["help", "watchdog", "checkin_missed", "signal_unavailable", "power_lost"]
HelpSource = Literal["eye_signal", "help_button", "switch", "test"]
SituationKey = Literal["breathing", "choking", "equipment", "pain", "position", "other"]
PlanKey = Literal["general", "breathing", "choking", "equipment", "pain", "position", "other"]
Answer = Literal["yes", "no", "not_sure"]
US_STATE = re.compile(r"^[A-Z]{2}$")

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


class DispatchAddress(BaseModel):
    """Where emergency services go. Structured, because dispatch services need it that way."""

    model_config = ConfigDict(extra="forbid")

    line1: str = Field(default="", max_length=100)
    line2: str = Field(default="", max_length=100)
    city: str = Field(default="", max_length=60)
    state: str = Field(default="", max_length=2)
    zip: str = Field(default="", max_length=10)

    @property
    def complete(self) -> bool:
        return bool(self.line1 and self.city and US_STATE.match(self.state) and re.match(r"^\d{5}(-\d{4})?$", self.zip))

    def one_line(self) -> str:
        parts = [self.line1, self.line2, self.city, f"{self.state} {self.zip}".strip()]
        return ", ".join(p for p in parts if p)


class DispatchSettings(BaseModel):
    """Requesting emergency services through a staffed dispatch centre (never an automated 911 call)."""

    model_config = ConfigDict(extra="forbid")

    consent: bool = False
    consented_at: str | None = None
    auto_after_s: int = Field(
        default=90, ge=0, le=600, description="Critical alert unanswered this long: request help. 0 = never"
    )
    address: DispatchAddress = Field(default_factory=DispatchAddress)
    phone: str = Field(default="", max_length=20, description="The person's phone, for the dispatcher (E.164)")
    entry: str = Field(default="", max_length=200, description="How responders get in, e.g. key safe code")
    pin: str = Field(default="", pattern=r"^(\d{4})?$", description="Needed to cancel a request")

    @model_validator(mode="after")
    def _phone(self) -> DispatchSettings:
        if self.phone and not E164.match(self.phone.replace(" ", "")):
            raise ValueError("The phone number for emergency services must look like +14155550123")
        if self.address.state and not US_STATE.match(self.address.state):
            raise ValueError("State must be a two-letter code, like CA")
        return self


class HomeSettings(BaseModel):
    """What AGENCY may do in the home during an alert, if a smart home is connected."""

    model_config = ConfigDict(extra="forbid")

    lights_on_alert: bool = True
    unlock_for_responders: bool = False
    unlock_for_emergency_services: bool = False
    relock_after_min: int = Field(default=15, ge=5, le=120)
    watch_power: bool = True
    power_critical_minutes: int = Field(default=20, ge=5, le=240)


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
    critical_alert_everyone: bool = True
    plans: dict[PlanKey, list[str]] = Field(default_factory=dict)
    plans_note: str = Field(default="", max_length=200)
    dispatch: DispatchSettings = Field(default_factory=DispatchSettings)
    home: HomeSettings = Field(default_factory=HomeSettings)

    @field_validator("plans")
    @classmethod
    def _plan_steps(cls, plans: dict[str, list[str]]) -> dict[str, list[str]]:
        for key, steps in plans.items():
            if len(steps) > 8:
                raise ValueError(f"{key}: at most 8 steps")
            if any(not (2 <= len(step.strip()) <= 200) for step in steps):
                raise ValueError(f"{key}: each step needs 2 to 200 characters")
        return {k: [step.strip() for step in v] for k, v in plans.items()}

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
    input_mode: str = Field(default="head", max_length=20)


class MonitoringRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    armed: bool


class SituationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    situation: SituationKey


class QuestionAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answer: Answer


class DispatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(default="", max_length=200)


class CheckinResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str = Field(default="button", max_length=20)
