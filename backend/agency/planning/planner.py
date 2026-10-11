"""Goal interpretation and plan creation (deterministic, with optional cloud assistance).

The deterministic path is always available and is what the demo uses without credentials.
When a cloud provider is configured, it may (a) extract fields from typed or phrase-built
requests and (b) adapt the built-in plan. Both outputs are validated by the same code that
validates the deterministic results; on any failure AGENCY falls back and says so.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from ..models import Goal, GoalRequest, PlanDraft, Question, QuestionOption
from ..reasoning.provider import ReasoningProvider
from ..tools.base import when
from .templates import ISSUE_QUESTION, baseline_plan
from .validate import PlanValidationError, tool_catalog_for, validate_plan

GOAL_CARDS: list[dict[str, str]] = [
    {
        "goal_type": "equipment_repair",
        "title": "Get my wheelchair repaired",
        "subtitle": "Find a technician before Friday, check for funding help, tell my caregiver",
        "icon": "wrench",
    },
    {
        "goal_type": "reschedule_appointment",
        "title": "Move an appointment",
        "subtitle": "Find a new time with the clinic and update my calendar",
        "icon": "calendar",
    },
    {
        "goal_type": "admin_request",
        "title": "Handle a form or renewal",
        "subtitle": "Prepare, submit and track administrative paperwork",
        "icon": "document",
    },
    {
        "goal_type": "message_followup",
        "title": "Send a message",
        "subtitle": "Message my caregiver or clinic and set a follow-up",
        "icon": "message",
    },
    {
        "goal_type": "resume",
        "title": "Resume a case",
        "subtitle": "Pick up a task where it left off",
        "icon": "resume",
    },
]

PHRASES: list[dict[str, str]] = [
    {"id": "wheelchair_repair", "text": "My wheelchair needs repair"},
    {"id": "wont_charge", "text": "It won't charge"},
    {"id": "joystick", "text": "The joystick isn't working"},
    {"id": "before_friday", "text": "Before Friday"},
    {"id": "funding", "text": "Can I get help paying?"},
    {"id": "tell_jordan", "text": "Tell Jordan"},
    {"id": "move_appointment", "text": "Move my appointment"},
    {"id": "paratransit", "text": "Renew paratransit"},
    {"id": "placard", "text": "Renew parking placard"},
    {"id": "please_call", "text": "Please call me"},
    {"id": "come_earlier", "text": "Come earlier today"},
    {"id": "supplies", "text": "Supplies are low"},
]

KEYWORDS: list[tuple[str, dict[str, str]]] = [
    ("wheelchair", {"goal_type": "equipment_repair"}),
    ("repair", {"goal_type": "equipment_repair"}),
    ("won't charge", {"issue": "battery"}),
    ("wont charge", {"issue": "battery"}),
    ("battery", {"issue": "battery"}),
    ("joystick", {"issue": "controls"}),
    ("controls", {"issue": "controls"}),
    ("tire", {"issue": "wheel"}),
    ("wheel ", {"issue": "wheel"}),
    ("seat", {"issue": "seating"}),
    ("cushion", {"issue": "seating"}),
    ("help paying", {"check_funding": "true"}),
    ("funding", {"check_funding": "true"}),
    ("financial", {"check_funding": "true"}),
    ("cost", {"check_funding": "true"}),
    ("jordan", {"notify_caregiver": "true"}),
    ("caregiver", {"notify_caregiver": "true"}),
    ("appointment", {"goal_type": "reschedule_appointment"}),
    ("reschedule", {"goal_type": "reschedule_appointment"}),
    ("paratransit", {"goal_type": "admin_request", "form_id": "form_paratransit"}),
    ("placard", {"goal_type": "admin_request", "form_id": "form_placard"}),
    ("renew", {"goal_type": "admin_request"}),
    ("form", {"goal_type": "admin_request"}),
    ("call me", {"goal_type": "message_followup", "template": "please_call"}),
    ("come earlier", {"goal_type": "message_followup", "template": "come_earlier"}),
    ("supplies", {"goal_type": "message_followup", "template": "supplies_low"}),
    ("message", {"goal_type": "message_followup"}),
    ("morning", {"time_of_day": "morning"}),
    ("afternoon", {"time_of_day": "afternoon"}),
]

TEMPLATE_QUESTION = Question(
    key="template",
    prompt="What do you want to say?",
    options=[
        QuestionOption(value="please_call", label="Please call me"),
        QuestionOption(value="come_earlier", label="Can you come earlier today?"),
        QuestionOption(value="need_help", label="I need a hand with something"),
        QuestionOption(value="supplies_low", label="Supplies are running low"),
    ],
)
CONTACT_QUESTION = Question(
    key="contact_id",
    prompt="Who should get the message?",
    options=[
        QuestionOption(value="c_jordan", label="Jordan (caregiver)"),
        QuestionOption(value="c_clinic", label="Demo Neurology Clinic"),
    ],
)
FORM_QUESTION = Question(
    key="form_id",
    prompt="Which request do you want to handle?",
    options=[
        QuestionOption(
            value="form_paratransit", label="Paratransit eligibility renewal", description="Demo Transit Accessibility Office"
        ),
        QuestionOption(
            value="form_placard", label="Accessible parking placard renewal", description="Demo Motor Vehicles Office"
        ),
    ],
)

PROHIBITED = [
    "Contacting real companies, offices or people",
    "Making payments",
    "Sharing medical records",
    "Claiming that funding or an application is approved",
]


def _keyword_selections(text: str) -> dict[str, str]:
    found: dict[str, str] = {}
    lowered = f" {text.lower()} "
    for keyword, values in KEYWORDS:
        if keyword in lowered:
            for key, value in values.items():
                found.setdefault(key, value)
    return found


def _truthy(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def build_goal(
    goal_type: str, selections: dict[str, str], profile: dict[str, Any], outcome: str | None = None
) -> tuple[Goal, list[Question], list[dict[str, Any]]]:
    """Deterministically build a validated Goal plus the questions still needing an answer."""
    deadline = profile.get("demo_deadline") or date.today().isoformat()
    questions: list[Question] = []
    toggles: list[dict[str, Any]] = []
    approvals: list[str]
    entities: dict[str, str] = {}
    preferences: dict[str, str] = {}
    options: dict[str, bool] = {}
    constraints = ["Only demonstration services are used"]

    if goal_type == "equipment_repair":
        issue = selections.get("issue")
        if issue:
            entities["issue"] = issue
        else:
            questions.append(ISSUE_QUESTION)
        preferences["time_of_day"] = selections.get("time_of_day") or profile.get("preferences", {}).get("time_of_day", "any")
        options["check_funding"] = _truthy(selections.get("check_funding"), True)
        options["notify_caregiver"] = _truthy(selections.get("notify_caregiver"), True)
        toggles = [
            {"key": "check_funding", "label": "Check for funding help", "value": options["check_funding"]},
            {"key": "notify_caregiver", "label": "Tell Jordan (caregiver)", "value": options["notify_caregiver"]},
        ]
        extras = []
        if options["check_funding"]:
            extras.append("find out whether financial help may be available")
        if options["notify_caregiver"]:
            extras.append("let Jordan know")
        default_outcome = (
            f"Get your wheelchair repaired before {when(deadline + 'T09:00').split(',')[0]}"
            + (", " + " and ".join(extras) if extras else "")
            + "."
        )
        constraints.append(f"Repair must happen before {deadline}")
        approvals = ["repair.submit_request", "funding.submit", "messaging.send"]
        goal_deadline: str | None = deadline
    elif goal_type == "reschedule_appointment":
        if selections.get("event_id"):
            entities["event_id"] = selections["event_id"]
        options["notify_caregiver"] = _truthy(selections.get("notify_caregiver"), False)
        toggles = [{"key": "notify_caregiver", "label": "Tell Jordan the new time", "value": options["notify_caregiver"]}]
        default_outcome = "Move an appointment to a better time and update your calendar."
        approvals = ["calendar.reschedule", "messaging.send"]
        goal_deadline = None
    elif goal_type == "admin_request":
        form_id = selections.get("form_id")
        if form_id in {"form_paratransit", "form_placard"}:
            entities["form_id"] = form_id
        else:
            questions.append(FORM_QUESTION)
        names = {"form_paratransit": "paratransit eligibility renewal", "form_placard": "accessible parking placard renewal"}
        default_outcome = f"Prepare, submit and track your {names.get(entities.get('form_id', ''), 'administrative request')}."
        approvals = ["funding.submit"]
        goal_deadline = None
    elif goal_type == "message_followup":
        contact = selections.get("contact_id")
        if contact in {"c_jordan", "c_clinic"}:
            entities["contact_id"] = contact
        else:
            questions.append(CONTACT_QUESTION)
        template = selections.get("template")
        if template in {o.value for o in TEMPLATE_QUESTION.options} | {"letter_request"}:
            entities["template"] = template
        else:
            questions.append(TEMPLATE_QUESTION)
        preferences["follow_up"] = selections.get("follow_up", "tomorrow")
        toggles = [{"key": "follow_up", "label": "Remind me to follow up tomorrow", "value": preferences["follow_up"] != "none"}]
        default_outcome = "Send a short message and set a reminder to follow up."
        approvals = ["messaging.send"]
        goal_deadline = None
    else:
        raise ValueError("unsupported goal type")

    goal = Goal(
        goal_type=goal_type,  # type: ignore[arg-type]
        outcome=(outcome or default_outcome)[:400],
        deadline=goal_deadline,
        preferences=preferences,
        entities=entities,
        constraints=constraints,
        missing_info=[q.key for q in questions],
        approvals_required=approvals,
        prohibited=PROHIBITED,
        options=options,
    )
    return goal, questions, toggles


async def interpret(request: GoalRequest, profile: dict[str, Any], provider: ReasoningProvider) -> dict[str, Any]:
    selections = dict(request.selections)
    text = " ".join([*request.phrases, request.free_text or ""]).strip()
    notes: list[str] = []
    mode = "deterministic"
    outcome: str | None = None

    if text:
        cloud = await provider.interpret_goal(text, selections, profile) if provider.available else None
        if cloud and cloud.get("goal_type") in {
            "equipment_repair",
            "reschedule_appointment",
            "admin_request",
            "message_followup",
        }:
            mode = "cloud"
            mapped = {
                "goal_type": cloud["goal_type"],
                "issue": cloud.get("issue"),
                "time_of_day": cloud.get("time_of_day") if cloud.get("time_of_day") != "any" else None,
                "check_funding": "true" if cloud.get("check_funding") else None,
                "notify_caregiver": "true" if cloud.get("notify_caregiver") else None,
                "contact_id": cloud.get("contact_id"),
                "template": cloud.get("message_template"),
                "follow_up": cloud.get("follow_up") if cloud.get("follow_up") != "none" else None,
                "form_id": cloud.get("form_id"),
            }
            for key, value in mapped.items():
                if value and key not in selections:
                    selections[key] = str(value)
            if cloud.get("goal_type") == "equipment_repair":
                selections.setdefault("check_funding", "true" if cloud.get("check_funding") else "false")
                selections.setdefault("notify_caregiver", "true" if cloud.get("notify_caregiver") else "false")
            outcome = str(cloud.get("outcome") or "")[:400] or None
            if cloud.get("notes"):
                notes.append(str(cloud["notes"])[:300])
        else:
            if cloud and cloud.get("goal_type") == "unsupported":
                return {
                    "goal": None,
                    "questions": [],
                    "toggles": [],
                    "ready": False,
                    "unsupported": "AGENCY can't do that yet. Choose one of the tasks on screen.",
                    "interpretation": {"mode": "cloud", "notes": [str(cloud.get("notes", ""))[:300]]},
                }
            found = _keyword_selections(text)
            for key, value in found.items():
                selections.setdefault(key, value)
            if found.get("goal_type") == "equipment_repair":
                selections.setdefault("check_funding", "true" if "check_funding" in found else "false")
                selections.setdefault("notify_caregiver", "true" if "notify_caregiver" in found else "false")
            if provider.available:
                notes.append("Cloud interpretation was unavailable, so I matched your words to known tasks.")

    goal_type = request.goal_type or selections.pop("goal_type", None)
    selections.pop("goal_type", None)
    if goal_type not in {"equipment_repair", "reschedule_appointment", "admin_request", "message_followup"}:
        return {
            "goal": None,
            "questions": [],
            "toggles": [],
            "ready": False,
            "unsupported": "I couldn't match that to a task I can do. Please choose one of the tasks on screen.",
            "interpretation": {"mode": mode, "notes": notes},
        }
    goal, questions, toggles = build_goal(goal_type, selections, profile, outcome)
    return {
        "goal": goal.model_dump(),
        "questions": [q.model_dump() for q in questions],
        "toggles": toggles,
        "ready": not questions,
        "selections": selections,
        "interpretation": {"mode": mode, "notes": notes},
    }


def case_title(goal: Goal) -> str:
    if goal.goal_type == "equipment_repair":
        deadline = when((goal.deadline or date.today().isoformat()) + "T09:00").split(",")[0]
        return f"Wheelchair repair before {deadline}"
    if goal.goal_type == "reschedule_appointment":
        return "Move an appointment"
    if goal.goal_type == "admin_request":
        return {"form_paratransit": "Paratransit renewal", "form_placard": "Parking placard renewal"}.get(
            goal.entities.get("form_id", ""), "Administrative request"
        )
    return "Message and follow-up"


async def make_plan(goal: Goal, provider: ReasoningProvider, *, use_cloud: bool = True) -> tuple[PlanDraft, dict[str, Any]]:
    baseline = baseline_plan(goal)
    reasoning: dict[str, Any] = {"mode": "deterministic", "planner": "built-in plan", "notes": []}
    if provider.available and use_cloud:
        catalog = tool_catalog_for(goal.goal_type)
        draft = await provider.draft_plan(goal, baseline, catalog)
        status = provider.status()
        if draft is None:
            reasoning["notes"].append(
                f"Cloud planning was unavailable ({status.get('last_error') or 'no response'}), so I used the built-in plan."
            )
        else:
            try:
                plan, notes = validate_plan(draft, goal.goal_type)
                return plan, {
                    "route": status.get("route"),
                    "mode": "cloud",
                    "planner": f"{status.get('label') or 'the cloud model'} ({status.get('model')}), "
                    "checked by AGENCY's plan validator",
                    "label": status.get("label"),
                    "model": status.get("model"),
                    "rationale": draft.rationale,
                    "notes": notes,
                }
            except PlanValidationError as exc:
                reasoning["notes"].append(
                    "The cloud plan didn't pass AGENCY's safety checks ("
                    + "; ".join(exc.problems[:3])
                    + "), so I used the built-in plan."
                )
    elif not provider.available:
        reasoning["notes"].append("Deterministic demo mode: no cloud model is configured.")
    route = provider.status().get("route") if provider.available and use_cloud else None
    if route:
        reasoning["route"] = route
        if route.get("decision") == "built-in":
            reasoning["notes"] = [n for n in reasoning["notes"] if not n.startswith("Cloud planning was unavailable")]
            reasoning["notes"].append(str(route.get("note")))
    plan, notes = validate_plan(baseline, goal.goal_type)
    reasoning["notes"].extend(notes)
    return plan, reasoning
