"""The Synapse layer: Ray's Synapse-Mesh routes every AI request (experts + Cisco network budget); Gemini answers.

A fake Synapse-Mesh edge speaks its real protocol (POST /intent, GET /network, POST /network/mock, as in
github.com/RayB-007/synapse-mesh backend/synapse_mesh/api.py and intent_orchestrator.py); Gemini is the real
google-genai SDK against a fake HTTP transport (see test_gemini.py). No network, no credentials.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient

from agency.network import NetworkMonitor, classify_rtt
from agency.synapse import SynapseLayer, SynapseRouter, budget, keyword_experts
from conftest import make_client, tune
from test_api_and_provider import plan_from_baseline
from test_gemini import FakeGemini

EDGE = "http://127.0.0.1:8000"
CAPS = {"OPTIMAL": 1.0, "CONGESTED": 0.4, "CRITICAL": 0.1, "OFFLINE": 0.1}
MODES = {"OPTIMAL": "Ultra-Fusion", "CONGESTED": "Lean-Fusion", "CRITICAL": "Critical-Fusion"}


class FakeEdge:
    """Synapse-Mesh's edge API: Sifter weights, budgeted by the Cisco sentinel's state."""

    def __init__(self, state: str = "OPTIMAL", ideal: dict[str, float] | None = None, source: str = "mock") -> None:
        self.state = state
        self.source = source
        self.ideal = ideal or {"coding": 0.1, "medical": 0.6, "legal": 0.3}
        self.prompts: list[str] = []
        self.up = True

    def network(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "source": self.source,
            "revision": 3,
            "sampled_at": 1.0,
            "latency_ms": 42.0,
            "detail": "",
            "network_cap": CAPS[self.state],
        }

    def handle(self, request: httpx.Request) -> httpx.Response:
        if not self.up:
            raise httpx.ConnectError("refused")
        path = request.url.path
        if path == "/network" and request.method == "GET":
            return httpx.Response(200, json=self.network())
        if path == "/network/mock":
            self.state = json.loads(request.content)["state"]
            return httpx.Response(200, json=self.network())
        if path == "/intent":
            self.prompts.append(json.loads(request.content)["prompt"])
            if self.state == "OFFLINE":
                return httpx.Response(
                    503,
                    json={"detail": "Cloud-Kernel is unreachable while offline; the edge client does not run local inference"},
                )
            cap = CAPS[self.state]
            total = sum(self.ideal.values())
            if self.state == "CRITICAL":
                top = max(self.ideal, key=lambda k: self.ideal[k])
                applied = {k: cap if k == top else 0.0 for k in self.ideal}
            else:
                applied = {k: v / total * cap for k, v in self.ideal.items()}
            return httpx.Response(
                200,
                json={
                    "weights": applied,
                    "ideal_weights": self.ideal,
                    "adapter_order": list(self.ideal),
                    "active_experts": [k for k, v in applied.items() if v > 0],
                    "network": self.network(),
                    "network_cap": cap,
                    "budget_spent": sum(applied.values()),
                    "fusion_mode": MODES[self.state],
                    "method": "MiniLM Sifter",
                    "reason_ms": 3.4,
                },
            )
        return httpx.Response(404)

    def router(self) -> SynapseRouter:
        client = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))
        monitor = NetworkMonitor(synapse_url=EDGE, client=client)
        return SynapseRouter(monitor=monitor, url=EDGE, client=client)


def plan_responder(holder: dict[str, Any]) -> Any:
    def respond(body: dict[str, Any] | None) -> Any:
        if body is None:
            return None
        props = body["generationConfig"]["responseJsonSchema"]["properties"]
        if "steps" in props:
            return plan_from_baseline(holder["goal"])
        if "paragraphs" in props:
            return {"paragraphs": ["From Gemini, with Synapse's lenses."]}
        raise AssertionError("unexpected call")

    return respond


def client_with(tmp_path: Path, edge: FakeEdge | None, holder: dict[str, Any]) -> tuple[TestClient, FakeGemini, SynapseRouter]:
    gemini = FakeGemini(plan_responder(holder))
    router = edge.router() if edge else SynapseRouter(monitor=NetworkMonitor())
    layer = SynapseLayer(gemini.provider(), router)
    return make_client(tmp_path, provider=layer), gemini, router


def interpret(c: TestClient, holder: dict[str, Any]) -> None:
    preview = c.post("/api/goals/interpret", json={"goal_type": "equipment_repair", "selections": {"issue": "battery"}}).json()
    holder["goal"] = preview["goal"]


def system_instruction(body: dict[str, Any]) -> str:
    return str(body["systemInstruction"]["parts"][0]["text"])


def test_synapse_routes_the_plan_and_gemini_gets_its_expert_mixture(tmp_path: Path) -> None:
    edge, holder = FakeEdge("OPTIMAL"), {}
    c, gemini, _ = client_with(tmp_path, edge, holder)
    with c:
        tune(c)
        interpret(c, holder)
        case = c.post("/api/cases", json={"goal": holder["goal"]}).json()
        health = c.get("/api/health").json()
    assert case["reasoning"]["mode"] == "cloud"
    route = case["reasoning"]["route"]
    assert route["router"] == "synapse" and route["mode"] == "Ultra-Fusion" and route["decision"] == "gemini"
    assert route["mixture"] == {"coding": 0.1, "medical": 0.6, "legal": 0.3}
    assert route["reason_ms"] == 3.4
    assert edge.prompts and "battery" in edge.prompts[0].lower()  # Synapse saw the request before Gemini did
    system = system_instruction(gemini.bodies[-1])
    assert "Synapse-Mesh routed this request (Ultra-Fusion)" in system
    assert "medical (60%)" in system and "legal (30%)" in system and "Clinical lens" in system
    # A plan is an everyday request: Synapse's fast lane asks for low thinking even on a good network.
    assert route["lane"] == "fast"
    assert gemini.bodies[-1]["generationConfig"]["thinkingConfig"] == {"thinking_level": "LOW"}
    assert health["synapse"]["connected"] is True and health["synapse"]["router"] == "Synapse-Mesh"
    assert health["synapse"]["last_route"]["mode"] == "Ultra-Fusion"


def test_congestion_means_lean_fusion_light_thinking_and_short_answers(tmp_path: Path) -> None:
    edge, holder = FakeEdge("CONGESTED"), {}
    c, gemini, _ = client_with(tmp_path, edge, holder)
    with c:
        tune(c)
        interpret(c, holder)
        case = c.post("/api/cases", json={"goal": holder["goal"]}).json()
    route = case["reasoning"]["route"]
    assert route["mode"] == "Lean-Fusion" and route["decision"] == "gemini-lean" and route["cap"] == 0.4
    body = gemini.bodies[-1]
    assert body["generationConfig"]["thinkingConfig"] == {"thinking_level": "LOW"}
    assert "keep the answer short" in system_instruction(body)


def test_critical_network_never_waits_for_the_cloud(tmp_path: Path) -> None:
    edge, holder = FakeEdge("CRITICAL"), {}
    c, gemini, _ = client_with(tmp_path, edge, holder)
    with c:
        tune(c)
        interpret(c, holder)
        case = c.post("/api/cases", json={"goal": holder["goal"]}).json()
        explained = c.get(f"/api/approvals/{case['pending_approvals'][0]['id']}/explain").json()
    assert gemini.requests == []  # Gemini was never called
    assert case["reasoning"]["mode"] == "deterministic"
    assert case["reasoning"]["route"]["mode"] == "Critical-Fusion"
    assert any("built-in plans" in n for n in case["reasoning"]["notes"])
    assert not any("unavailable" in n for n in case["reasoning"]["notes"])
    assert case["status"] == "waiting_approval"  # the task itself carries on
    assert explained["source"] == "deterministic" and explained["route"]["decision"] == "built-in"


def test_offline_synapse_means_safe_mode_and_lifeline_says_alerts_cant_go_out(tmp_path: Path) -> None:
    edge, holder = FakeEdge("OFFLINE", source="restconf"), {}
    c, gemini, router = client_with(tmp_path, edge, holder)
    with c:
        tune(c)
        assert c.post("/api/runtime/check-cloud").status_code == 200  # polls the sentinel
        health = c.get("/api/health").json()
        lifeline = c.get("/api/lifeline/status").json()
        interpret(c, holder)
        case = c.post("/api/cases", json={"goal": holder["goal"]}).json()
    assert health["network"]["state"] == "offline" and health["network"]["source"] == "cisco"
    assert "RESTCONF" in health["network"]["detail"] and health["network"]["simulated"] is False
    assert any("network is offline (Cisco sentinel)" in p for p in lifeline["problems"])
    assert lifeline["network"]["state"] == "offline"
    assert case["reasoning"]["route"]["mode"] == "Safe-Mode"
    assert [r for r in gemini.requests if r.method == "POST"] == []  # no generation; only the credential check


def test_without_synapse_agency_stands_in_and_says_so(tmp_path: Path) -> None:
    edge, holder = FakeEdge(), {}
    edge.up = False
    c, gemini, _ = client_with(tmp_path, edge, holder)
    with c:
        tune(c)
        interpret(c, holder)
        case = c.post("/api/cases", json={"goal": holder["goal"]}).json()
        health = c.get("/api/health").json()
    route = case["reasoning"]["route"]
    assert route["router"] == "agency" and "isn't running" in route["method"]
    assert health["synapse"]["connected"] is False and health["synapse"]["router"] == "AGENCY stand-in router"
    assert case["reasoning"]["mode"] == "cloud"  # Gemini still answers
    assert "Synapse-Mesh routed this request" in system_instruction(gemini.bodies[-1])


def test_presenter_network_controls_move_synapse_and_agency_together(tmp_path: Path) -> None:
    edge, holder = FakeEdge("OPTIMAL"), {}
    c, gemini, _ = client_with(tmp_path, edge, holder)
    with c:
        tune(c)
        snap = c.put("/api/demo/network", json={"state": "slow"}).json()
        assert snap["state"] == "slow" and snap["simulated"] is True and snap["source"] == "demo"
        assert edge.state == "CONGESTED"  # Ray's dashboard moves too
        route = c.post("/api/synapse/route", json={"text": "Renew my parking placard form", "purpose": "task"}).json()
        assert route["mode"] == "Lean-Fusion" and route["decision"] == "gemini-lean"
        assert "keep the answer short" in route["brief"]
        c.put("/api/demo/network", json={"state": "offline"})
        assert c.post("/api/synapse/route", json={"text": "Renew my placard"}).json()["decision"] == "built-in"
        assert any("offline" in p for p in c.get("/api/lifeline/status").json()["problems"])
        back = c.put("/api/demo/network", json={"state": None}).json()
        assert back["source"] == "cisco"  # live sentinel again
        recent = c.get("/api/synapse").json()["recent"]
        assert [r["mode"] for r in recent[:2]] == ["Safe-Mode", "Lean-Fusion"]


def test_demo_network_needs_presenter_controls(tmp_path: Path) -> None:
    from agency.config import load_settings
    from agency.main import create_app

    settings = load_settings(db_path=tmp_path / "x.db", frontend_dist=None, demo_controls=False, lifeline_loop=False)
    with TestClient(create_app(settings)) as c:
        assert c.put("/api/demo/network", json={"state": "offline"}).status_code == 403


def test_network_recovery_wakes_lifeline(tmp_path: Path) -> None:
    calls: list[tuple[str, str]] = []
    monitor = NetworkMonitor()
    monitor.on_change(lambda old, new: calls.append((old, new)))
    asyncio.run(monitor.set_demo("offline"))
    asyncio.run(monitor.set_demo("good"))
    assert calls == [("unknown", "offline"), ("offline", "good")]


def test_budget_and_keyword_router_match_synapse_rules() -> None:
    assert budget({"coding": 0.8, "medical": 0.8, "legal": 0.4}, 0.6, False) == {"coding": 0.24, "medical": 0.24, "legal": 0.12}
    assert budget({"medical": 0.6, "legal": 0.3}, 0.1, True) == {"medical": 0.1, "legal": 0.0}
    assert keyword_experts("Sign the benefits renewal form for my clinic appointment") == {"medical": 0.333, "legal": 0.667}
    assert keyword_experts("hello there") == {"general": 1.0}
    assert classify_rtt(120) == "good" and classify_rtt(900) == "slow" and classify_rtt(2500) == "critical"
