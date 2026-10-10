"""The registry of permitted tools.

Every tool targets a local demonstration service (or AGENCY's own case store). There is no
tool for shell commands, SQL, arbitrary HTTP or browser control, and the planner cannot
invent one: unknown tool names are rejected by the plan validator and by the executor.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..models import RetryPolicy, ToolResult, VerificationResult
from ..services.common import ServiceError
from ..services.messaging import body_digest
from .base import (
    ActionSummary,
    ToolContext,
    ToolSpec,
    check,
    checks_result,
    fail,
    money,
    ok,
    when,
)

Issue = Literal["battery", "controls", "wheel", "seating", "other"]
ISSUE_LABELS = {
    "battery": "won't charge or the battery runs out",
    "controls": "joystick or controls not working",
    "wheel": "wheel, tire or caster problem",
    "seating": "seat or cushion problem",
    "other": "another problem",
}


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _service_failure(exc: ServiceError) -> ToolResult:
    return fail(exc.code, exc.message, retryable=exc.retryable, details=exc.details | {"status": exc.status})


# ---------------------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------------------


class ProfileIn(_In):
    pass


async def _profile_read(ctx: ToolContext, inp: ProfileIn) -> ToolResult:
    p = ctx.profile
    return ok(
        "Loaded the demo profile: device details and documents on file.",
        {
            "device": p["device"],
            "documents_on_file": [d["id"] for d in p["documents_on_file"]],
            "documents": p["documents_on_file"],
            "contacts": p["contacts"],
            "deadline": p.get("demo_deadline"),
        },
        {"source": "AGENCY demo profile (fictional)"},
    )


# ---------------------------------------------------------------------------------------
# Demo Repair Provider
# ---------------------------------------------------------------------------------------


class FindSlotsIn(_In):
    issue: Issue
    before: str | None = Field(default=None, description="ISO date; only slots before this day")
    time_of_day: Literal["morning", "afternoon", "any"] = "any"


async def _find_slots(ctx: ToolContext, inp: FindSlotsIn) -> ToolResult:
    found = ctx.repair.search_slots(issue=inp.issue, before=inp.before, limit=8)
    slots = found["slots"]
    if not slots:
        return fail(
            "no_slots_before_deadline",
            "The repair provider has no open times before the deadline.",
            details={"before": inp.before},
        )

    def matches(slot: dict[str, Any]) -> bool:
        hour = int(slot["starts_at"][11:13])
        if inp.time_of_day == "morning":
            return hour < 12
        if inp.time_of_day == "afternoon":
            return hour >= 12
        return True

    preferred = [s for s in slots if matches(s)]
    recommended = (preferred or slots)[0]
    return ok(
        f"Found {len(slots)} open repair times before the deadline. Earliest that fits: {when(recommended['starts_at'])}.",
        {
            "slots": slots[:4],
            "recommended": recommended,
            "estimate_cents": found["estimate_cents"],
        },
        {"integration": "Demo Repair Provider", "simulated": True, "open_slots_seen": [s["slot_id"] for s in slots]},
    )


class PrepareRepairIn(_In):
    issue: Issue
    slot_id: str
    device_serial: str


async def _prepare_repair(ctx: ToolContext, inp: PrepareRepairIn) -> ToolResult:
    try:
        request, replayed = ctx.repair.create_draft(
            idempotency_key=ctx.idempotency_key,
            device={"serial": inp.device_serial, "category": ctx.profile["device"]["category"]},
            issue=inp.issue,
            slot_id=inp.slot_id,
        )
    except ServiceError as exc:
        return _service_failure(exc)
    return ok(
        f"Prepared a draft repair request (not submitted). Estimate {money(request['estimate_cents'])}.",
        {"request_id": request["request_id"], "status": request["status"], "estimate_cents": request["estimate_cents"]},
        {"integration": "Demo Repair Provider", "record": request["request_id"], "record_status": "draft", "simulated": True},
        replayed=replayed,
    )


def _verify_draft_repair(ctx: ToolContext, inp: PrepareRepairIn, result: ToolResult) -> VerificationResult:
    record = ctx.repair.get_request(result.data.get("request_id", ""))
    return checks_result(
        [
            check("Draft exists at the provider", True, record is not None),
            check("Draft has not been submitted", "draft", record["status"] if record else None),
        ],
        "The provider holds a draft request. Nothing has been booked yet.",
        "The provider's records don't match the draft we prepared.",
    )


class SubmitRepairIn(_In):
    request_id: str
    slot_id: str


async def _submit_repair(ctx: ToolContext, inp: SubmitRepairIn) -> ToolResult:
    try:
        outcome = ctx.repair.submit(idempotency_key=ctx.idempotency_key, request_id=inp.request_id, slot_id=inp.slot_id)
    except ServiceError as exc:
        return _service_failure(exc)
    if outcome["slow"]:
        # The provider committed the booking but answers too slowly; the executor's timeout
        # fires first and it has to find out what happened on its own.
        await asyncio.sleep(3600)
    return _repair_booked_result(ctx, outcome["request"], replayed=outcome["replayed"])


def _repair_booked_result(ctx: ToolContext, request: dict[str, Any], *, replayed: bool) -> ToolResult:
    slot = ctx.repair.get_slot(request["slot_id"]) or {}
    return ok(
        f"The repair provider confirmed the booking for {when(slot.get('starts_at'))}. Reference {request['reference']}.",
        {
            "request_id": request["request_id"],
            "reference": request["reference"],
            "status": request["status"],
            "slot": slot,
            "starts_at": slot.get("starts_at"),
            "ends_at": slot.get("ends_at"),
            "technician": slot.get("technician"),
            "visit_type": slot.get("visit_type"),
        },
        {
            "integration": "Demo Repair Provider",
            "simulated": True,
            "record": request["request_id"],
            "reference": request["reference"],
            "record_status": request["status"],
        },
        replayed=replayed,
    )


def _lookup_repair_submission(ctx: ToolContext, inp: SubmitRepairIn) -> ToolResult | None:
    request = ctx.repair.find_submission(ctx.idempotency_key)
    if not request:
        return None
    return _repair_booked_result(ctx, request, replayed=True)


def _verify_repair_booking(ctx: ToolContext, inp: SubmitRepairIn, result: ToolResult) -> VerificationResult:
    record = ctx.repair.get_request(inp.request_id)
    slot = ctx.repair.get_slot(inp.slot_id)
    return checks_result(
        [
            check("Request is confirmed at the provider", "confirmed", record["status"] if record else None),
            check("Booked time is the approved time", inp.slot_id, record["slot_id"] if record else None),
            check("Slot is held for this request", inp.request_id, slot["booked_request_id"] if slot else None),
            check("Provider issued a reference", True, bool(record and record["reference"])),
        ],
        "Checked with the Demo Repair Provider: the booking is confirmed for the approved time.",
        "The provider's records do not show the booking we expected.",
    )


def _describe_repair_booking(ctx: ToolContext, inp: SubmitRepairIn) -> ActionSummary:
    slot = ctx.repair.get_slot(inp.slot_id) or {}
    request = ctx.repair.get_request(inp.request_id) or {}
    options = []
    for out in ctx.step_outputs.values():
        if isinstance(out, dict) and "slots" in out and "recommended" in out:
            options = [
                {"value": s["slot_id"], "label": when(s["starts_at"]), "description": f"{s['visit_type']} · {s['technician']}"}
                for s in out["slots"]
                if s["status"] == "open"
            ]
    return ActionSummary(
        headline=f"Book the wheelchair repair for {when(slot.get('starts_at'))}",
        details=[
            ("When", f"{when(slot.get('starts_at'))} (about 2 hours)"),
            ("Where", str(slot.get("visit_type", "")).capitalize()),
            ("Technician", str(slot.get("technician", ""))),
            ("Problem", ISSUE_LABELS.get(str(request.get("issue")), str(request.get("issue")))),
            ("Estimate", money(request.get("estimate_cents"))),
            ("Provider", "Demo Repair Provider (simulated)"),
        ],
        effect="AGENCY submits your draft request and books this time with the demo repair provider.",
        if_rejected="Nothing is booked. The draft request stays unsent and you can pick another time.",
        reversible="The booking can be cancelled with the provider later.",
        edit={"field": "slot_id", "label": "Choose a different time", "options": options} if len(options) > 1 else None,
    )


def _edit_repair_booking(ctx: ToolContext, inp: SubmitRepairIn, edits: dict[str, Any]) -> dict[str, Any]:
    slot_id = str(edits.get("slot_id", ""))
    slot = ctx.repair.get_slot(slot_id)
    if not slot or slot["status"] != "open":
        raise ValueError("That time is not available. Choose one of the listed times.")
    return {"request_id": inp.request_id, "slot_id": slot_id}


# ---------------------------------------------------------------------------------------
# Demo Funding Service
# ---------------------------------------------------------------------------------------


class PolicyIn(_In):
    device_category: Literal["power_wheelchair", "manual_wheelchair"]
    service: Literal["repair"] = "repair"


async def _get_policy(ctx: ToolContext, inp: PolicyIn) -> ToolResult:
    program = ctx.funding.get_policy(device_category=inp.device_category, service=inp.service)
    if not program:
        return fail("no_program", "No demo assistance program covers this kind of repair.")
    return ok(
        f"Retrieved the rules for {program['name']}.",
        {"program": program, "program_id": program["id"], "requirements": program["requirements"]},
        {"integration": "Demo Funding Service", "simulated": True, "program": program["id"]},
    )


class RequirementsIn(_In):
    program_id: str
    documents_on_file: list[str]
    has_repair_estimate: bool


async def _check_requirements(ctx: ToolContext, inp: RequirementsIn) -> ToolResult:
    program = next((p for p in ctx.funding.list_programs() if p["id"] == inp.program_id), None)
    if not program:
        return fail("no_program", f"Program {inp.program_id} not found.")
    have = set(inp.documents_on_file)
    if inp.has_repair_estimate:
        have.add("repair_estimate")
    met = [r for r in program["requirements"] if r["id"] in have]
    missing = [r for r in program["requirements"] if r["id"] not in have]
    eligibility = "possibly_eligible_pending_documents" if missing else "possibly_eligible"
    message = (
        f"{len(met)} of {len(program['requirements'])} requirements are met. Still needed: "
        + "; ".join(r["label"] for r in missing)
        + ". This is not a funding decision."
        if missing
        else "All listed requirements appear to be met. This is not a funding decision; the program decides."
    )
    return ok(
        message,
        {
            "eligibility": eligibility,
            "met": met,
            "missing": missing,
            "missing_ids": [r["id"] for r in missing],
            "decision": None,
            "disclaimer": program["disclaimer"],
        },
        {"integration": "AGENCY rules check against the demo policy", "simulated": True},
    )


class PrepareInquiryIn(_In):
    program_id: str
    repair_request_id: str
    estimate_cents: int = Field(ge=0)
    missing_documents: list[str] = Field(default_factory=list)


async def _prepare_inquiry(ctx: ToolContext, inp: PrepareInquiryIn) -> ToolResult:
    try:
        record, replayed = ctx.funding.create_draft(
            idempotency_key=ctx.idempotency_key,
            kind="inquiry",
            program_id=inp.program_id,
            form_id=None,
            payload={
                "device_serial": ctx.profile["device"]["serial"],
                "repair_request_id": inp.repair_request_id,
                "estimate_cents": inp.estimate_cents,
                "documents_to_follow": inp.missing_documents,
            },
        )
    except ServiceError as exc:
        return _service_failure(exc)
    return ok(
        "Prepared a funding inquiry draft (not sent).",
        {"case_id": record["case_id"], "status": record["status"]},
        {"integration": "Demo Funding Service", "record": record["case_id"], "record_status": "draft", "simulated": True},
        replayed=replayed,
    )


def _verify_funding_draft(ctx: ToolContext, inp: Any, result: ToolResult) -> VerificationResult:
    record = ctx.funding.get_case(result.data.get("case_id", ""))
    return checks_result(
        [
            check("Draft exists at the funding service", True, record is not None),
            check("Draft has not been submitted", "draft", record["status"] if record else None),
        ],
        "The funding service holds the draft. Nothing has been sent yet.",
        "The funding service's records don't match the draft.",
    )


class SubmitFundingIn(_In):
    case_id: str


async def _submit_funding(ctx: ToolContext, inp: SubmitFundingIn) -> ToolResult:
    try:
        outcome = ctx.funding.submit(idempotency_key=ctx.idempotency_key, case_id=inp.case_id)
    except ServiceError as exc:
        return _service_failure(exc)
    return _funding_submitted_result(outcome["case"], replayed=outcome["replayed"])


def _funding_submitted_result(record: dict[str, Any], *, replayed: bool) -> ToolResult:
    noun = "inquiry" if record["kind"] == "inquiry" else "application"
    return ok(
        f"The demo office received the {noun}. Reference {record['reference']}. No decision has been made.",
        {"case_id": record["case_id"], "reference": record["reference"], "status": record["status"], "decision": None},
        {
            "integration": "Demo Funding Service",
            "simulated": True,
            "record": record["case_id"],
            "reference": record["reference"],
            "record_status": record["status"],
        },
        replayed=replayed,
    )


def _lookup_funding_submission(ctx: ToolContext, inp: SubmitFundingIn) -> ToolResult | None:
    record = ctx.funding.find_submission(ctx.idempotency_key)
    return _funding_submitted_result(record, replayed=True) if record else None


def _verify_funding_submission(ctx: ToolContext, inp: SubmitFundingIn, result: ToolResult) -> VerificationResult:
    record = ctx.funding.get_case(inp.case_id)
    return checks_result(
        [
            check("Office shows it as received", "received", record["status"] if record else None),
            check("Office issued a reference", True, bool(record and record["reference"])),
            check("No funding decision is claimed", None, record["decision"] if record else "missing"),
        ],
        "Checked with the Demo Funding Service: it was received. A decision is still pending.",
        "The funding service does not show this as received.",
    )


def _describe_funding_submission(ctx: ToolContext, inp: SubmitFundingIn) -> ActionSummary:
    record = ctx.funding.get_case(inp.case_id) or {"payload": {}, "kind": "inquiry", "program_id": None, "form_id": None}
    payload = record["payload"]
    if record["kind"] == "inquiry":
        program = next((p for p in ctx.funding.list_programs() if p["id"] == record["program_id"]), {})
        to_follow = payload.get("documents_to_follow") or []
        details = [
            ("Program", f"{program.get('name', 'Demo program')} (simulated)"),
            ("Repair estimate", money(payload.get("estimate_cents"))),
            ("Documents still needed", ", ".join(d.replace("_", " ") for d in to_follow) or "None"),
        ]
        return ActionSummary(
            headline="Send a funding inquiry for the repair cost",
            details=details,
            effect="AGENCY sends the inquiry to the demo assistance program and records its reference number.",
            if_rejected="No inquiry is sent. The repair booking is not affected.",
            reversible="An inquiry can be withdrawn. It is not an application approval.",
        )
    form = ctx.funding.get_form(record["form_id"] or "") or {}
    details = [("Form", str(form.get("name", "")))] + [
        (k.replace("_", " ").capitalize(), str(v)) for k, v in (payload.get("fields") or {}).items()
    ]
    return ActionSummary(
        headline=f"Submit the {form.get('name', 'application')}",
        details=details + [("Office", f"{form.get('office', 'Demo office')} (simulated)")],
        effect="AGENCY submits this application to the demo office and records the reference number.",
        if_rejected="Nothing is submitted. The draft stays saved in this case.",
        reversible="You can ask the office to withdraw it later.",
    )


# ---------------------------------------------------------------------------------------
# Administrative forms (also served by the Demo Funding Service)
# ---------------------------------------------------------------------------------------


class PrefillIn(_In):
    form_id: str


async def _prefill_form(ctx: ToolContext, inp: PrefillIn) -> ToolResult:
    form = ctx.funding.get_form(inp.form_id)
    if not form:
        return fail("unknown_form", f"Form {inp.form_id} does not exist.")
    known = {"mobility_device": ctx.profile["device"]["label"]}
    filled = {f: known[f] for f in form["fields"] if f in known}
    missing = [f for f in form["fields"] if f not in known]
    return ok(
        f"Filled {len(filled)} of {len(form['fields'])} fields from your profile.",
        {"form": form, "filled": filled, "missing_fields": missing},
        {"integration": "Demo Funding Service", "simulated": True, "form": form["id"]},
    )


class PrepareApplicationIn(_In):
    form_id: str
    prefilled: dict[str, str]
    answers: dict[str, str]


async def _prepare_application(ctx: ToolContext, inp: PrepareApplicationIn) -> ToolResult:
    try:
        record, replayed = ctx.funding.create_draft(
            idempotency_key=ctx.idempotency_key,
            kind="application",
            program_id=None,
            form_id=inp.form_id,
            payload={"fields": {**inp.prefilled, **inp.answers}},
        )
    except ServiceError as exc:
        return _service_failure(exc)
    return ok(
        "Prepared the application draft (not submitted).",
        {"case_id": record["case_id"], "status": record["status"]},
        {"integration": "Demo Funding Service", "record": record["case_id"], "record_status": "draft", "simulated": True},
        replayed=replayed,
    )


class StatusIn(_In):
    case_id: str


async def _check_status(ctx: ToolContext, inp: StatusIn) -> ToolResult:
    record = ctx.funding.get_case(inp.case_id)
    if not record:
        return fail("unknown_case", "That request was not found.")
    form = ctx.funding.get_form(record["form_id"] or "") or {}
    return ok(
        f"Status: {record['status']}. Typical processing time: {form.get('processing_time', 'unknown')}.",
        {"status": record["status"], "reference": record["reference"], "processing_time": form.get("processing_time")},
        {"integration": "Demo Funding Service", "simulated": True, "reference": record["reference"]},
    )


# ---------------------------------------------------------------------------------------
# Demo Calendar
# ---------------------------------------------------------------------------------------


class AddEventIn(_In):
    title: str = Field(min_length=3, max_length=120)
    starts_at: str
    ends_at: str
    location: str = Field(default="", max_length=120)
    notes: str = Field(default="", max_length=300)


async def _add_event(ctx: ToolContext, inp: AddEventIn) -> ToolResult:
    try:
        event, replayed = ctx.calendar.create_event(
            idempotency_key=ctx.idempotency_key,
            title=inp.title,
            starts_at=inp.starts_at,
            ends_at=inp.ends_at,
            location=inp.location,
            kind="reminder" if "remind" in inp.title.lower() or "check" in inp.title.lower() else "appointment",
            notes=inp.notes,
        )
    except ServiceError as exc:
        return _service_failure(exc)
    return ok(
        f"Added “{event['title']}” to your demo calendar for {when(event['starts_at'])}.",
        {"event_id": event["event_id"], "starts_at": event["starts_at"], "title": event["title"]},
        {"integration": "Demo Calendar", "simulated": True, "record": event["event_id"]},
        replayed=replayed,
    )


def _lookup_event(ctx: ToolContext, inp: AddEventIn) -> ToolResult | None:
    event = ctx.calendar.find_by_key(ctx.idempotency_key)
    if not event:
        return None
    return ok(
        f"Found the event already on your demo calendar for {when(event['starts_at'])}.",
        {"event_id": event["event_id"], "starts_at": event["starts_at"], "title": event["title"]},
        {"integration": "Demo Calendar", "simulated": True, "record": event["event_id"]},
        replayed=True,
    )


def _verify_event(ctx: ToolContext, inp: AddEventIn, result: ToolResult) -> VerificationResult:
    event = ctx.calendar.get_event(result.data.get("event_id", ""))
    return checks_result(
        [
            check("Event is on the calendar", True, event is not None),
            check("Start time matches", inp.starts_at, event["starts_at"] if event else None),
        ],
        "Checked the Demo Calendar: the event is there at the right time.",
        "The calendar does not show the event as expected.",
    )


class ListEventsIn(_In):
    pass


async def _list_events(ctx: ToolContext, inp: ListEventsIn) -> ToolResult:
    events = [e for e in ctx.calendar.list_events() if e["kind"] == "appointment"]
    return ok(
        f"Found {len(events)} upcoming appointments.",
        {"events": events},
        {"integration": "Demo Calendar", "simulated": True},
    )


class FindOpeningsIn(_In):
    event_id: str
    after: str | None = None


async def _find_openings(ctx: ToolContext, inp: FindOpeningsIn) -> ToolResult:
    event = ctx.calendar.get_event(inp.event_id)
    if not event:
        return fail("unknown_event", "That appointment was not found.")
    openings = ctx.calendar.list_openings(provider=event["location"])
    if inp.after:
        openings = [o for o in openings if o["starts_at"] > inp.after]
    if not openings:
        return fail("no_openings", f"{event['location']} has no open times listed.")
    return ok(
        f"{event['location']} has {len(openings)} open times. Earliest: {when(openings[0]['starts_at'])}.",
        {"event": event, "openings": openings[:4], "recommended": openings[0]},
        {"integration": "Demo Calendar", "simulated": True},
    )


class RescheduleIn(_In):
    event_id: str
    opening_id: str


async def _reschedule(ctx: ToolContext, inp: RescheduleIn) -> ToolResult:
    try:
        outcome = ctx.calendar.reschedule(idempotency_key=ctx.idempotency_key, event_id=inp.event_id, opening_id=inp.opening_id)
    except ServiceError as exc:
        return _service_failure(exc)
    event = outcome["event"]
    return ok(
        f"Moved “{event['title']}” to {when(event['starts_at'])}.",
        {"event_id": event["event_id"], "starts_at": event["starts_at"], "title": event["title"], "location": event["location"]},
        {"integration": "Demo Calendar", "simulated": True, "record": event["event_id"]},
        replayed=outcome["replayed"],
    )


def _lookup_reschedule(ctx: ToolContext, inp: RescheduleIn) -> ToolResult | None:
    event = ctx.calendar.find_by_key(ctx.idempotency_key)
    if not event:
        return None
    return ok(
        f"The appointment was already moved to {when(event['starts_at'])}.",
        {"event_id": event["event_id"], "starts_at": event["starts_at"], "title": event["title"], "location": event["location"]},
        {"integration": "Demo Calendar", "simulated": True, "record": event["event_id"]},
        replayed=True,
    )


def _verify_reschedule(ctx: ToolContext, inp: RescheduleIn, result: ToolResult) -> VerificationResult:
    event = ctx.calendar.get_event(inp.event_id)
    opening = next((o for o in ctx.db.query("SELECT * FROM svc_calendar_openings WHERE id = ?", (inp.opening_id,))), None)
    return checks_result(
        [
            check(
                "Appointment shows the new time", opening["starts_at"] if opening else None, event["starts_at"] if event else None
            ),
            check("Clinic marked the time as taken", "taken", opening["status"] if opening else None),
        ],
        "Checked the Demo Calendar: the appointment is at the new time.",
        "The calendar does not show the new time.",
    )


def _describe_reschedule(ctx: ToolContext, inp: RescheduleIn) -> ActionSummary:
    event = ctx.calendar.get_event(inp.event_id) or {}
    opening = ctx.db.query_one("SELECT * FROM svc_calendar_openings WHERE id = ?", (inp.opening_id,))
    options = [
        {"value": o["opening_id"], "label": when(o["starts_at"]), "description": o["provider"]}
        for o in ctx.calendar.list_openings(provider=event.get("location"))[:4]
    ]
    return ActionSummary(
        headline=f"Move “{event.get('title', 'appointment')}” to {when(opening['starts_at'] if opening else None)}",
        details=[
            ("Currently", when(event.get("starts_at"))),
            ("New time", when(opening["starts_at"] if opening else None)),
            ("With", f"{event.get('location', '')} (simulated)"),
        ],
        effect="AGENCY asks the demo clinic to move your appointment to the new time.",
        if_rejected="Your appointment stays at its current time.",
        reversible="You can reschedule again if another time is open.",
        edit={"field": "opening_id", "label": "Choose a different time", "options": options} if len(options) > 1 else None,
    )


def _edit_reschedule(ctx: ToolContext, inp: RescheduleIn, edits: dict[str, Any]) -> dict[str, Any]:
    opening_id = str(edits.get("opening_id", ""))
    if opening_id not in {o["opening_id"] for o in ctx.calendar.list_openings()}:
        raise ValueError("That time is not open. Choose one of the listed times.")
    return {"event_id": inp.event_id, "opening_id": opening_id}


# ---------------------------------------------------------------------------------------
# Demo Messaging Service
# ---------------------------------------------------------------------------------------

TEMPLATES: dict[str, dict[str, str]] = {
    "repair_booked": {
        "subject": "Wheelchair repair booked",
        "standard": (
            "Hi {name}, my wheelchair repair is booked for {when} ({visit_type}) with {technician}. "
            "Reference {reference}. Could you be there to help? Thank you. Riley"
        ),
        "short": "Hi {name}, wheelchair repair booked for {when}, ref {reference}. Can you be there? Riley",
        "detailed": (
            "Hi {name}, an update on my wheelchair: the repair is booked for {when} ({visit_type}) with "
            "{technician}, reference {reference}. I have also sent a funding inquiry; the program still "
            "needs a letter from my clinic. Could you be there for the visit and help me follow up on the "
            "letter? Thank you. Riley"
        ),
    },
    "appointment_moved": {
        "subject": "Appointment moved",
        "standard": "Hi {name}, my {title} has moved to {when}. Could you help me get there? Thank you. Riley",
        "short": "Hi {name}, {title} moved to {when}. Riley",
        "detailed": "Hi {name}, I moved my {title} to {when} at {location}. Could you help with transport? Thank you. Riley",
    },
    "please_call": {
        "subject": "Please call me",
        "standard": "Hi {name}, could you call me when you have a moment today? Thank you. Riley",
        "short": "Hi {name}, please call me today. Riley",
        "detailed": "Hi {name}, could you call me when you have a moment today? It isn't an emergency. Thank you. Riley",
    },
    "come_earlier": {
        "subject": "Could you come earlier?",
        "standard": "Hi {name}, could you come a little earlier today? Thank you. Riley",
        "short": "Hi {name}, can you come earlier today? Riley",
        "detailed": "Hi {name}, if it works for you, could you come about an hour earlier today? Thank you. Riley",
    },
    "supplies_low": {
        "subject": "Supplies running low",
        "standard": "Hi {name}, I'm running low on supplies. Could we order more this week? Thank you. Riley",
        "short": "Hi {name}, supplies are low, can we reorder this week? Riley",
        "detailed": "Hi {name}, I'm running low on supplies. Could we place an order this week so nothing runs out? Thank you. Riley",
    },
    "letter_request": {
        "subject": "Letter of medical necessity",
        "standard": (
            "Hello, could my clinician prepare a letter of medical necessity for my power wheelchair repair? "
            "The Demo Mobility Equipment Assistance Program needs it for my funding inquiry. Thank you. Riley"
        ),
        "short": "Hello, could I get a letter of medical necessity for my wheelchair repair funding? Thank you. Riley",
        "detailed": (
            "Hello, I've sent a funding inquiry to the Demo Mobility Equipment Assistance Program for a power wheelchair "
            "repair. They need a letter of medical necessity from my clinician, dated within the last 12 months. Could "
            "you let me know when it can be prepared? Thank you. Riley"
        ),
    },
    "need_help": {
        "subject": "I need help with something",
        "standard": "Hi {name}, I need a hand with something at home today when you're free. Thank you. Riley",
        "short": "Hi {name}, I need a hand today. Riley",
        "detailed": "Hi {name}, when you're free today I need a hand with something at home. It isn't urgent. Thank you. Riley",
    },
}
VARIANTS = ("standard", "short", "detailed")


class _Default(dict[str, str]):
    def __missing__(self, key: str) -> str:
        return "(not available)"


def render_template(template: str, variant: str, context: dict[str, str]) -> tuple[str, str]:
    t = TEMPLATES[template]
    return t["subject"], t[variant].format_map(_Default(context))


class PrepareMessageIn(_In):
    contact_id: str
    template: Literal[
        "repair_booked", "appointment_moved", "please_call", "come_earlier", "supplies_low", "need_help", "letter_request"
    ]
    variant: Literal["standard", "short", "detailed"] = "standard"
    context: dict[str, str] = Field(default_factory=dict)


async def _prepare_message(ctx: ToolContext, inp: PrepareMessageIn) -> ToolResult:
    contact = ctx.messaging.get_contact(inp.contact_id)
    if not contact:
        return fail("unknown_contact", "That contact is not in the demo address book.")
    first = contact["name"].split(" ")[0]
    context = {"name": first, **{k: (when(v) if k == "when" else v) for k, v in inp.context.items()}}
    subject, body = render_template(inp.template, inp.variant, context)
    try:
        message, replayed = ctx.messaging.create_draft(
            idempotency_key=ctx.idempotency_key, contact_id=inp.contact_id, subject=subject, body=body
        )
    except ServiceError as exc:
        return _service_failure(exc)
    return ok(
        f"Drafted a message to {contact['name']} (not sent).",
        {
            "message_id": message["message_id"],
            "body": message["body"],
            "body_digest": message["body_digest"],
            "contact": contact,
            "template": inp.template,
            "context": context,
        },
        {"integration": "Demo Messaging Service", "simulated": True, "record": message["message_id"], "record_status": "draft"},
        replayed=replayed,
    )


def _verify_message_draft(ctx: ToolContext, inp: PrepareMessageIn, result: ToolResult) -> VerificationResult:
    message = ctx.messaging.get_message(result.data.get("message_id", ""))
    return checks_result(
        [
            check("Draft is in the demo outbox", True, message is not None),
            check("Draft has not been sent", "draft", message["status"] if message else None),
        ],
        "The draft is saved in the demo outbox. Nothing has been sent.",
        "The demo outbox doesn't show the draft.",
    )


class SendMessageIn(_In):
    message_id: str
    body_digest: str = Field(description="Fingerprint of the exact text the user approved")


async def _send_message(ctx: ToolContext, inp: SendMessageIn) -> ToolResult:
    message = ctx.messaging.get_message(inp.message_id)
    if message and message["status"] == "draft" and message["body_digest"] != inp.body_digest:
        return fail("draft_changed", "The draft changed after you approved it, so it was not sent.")
    try:
        outcome = ctx.messaging.send(idempotency_key=ctx.idempotency_key, message_id=inp.message_id)
    except ServiceError as exc:
        return _service_failure(exc)
    return _message_sent_result(ctx, outcome["message"], replayed=outcome["replayed"])


def _message_sent_result(ctx: ToolContext, message: dict[str, Any], *, replayed: bool) -> ToolResult:
    contact = ctx.messaging.get_contact(message["contact_id"]) or {"name": "the contact"}
    return ok(
        f"The demo outbox recorded the message to {contact['name']} as delivered (simulated, not sent to a real person).",
        {"message_id": message["message_id"], "status": message["status"], "sent_at": message["sent_at"]},
        {
            "integration": "Demo Messaging Service",
            "simulated": True,
            "record": message["message_id"],
            "record_status": message["status"],
            "real_world_delivery": False,
        },
        replayed=replayed,
    )


def _lookup_send(ctx: ToolContext, inp: SendMessageIn) -> ToolResult | None:
    message = ctx.messaging.find_send(ctx.idempotency_key)
    return _message_sent_result(ctx, message, replayed=True) if message else None


def _verify_send(ctx: ToolContext, inp: SendMessageIn, result: ToolResult) -> VerificationResult:
    message = ctx.messaging.get_message(inp.message_id)
    return checks_result(
        [
            check("Outbox shows it delivered (simulated)", "delivered_simulated", message["status"] if message else None),
            check("Sent text is the text you approved", inp.body_digest, message["body_digest"] if message else None),
        ],
        "Checked the Demo Messaging Service: the approved text was recorded as delivered (simulated).",
        "The demo outbox does not show the message as delivered.",
    )


def _describe_send(ctx: ToolContext, inp: SendMessageIn) -> ActionSummary:
    message = ctx.messaging.get_message(inp.message_id) or {"body": "", "contact_id": ""}
    contact = ctx.messaging.get_contact(message["contact_id"]) or {"name": "contact", "channel": ""}
    return ActionSummary(
        headline=f"Send this message to {contact['name']}",
        details=[
            ("To", f"{contact['name']} via {contact['channel']}"),
            ("Message", message["body"]),
            ("Delivery", "Demo Messaging Service (simulated, nobody is actually contacted)"),
        ],
        effect="AGENCY places this exact text in the demo outbox and marks it delivered.",
        if_rejected="The message stays as an unsent draft.",
        reversible="A sent message cannot be unsent.",
        edit={
            "field": "variant",
            "label": "Use different wording",
            "options": [
                {"value": "short", "label": "Shorter", "description": ""},
                {"value": "standard", "label": "Standard", "description": ""},
                {"value": "detailed", "label": "More detail", "description": ""},
            ],
        },
    )


def _edit_send(ctx: ToolContext, inp: SendMessageIn, edits: dict[str, Any]) -> dict[str, Any]:
    variant = str(edits.get("variant", ""))
    if variant not in VARIANTS:
        raise ValueError("Choose one of the listed wordings.")
    draft_output = next(
        (
            o
            for o in ctx.step_outputs.values()
            if isinstance(o, dict) and o.get("message_id") == inp.message_id and "template" in o
        ),
        None,
    )
    if not draft_output:
        raise ValueError("The original draft could not be found.")
    _, body = render_template(draft_output["template"], variant, draft_output["context"])
    updated = ctx.messaging.update_draft(message_id=inp.message_id, body=body)
    return {"message_id": inp.message_id, "body_digest": body_digest(updated["body"])}


# ---------------------------------------------------------------------------------------
# AGENCY's own case store
# ---------------------------------------------------------------------------------------


class VerifyOutcomesIn(_In):
    pass


async def _verify_outcomes(ctx: ToolContext, inp: VerifyOutcomesIn) -> ToolResult:
    # Implemented by the executor, which can see the whole case (see engine.executor).
    raise RuntimeError("case.verify_outcomes is handled by the executor")


class SaveNotesIn(_In):
    pass


async def _save_notes(ctx: ToolContext, inp: SaveNotesIn) -> ToolResult:
    raise RuntimeError("case.save_notes is handled by the executor")


# ---------------------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------------------

_CONSEQUENTIAL_RETRY = RetryPolicy(max_attempts=2, backoff_ms=500)

TOOLS: dict[str, ToolSpec] = {
    t.name: t
    for t in [
        ToolSpec(
            "profile.read",
            "Read your profile",
            "Read device details, documents on file and contacts from the demo profile.",
            ProfileIn,
            ("device", "documents_on_file", "documents", "contacts", "deadline"),
            "agency",
            False,
            _profile_read,
            read_only=True,
        ),
        ToolSpec(
            "repair.find_slots",
            "Find repair times",
            "Search the Demo Repair Provider for open appointment times before a date.",
            FindSlotsIn,
            ("slots", "recommended", "estimate_cents"),
            "repair",
            False,
            _find_slots,
            read_only=True,
        ),
        ToolSpec(
            "repair.prepare_request",
            "Prepare repair request",
            "Create a draft repair request at the Demo Repair Provider. Does not book.",
            PrepareRepairIn,
            ("request_id", "status", "estimate_cents"),
            "repair",
            False,
            _prepare_repair,
            verify=_verify_draft_repair,
        ),
        ToolSpec(
            "repair.submit_request",
            "Book the repair",
            "Submit a draft repair request and book a time. Consequential.",
            SubmitRepairIn,
            ("request_id", "reference", "status", "slot", "starts_at", "ends_at", "technician", "visit_type"),
            "repair",
            True,
            _submit_repair,
            verify=_verify_repair_booking,
            lookup=_lookup_repair_submission,
            describe=_describe_repair_booking,
            apply_edit=_edit_repair_booking,
            reversible="Can be cancelled with the provider",
            retry=_CONSEQUENTIAL_RETRY,
            timeout_s=4.0,
        ),
        ToolSpec(
            "funding.get_policy",
            "Check funding rules",
            "Retrieve the demo assistance program's rules for this repair.",
            PolicyIn,
            ("program", "program_id", "requirements"),
            "funding",
            False,
            _get_policy,
            read_only=True,
        ),
        ToolSpec(
            "funding.check_requirements",
            "Check documents needed",
            "Compare the program's requirements with documents on file. Never decides eligibility.",
            RequirementsIn,
            ("eligibility", "met", "missing", "missing_ids", "decision", "disclaimer"),
            "agency",
            False,
            _check_requirements,
            read_only=True,
        ),
        ToolSpec(
            "funding.prepare_inquiry",
            "Prepare funding inquiry",
            "Create a draft funding inquiry at the Demo Funding Service. Does not send.",
            PrepareInquiryIn,
            ("case_id", "status"),
            "funding",
            False,
            _prepare_inquiry,
            verify=_verify_funding_draft,
        ),
        ToolSpec(
            "funding.submit",
            "Send inquiry or application",
            "Submit a draft inquiry or application to the Demo Funding Service. Consequential.",
            SubmitFundingIn,
            ("case_id", "reference", "status", "decision"),
            "funding",
            True,
            _submit_funding,
            verify=_verify_funding_submission,
            lookup=_lookup_funding_submission,
            describe=_describe_funding_submission,
            reversible="Can be withdrawn",
            retry=_CONSEQUENTIAL_RETRY,
        ),
        ToolSpec(
            "admin.prefill_form",
            "Fill in the form",
            "Pre-fill a demo administrative form from the profile and list missing fields.",
            PrefillIn,
            ("form", "filled", "missing_fields"),
            "funding",
            False,
            _prefill_form,
            read_only=True,
        ),
        ToolSpec(
            "admin.prepare_application",
            "Prepare application",
            "Create a draft application at the Demo Funding Service. Does not submit.",
            PrepareApplicationIn,
            ("case_id", "status"),
            "funding",
            False,
            _prepare_application,
            verify=_verify_funding_draft,
        ),
        ToolSpec(
            "admin.check_status",
            "Check request status",
            "Look up the status of a submitted request.",
            StatusIn,
            ("status", "reference", "processing_time"),
            "funding",
            False,
            _check_status,
            read_only=True,
        ),
        ToolSpec(
            "calendar.add_event",
            "Add to calendar",
            "Add an event or reminder to the user's Demo Calendar.",
            AddEventIn,
            ("event_id", "starts_at", "title"),
            "calendar",
            False,
            _add_event,
            verify=_verify_event,
            lookup=_lookup_event,
        ),
        ToolSpec(
            "calendar.list_appointments",
            "List appointments",
            "List upcoming appointments on the Demo Calendar.",
            ListEventsIn,
            ("events",),
            "calendar",
            False,
            _list_events,
            read_only=True,
        ),
        ToolSpec(
            "calendar.find_openings",
            "Find new times",
            "Find open times with the appointment's provider.",
            FindOpeningsIn,
            ("event", "openings", "recommended"),
            "calendar",
            False,
            _find_openings,
            read_only=True,
        ),
        ToolSpec(
            "calendar.reschedule",
            "Move appointment",
            "Move an appointment to an open time. Consequential.",
            RescheduleIn,
            ("event_id", "starts_at", "title", "location"),
            "calendar",
            True,
            _reschedule,
            verify=_verify_reschedule,
            lookup=_lookup_reschedule,
            describe=_describe_reschedule,
            apply_edit=_edit_reschedule,
            reversible="Can be moved again",
            retry=_CONSEQUENTIAL_RETRY,
        ),
        ToolSpec(
            "messaging.prepare_message",
            "Draft a message",
            "Draft a message from a fixed template in the Demo Messaging Service. Does not send.",
            PrepareMessageIn,
            ("message_id", "body", "body_digest", "contact", "template", "context"),
            "messaging",
            False,
            _prepare_message,
            verify=_verify_message_draft,
        ),
        ToolSpec(
            "messaging.send",
            "Send message",
            "Send an approved draft through the Demo Messaging Service (simulated delivery). Consequential.",
            SendMessageIn,
            ("message_id", "status", "sent_at"),
            "messaging",
            True,
            _send_message,
            verify=_verify_send,
            lookup=_lookup_send,
            describe=_describe_send,
            apply_edit=_edit_send,
            reversible="Cannot be unsent",
            retry=_CONSEQUENTIAL_RETRY,
        ),
        ToolSpec(
            "case.verify_outcomes",
            "Double-check everything",
            "Re-check every completed action against the services' own records.",
            VerifyOutcomesIn,
            ("outcomes", "pending", "all_verified"),
            "agency",
            False,
            _verify_outcomes,
        ),
        ToolSpec(
            "case.save_notes",
            "Save case notes",
            "Save a summary and follow-ups so the case can be resumed later.",
            SaveNotesIn,
            ("summary", "follow_ups"),
            "agency",
            False,
            _save_notes,
        ),
    ]
}

ASK_TOOL = "user.ask"

ALLOWED_TOOLS_BY_GOAL: dict[str, set[str]] = {
    "equipment_repair": {
        ASK_TOOL,
        "profile.read",
        "repair.find_slots",
        "repair.prepare_request",
        "repair.submit_request",
        "funding.get_policy",
        "funding.check_requirements",
        "funding.prepare_inquiry",
        "funding.submit",
        "calendar.add_event",
        "messaging.prepare_message",
        "messaging.send",
        "case.verify_outcomes",
        "case.save_notes",
    },
    "reschedule_appointment": {
        ASK_TOOL,
        "profile.read",
        "calendar.list_appointments",
        "calendar.find_openings",
        "calendar.reschedule",
        "messaging.prepare_message",
        "messaging.send",
        "case.verify_outcomes",
        "case.save_notes",
    },
    "admin_request": {
        ASK_TOOL,
        "profile.read",
        "admin.prefill_form",
        "admin.prepare_application",
        "funding.submit",
        "admin.check_status",
        "calendar.add_event",
        "case.verify_outcomes",
        "case.save_notes",
    },
    "message_followup": {
        ASK_TOOL,
        "profile.read",
        "messaging.prepare_message",
        "messaging.send",
        "calendar.add_event",
        "case.verify_outcomes",
        "case.save_notes",
    },
}


def get_tool(name: str) -> ToolSpec | None:
    return TOOLS.get(name)
