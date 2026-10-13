"""The Google Gemini provider, run through the real google-genai SDK against a fake HTTP transport.

No network and no credentials: every request the SDK would send is captured by an
``httpx.MockTransport`` and answered with a canned Gemini API response, so these tests check the
actual wire format (endpoint, key header, structured-output config) as well as AGENCY's handling.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from google import genai
from google.genai import types

from agency.reasoning.provider import (
    GEMINI_BACKUP_MODEL,
    AnthropicProvider,
    DisabledProvider,
    GeminiProvider,
    build_provider,
)
from conftest import make_client, start_repair, step, tune
from test_api_and_provider import plan_from_baseline

MODEL = "gemini-3.8-flash"
KEY = "test-gemini-key-not-real"


def reply(data: Any, finish: str = "STOP") -> httpx.Response:
    text = data if isinstance(data, str) else json.dumps(data)
    return httpx.Response(
        200,
        json={
            "candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": finish}],
            "modelVersion": MODEL,
        },
    )


def api_error(code: int, status: str, message: str) -> httpx.Response:
    return httpx.Response(code, json={"error": {"code": code, "message": message, "status": status}})


class FakeGemini:
    """Answers the SDK's HTTP requests. ``responder(body)`` returns a dict (the model's JSON answer),
    an ``httpx.Response``, or raises (for example ``httpx.ConnectError``)."""

    def __init__(self, responder: Any) -> None:
        self.responder = responder
        self.requests: list[httpx.Request] = []
        self.bodies: list[dict[str, Any]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "GET":  # models.get, used by the credential check
            result = self.responder(None)
            return result if isinstance(result, httpx.Response) else httpx.Response(200, json={"name": f"models/{MODEL}"})
        body = json.loads(request.content)
        self.bodies.append(body)
        result = self.responder(body)
        return result if isinstance(result, httpx.Response) else reply(result)

    def provider(self) -> GeminiProvider:
        client = genai.Client(
            api_key=KEY,
            http_options=types.HttpOptions(httpx_async_client=httpx.AsyncClient(transport=httpx.MockTransport(self.handle))),
        )
        return GeminiProvider(model=MODEL, client=client)


def schema_of(body: dict[str, Any]) -> dict[str, Any]:
    return body["generationConfig"]["responseJsonSchema"]


def gemini_client(tmp_path: Path, responder: Any) -> tuple[TestClient, FakeGemini]:
    fake = FakeGemini(responder)
    return make_client(tmp_path, provider=fake.provider()), fake


def interpret_repair(c: TestClient) -> dict[str, Any]:
    preview = c.post("/api/goals/interpret", json={"goal_type": "equipment_repair", "selections": {"issue": "battery"}}).json()
    assert preview["ready"]
    return preview


def test_gemini_plan_is_used_when_valid(tmp_path: Path) -> None:
    holder: dict[str, Any] = {}

    def responder(body: dict[str, Any]) -> Any:
        assert "steps" in schema_of(body)["properties"]
        plan = plan_from_baseline(holder["goal"], drop={"get_policy", "check_documents", "prepare_inquiry", "submit_inquiry"})
        for s in plan["steps"]:
            if s["id"] == "book_repair":
                s["approval"] = "none"  # the validator must force this back to "required"
        return plan

    c, fake = gemini_client(tmp_path, responder)
    with c:
        tune(c)
        holder["goal"] = interpret_repair(c)["goal"]
        case = c.post("/api/cases", json={"goal": holder["goal"]}).json()
        assert case["reasoning"]["mode"] == "cloud"
        assert case["reasoning"]["label"] == "Gemini"
        assert case["reasoning"]["planner"].startswith(f"Gemini ({MODEL})")
        assert [s["id"] for s in case["steps"]][-2:] == ["verify_all", "save_notes"]
        assert "submit_inquiry" not in {s["id"] for s in case["steps"]}
        assert step(case, "book_repair")["approval"] == "required"
        assert step(case, "book_repair")["status"] == "awaiting_approval"

        health = c.get("/api/health").json()["reasoning"]
        assert (health["provider"], health["label"], health["model"], health["state"]) == ("google", "Gemini", MODEL, "ok")

    # What actually went over the wire.
    request = fake.requests[0]
    assert request.method == "POST"
    assert str(request.url) == f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    assert request.headers["x-goog-api-key"] == KEY  # the key travels in a header, never in the URL
    assert KEY not in str(request.url)
    body = fake.bodies[0]
    config = body["generationConfig"]
    assert config["responseMimeType"] == "application/json"
    assert config["responseJsonSchema"]["required"] == ["rationale", "steps"]
    assert config["thinkingConfig"] == {"thinking_level": "MEDIUM"}
    assert "AGENCY" in body["systemInstruction"]["parts"][0]["text"]
    sent = json.dumps(body)
    assert "BUILT-IN PLAN" in sent
    for private in ("landmark", "calibration", "iris", "frame"):
        assert private not in sent.lower()  # no camera or eye data ever goes to the model


def test_gemini_plan_with_forbidden_tool_falls_back_to_builtin(tmp_path: Path) -> None:
    holder: dict[str, Any] = {}

    def responder(body: dict[str, Any]) -> Any:
        def sneak(data: dict[str, Any]) -> None:
            data["steps"].append(
                {
                    "id": "pay",
                    "title": "Pay the technician",
                    "description": "Pay now",
                    "tool": "calendar.reschedule",
                    "inputs_json": "{}",
                    "depends_on": [],
                    "approval": "none",
                    "optional": False,
                    "expected_output": "",
                    "question_json": "",
                }
            )

        return plan_from_baseline(holder["goal"], mutate=sneak)

    c, _ = gemini_client(tmp_path, responder)
    with c:
        tune(c)
        holder["goal"] = interpret_repair(c)["goal"]
        case = c.post("/api/cases", json={"goal": holder["goal"]}).json()
        assert case["reasoning"]["mode"] == "deterministic"
        assert any("safety checks" in n for n in case["reasoning"]["notes"])
        assert "pay" not in {s["id"] for s in case["steps"]}


def connection_refused(body: Any) -> Any:
    raise httpx.ConnectError("connection refused")


@pytest.mark.parametrize(
    ("respond", "reported"),
    [
        (
            lambda b: api_error(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key."),
            "the API key was rejected",
        ),
        (lambda b: api_error(403, "PERMISSION_DENIED", "Permission denied."), "the API key lacks permission for this model"),
        (lambda b: api_error(404, "NOT_FOUND", "models/x is not found."), f"model {MODEL} was not found"),
        (lambda b: api_error(429, "RESOURCE_EXHAUSTED", "Quota exceeded."), "rate limited"),
        (lambda b: api_error(503, "UNAVAILABLE", "The model is overloaded."), "service error 503"),
        (lambda b: api_error(400, "INVALID_ARGUMENT", "Schema too deep."), "request rejected: Schema too deep."),
        (connection_refused, "could not reach the API (network)"),
    ],
)
def test_gemini_errors_fall_back_and_are_reported(tmp_path: Path, respond: Any, reported: str) -> None:
    c, _ = gemini_client(tmp_path, respond)
    with c:
        tune(c)
        case = start_repair(c)
        assert case["reasoning"]["mode"] == "deterministic"
        assert any("unavailable" in n and reported in n for n in case["reasoning"]["notes"])
        assert case["status"] == "waiting_approval"  # the workflow itself is unaffected
        health = c.get("/api/health").json()["reasoning"]
        assert health["mode"] == "cloud_degraded" and health["state"] == "error"
        assert "built-in" in health["description"] and reported in health["description"]


@pytest.mark.parametrize(
    ("response", "reported"),
    [
        (reply({"paragraphs": ["x"]}, finish="SAFETY"), "the model declined this request"),
        (reply({"paragraphs": ["x"]}, finish="MAX_TOKENS"), "the response was cut off"),
        (httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}}), "the model declined this request"),
        (reply("not json at all"), "response was not valid JSON"),
        (reply(["a", "list"]), "response was not an object"),
        (reply(""), "empty response"),
    ],
)
def test_gemini_unusable_responses_are_rejected(response: httpx.Response, reported: str) -> None:
    provider = FakeGemini(lambda body: response).provider()
    assert asyncio.run(provider.explain({"headline": "Book a repair"})) is None
    status = provider.status()
    assert status["state"] == "error" and status["last_error"] == reported


def test_gemini_interpretation_and_labelled_explanation(tmp_path: Path) -> None:
    def responder(body: dict[str, Any]) -> Any:
        props = schema_of(body)["properties"]
        if "goal_type" in props:
            # The nullable fields use anyOf, which Gemini's JSON-schema support accepts.
            assert props["issue"]["anyOf"][1] == {"type": "null"}
            assert body["generationConfig"]["thinkingConfig"] == {"thinking_level": "LOW"}
            assert "Friday" in body["contents"][0]["parts"][0]["text"]
            return {
                "goal_type": "equipment_repair",
                "outcome": "Get your wheelchair fixed before Friday and tell Jordan.",
                "issue": "controls",
                "time_of_day": "afternoon",
                "check_funding": True,
                "notify_caregiver": True,
                "contact_id": None,
                "message_template": None,
                "follow_up": "none",
                "form_id": None,
                "notes": "",
            }
        if "paragraphs" in props:
            return {"paragraphs": ["This books a repair time with the demo provider.", "  "]}
        return httpx.Response(503, json={"error": {"code": 503, "message": "busy", "status": "UNAVAILABLE"}})

    c, _ = gemini_client(tmp_path, responder)
    with c:
        tune(c)
        preview = c.post(
            "/api/goals/interpret",
            json={"free_text": "Fix my wheelchair before Friday, check if there's help paying, and tell my caregiver."},
        ).json()
        assert preview["interpretation"]["mode"] == "cloud"
        assert preview["goal"]["entities"]["issue"] == "controls"
        assert preview["goal"]["options"] == {"check_funding": True, "notify_caregiver": True}
        case = c.post("/api/cases", json={"goal": preview["goal"]}).json()  # cloud planning fails: built-in plan
        assert case["reasoning"]["mode"] == "deterministic"
        explained = c.get(f"/api/approvals/{case['pending_approvals'][0]['id']}/explain").json()
        assert explained["source"] == "cloud"
        assert (explained["label"], explained["model"]) == ("Gemini", MODEL)
        assert explained["paragraphs"] == ["This books a repair time with the demo provider."]
        assert explained["facts"]  # AGENCY's own facts are always shown alongside


def test_gemini_credential_check() -> None:
    ok = FakeGemini(lambda body: None)
    status = asyncio.run(ok.provider().check())
    assert status["state"] == "ok"
    assert ok.requests[0].method == "GET" and str(ok.requests[0].url).endswith(f"/v1beta/models/{MODEL}")

    bad = FakeGemini(lambda body: api_error(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key."))
    status = asyncio.run(bad.provider().check())
    assert status["state"] == "error" and status["last_error"] == "the API key was rejected"


def test_thinking_level_is_only_sent_to_gemini_3_models() -> None:
    fake = FakeGemini(lambda body: {"paragraphs": ["ok"]})
    provider = fake.provider()
    provider.model = "gemini-2.5-flash"
    assert asyncio.run(provider.explain({"x": 1})) == ["ok"]
    assert "thinkingConfig" not in fake.bodies[0]["generationConfig"]


def test_build_provider_prefers_gemini_and_never_claims_cloud_without_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(name, raising=False)

    def build(reasoning: str = "auto") -> Any:
        return build_provider(reasoning, gemini_model=MODEL, anthropic_model="claude-opus-5-5")

    assert isinstance(build(), DisabledProvider)
    assert "GEMINI_API_KEY" in build().status()["description"]
    assert "GEMINI_API_KEY is not set" in build("gemini").status()["description"]

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-real")
    assert isinstance(build(), AnthropicProvider)
    assert build().status()["label"] == "Claude"
    assert isinstance(build("gemini"), DisabledProvider)

    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    chosen = build()
    assert isinstance(chosen, GeminiProvider) and chosen.model == MODEL
    assert (chosen.status()["provider"], chosen.status()["label"], chosen.status()["state"]) == ("google", "Gemini", "configured")
    assert KEY not in repr(chosen) and KEY not in json.dumps(chosen.status())
    assert isinstance(build("anthropic"), AnthropicProvider)
    assert isinstance(build("deterministic"), DisabledProvider)
    assert "Unknown" in build("chatgpt").status()["description"]

    monkeypatch.delenv("GEMINI_API_KEY")
    monkeypatch.setenv("GOOGLE_API_KEY", KEY)  # the SDK's other documented variable works too
    assert isinstance(build("gemini"), GeminiProvider)


def test_gemini_key_is_never_returned_by_the_api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    with make_client(tmp_path, provider=FakeGemini(lambda body: None).provider()) as c:
        for path in ("/api/health", "/api/runtime"):
            assert KEY not in c.get(path).text


# -- the two models: fast lane, failover, and which model answered ---------------------------------

LIST = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "string"}}}, "required": ["items"]}


def model_of(request: httpx.Request) -> str:
    return request.url.path.rsplit("/", 1)[-1].split(":")[0]


def by_model(answers: dict[str, Any]) -> FakeGemini:
    """Answers per model (the model is in the request's URL)."""

    def respond(body: dict[str, Any] | None) -> Any:
        answer = answers[model_of(fake.requests[-1])]
        return answer(body) if callable(answer) else answer

    fake = FakeGemini(respond)
    return fake


def fast_model() -> str:
    return GeminiProvider(model=MODEL, client=object()).fast_model


def test_fast_lane_falls_over_when_the_quick_model_is_misconfigured_and_says_so() -> None:
    fast = fast_model()
    fake = by_model({fast: api_error(404, "NOT_FOUND", f"models/{fast} is not found."), MODEL: {"items": ["ok"]}})
    provider = fake.provider()
    provider.lane = "fast"
    assert asyncio.run(provider._call_json("complete_sentence", "I want", LIST)) == {"items": ["ok"]}
    assert [model_of(r) for r in fake.requests] == [fast, MODEL]
    assert provider.last_model == MODEL  # the label names the model that really answered
    status = provider.status()
    assert status["state"] == "ok"
    # Not hidden by the fallback: the status names the model that isn't there.
    assert status["model_problems"] == {fast: f"model {fast} was not found"}
    assert f"model {fast} was not found" in status["description"]


def test_when_both_models_fail_the_error_names_each_model() -> None:
    fast = fast_model()
    fake = FakeGemini(lambda body: api_error(404, "NOT_FOUND", "not found"))
    provider = fake.provider()
    assert asyncio.run(provider._call_json("explain", "x", LIST)) is None
    assert provider.status()["last_error"] == (
        f"model {MODEL} was not found; model {fast} was not found; model {GEMINI_BACKUP_MODEL} was not found"
    )
    assert provider.last_model is None


def test_when_both_usual_models_are_busy_the_backup_model_answers() -> None:
    fast = fast_model()
    busy = api_error(503, "UNAVAILABLE", "overloaded")
    fake = by_model({MODEL: busy, fast: busy, GEMINI_BACKUP_MODEL: {"paragraphs": ["ok"]}})
    provider = fake.provider()
    assert asyncio.run(provider.explain({"headline": "x"})) == ["ok"]
    assert [model_of(r) for r in fake.requests] == [MODEL, fast, GEMINI_BACKUP_MODEL]
    assert provider.last_model == GEMINI_BACKUP_MODEL


def test_a_rejected_key_is_not_retried_on_the_other_model() -> None:
    fake = FakeGemini(lambda body: api_error(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key."))
    provider = fake.provider()
    provider.lane = "fast"
    assert asyncio.run(provider._call_json("suggest_replies", "Hi", LIST)) is None
    assert len(fake.requests) == 1
    assert provider.status()["last_error"] == "the API key was rejected"
    assert "model_problems" not in provider.status()  # a key problem, not a model problem


def test_a_busy_model_hands_over_at_once_and_the_label_follows() -> None:
    fast = fast_model()
    fake = by_model({MODEL: api_error(503, "UNAVAILABLE", "overloaded"), fast: {"paragraphs": ["ok"]}})
    provider = fake.provider()
    assert asyncio.run(provider.explain({"headline": "x"})) == ["ok"]
    assert [model_of(r) for r in fake.requests] == [MODEL, fast]
    assert provider.last_model == fast
    assert "model_problems" not in provider.status()  # busy is not a configuration mistake


def test_an_unusable_answer_does_not_change_the_answering_model() -> None:
    provider = FakeGemini(lambda body: reply({"items": ["x"]}, finish="SAFETY")).provider()
    assert asyncio.run(provider._call_json("explain", "x", LIST)) is None
    assert provider.last_model is None


def test_a_fallback_keeps_the_lane_effort_and_lenses_it_started_with() -> None:
    fast = fast_model()
    provider: GeminiProvider

    def first(body: dict[str, Any]) -> Any:
        # Another request is prepared by the Synapse layer while this one waits.
        provider.lane, provider.effort, provider.expert_brief = "deep", "high", "OTHER REQUEST'S LENSES"
        return api_error(429, "RESOURCE_EXHAUSTED", "Quota exceeded.")

    fake = by_model({fast: first, MODEL: {"items": ["ok"]}})
    provider = fake.provider()
    provider.lane, provider.effort, provider.expert_brief = "fast", "low", "THIS REQUEST'S LENSES"
    assert asyncio.run(provider._call_json("plan_task", "x", LIST)) == {"items": ["ok"]}
    first_body, second_body = fake.bodies
    assert system_text(second_body) == system_text(first_body)
    assert "THIS REQUEST'S LENSES" in system_text(second_body)
    assert second_body["generationConfig"]["thinkingConfig"] == {"thinking_level": "LOW"}


def system_text(body: dict[str, Any]) -> str:
    return str(body["systemInstruction"]["parts"][0]["text"])


def test_client_deadlines_are_never_below_the_api_minimum(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", KEY)

    def timeouts(provider: GeminiProvider) -> tuple[Any, Any]:
        return provider.client._api_client._http_options.timeout, provider.fast_client._api_client._http_options.timeout

    # The API answers 400 "Minimum allowed deadline is 10s" to anything shorter, which broke every call.
    assert timeouts(GeminiProvider(model=MODEL, timeout_s=5)) == (10_000, 10_000)
    assert timeouts(GeminiProvider(model=MODEL, timeout_s=40)) == (40_000, 10_000)
