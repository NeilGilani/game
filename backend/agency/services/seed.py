"""Fictional demonstration data. Nothing here describes a real person, company or program.

Dates are generated relative to the day the demo is reset, so "before Friday" always means
the coming Friday.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any

from ..db import Database, dumps, utcnow
from ..lifeline.home import seed_demo_home
from ..lifeline.rescue import DEMO_PLANS

DEMO_PROFILE: dict[str, Any] = {
    "fictional": True,
    "display_name": "Riley",
    "note": "Fictional demonstration profile. No real personal data is stored.",
    "device": {
        "category": "power_wheelchair",
        "label": "Power wheelchair (demo model PW-200)",
        "serial": "DEMO-PW-0042",
        "registered_with_program": True,
    },
    "documents_on_file": [
        {"id": "device_registration", "label": "Device registration"},
        {"id": "proof_of_residence", "label": "Proof of residence"},
    ],
    "contacts": {"caregiver": "c_jordan", "clinic": "c_clinic", "repair": "c_repair"},
    "preferences": {"time_of_day": "morning"},
}

PROGRAMS: list[dict[str, Any]] = [
    {
        "id": "prog_mobility",
        "kind": "program",
        "name": "Demo Mobility Equipment Assistance Program",
        "covers": ["power_wheelchair_repair", "manual_wheelchair_repair"],
        "requirements": [
            {"id": "device_registration", "label": "Device registered with the program"},
            {
                "id": "letter_of_medical_necessity",
                "label": "Letter of medical necessity from your clinician (dated within 12 months)",
            },
            {"id": "repair_estimate", "label": "Written repair estimate from the repair provider"},
        ],
        "max_benefit_cents": 150_000,
        "decision_time": "7 to 10 business days",
        "disclaimer": (
            "Demonstration policy. Meeting the listed requirements does not guarantee funding; the program makes the decision."
        ),
    },
    {
        "id": "form_paratransit",
        "kind": "form",
        "name": "Paratransit eligibility renewal (demo)",
        "office": "Demo Transit Accessibility Office",
        "fields": ["mobility_device", "trips_per_week", "needs_attendant"],
        "processing_time": "about 2 weeks",
    },
    {
        "id": "form_placard",
        "kind": "form",
        "name": "Accessible parking placard renewal (demo)",
        "office": "Demo Motor Vehicles Office",
        "fields": ["mobility_device", "placard_type"],
        "processing_time": "about 10 days",
    },
]

# Lifeline defaults for the fictional demo. Every contact uses the simulated "demo" channel, so
# nobody real is ever contacted until someone deliberately adds a real phone number in setup.
DEMO_LIFELINE: dict[str, Any] = {
    "consent": True,
    "consent_note": "Recorded for the fictional demo profile. A real user confirms this themselves in Lifeline setup.",
    "contacts": [
        {"id": "jordan", "name": "Jordan", "role": "caregiver", "channel": "demo", "address": "", "priority": 1},
        {"id": "morgan", "name": "Morgan", "role": "neighbour", "channel": "demo", "address": "", "priority": 2},
        {
            "id": "monitoring",
            "name": "Demo Monitoring Center",
            "role": "monitoring_service",
            "channel": "demo",
            "address": "",
            "priority": 3,
        },
    ],
    "cancel_window_s": 8,
    "ack_timeout_s": 45,
    "watchdog_timeout_s": 30,
    "checkin_interval_min": 0,
    "checkin_response_s": 90,
    "alert_on_signal_unavailable": False,
    "signal_grace_s": 180,
    "responder": {
        "person_name": "Riley",
        "address": "Demo address: 100 Example Street, Apt 2 (fictional). Key safe by the door, code with Jordan.",
        "communication": "Can't speak. Answers yes/no with eye movements: look up for yes, close eyes for no.",
        "breathing": "Uses a home ventilator (BiPAP) at night and when tired. Check the mask and tubing first.",
        "medical": "ALS (fictional demo profile).",
        "allergies": "Penicillin (demo).",
        "medications": "Riluzole (demo).",
        "advance_directive": "Copy on the fridge (demo).",
        "notes": "Please talk to Riley directly. They can hear and understand everything.",
    },
    "critical_alert_everyone": True,
    "plans": DEMO_PLANS,
    "plans_note": "Example care plan for the fictional demo profile. A real plan must be written with the person's care team.",
    "dispatch": {
        "consent": True,
        "auto_after_s": 90,
        "address": {"line1": "100 Example Street", "line2": "Apt 2", "city": "Santa Cruz", "state": "CA", "zip": "95060"},
        "phone": "+18315550142",
        "entry": "Key safe by the front door (demo). The door can also be unlocked remotely.",
        "pin": "4321",
    },
    "home": {
        "lights_on_alert": True,
        "unlock_for_responders": True,
        "unlock_for_emergency_services": True,
        "relock_after_min": 15,
        "watch_power": True,
        "power_critical_minutes": 20,
    },
}

CONTACTS = [
    ("c_jordan", "Jordan (caregiver)", "caregiver", "demo text message"),
    ("c_clinic", "Demo Neurology Clinic front desk", "clinic", "demo patient portal"),
    ("c_repair", "Demo Mobility Repair service desk", "repair_provider", "demo email"),
]


def demo_deadline(today: date) -> date:
    """The coming Friday, at least two days away."""
    days_ahead = (4 - today.weekday()) % 7
    if days_ahead < 2:
        days_ahead += 7
    return today + timedelta(days=days_ahead)


def _business_days(start: date, count: int) -> list[date]:
    days: list[date] = []
    current = start
    while len(days) < count:
        if current.weekday() < 5:
            days.append(current)
        current += timedelta(days=1)
    return days


def _at(day: date, hour: int, minute: int = 0) -> str:
    return datetime.combine(day, time(hour, minute)).strftime("%Y-%m-%dT%H:%M")


def seed_demo_data(db: Database, today: date | None = None) -> dict[str, Any]:
    """Wipe and recreate all demo service data, cases and audit history."""
    today = today or date.today()
    deadline = demo_deadline(today)
    with db.transaction():
        for table in (
            "audit_events",
            "verifications",
            "approvals",
            "invocations",
            "steps",
            "cases",
            "svc_repair_slots",
            "svc_repair_requests",
            "svc_repair_submissions",
            "svc_funding_programs",
            "svc_funding_cases",
            "svc_funding_submissions",
            "svc_calendar_events",
            "svc_calendar_openings",
            "svc_calendar_ops",
            "svc_contacts",
            "svc_messages",
            "svc_message_sends",
            "lifeline_events",
            "lifeline_questions",
            "lifeline_steps",
            "lifeline_dispatch",
            "lifeline_notifications",
            "lifeline_alerts",
            "svc_home_devices",
            "profile",
        ):
            db.execute(f"DELETE FROM {table}")  # noqa: S608 - fixed table names

        profile = dict(DEMO_PROFILE)
        profile["demo_today"] = today.isoformat()
        profile["demo_deadline"] = deadline.isoformat()
        db.execute("INSERT INTO profile(id, data) VALUES (1, ?)", (dumps(profile),))

        # Repair slots: a morning home visit and an afternoon shop visit on each business day
        # from tomorrow, including some after the deadline. A couple are already taken.
        days = _business_days(today + timedelta(days=1), 7)
        technicians = ["Sam at Demo Mobility Repair", "Priya at Demo Mobility Repair"]
        n = 0
        for i, day in enumerate(days):
            for hour, visit, tech in ((9, "home visit", technicians[i % 2]), (14, "repair shop", technicians[(i + 1) % 2])):
                n += 1
                taken = i == 0 and hour == 14
                db.execute(
                    "INSERT INTO svc_repair_slots(id, technician, starts_at, ends_at, visit_type, status,"
                    " booked_request_id, note) VALUES (?,?,?,?,?,?,?,?)",
                    (
                        f"slot_{n:02d}",
                        tech,
                        _at(day, hour),
                        _at(day, hour + 2),
                        visit,
                        "booked" if taken else "open",
                        None,
                        "Booked by another customer" if taken else None,
                    ),
                )

        for program in PROGRAMS:
            db.execute("INSERT INTO svc_funding_programs(id, data) VALUES (?, ?)", (program["id"], dumps(program)))

        for contact in CONTACTS:
            db.execute("INSERT INTO svc_contacts(id, name, role, channel) VALUES (?,?,?,?)", contact)

        # The user's demo calendar and the demo clinic's open times.
        next_days = _business_days(today + timedelta(days=1), 10)
        appointment_day = next_days[0]
        events = [
            (
                "ev_neuro",
                "Neurology follow-up",
                _at(appointment_day, 10),
                _at(appointment_day, 11),
                "Demo Neurology Clinic",
                "appointment",
                "Bring medication list.",
            ),
            ("ev_pt", "Physical therapy", _at(next_days[2], 15), _at(next_days[2], 16), "Demo Therapy Center", "appointment", ""),
        ]
        for ev in events:
            db.execute(
                "INSERT INTO svc_calendar_events(id, idempotency_key, title, starts_at, ends_at, location,"
                " kind, status, notes, history, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (ev[0], None, ev[1], ev[2], ev[3], ev[4], ev[5], "scheduled", ev[6], dumps([]), utcnow()),
            )
        k = 0
        for day in next_days[2:9]:
            for hour, provider in (
                (9, "Demo Neurology Clinic"),
                (11, "Demo Therapy Center"),
                (13, "Demo Neurology Clinic"),
                (16, "Demo Therapy Center"),
            ):
                k += 1
                db.execute(
                    "INSERT INTO svc_calendar_openings(id, provider, starts_at, ends_at, status) VALUES (?,?,?,?,?)",
                    (f"open_{k:02d}", provider, _at(day, hour), _at(day, hour + 1), "open"),
                )

        db.set_state("faults", {})
        now = utcnow()
        db.set_state("lifeline_settings", _demo_lifeline(now))
        db.set_state("lifeline_monitor", {})
        db.set_state("lifeline_home", {})
        db.set_state("lifeline_power", {})
        seed_demo_home(db)
        db.set_state("seeded_at", utcnow())
    return {"today": today.isoformat(), "deadline": deadline.isoformat()}


def ensure_seeded(db: Database) -> None:
    if db.query_one("SELECT id FROM profile WHERE id = 1") is None:
        seed_demo_data(db)
        return
    # A database created by an earlier version: add what's new without touching anything else.
    settings = db.get_state("lifeline_settings")
    if settings is None:
        db.set_state("lifeline_settings", _demo_lifeline(utcnow()))
    elif "plans" not in settings:
        now = utcnow()
        demo = _demo_lifeline(now)
        db.set_state(
            "lifeline_settings",
            {**settings, **{k: demo[k] for k in ("critical_alert_everyone", "plans", "plans_note", "dispatch", "home")}},
        )
    if db.query_one("SELECT id FROM svc_home_devices LIMIT 1") is None:
        seed_demo_home(db)


def _demo_lifeline(now: str) -> dict[str, Any]:
    return {
        **DEMO_LIFELINE,
        "consented_at": now,
        "dispatch": {**DEMO_LIFELINE["dispatch"], "consented_at": now},
    }
