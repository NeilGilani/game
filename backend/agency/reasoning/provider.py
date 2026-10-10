"""Optional cloud reasoning.

AGENCY works fully without a model: the deterministic planner and interpreter in
``agency.planning`` handle every supported goal. When ANTHROPIC_API_KEY is set, the
Anthropic provider is used for three narrow jobs:

1. interpreting a typed or phrase-built goal into the structured Goal model,
2. adapting the built-in plan to that goal (the result must pass the same validator),
3. explaining an action or a failure in plain language.

What is sent: the goal text and selections, the fictional demo profile summary, the tool
catalog and the built-in plan. Never camera frames, face or eye landmarks, or calibration
data. Model output never decides whether an action happened: only tool responses and
verification against the services' records do.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

from pydantic import ValidationError

from ..db import utcnow
from ..models import Goal, PlanDraft, Question, StepDraft
from ..tools.catalog import TEMPLATES as MESSAGE_TEMPLATES

log = logging.getLogger("agency.reasoning")

ISSUES = ["battery", "controls", "wheel", "seating", "other"]
GOAL_TYPES = ["equipment_repair", "reschedule_appointment", "admin_request", "message_followup"]


def _nullable_enum(values: list[str]) -> dict[str, Any]:
    return {"anyOf": [{"type": "string", "enum": values}, {"type": "null"}]}


GOAL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "goal_type": {"type": "string", "enum": GOAL_TYPES + ["unsupported"]},
        "outcome": {"type": "string"},
        "issue": _nullable_enum(ISSUES),
        "time_of_day": {"type": "string", "enum": ["morning", "afternoon", "any"]},
        "check_funding": {"type": "boolean"},
        "notify_caregiver": {"type": "boolean"},
        "contact_id": _nullable_enum(["c_jordan", "c_clinic"]),
        "message_template": _nullable_enum(sorted(MESSAGE_TEMPLATES)),
        "follow_up": {"type": "string", "enum": ["tomorrow", "in_3_days", "none"]},
        "form_id": _nullable_enum(["form_paratransit", "form_placard"]),
        "notes": {"type": "string"},
    },
    "required": [
        "goal_type",
        "outcome",
        "issue",
        "time_of_day",
        "check_funding",
        "notify_caregiver",
        "contact_id",
        "message_template",
        "follow_up",
        "form_id",
        "notes",
    ],
    "additionalProperties": False,
}


def plan_schema(tool_names: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "rationale": {"type": "string"},
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "title": {"type": "string"},
                        "description": {"type": "string"},
                        "tool": {"type": "string", "enum": tool_names},
                        "inputs_json": {"type": "string"},
                        "depends_on": {"type": "array", "items": {"type": "string"}},
                        "approval": {"type": "string", "enum": ["none", "required"]},
                        "optional": {"type": "boolean"},
                        "expected_output": {"type": "string"},
                        "question_json": {"type": "string"},
                    },
                    "required": [
                        "id",
                        "title",
                        "description",
                        "tool",
                        "inputs_json",
                        "depends_on",
                        "approval",
                        "optional",
                        "expected_output",
                        "question_json",
                    ],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["rationale", "steps"],
        "additionalProperties": False,
    }


EXPLAIN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"paragraphs": {"type": "array", "items": {"type": "string"}}},
    "required": ["paragraphs"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You are the reasoning component of AGENCY, an accessibility-first assistant that helps \
people with severe motor disabilities finish multi-step digital tasks with very little physical input.

How you fit in:
- The person chooses a goal with a few large selections (eye gaze, switch scanning, or a keyboard). You turn that \
into structured data. A separate, deterministic executor runs every action, asks the person to approve anything \
consequential, and verifies results against each service's own records. You never run actions yourself.
- Every integration is a local demonstration service (Demo Repair Provider, Demo Funding Service, Demo Calendar, \
Demo Messaging Service). Nothing reaches a real company, office or person.

Rules:
- Use only the tools listed. If the goal needs something the tools can't do, say so in your notes or rationale.
- Never claim an outcome. Funding is never "approved" or "guaranteed"; bookings are not confirmed until verified.
- Write titles and descriptions in short, plain, respectful language, addressed to the person ("your wheelchair").
- Ask only for information that is genuinely missing. Fewer questions are better: each answer costs physical effort.
"""


class ReasoningProvider(Protocol):
    def status(self) -> dict[str, Any]: ...

    @property
    def available(self) -> bool: ...

    async def interpret_goal(
        self, request_text: str, selections: dict[str, str], profile: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def draft_plan(self, goal: Goal, baseline: PlanDraft, catalog: list[dict[str, Any]]) -> PlanDraft | None: ...

    async def explain(self, topic: dict[str, Any]) -> list[str] | None: ...

    async def check(self) -> dict[str, Any]: ...


@dataclass
class DisabledProvider:
    """Used when no API key is configured or cloud reasoning is switched off."""

    reason: str = "No cloud model is configured (ANTHROPIC_API_KEY is not set)."

    @property
    def available(self) -> bool:
        return False

    def status(self) -> dict[str, Any]:
        return {
            "mode": "deterministic",
            "provider": None,
            "model": None,
            "state": "not_configured",
            "description": "Deterministic demo mode: built-in plans and rules. " + self.reason,
            "last_ok_at": None,
            "last_error": None,
            "calls": 0,
        }

    async def interpret_goal(
        self, request_text: str, selections: dict[str, str], profile: dict[str, Any]
    ) -> dict[str, Any] | None:
        return None

    async def draft_plan(self, goal: Goal, baseline: PlanDraft, catalog: list[dict[str, Any]]) -> PlanDraft | None:
        return None

    async def explain(self, topic: dict[str, Any]) -> list[str] | None:
        return None

    async def check(self) -> dict[str, Any]:
        return self.status()


@dataclass
class AnthropicProvider:
    model: str
    effort: str = "medium"
    use_fallbacks: bool = True
    timeout_s: float = 45.0
    client: Any = None
    calls: int = 0
    last_ok_at: str | None = None
    last_error: str | None = None
    last_error_at: str | None = None
    state: str = "configured"
    history: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.client is None:
            import anthropic

            self.client = anthropic.AsyncAnthropic(timeout=self.timeout_s, max_retries=1)

    @property
    def available(self) -> bool:
        return True

    def status(self) -> dict[str, Any]:
        descriptions = {
            "configured": f"Cloud reasoning configured ({self.model}); not used yet in this session.",
            "ok": f"Cloud reasoning active ({self.model}). Last call succeeded.",
            "error": f"Cloud reasoning configured ({self.model}) but the last call failed, so AGENCY used its built-in "
            f"plans: {self.last_error}",
        }
        return {
            "mode": "cloud" if self.state != "error" else "cloud_degraded",
            "provider": "anthropic",
            "model": self.model,
            "state": self.state,
            "description": descriptions.get(self.state, self.state),
            "last_ok_at": self.last_ok_at,
            "last_error": self.last_error,
            "last_error_at": self.last_error_at,
            "calls": self.calls,
        }

    def _record(self, ok: bool, purpose: str, error: str | None = None) -> None:
        self.calls += 1
        if ok:
            self.state = "ok"
            self.last_ok_at = utcnow()
        else:
            self.state = "error"
            self.last_error = error
            self.last_error_at = utcnow()
        self.history = (self.history + [{"at": utcnow(), "purpose": purpose, "ok": ok, "error": error}])[-20:]

    async def _call_json(
        self, purpose: str, user: str, schema: dict[str, Any], *, effort: str | None = None, max_tokens: int = 16000
    ) -> dict[str, Any] | None:
        import anthropic

        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user}],
            "output_config": {"effort": effort or self.effort, "format": {"type": "json_schema", "schema": schema}},
            "cache_control": {"type": "ephemeral"},
        }
        if self.use_fallbacks:
            kwargs["betas"] = ["server-side-fallback-2026-07-01"]
            kwargs["fallbacks"] = "default"
        try:
            response = await self.client.beta.messages.create(**kwargs)
        except anthropic.AuthenticationError:
            self._record(False, purpose, "the API key was rejected")
            return None
        except anthropic.PermissionDeniedError:
            self._record(False, purpose, "the API key lacks permission for this model")
            return None
        except anthropic.NotFoundError:
            self._record(False, purpose, f"model {self.model} was not found")
            return None
        except anthropic.RateLimitError:
            self._record(False, purpose, "rate limited")
            return None
        except anthropic.BadRequestError as exc:
            self._record(False, purpose, f"request rejected: {exc.message}"[:200])
            return None
        except anthropic.APIStatusError as exc:
            self._record(False, purpose, f"service error {exc.status_code}")
            return None
        except anthropic.APIConnectionError:
            self._record(False, purpose, "could not reach the API (network)")
            return None
        if getattr(response, "stop_reason", None) == "refusal":
            self._record(False, purpose, "the model declined this request")
            return None
        if getattr(response, "stop_reason", None) == "max_tokens":
            self._record(False, purpose, "the response was cut off")
            return None
        text = next((b.text for b in response.content if getattr(b, "type", None) == "text"), None)
        if not text:
            self._record(False, purpose, "empty response")
            return None
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            self._record(False, purpose, "response was not valid JSON")
            return None
        if not isinstance(data, dict):
            self._record(False, purpose, "response was not an object")
            return None
        self._record(True, purpose)
        return data

    async def interpret_goal(
        self, request_text: str, selections: dict[str, str], profile: dict[str, Any]
    ) -> dict[str, Any] | None:
        user = (
            "Interpret this request into structured fields.\n\n"
            f"Request (typed or built from phrase buttons): {json.dumps(request_text)}\n"
            f"Selections already made: {json.dumps(selections)}\n"
            f"Demo profile summary (fictional): device={profile.get('device', {}).get('label')}, "
            f"caregiver contact id c_jordan (Jordan), clinic contact id c_clinic, "
            f"default time preference {profile.get('preferences', {}).get('time_of_day', 'any')}, "
            f"deadline for 'before Friday' = {profile.get('demo_deadline')}.\n\n"
            "Goal types: equipment_repair (wheelchair or mobility device repair, optionally a funding inquiry and a "
            "caregiver message), reschedule_appointment, admin_request (paratransit renewal form_paratransit or parking "
            "placard form_placard), message_followup (send a short message from a template and set a follow-up reminder). "
            "Use 'unsupported' if none fit. For fields that don't apply, use null, 'any', false or 'none'. "
            "Set check_funding true only if they mention cost, money, funding, insurance or assistance; set "
            "notify_caregiver true if they mention their caregiver or Jordan. 'outcome' is one plain sentence in the "
            "second person describing what they want."
        )
        return await self._call_json("interpret_goal", user, GOAL_SCHEMA, effort="low", max_tokens=4000)

    async def draft_plan(self, goal: Goal, baseline: PlanDraft, catalog: list[dict[str, Any]]) -> PlanDraft | None:
        tools = sorted({c["name"] for c in catalog} | {"user.ask"})
        user = (
            "Adapt the built-in plan below to this person's goal. Keep it executable.\n\n"
            f"GOAL:\n{goal.model_dump_json(indent=2)}\n\n"
            f"TOOLS (only these may be used; 'user.ask' asks the person a multiple-choice question):\n{json.dumps(catalog, indent=1)}\n\n"
            f"BUILT-IN PLAN:\n{baseline.model_dump_json(indent=1)}\n\n"
            "Output rules:\n"
            "- Return steps in execution order. depends_on may only name earlier steps.\n"
            '- inputs_json is a JSON object string. To use an earlier step\'s result write {"$ref": "<step_id>.<key>..."} '
            'and list that step in depends_on; for text built from results use {"$fmt": "text {0}", "args": ["<step_id>.<key>"]}.\n'
            '- question_json is "" unless the tool is user.ask, in which case it is a JSON object '
            '{"key", "prompt", "options": [{"value", "label", "description"}]} with 2 to 6 options.\n'
            "- Do not add the final 'verify_all' or 'save_notes' steps; AGENCY adds them.\n"
            "- Keep the built-in step ids where you keep a step. Remove steps the person clearly doesn't want; rewrite "
            "titles and descriptions so they speak to this person's situation.\n"
            '- Any action that changes something outside AGENCY must have approval "required".'
        )
        data = await self._call_json("draft_plan", user, plan_schema(tools))
        if data is None:
            return None
        try:
            steps = []
            for raw in data.get("steps", []):
                question = None
                if raw.get("question_json"):
                    question = Question.model_validate(json.loads(raw["question_json"]))
                steps.append(
                    StepDraft(
                        id=raw["id"],
                        title=raw["title"],
                        description=raw["description"],
                        tool=raw["tool"],
                        inputs=json.loads(raw["inputs_json"] or "{}"),
                        depends_on=raw["depends_on"],
                        approval=raw["approval"],
                        optional=raw["optional"],
                        expected_output=raw["expected_output"][:240],
                        question=question,
                    )
                )
            return PlanDraft(steps=steps, rationale=str(data.get("rationale", ""))[:800])
        except (ValidationError, json.JSONDecodeError, KeyError, TypeError) as exc:
            self._record(False, "draft_plan", f"plan did not match the required structure ({type(exc).__name__})")
            return None

    async def explain(self, topic: dict[str, Any]) -> list[str] | None:
        user = (
            "Explain this to the person in 2 or 3 short paragraphs of plain language: what will happen, why AGENCY "
            "is asking, and what happens if they say no. Mention that it uses a demonstration service. Do not add "
            "facts that are not in the data. Data:\n" + json.dumps(topic, indent=1, default=str)
        )
        data = await self._call_json("explain", user, EXPLAIN_SCHEMA, effort="low", max_tokens=2000)
        if not data:
            return None
        paragraphs = [str(p)[:600] for p in data.get("paragraphs", []) if str(p).strip()]
        return paragraphs[:4] or None

    async def check(self) -> dict[str, Any]:
        """Cheap credential check: retrieve the model's metadata (no tokens generated)."""
        import anthropic

        try:
            await self.client.models.retrieve(self.model)
            self._record(True, "check")
        except anthropic.AuthenticationError:
            self._record(False, "check", "the API key was rejected")
        except anthropic.NotFoundError:
            self._record(False, "check", f"model {self.model} was not found")
        except anthropic.APIStatusError as exc:
            self._record(False, "check", f"service error {exc.status_code}")
        except anthropic.APIConnectionError:
            self._record(False, "check", "could not reach the API (network)")
        return self.status()


def build_provider(reasoning: str, model: str, effort: str, fallbacks: bool, timeout_s: float) -> ReasoningProvider:
    if reasoning in {"deterministic", "off", "demo"}:
        return DisabledProvider(reason="Cloud reasoning is switched off (AGENCY_REASONING=deterministic).")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return DisabledProvider()
    try:
        return AnthropicProvider(model=model, effort=effort, use_fallbacks=fallbacks, timeout_s=timeout_s)
    except Exception as exc:  # pragma: no cover - SDK import problems
        log.warning("could not start the Anthropic client: %s", exc)
        return DisabledProvider(reason=f"The Anthropic client could not start ({type(exc).__name__}).")
