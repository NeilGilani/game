"""Deterministic plans for each supported goal. Used directly in demo mode, and given to the
cloud planner as a baseline it may adapt (the result is validated the same way)."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any

from ..models import Goal, PlanDraft, Question, QuestionOption, RetryPolicy, StepDraft


def _ref(path: str) -> dict[str, str]:
    return {"$ref": path}


def _fmt(text: str, *args: str) -> dict[str, Any]:
    return {"$fmt": text, "args": list(args)}


FINALIZERS = [
    StepDraft(
        id="verify_all",
        title="Double-check every result",
        description="Re-check each completed action against the service's own records and list anything still pending.",
        tool="case.verify_outcomes",
        preconditions=[{"type": "all_others_settled"}],
        expected_output="A list of verified outcomes and open items.",
        verification="Every confirmed action is re-read from its service.",
    ),
    StepDraft(
        id="save_notes",
        title="Save the case so you can come back to it",
        description="Store a plain-language summary and follow-ups for this case.",
        tool="case.save_notes",
        depends_on=["verify_all"],
        preconditions=[{"type": "all_others_settled"}],
        expected_output="A saved case summary.",
    ),
]

ISSUE_QUESTION = Question(
    key="issue",
    prompt="What's wrong with the wheelchair?",
    options=[
        QuestionOption(value="battery", label="Won't charge / battery", description="Battery drains or won't charge"),
        QuestionOption(value="controls", label="Joystick or controls", description="Controls don't respond"),
        QuestionOption(value="wheel", label="Wheel or tire", description="Flat, wobble or caster"),
        QuestionOption(value="seating", label="Seat or cushion", description="Seating or positioning"),
        QuestionOption(value="other", label="Something else", description="The technician will assess it"),
    ],
)

FORM_QUESTIONS: dict[str, list[Question]] = {
    "form_paratransit": [
        Question(
            key="trips_per_week",
            prompt="About how many paratransit trips do you take each week?",
            options=[
                QuestionOption(value="1-2", label="1 to 2 trips"),
                QuestionOption(value="3-5", label="3 to 5 trips"),
                QuestionOption(value="6+", label="6 or more"),
            ],
        ),
        Question(
            key="needs_attendant",
            prompt="Do you travel with an attendant?",
            options=[
                QuestionOption(value="yes", label="Yes, with an attendant"),
                QuestionOption(value="no", label="No, on my own"),
            ],
        ),
    ],
    "form_placard": [
        Question(
            key="placard_type",
            prompt="Which placard do you need?",
            options=[
                QuestionOption(value="permanent", label="Permanent placard"),
                QuestionOption(value="temporary", label="Temporary placard"),
            ],
        )
    ],
}


def _reminder_time(days_ahead: int) -> tuple[str, str]:
    day = date.today() + timedelta(days=days_ahead)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    start = datetime.combine(day, time(10, 0))
    return start.strftime("%Y-%m-%dT%H:%M"), (start + timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M")


def repair_plan(goal: Goal) -> PlanDraft:
    issue = goal.entities.get("issue")
    time_of_day = goal.preferences.get("time_of_day", "any")
    if time_of_day not in {"morning", "afternoon", "any"}:
        time_of_day = "any"
    check_funding = goal.options.get("check_funding", True)
    notify = goal.options.get("notify_caregiver", True)
    issue_value: Any = issue if issue else _ref("ask_issue.value")

    steps: list[StepDraft] = [
        StepDraft(
            id="details",
            title="Collect device and repair details",
            description="Read your wheelchair's details and the documents already on file.",
            tool="profile.read",
            expected_output="Device serial number, documents on file, contacts.",
        )
    ]
    if not issue:
        steps.append(
            StepDraft(
                id="ask_issue",
                title="Ask what needs repairing",
                description="I need to know what's wrong before I can look for a technician.",
                tool="user.ask",
                question=ISSUE_QUESTION,
                expected_output="The problem, in your words.",
            )
        )
    steps += [
        StepDraft(
            id="find_slots",
            title="Check the repair provider's available times",
            description=f"Ask the Demo Repair Provider for open times before {goal.deadline or 'the deadline'}.",
            tool="repair.find_slots",
            inputs={"issue": issue_value, "before": goal.deadline, "time_of_day": time_of_day},
            depends_on=["details"] + ([] if issue else ["ask_issue"]),
            expected_output="Open repair times and a cost estimate.",
            retry=RetryPolicy(max_attempts=2, backoff_ms=300),
        ),
        StepDraft(
            id="prepare_request",
            title="Prepare a repair request",
            description="Create a draft request for the earliest time that suits you. Nothing is booked yet.",
            tool="repair.prepare_request",
            inputs={
                "issue": issue_value,
                "slot_id": _ref("find_slots.recommended.slot_id"),
                "device_serial": _ref("details.device.serial"),
            },
            depends_on=["find_slots", "details"],
            expected_output="A draft repair request held by the provider.",
            verification="The provider shows the request as a draft.",
        ),
    ]
    if check_funding:
        steps += [
            StepDraft(
                id="get_policy",
                title="Check the demo funding program's rules",
                description="Retrieve what the Demo Mobility Equipment Assistance Program requires for repairs.",
                tool="funding.get_policy",
                inputs={"device_category": _ref("details.device.category"), "service": "repair"},
                depends_on=["details"],
                expected_output="The program's requirements.",
            ),
            StepDraft(
                id="check_documents",
                title="Identify missing documents",
                description="Compare the program's requirements with what's on file. This is not a funding decision.",
                tool="funding.check_requirements",
                inputs={
                    "program_id": _ref("get_policy.program_id"),
                    "documents_on_file": _ref("details.documents_on_file"),
                    "has_repair_estimate": True,
                },
                depends_on=["get_policy", "details", "prepare_request"],
                expected_output="Which requirements are met and which documents are missing.",
            ),
            StepDraft(
                id="prepare_inquiry",
                title="Prepare a funding inquiry",
                description="Draft an inquiry about help with the repair cost, noting documents that will follow.",
                tool="funding.prepare_inquiry",
                inputs={
                    "program_id": _ref("get_policy.program_id"),
                    "repair_request_id": _ref("prepare_request.request_id"),
                    "estimate_cents": _ref("prepare_request.estimate_cents"),
                    "missing_documents": _ref("check_documents.missing_ids"),
                },
                depends_on=["check_documents", "prepare_request"],
                expected_output="A draft inquiry held by the funding service.",
                verification="The funding service shows the inquiry as a draft.",
            ),
        ]
    steps.append(
        StepDraft(
            id="book_repair",
            title="Book the repair appointment",
            description="Submit the request and book the time with the provider, once you approve.",
            tool="repair.submit_request",
            inputs={"request_id": _ref("prepare_request.request_id"), "slot_id": _ref("find_slots.recommended.slot_id")},
            depends_on=["prepare_request"],
            approval="required",
            expected_output="A confirmed booking with a reference number.",
            verification="The provider's records show the booking at the approved time.",
            timeout_s=4.0,
        )
    )
    if check_funding:
        steps.append(
            StepDraft(
                id="submit_inquiry",
                title="Send the funding inquiry",
                description="Send the inquiry to the demo program, once you approve. This asks; it does not apply for approval.",
                tool="funding.submit",
                inputs={"case_id": _ref("prepare_inquiry.case_id")},
                depends_on=["prepare_inquiry"],
                approval="required",
                expected_output="A received inquiry with a reference number. No decision.",
                verification="The funding service shows it as received with no decision.",
            )
        )
    steps.append(
        StepDraft(
            id="add_to_calendar",
            title="Add the repair to your calendar",
            description="Put the confirmed repair time on your demo calendar.",
            tool="calendar.add_event",
            inputs={
                "title": _fmt("Wheelchair repair ({0})", "book_repair.reference"),
                "starts_at": _ref("book_repair.starts_at"),
                "ends_at": _ref("book_repair.ends_at"),
                "location": _ref("book_repair.visit_type"),
                "notes": _fmt("Technician: {0}", "book_repair.technician"),
            },
            depends_on=["book_repair"],
            expected_output="A calendar event at the booked time.",
            verification="The calendar shows the event at the booked time.",
        )
    )
    if notify:
        steps += [
            StepDraft(
                id="draft_caregiver",
                title="Draft a message to your caregiver",
                description="Write a short note to Jordan with the confirmed repair time.",
                tool="messaging.prepare_message",
                inputs={
                    "contact_id": "c_jordan",
                    "template": "repair_booked",
                    "variant": "standard",
                    "context": {
                        "when": _ref("book_repair.starts_at"),
                        "visit_type": _ref("book_repair.visit_type"),
                        "technician": _ref("book_repair.technician"),
                        "reference": _ref("book_repair.reference"),
                    },
                },
                depends_on=["book_repair"],
                optional=True,
                expected_output="An unsent draft in the demo outbox.",
            ),
            StepDraft(
                id="send_caregiver",
                title="Send the message to your caregiver",
                description="Send the note to Jordan, once you approve.",
                tool="messaging.send",
                inputs={"message_id": _ref("draft_caregiver.message_id"), "body_digest": _ref("draft_caregiver.body_digest")},
                depends_on=["draft_caregiver"],
                approval="required",
                optional=True,
                expected_output="The approved text recorded as delivered (simulated).",
                verification="The outbox shows the exact approved text as delivered.",
            ),
        ]
    return PlanDraft(steps=steps + FINALIZERS, rationale="Built-in repair coordination plan.")


def reschedule_plan(goal: Goal) -> PlanDraft:
    event_id = goal.entities.get("event_id")
    notify = goal.options.get("notify_caregiver", False)
    event_value: Any = event_id if event_id else _ref("ask_which.value")
    steps: list[StepDraft] = [
        StepDraft(
            id="list_appts",
            title="Look up your appointments",
            description="Read upcoming appointments from your demo calendar.",
            tool="calendar.list_appointments",
            expected_output="Upcoming appointments.",
        )
    ]
    if not event_id:
        steps.append(
            StepDraft(
                id="ask_which",
                title="Ask which appointment to move",
                description="I'll show your upcoming appointments so you can pick one.",
                tool="user.ask",
                inputs={
                    "prompt": "Which appointment do you want to move?",
                    "options_from": "list_appts.events",
                    "value_field": "event_id",
                    "label_template": "{title}",
                    "description_template": "{starts_at|when} · {location}",
                },
                depends_on=["list_appts"],
            )
        )
    steps += [
        StepDraft(
            id="find_times",
            title="Find open times with the clinic",
            description="Ask the provider for open appointment times.",
            tool="calendar.find_openings",
            inputs={"event_id": event_value},
            depends_on=["list_appts"] + ([] if event_id else ["ask_which"]),
            expected_output="Open times, earliest first.",
        ),
        StepDraft(
            id="move",
            title="Move the appointment",
            description="Move the appointment to the earliest open time, once you approve.",
            tool="calendar.reschedule",
            inputs={"event_id": event_value, "opening_id": _ref("find_times.recommended.opening_id")},
            depends_on=["find_times"],
            approval="required",
            expected_output="The appointment at its new time.",
            verification="The calendar shows the new time and the clinic marks it taken.",
        ),
    ]
    if notify:
        steps += [
            StepDraft(
                id="draft_note",
                title="Draft a note to your caregiver",
                description="Let Jordan know about the new time.",
                tool="messaging.prepare_message",
                inputs={
                    "contact_id": "c_jordan",
                    "template": "appointment_moved",
                    "context": {"when": _ref("move.starts_at"), "title": _ref("move.title"), "location": _ref("move.location")},
                },
                depends_on=["move"],
                optional=True,
            ),
            StepDraft(
                id="send_note",
                title="Send the note",
                description="Send the note to Jordan, once you approve.",
                tool="messaging.send",
                inputs={"message_id": _ref("draft_note.message_id"), "body_digest": _ref("draft_note.body_digest")},
                depends_on=["draft_note"],
                approval="required",
                optional=True,
            ),
        ]
    return PlanDraft(steps=steps + FINALIZERS, rationale="Built-in rescheduling plan.")


def admin_plan(goal: Goal) -> PlanDraft:
    form_id = goal.entities.get("form_id", "form_paratransit")
    questions = FORM_QUESTIONS.get(form_id, [])
    remind_start, remind_end = _reminder_time(14)
    steps: list[StepDraft] = [
        StepDraft(
            id="prefill",
            title="Fill in what I already know",
            description="Pre-fill the form from your profile and find the fields still missing.",
            tool="admin.prefill_form",
            inputs={"form_id": form_id},
            expected_output="A partly filled form and the list of missing fields.",
        )
    ]
    for q in questions:
        steps.append(
            StepDraft(
                id=f"ask_{q.key}",
                title=f"Ask: {q.prompt}",
                description="This is required by the form and isn't in your profile.",
                tool="user.ask",
                question=q,
                depends_on=["prefill"],
            )
        )
    steps += [
        StepDraft(
            id="prepare_app",
            title="Prepare the application",
            description="Create a draft with your answers. Nothing is submitted yet.",
            tool="admin.prepare_application",
            inputs={
                "form_id": form_id,
                "prefilled": _ref("prefill.filled"),
                "answers": {q.key: _ref(f"ask_{q.key}.value") for q in questions},
            },
            depends_on=["prefill"] + [f"ask_{q.key}" for q in questions],
            verification="The office shows a draft application.",
        ),
        StepDraft(
            id="submit_app",
            title="Submit the application",
            description="Submit the application to the demo office, once you approve.",
            tool="funding.submit",
            inputs={"case_id": _ref("prepare_app.case_id")},
            depends_on=["prepare_app"],
            approval="required",
            verification="The office shows it as received with a reference number.",
        ),
        StepDraft(
            id="check_status",
            title="Track the request",
            description="Check the request's status with the office.",
            tool="admin.check_status",
            inputs={"case_id": _ref("prepare_app.case_id")},
            depends_on=["submit_app"],
        ),
        StepDraft(
            id="reminder",
            title="Set a reminder to follow up",
            description="Add a reminder in two weeks to check on the request.",
            tool="calendar.add_event",
            inputs={
                "title": _fmt("Check on application {0}", "submit_app.reference"),
                "starts_at": remind_start,
                "ends_at": remind_end,
                "location": "Reminder",
                "notes": "Created by AGENCY",
            },
            depends_on=["submit_app"],
            optional=True,
        ),
    ]
    return PlanDraft(steps=steps + FINALIZERS, rationale="Built-in administrative request plan.")


def message_plan(goal: Goal) -> PlanDraft:
    contact = goal.entities.get("contact_id", "c_jordan")
    template = goal.entities.get("template", "please_call")
    follow_up = goal.preferences.get("follow_up", "tomorrow")
    steps: list[StepDraft] = [
        StepDraft(
            id="draft",
            title="Draft the message",
            description="Write the message from the phrase you chose. Nothing is sent yet.",
            tool="messaging.prepare_message",
            inputs={"contact_id": contact, "template": template, "variant": "standard", "context": {}},
            expected_output="An unsent draft in the demo outbox.",
        ),
        StepDraft(
            id="send",
            title="Send the message",
            description="Send it once you approve.",
            tool="messaging.send",
            inputs={"message_id": _ref("draft.message_id"), "body_digest": _ref("draft.body_digest")},
            depends_on=["draft"],
            approval="required",
        ),
    ]
    if follow_up in {"tomorrow", "in_3_days"}:
        start, end = _reminder_time(1 if follow_up == "tomorrow" else 3)
        steps.append(
            StepDraft(
                id="follow_up",
                title="Set a follow-up reminder",
                description="Remind you to check whether you got a reply.",
                tool="calendar.add_event",
                inputs={
                    "title": _fmt("Follow up with {0}", "draft.contact.name"),
                    "starts_at": start,
                    "ends_at": end,
                    "location": "Reminder",
                    "notes": "Created by AGENCY",
                },
                depends_on=["send"],
                optional=True,
            )
        )
    return PlanDraft(steps=steps + FINALIZERS, rationale="Built-in message and follow-up plan.")


TEMPLATES = {
    "equipment_repair": repair_plan,
    "reschedule_appointment": reschedule_plan,
    "admin_request": admin_plan,
    "message_followup": message_plan,
}


def baseline_plan(goal: Goal) -> PlanDraft:
    return TEMPLATES[goal.goal_type](goal)
