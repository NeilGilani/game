"""The on-device model (Synapse-Mesh) as AGENCY's offline and private explainer.

Synapse-Mesh itself isn't run here (its model files live on the developer's Mac). A fake server
speaks its real protocol: POST /generate streams NDJSON events ending in {"event": "response",
"text": ...}, and GET /health reports the base model.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from agency.reasoning.local import SynapseMeshProvider, WithLocalFallback, local_from_env, split_paragraphs, with_local_model
from agency.reasoning.provider import DisabledProvider
from conftest import make_client, start_repair, tune
from test_gemini import MODEL, FakeGemini, api_error

URL = "http://127.0.0.1:8100"
ANSWER = "This books a repair visit with the demo provider.\n\nIf you say no, nothing is booked."


class FakeSynapse:
    def __init__(self, respond: Any = None) -> None:
        self.respond = respond
        self.prompts: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/health":
            return httpx.Response(200, json={"status": "ready", "base_model": "Qwen/Qwen2.5-1.5B-Instruct"})
        assert request.url.path == "/generate"
        body = json.loads(request.content)
        self.prompts.append(body["prompt"])
        if self.respond is not None:
            result: httpx.Response = self.respond(body)
            return result
        events = [
            {"event": "intent", "active_experts": ["legal"]},
            {"event": "loading", "device": "mps", "base_cold": False},
            {"event": "token", "token_index": 0, "text": "This"},
            {"event": "response", "text": ANSWER},
            {"event": "complete", "base_restored": True},
        ]
        return httpx.Response(200, text="\n".join(json.dumps(e) for e in events) + "\n")

    def provider(self) -> SynapseMeshProvider:
        return SynapseMeshProvider(url=URL, client=httpx.AsyncClient(transport=httpx.MockTransport(self.handle)))


def explain_first_approval(c: TestClient) -> dict[str, Any]:
    tune(c)
    case = start_repair(c)
    result: dict[str, Any] = c.get(f"/api/approvals/{case['pending_approvals'][0]['id']}/explain").json()
    return result


def test_without_a_cloud_key_explanations_come_from_the_mac_and_plans_stay_built_in(tmp_path: Path) -> None:
    synapse = FakeSynapse()
    provider = WithLocalFallback(primary=DisabledProvider(), local=synapse.provider())
    with make_client(tmp_path, provider=provider) as c:
        health = c.get("/api/health").json()["reasoning"]
        assert health["label"] == "On-device" and health["mode"] == "local"
        case = start_repair(c)
        assert case["reasoning"]["mode"] == "deterministic"  # the small model never plans
        assert synapse.prompts == []  # ... and isn't asked to
        explained = c.get(f"/api/approvals/{case['pending_approvals'][0]['id']}/explain").json()
    assert explained["source"] == "cloud" and explained["on_device"] is True
    assert explained["paragraphs"] == ["This books a repair visit with the demo provider.", "If you say no, nothing is booked."]
    assert explained["facts"]  # AGENCY's own facts are always shown alongside
    assert "Synapse-Mesh" in explained["model"]
    assert len(synapse.prompts) == 1 and "demonstration service" in synapse.prompts[0]


def test_when_gemini_cant_be_reached_the_mac_explains_instead(tmp_path: Path) -> None:
    def gemini(body: Any) -> Any:
        raise httpx.ConnectError("no internet")

    synapse = FakeSynapse()
    provider = WithLocalFallback(primary=FakeGemini(gemini).provider(), local=synapse.provider())
    with make_client(tmp_path, provider=provider) as c:
        explained = explain_first_approval(c)
        health = c.get("/api/health").json()["reasoning"]
    assert explained["on_device"] is True and explained["label"] == "On-device"
    assert health["label"] == "Gemini" and health["local"]["state"] == "ok"


def test_gemini_still_explains_when_it_is_reachable(tmp_path: Path) -> None:
    synapse = FakeSynapse()
    gemini = FakeGemini(lambda body: {"paragraphs": ["From Gemini."]} if "paragraphs" in json.dumps(body) else None)
    provider = WithLocalFallback(primary=gemini.provider(), local=synapse.provider())
    with make_client(tmp_path, provider=provider) as c:
        tune(c)
        case = start_repair(c)
        explained = c.get(f"/api/approvals/{case['pending_approvals'][0]['id']}/explain").json()
    assert explained["label"] == "Gemini" and explained["model"] == MODEL and explained["on_device"] is False
    assert explained["paragraphs"] == ["From Gemini."]
    assert synapse.prompts == []


def test_a_cloud_refusal_is_not_routed_around(tmp_path: Path) -> None:
    gemini = FakeGemini(lambda body: api_error(400, "INVALID_ARGUMENT", "Request rejected."))
    synapse = FakeSynapse()
    provider = WithLocalFallback(primary=gemini.provider(), local=synapse.provider())
    with make_client(tmp_path, provider=provider) as c:
        explained = explain_first_approval(c)
    assert explained["source"] == "deterministic"
    assert synapse.prompts == []


def test_private_mode_never_sends_explanations_to_the_cloud(tmp_path: Path) -> None:
    gemini = FakeGemini(lambda body: {"paragraphs": ["From Gemini."]})
    synapse = FakeSynapse()
    provider = WithLocalFallback(primary=gemini.provider(), local=synapse.provider(), private=True)
    with make_client(tmp_path, provider=provider) as c:
        explained = explain_first_approval(c)
        assert c.get("/api/health").json()["reasoning"]["private_explanations"] is True
    assert explained["on_device"] is True
    sent_to_gemini = [json.dumps(b) for b in gemini.bodies]
    assert not any("Explain this" in b for b in sent_to_gemini)  # plans may use Gemini; explanations never


@pytest.mark.parametrize(
    ("respond", "reported"),
    [
        (lambda body: (_ for _ in ()).throw(httpx.ConnectError("refused")), "isn't running"),
        (lambda body: httpx.Response(500, text="boom"), "answered 500"),
        (lambda body: httpx.Response(200, text=json.dumps({"event": "error", "message": "Safe-Mode files missing"})), "failed"),
        (lambda body: httpx.Response(200, text=json.dumps({"event": "response", "text": "   "})), "returned nothing"),
        (lambda body: (_ for _ in ()).throw(httpx.ReadTimeout("slow")), "took too long"),
    ],
)
def test_if_the_mac_model_fails_agency_uses_its_own_words(tmp_path: Path, respond: Any, reported: str) -> None:
    synapse = FakeSynapse(respond)
    provider = WithLocalFallback(primary=DisabledProvider(), local=synapse.provider())
    with make_client(tmp_path, provider=provider) as c:
        explained = explain_first_approval(c)
        local = c.get("/api/health").json()["reasoning"]["local"]
    assert explained["source"] == "deterministic"
    assert any("demonstration service" in p for p in explained["paragraphs"])
    assert local["state"] == "error" and reported in local["last_error"]


def test_explaining_never_changes_an_approval(tmp_path: Path) -> None:
    provider = WithLocalFallback(primary=DisabledProvider(), local=FakeSynapse().provider())
    with make_client(tmp_path, provider=provider) as c:
        tune(c)
        case = start_repair(c)
        approval = case["pending_approvals"][0]
        c.get(f"/api/approvals/{approval['id']}/explain")
        after = c.get(f"/api/cases/{case['id']}").json()
    assert approval["id"] in {a["id"] for a in after["pending_approvals"]}
    assert after["status"] == "waiting_approval"


def test_the_on_device_model_must_be_on_this_computer() -> None:
    assert local_from_env({}) is None
    assert local_from_env({"AGENCY_LOCAL_MODEL_URL": URL}) is not None
    assert local_from_env({"AGENCY_LOCAL_MODEL_URL": "http://localhost:8100"}) is not None
    assert local_from_env({"AGENCY_LOCAL_MODEL_URL": "http://[::1]:8100"}) is not None
    assert local_from_env({"AGENCY_LOCAL_MODEL_URL": "http://192.168.1.20:8100"}) is None
    assert local_from_env({"AGENCY_LOCAL_MODEL_URL": "https://example.com"}) is None
    assert local_from_env({"AGENCY_LOCAL_MODEL_URL": "ftp://127.0.0.1"}) is None
    allowed = {"AGENCY_LOCAL_MODEL_URL": "http://192.168.1.20:8100", "AGENCY_LOCAL_MODEL_ALLOW_REMOTE": "1"}
    assert local_from_env(allowed) is not None

    plain = DisabledProvider()
    assert with_local_model(plain, {}) is plain
    wrapped = with_local_model(plain, {"AGENCY_LOCAL_MODEL_URL": URL, "AGENCY_PRIVATE_EXPLANATIONS": "1"})
    assert isinstance(wrapped, WithLocalFallback) and wrapped.private


def test_health_check_reads_the_base_model() -> None:
    provider = FakeSynapse().provider()
    status = asyncio.run(provider.check())
    assert status["state"] == "ok" and status["model"] == "Synapse-Mesh (Qwen/Qwen2.5-1.5B-Instruct)"


def test_paragraph_splitting() -> None:
    assert split_paragraphs("One.\n\nTwo.") == ["One.", "Two."]
    assert split_paragraphs("One.\nTwo.\n") == ["One.", "Two."]
    assert split_paragraphs("\n".join(str(i) for i in range(9))) == ["0", "1", "2", "3"]
    assert split_paragraphs("x" * 900) == ["x" * 600]


class EdgeSynapse(FakeSynapse):
    """The newer Synapse-Mesh: an edge client whose generation runs on a cloud GPU kernel."""

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/health":
            return httpx.Response(
                200,
                json={
                    "status": "cold",
                    "base_model": "Qwen/Qwen2.5-1.5B-Instruct",
                    "device": "edge",
                    "engine": "cloud-edge-client",
                    "cloud_configured": True,
                    "network": {"state": "OPTIMAL", "mode": "cloud"},
                },
            )
        return super().handle(request)


def test_a_cloud_kernel_synapse_is_never_called_on_device(tmp_path: Path) -> None:
    synapse = EdgeSynapse()
    provider = WithLocalFallback(primary=DisabledProvider(), local=synapse.provider())
    with make_client(tmp_path, provider=provider) as c:
        explained = explain_first_approval(c)
        health = c.get("/api/health").json()["reasoning"]
    assert explained["on_device"] is False
    assert explained["label"] == "Synapse-Mesh" and "cloud GPU" in explained["model"]
    assert health["mode"] == "cloud" and health["local"]["on_device"] is False
    assert health["local"]["network"]["state"] == "OPTIMAL"
    assert "left this computer" in health["local"]["description"]


def test_private_mode_refuses_a_cloud_kernel_synapse(tmp_path: Path) -> None:
    synapse = EdgeSynapse()
    provider = WithLocalFallback(primary=DisabledProvider(), local=synapse.provider(), private=True)
    with make_client(tmp_path, provider=provider) as c:
        explained = explain_first_approval(c)
    assert explained["source"] == "deterministic"
    assert synapse.prompts == []  # the text never went to the edge, so never to its cloud kernel


def test_private_mode_refuses_a_synapse_whose_setup_is_unknown(tmp_path: Path) -> None:
    def broken_health(body: Any) -> httpx.Response:
        return httpx.Response(200, text=json.dumps({"event": "response", "text": "x"}))

    class NoHealth(FakeSynapse):
        def handle(self, request: httpx.Request) -> httpx.Response:
            if request.method == "GET":
                return httpx.Response(503)
            return super().handle(request)

    synapse = NoHealth()
    provider = WithLocalFallback(primary=DisabledProvider(), local=synapse.provider(), private=True)
    with make_client(tmp_path, provider=provider) as c:
        explained = explain_first_approval(c)
    assert explained["source"] == "deterministic"
    assert synapse.prompts == []
