"""HTTP surface (health, auth, demo controls) and the optional cloud provider."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import anthropic
import pytest
from fastapi.testclient import TestClient

from agency.planning.templates import baseline_plan
from agency.reasoning.provider import AnthropicProvider, DisabledProvider
from conftest import make_client, start_repair, step, tune


def test_health_reports_node_reasoning_and_database(client: TestClient) -> None:
    health = client.get("/api/health").json()
    assert health["status"] == "ok"
    assert health["database"]["schema_version"] == 2
    assert health["reasoning"]["mode"] == "deterministic"
    assert health["reasoning"]["state"] == "not_configured"
    assert health["node"]["role"] in {"local", "raspberry-pi"}
    assert health["auth_required"] is False


def test_runtime_lists_simulated_integrations(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-a-real-key")
    runtime = client.get("/api/runtime").json()
    assert {i["name"] for i in runtime["integrations"]} == {
        "Demo Repair Provider",
        "Demo Funding Service",
        "Demo Calendar",
        "Demo Messaging Service",
    }
    assert all(i["simulated"] and i["real_world_effects"] is False for i in runtime["integrations"])
    assert "No frames" in runtime["privacy"]["camera_processing"]
    assert "sk-ant" not in json.dumps(runtime)  # secrets are never returned


def test_token_is_required_when_configured(tmp_path: Path) -> None:
    with make_client(tmp_path, token="s3cret") as c:
        assert c.get("/api/health").status_code == 200  # health stays public, with no personal data
        assert c.get("/api/cases").status_code == 401
        assert c.post("/api/system/pause").status_code == 401
        assert c.get("/api/cases", headers={"X-Agency-Token": "wrong"}).status_code == 401
        assert c.get("/api/cases", headers={"X-Agency-Token": "s3cret"}).status_code == 200
        assert c.get("/api/health").json()["auth_required"] is True


def test_cors_allows_only_configured_origins(client: TestClient) -> None:
    ok = client.options("/api/cases", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    bad = client.options("/api/cases", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers


def test_preferences_round_trip_and_validation(client: TestClient) -> None:
    prefs = client.get("/api/preferences").json()
    prefs["dwell_ms"] = 1500
    prefs["input_mode"] = "gaze"
    assert client.put("/api/preferences", json=prefs).json()["dwell_ms"] == 1500
    prefs["dwell_ms"] = 50
    assert client.put("/api/preferences", json=prefs).status_code == 422


def test_demo_reset_and_faults(client: TestClient) -> None:
    start_repair(client)
    assert client.put("/api/demo/faults", json={"repair_slot_taken": True}).json()["repair_slot_taken"] is True
    info = client.post("/api/demo/reset").json()
    assert "deadline" in info
    assert client.get("/api/cases").json() == []
    assert client.get("/api/demo/faults").json()["repair_slot_taken"] is False


def test_explain_is_deterministic_without_cloud(client: TestClient) -> None:
    case = start_repair(client)
    approval = case["pending_approvals"][0]
    explained = client.get(f"/api/approvals/{approval['id']}/explain").json()
    assert explained["source"] == "deterministic"
    assert any("demonstration service" in p for p in explained["paragraphs"])


def test_creating_case_with_missing_info_is_rejected(client: TestClient) -> None:
    preview = client.post("/api/goals/interpret", json={"goal_type": "equipment_repair"}).json()
    assert not preview["ready"] and preview["questions"][0]["key"] == "issue"
    assert client.post("/api/cases", json={"goal": preview["goal"]}).status_code == 422


def test_catalog_suggests_follow_up_after_repair(client: TestClient) -> None:
    case = start_repair(client)
    ids = [a["id"] for a in case["pending_approvals"]]
    case = client.post("/api/approvals/batch", json={"approval_ids": ids, "decision": "approve"}).json()["cases"][0]
    ids = [a["id"] for a in case["pending_approvals"]]
    client.post("/api/approvals/batch", json={"approval_ids": ids, "decision": "approve"})
    catalog = client.get("/api/goals/catalog").json()
    assert len(catalog["cards"]) == 5
    assert any(s["title"].startswith("Ask the clinic") for s in catalog["suggestions"])


# ---------------------------------------------------------------------------------------
# Cloud provider (with a fake Anthropic client: no network, no credentials)
# ---------------------------------------------------------------------------------------


class FakeMessages:
    def __init__(self, responder: Any) -> None:
        self.responder = responder
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        result = self.responder(kwargs)
        if isinstance(result, Exception):
            raise result
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps(result))], stop_reason="end_turn")


class FakeClient:
    def __init__(self, responder: Any) -> None:
        self.beta = SimpleNamespace(messages=FakeMessages(responder))

        async def retrieve(model: str) -> Any:
            return SimpleNamespace(id=model)

        self.models = SimpleNamespace(retrieve=retrieve)


def plan_from_baseline(goal: dict[str, Any], *, drop: set[str] = frozenset(), mutate: Any = None) -> dict[str, Any]:
    from agency.models import Goal

    base = baseline_plan(Goal.model_validate(goal))
    steps = []
    for s in base.steps:
        if s.id in drop or s.tool in {"case.verify_outcomes", "case.save_notes"}:
            continue
        raw = {
            "id": s.id,
            "title": s.title,
            "description": s.description,
            "tool": s.tool,
            "inputs_json": json.dumps(s.inputs),
            "depends_on": s.depends_on,
            "approval": s.approval,
            "optional": s.optional,
            "expected_output": s.expected_output,
            "question_json": s.question.model_dump_json() if s.question else "",
        }
        steps.append(raw)
    data = {"rationale": "Adapted for Riley: no funding check requested.", "steps": steps}
    if mutate:
        mutate(data)
    return data


def cloud_client(tmp_path: Path, responder: Any) -> tuple[TestClient, AnthropicProvider]:
    provider = AnthropicProvider(model="claude-opus-5-5", client=FakeClient(responder))
    return make_client(tmp_path, provider=provider), provider


def test_cloud_plan_is_used_when_valid(tmp_path: Path) -> None:
    holder: dict[str, Any] = {}

    def responder(kwargs: dict[str, Any]) -> Any:
        schema = kwargs["output_config"]["format"]["schema"]
        if "steps" in schema["properties"]:
            plan = plan_from_baseline(holder["goal"], drop={"get_policy", "check_documents", "prepare_inquiry", "submit_inquiry"})
            for s in plan["steps"]:
                if s["id"] == "book_repair":
                    s["approval"] = "none"  # the validator must force this back to "required"
            return plan
        raise AssertionError("unexpected call")

    c, provider = cloud_client(tmp_path, responder)
    with c:
        tune(c)
        preview = c.post(
            "/api/goals/interpret", json={"goal_type": "equipment_repair", "selections": {"issue": "battery"}}
        ).json()
        holder["goal"] = preview["goal"]
        case = c.post("/api/cases", json={"goal": preview["goal"]}).json()
        assert case["reasoning"]["mode"] == "cloud"
        assert "claude-opus-5-5" in case["reasoning"]["planner"]
        assert [s["id"] for s in case["steps"]][-2:] == ["verify_all", "save_notes"]
        assert "submit_inquiry" not in {s["id"] for s in case["steps"]}
        assert step(case, "book_repair")["approval"] == "required"
        assert step(case, "book_repair")["status"] == "awaiting_approval"
        call = c.app.state.agency.provider.client.beta.messages.calls[0]  # type: ignore[attr-defined]
        assert call["model"] == "claude-opus-5-5"
        assert call["output_config"]["format"]["type"] == "json_schema"
        assert call["fallbacks"] == "default"
        assert c.get("/api/health").json()["reasoning"]["state"] == "ok"
    assert provider.calls == 1


def test_cloud_plan_with_forbidden_tool_falls_back_to_builtin(tmp_path: Path) -> None:
    holder: dict[str, Any] = {}

    def responder(kwargs: dict[str, Any]) -> Any:
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

    c, _ = cloud_client(tmp_path, responder)
    with c:
        tune(c)
        preview = c.post(
            "/api/goals/interpret", json={"goal_type": "equipment_repair", "selections": {"issue": "battery"}}
        ).json()
        holder["goal"] = preview["goal"]
        case = c.post("/api/cases", json={"goal": preview["goal"]}).json()
        assert case["reasoning"]["mode"] == "deterministic"
        assert any("safety checks" in n for n in case["reasoning"]["notes"])
        assert "pay" not in {s["id"] for s in case["steps"]}


def test_cloud_errors_fall_back_and_are_reported(tmp_path: Path) -> None:
    def responder(kwargs: dict[str, Any]) -> Any:
        return anthropic.APIConnectionError(request=SimpleNamespace())  # type: ignore[arg-type]

    c, provider = cloud_client(tmp_path, responder)
    with c:
        tune(c)
        case = start_repair(c)
        assert case["reasoning"]["mode"] == "deterministic"
        assert any("unavailable" in n for n in case["reasoning"]["notes"])
        health = c.get("/api/health").json()
        assert health["reasoning"]["state"] == "error"
        assert "built-in" in health["reasoning"]["description"]
        # The workflow itself is unaffected.
        assert case["status"] == "waiting_approval"


def test_cloud_interpretation_of_free_text(tmp_path: Path) -> None:
    def responder(kwargs: dict[str, Any]) -> Any:
        assert "Before Friday" in kwargs["messages"][0]["content"] or "Friday" in kwargs["messages"][0]["content"]
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

    c, _ = cloud_client(tmp_path, responder)
    with c:
        preview = c.post(
            "/api/goals/interpret",
            json={
                "free_text": "I need to arrange a repair for my wheelchair before Friday, find out whether financial assistance "
                "may be available, and prepare a message for my caregiver."
            },
        ).json()
        assert preview["interpretation"]["mode"] == "cloud"
        goal = preview["goal"]
        assert goal["entities"]["issue"] == "controls"
        assert goal["preferences"]["time_of_day"] == "afternoon"
        assert goal["options"] == {"check_funding": True, "notify_caregiver": True}
        assert preview["ready"]


def test_cloud_explanation_is_labelled(tmp_path: Path) -> None:
    def responder(kwargs: dict[str, Any]) -> Any:
        props = kwargs["output_config"]["format"]["schema"]["properties"]
        if "paragraphs" in props:
            return {"paragraphs": ["This books a repair time with the demo provider."]}
        if "steps" in props:
            return anthropic.APIConnectionError(request=SimpleNamespace())  # type: ignore[arg-type]
        raise AssertionError

    c, _ = cloud_client(tmp_path, responder)
    with c:
        tune(c)
        case = start_repair(c)
        explained = c.get(f"/api/approvals/{case['pending_approvals'][0]['id']}/explain").json()
        assert explained["source"] == "cloud" and explained["model"] == "claude-opus-5-5"
        assert explained["facts"]  # the deterministic facts are always included alongside


def test_disabled_provider_never_claims_cloud() -> None:
    status = DisabledProvider().status()
    assert status["mode"] == "deterministic" and status["state"] == "not_configured"


@pytest.mark.parametrize("stop_reason", ["refusal", "max_tokens"])
def test_provider_handles_unusable_stop_reasons(stop_reason: str) -> None:
    import asyncio

    class Messages:
        async def create(self, **kwargs: Any) -> Any:
            return SimpleNamespace(content=[SimpleNamespace(type="text", text="{}")], stop_reason=stop_reason)

    client = SimpleNamespace(beta=SimpleNamespace(messages=Messages()))
    provider = AnthropicProvider(model="claude-opus-5-5", client=client)
    assert asyncio.run(provider.explain({"x": 1})) is None
    assert provider.status()["state"] == "error"


def test_activity_lists_verified_outcomes(client: TestClient) -> None:
    case = start_repair(client)
    ids = [a["id"] for a in case["pending_approvals"]]
    client.post("/api/approvals/batch", json={"approval_ids": ids, "decision": "approve"})
    activity = client.get("/api/activity").json()
    assert activity and activity[0]["case_title"].startswith("Wheelchair repair")
    assert {"verified"} <= {e["kind"] for e in activity}
