"""Optional cloud reasoning.

AGENCY works fully without a model: the deterministic planner and interpreter in
``agency.planning`` handle every supported goal. When a cloud model is configured (Google
Gemini with GEMINI_API_KEY, or Anthropic Claude with ANTHROPIC_API_KEY), it is used for three
narrow jobs:

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
from pathlib import Path
from typing import Any, ClassVar, Protocol

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

    reason: str = "No cloud model is configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY to add one)."

    @property
    def available(self) -> bool:
        return False

    def status(self) -> dict[str, Any]:
        return {
            "mode": "deterministic",
            "provider": None,
            "label": None,
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
class CloudProvider:
    """What every cloud model shares: the prompts, the response parsing, and the status record.

    Subclasses only implement ``_call_json`` (one structured-output request) and ``check``.
    """

    model: str
    effort: str = "medium"
    timeout_s: float = 45.0
    client: Any = None
    calls: int = 0
    last_ok_at: str | None = None
    last_error: str | None = None
    last_error_at: str | None = None
    state: str = "configured"
    history: list[dict[str, Any]] = field(default_factory=list)
    # Set per request by the Synapse layer (agency/synapse.py): the weighted expert lenses for this request.
    expert_brief: str = ""
    # Set per request by the Synapse layer: "fast" for everyday requests (a quick model first), "deep" otherwise.
    lane: str = "deep"
    # The model that answered the last successful request (a fast-lane or fallback model may stand in).
    last_model: str | None = None

    name: ClassVar[str] = "cloud"
    label: ClassVar[str] = "Cloud model"

    @property
    def available(self) -> bool:
        return True

    def status(self) -> dict[str, Any]:
        descriptions = {
            "configured": f"Cloud reasoning configured ({self.label}, {self.model}); not used yet in this session.",
            "ok": f"Cloud reasoning active ({self.label}, {self.model}). Last call succeeded.",
            "error": f"Cloud reasoning configured ({self.label}, {self.model}) but the last call failed, so AGENCY "
            f"used its built-in plans: {self.last_error}",
        }
        return {
            "mode": "cloud" if self.state != "error" else "cloud_degraded",
            "provider": self.name,
            "label": self.label,
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

    def system_prompt(self) -> str:
        return f"{SYSTEM_PROMPT}\n{self.expert_brief}\n" if self.expert_brief else SYSTEM_PROMPT

    def _parse_object(self, purpose: str, text: str | None) -> dict[str, Any] | None:
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

    async def _call_json(
        self, purpose: str, user: str, schema: dict[str, Any], *, effort: str | None = None, max_tokens: int = 16000
    ) -> dict[str, Any] | None:
        raise NotImplementedError

    async def check(self) -> dict[str, Any]:
        raise NotImplementedError

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


@dataclass
class AnthropicProvider(CloudProvider):
    use_fallbacks: bool = True

    name: ClassVar[str] = "anthropic"
    label: ClassVar[str] = "Claude"

    def __post_init__(self) -> None:
        if self.client is None:
            import anthropic

            self.client = anthropic.AsyncAnthropic(timeout=self.timeout_s, max_retries=1)

    async def _call_json(
        self, purpose: str, user: str, schema: dict[str, Any], *, effort: str | None = None, max_tokens: int = 16000
    ) -> dict[str, Any] | None:
        import anthropic

        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": self.system_prompt(),
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
        return self._parse_object(purpose, text)

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


# Gemini's thinking levels (ai.google.dev/gemini-api/docs/thinking). Gemini 3 Flash models accept
# low, medium and high; older models use a token budget instead, so no level is sent to them.
_THINKING_LEVELS = {"low": "LOW", "medium": "MEDIUM", "high": "HIGH", "xhigh": "HIGH", "max": "HIGH"}
_GEMINI_BLOCKED = {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"}


def gemini_api_key() -> str | None:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or None


# Synapse's fast lane: everyday requests (a short plan, replies, a sentence ending) go to Flash-Lite first, which
# answers in about a second. If a model is busy or rate limited, the other one answers at once instead of a retry.
GEMINI_FAST_MODEL = "gemini-3.5-flash-lite"
# A busy or limited model: move on to the next one immediately.
_GEMINI_BUSY = {429, 500, 502, 503, 504}
MIN_DEADLINE_S = 10.0  # the API refuses deadlines under 10 s ("Minimum allowed deadline is 10s")
FAST_TIMEOUT_S = MIN_DEADLINE_S


@dataclass
class GeminiProvider(CloudProvider):
    """Google Gemini through the official ``google-genai`` SDK, with JSON-schema structured output."""

    name: ClassVar[str] = "google"
    label: ClassVar[str] = "Gemini"
    fast_model: str = field(default_factory=lambda: os.environ.get("AGENCY_GEMINI_FAST_MODEL") or GEMINI_FAST_MODEL)
    fast_client: Any = None
    # A model that failed for a reason of its own (not found, request rejected) while the other model answered:
    # shown in the status so a configuration mistake is never hidden by the fallback.
    model_problems: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.client is not None and self.fast_client is None:
            self.fast_client = self.client  # a client handed in (tests) serves both lanes
        if self.client is None:
            from google import genai
            from google.genai import types

            self.client = genai.Client(
                api_key=gemini_api_key(),
                http_options=types.HttpOptions(
                    timeout=int(max(self.timeout_s, MIN_DEADLINE_S) * 1000),  # milliseconds
                    retry_options=types.HttpRetryOptions(attempts=2),
                ),
            )
        if self.fast_client is None:
            from google import genai
            from google.genai import types

            # No retries and a short timeout: on any trouble the other model answers instead.
            self.fast_client = genai.Client(
                api_key=gemini_api_key(),
                http_options=types.HttpOptions(
                    timeout=int(FAST_TIMEOUT_S * 1000),
                    retry_options=types.HttpRetryOptions(attempts=1),
                ),
            )

    def status(self) -> dict[str, Any]:
        out = super().status()
        if self.model_problems:
            problems = "; ".join(f"{m}: {e}" for m, e in self.model_problems.items())
            out["model_problems"] = dict(self.model_problems)
            out["description"] += f" Check the model settings ({problems}); the other model answered instead."
        return out

    def _config(
        self,
        schema: dict[str, Any] | None,
        effort: str | None,
        max_tokens: int,
        model: str | None = None,
        system: str | None = None,
    ) -> Any:
        from google.genai import types

        config = types.GenerateContentConfig(
            system_instruction=system if system is not None else self.system_prompt(),
            response_mime_type="application/json",
            response_json_schema=schema,
            # Gemini counts thinking tokens against this limit, so leave room beyond the answer itself.
            max_output_tokens=max_tokens * 2,
        )
        level = _THINKING_LEVELS.get(effort or self.effort)
        if level and (model or self.model).startswith("gemini-3"):
            config.thinking_config = types.ThinkingConfig(thinking_level=types.ThinkingLevel(level))
        return config

    def _api_error(self, exc: Exception, model: str | None = None) -> str:
        from google.genai import errors

        if not isinstance(exc, errors.APIError):
            return "could not reach the API (network)"
        code = exc.code
        message = str(exc.message or "")
        if code == 401 or (code == 400 and "api key" in message.lower()):
            return "the API key was rejected"
        if code == 403:
            return "the API key lacks permission for this model"
        if code == 404:
            return f"model {model or self.model} was not found"
        if code == 429:
            return "rate limited"
        if code == 400:
            return f"request rejected: {message}"[:200]
        return f"service error {code}"

    @staticmethod
    def _key_problem(exc: Exception) -> bool:
        """An error every model would give (the key itself): no point asking the other model."""
        from google.genai import errors

        if not isinstance(exc, errors.APIError):
            return False
        return exc.code in (401, 403) or (exc.code == 400 and "api key" in str(exc.message or "").lower())

    async def _call_json(
        self, purpose: str, user: str, schema: dict[str, Any], *, effort: str | None = None, max_tokens: int = 16000
    ) -> dict[str, Any] | None:
        import httpx
        from google.genai import errors

        # The Synapse layer sets the lane, effort and expert lenses per request: read them once, before the first
        # await, so a request that runs at the same time can't change them halfway through a fallback.
        lane, effort, system = self.lane, effort or self.effort, self.system_prompt()
        # Fast lane: the quick model, then the main one. Otherwise the main model, then the quick one.
        order = [self.fast_model, self.model] if lane == "fast" else [self.model, self.fast_model]
        order = list(dict.fromkeys(m for m in order if m))
        response, answered_by, failures = None, None, []
        for i, model in enumerate(order):
            last = i == len(order) - 1
            client = self.client if (model == self.model and lane != "fast") else self.fast_client
            try:
                response = await client.aio.models.generate_content(
                    model=model, contents=user, config=self._config(schema, effort, max_tokens, model, system)
                )
                answered_by = model
                break
            except (errors.APIError, httpx.HTTPError, OSError, TimeoutError) as exc:
                problem = self._api_error(exc, model)
                failures.append(problem)
                busy = not isinstance(exc, errors.APIError) or exc.code in _GEMINI_BUSY
                if not busy and not self._key_problem(exc):
                    # This model's own problem (not found, request rejected): the other model may still answer,
                    # but the mistake stays visible in the status until this model works again.
                    self.model_problems[model] = problem
                    log.warning("Gemini model %s failed (%s); trying the other model", model, problem)
                if last or self._key_problem(exc):
                    self._record(False, purpose, "; ".join(dict.fromkeys(failures)))
                    return None
        if response is None or answered_by is None:
            return None
        feedback = getattr(response, "prompt_feedback", None)
        if feedback is not None and getattr(feedback, "block_reason", None):
            self._record(False, purpose, "the model declined this request")
            return None
        candidates = getattr(response, "candidates", None) or []
        finish = getattr(getattr(candidates[0], "finish_reason", None), "name", None) if candidates else None
        if finish in _GEMINI_BLOCKED:
            self._record(False, purpose, "the model declined this request")
            return None
        if finish == "MAX_TOKENS":
            self._record(False, purpose, "the response was cut off")
            return None
        data = self._parse_object(purpose, response.text)
        if data is not None:
            self.last_model = answered_by
            self.model_problems.pop(answered_by, None)
        return data

    async def check(self) -> dict[str, Any]:
        """Cheap credential check: read the model's metadata (no tokens generated)."""
        import httpx
        from google.genai import errors

        try:
            await self.client.aio.models.get(model=self.model)
            self._record(True, "check")
        except (errors.APIError, httpx.HTTPError, OSError, TimeoutError) as exc:
            self._record(False, "check", self._api_error(exc))
        return self.status()


def build_provider(
    reasoning: str,
    *,
    gemini_model: str,
    anthropic_model: str,
    effort: str = "medium",
    fallbacks: bool = True,
    timeout_s: float = 45.0,
    relay_url: str | None = None,
    identity_dir: Path | None = None,
) -> ReasoningProvider:
    """Pick the cloud model from AGENCY_REASONING and the keys present.

    auto: Gemini when GEMINI_API_KEY (or GOOGLE_API_KEY) is set, else Claude when ANTHROPIC_API_KEY
    is set, else Gemini through AGENCY Cloud (``relay_url``; AGENCY_RELAY=off leaves it None), else the
    deterministic built-in plans. gemini: a local key, else AGENCY Cloud. anthropic: only Claude.
    """
    if reasoning in {"deterministic", "off", "demo"}:
        return DisabledProvider(reason="Cloud reasoning is switched off (AGENCY_REASONING=deterministic).")
    want_gemini = reasoning in {"auto", "gemini", "google"}
    want_anthropic = reasoning in {"auto", "anthropic", "claude"}
    if not want_gemini and not want_anthropic:
        return DisabledProvider(reason=f"Unknown AGENCY_REASONING value {reasoning!r}; use auto, gemini or anthropic.")
    try:
        if want_gemini and gemini_api_key():
            return GeminiProvider(model=gemini_model, effort=effort, timeout_s=timeout_s)
        if want_anthropic and os.environ.get("ANTHROPIC_API_KEY"):
            return AnthropicProvider(model=anthropic_model, effort=effort, use_fallbacks=fallbacks, timeout_s=timeout_s)
        if want_gemini and relay_url:
            # No key of their own: Gemini on AGENCY's key, through AGENCY Cloud (reasoning/cloud.py).
            from .cloud import AgencyCloud, AgencyCloudProvider, default_store

            cloud = AgencyCloud(relay_url, default_store(identity_dir))
            return AgencyCloudProvider(model=gemini_model, effort=effort, timeout_s=timeout_s, cloud=cloud)
    except Exception as exc:  # pragma: no cover - SDK import problems
        log.warning("could not start the cloud model client: %s", exc)
        return DisabledProvider(reason=f"The cloud model client could not start ({type(exc).__name__}).")
    if reasoning in {"gemini", "google"}:
        return DisabledProvider(reason="AGENCY_REASONING=gemini but GEMINI_API_KEY is not set and AGENCY Cloud is off.")
    if reasoning in {"anthropic", "claude"}:
        return DisabledProvider(reason="AGENCY_REASONING=anthropic but ANTHROPIC_API_KEY is not set.")
    if not relay_url:
        return DisabledProvider(
            reason="AGENCY Cloud is switched off (AGENCY_RELAY=off) and no GEMINI_API_KEY or ANTHROPIC_API_KEY is set."
        )
    return DisabledProvider()
