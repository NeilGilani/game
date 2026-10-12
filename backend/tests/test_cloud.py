"""AGENCY Cloud: the coordinator on AGENCY's relay instead of a key of its own.

A fake relay (httpx.MockTransport) checks every signature the way site/functions/_lib/relay.ts does and answers
like it, so these tests cover registration, signing, the fast lane, failover between models, the relay's own
refusals in plain words, the Synapse cache and the provider choice. No network.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import stat
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from agency import assist
from agency.network import NetworkMonitor
from agency.reasoning.cloud import (
    AgencyCloud,
    AgencyCloudProvider,
    FileIdentityStore,
    Identity,
    MemoryIdentityStore,
    default_store,
)
from agency.reasoning.provider import (
    FAST_TIMEOUT_S,
    GEMINI_FAST_MODEL,
    AnthropicProvider,
    DisabledProvider,
    GeminiProvider,
    build_provider,
)
from agency.synapse import SynapseLayer, SynapseRouter
from conftest import make_client

RELAY = "https://relay.example"
MASTER = b"fake-relay-master-secret"
MODEL = "gemini-3.8-flash"

PLAN = {
    "steps": [
        {"title": "Open the practice store", "risk": "read", "done": "Opened it"},
        {"title": "Pay", "risk": "consequential", "done": "Paid"},
    ]
}


def answer(data: Any, finish: str = "STOP") -> dict[str, Any]:
    return {"candidates": [{"content": {"role": "model", "parts": [{"text": json.dumps(data)}]}, "finishReason": finish}]}


def refusal(code: int, reason: str, message: str = "no", **extra: Any) -> httpx.Response:
    return httpx.Response(code, json={"error": {"code": code, "status": "X", "reason": reason, "message": message, **extra}})


class FakeRelay:
    """Registers installs and verifies signed requests like the real relay. ``respond(body)`` answers generate."""

    def __init__(self, respond: Callable[[dict[str, Any]], Any] | None = None) -> None:
        self.respond = respond or (lambda body: answer(PLAN))
        self.registered: list[str] = []
        self.generated: list[dict[str, Any]] = []
        self.statuses = 0
        self.master = MASTER
        self.clock_skew = 0  # seconds the relay's clock is ahead
        self.forget_once = False

    def secret(self, install: str) -> str:
        digest = hmac.new(self.master, f"agency-cloud-install:{install}".encode(), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).decode().rstrip("=")

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/relay/v1/register":
            install = f"i_{len(self.registered):022d}"
            self.registered.append(install)
            return httpx.Response(200, json={"installId": install, "secret": self.secret(install)})
        install = request.headers.get("x-agency-install", "")
        stamp = request.headers.get("x-agency-time", "0")
        now = int(time.time()) + self.clock_skew
        if abs(now - int(stamp)) > 300:
            return refusal(401, "clock", serverTime=now)
        canonical = "\n".join(["AGENCY-CLOUD-1", request.method, path, stamp, hashlib.sha256(request.content).hexdigest()])
        expected = hmac.new(self.secret(install).encode(), canonical.encode(), hashlib.sha256).hexdigest()
        if self.forget_once or not hmac.compare_digest(expected, request.headers.get("x-agency-signature", "")):
            self.forget_once = False
            return refusal(401, "auth")
        if path == "/api/relay/v1/status":
            self.statuses += 1
            return httpx.Response(200, json={"ok": True, "installId": install})
        if path == "/api/relay/v1/generate":
            body = json.loads(request.content)
            self.generated.append(body)
            result = self.respond(body)
            if isinstance(result, Exception):
                raise result
            return result if isinstance(result, httpx.Response) else httpx.Response(200, json=result)
        return httpx.Response(404)

    def cloud(self, store: Any = None) -> AgencyCloud:
        return AgencyCloud(RELAY, store or MemoryIdentityStore(), transport=httpx.MockTransport(self.handle))

    def provider(self, store: Any = None, **kw: Any) -> AgencyCloudProvider:
        return AgencyCloudProvider(model=MODEL, cloud=self.cloud(store), **kw)


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def plan_json(provider: AgencyCloudProvider) -> dict[str, Any] | None:
    return run(provider._call_json("plan_task", "Order soup", {"type": "object"}, max_tokens=1000))  # type: ignore[no-any-return]


# ---------------------------------------------------------------------------------------------------------------


def test_registers_once_signs_every_request_and_keeps_the_install_in_a_private_file(tmp_path: Path) -> None:
    relay = FakeRelay()
    store = FileIdentityStore(tmp_path / "agency-cloud.json")
    provider = relay.provider(store)
    assert plan_json(provider) == PLAN
    assert plan_json(provider) == PLAN
    assert len(relay.registered) == 1 and len(relay.generated) == 2
    saved = json.loads((tmp_path / "agency-cloud.json").read_text())
    assert saved["installId"] == relay.registered[0] and saved["relay"] == RELAY
    assert stat.S_IMODE((tmp_path / "agency-cloud.json").stat().st_mode) == 0o600
    # A restart reuses the stored install.
    assert plan_json(relay.provider(FileIdentityStore(tmp_path / "agency-cloud.json"))) == PLAN
    assert len(relay.registered) == 1
    status = provider.status()
    assert status["label"] == "AGENCY Cloud" and status["via"] == "agency-cloud" and status["state"] == "ok"
    assert "AGENCY Cloud" in status["description"]


def test_sends_the_same_request_a_local_key_would_and_the_fast_lane_goes_to_flash_lite_first() -> None:
    relay = FakeRelay()
    provider = relay.provider()
    provider.lane = "fast"
    provider.effort = "low"
    provider.expert_brief = "Everyday lens: short."
    assert plan_json(provider) == PLAN
    body = relay.generated[0]
    assert body["model"] == GEMINI_FAST_MODEL
    assert body["user"] == "Order soup"
    assert body["schema"] == {"type": "object"}
    assert body["maxOutputTokens"] == 2000  # room for thinking, as with a local key
    assert body["thinkingLevel"] == "LOW"
    assert body["timeoutMs"] == FAST_TIMEOUT_S * 1000  # the API's minimum deadline
    assert "Everyday lens: short." in body["system"]
    assert set(body) == {"model", "user", "schema", "maxOutputTokens", "thinkingLevel", "timeoutMs", "system"}
    assert provider.last_model == GEMINI_FAST_MODEL

    provider.lane = "deep"
    plan_json(provider)
    assert relay.generated[-1]["model"] == MODEL
    assert relay.generated[-1]["timeoutMs"] >= 10_000


def test_fails_over_to_the_other_model_when_gemini_is_busy_or_a_model_is_not_offered() -> None:
    def respond(body: dict[str, Any]) -> Any:
        if body["model"] == GEMINI_FAST_MODEL:
            return refusal(503, "upstream", "The model is overloaded.")
        return answer(PLAN)

    relay = FakeRelay(respond)
    provider = relay.provider()
    provider.lane = "fast"
    assert plan_json(provider) == PLAN
    assert [b["model"] for b in relay.generated] == [GEMINI_FAST_MODEL, MODEL]
    assert provider.last_model == MODEL and not provider.model_problems

    relay = FakeRelay(
        lambda body: (
            refusal(400, "model", 'AGENCY Cloud doesn\'t offer the model "x".') if body["model"] == MODEL else answer(PLAN)
        )
    )
    provider = relay.provider()
    assert plan_json(provider) == PLAN
    assert MODEL in provider.model_problems  # the mistake stays visible while the other model answers

    relay = FakeRelay(lambda body: httpx.ConnectError("down") if body["model"] == MODEL else answer(PLAN))
    provider = relay.provider()
    assert plan_json(provider) == PLAN


@pytest.mark.parametrize(
    ("reason", "code", "words"),
    [
        ("busy", 429, "AGENCY's AI is busy. Try again in a minute."),
        (
            "daily_limit",
            429,
            "AGENCY's AI has reached today's limit for this computer, so the built-in plan is used until tomorrow.",
        ),
        ("budget", 429, "AGENCY's AI has reached its daily limit, so the built-in plan is used until tomorrow."),
        ("disabled", 503, "AGENCY's AI is switched off for now, so the built-in plan is used."),
        ("upstream_key", 502, "AGENCY's AI isn't available right now."),
    ],
)
def test_the_relays_own_refusals_stop_at_once_in_plain_words(reason: str, code: int, words: str) -> None:
    relay = FakeRelay(lambda body: refusal(code, reason, "server words"))
    provider = relay.provider()
    provider.lane = "fast"
    assert plan_json(provider) is None
    assert len(relay.generated) == 1  # no second model: it would get the same answer and spend the budget
    status = provider.status()
    assert status["state"] == "error" and status["last_error"] == words
    assert words in status["description"] and "built-in plans" in status["description"]


def test_gemini_errors_through_the_relay_read_as_they_do_with_a_local_key() -> None:
    relay = FakeRelay(lambda body: refusal(429, "upstream", "Resource exhausted"))
    provider = relay.provider()
    assert plan_json(provider) is None
    assert len(relay.generated) == 2  # busy: the other model was tried
    assert provider.last_error == "rate limited"

    relay = FakeRelay(lambda body: answer(PLAN, finish="SAFETY"))
    provider = relay.provider()
    assert plan_json(provider) is None and provider.last_error == "the model declined this request"

    relay = FakeRelay(lambda body: httpx.Response(200, text="<html>oops</html>"))
    provider = relay.provider()
    assert plan_json(provider) is None
    assert provider.last_error is not None


def test_registers_again_when_the_relay_forgets_this_computer_and_fixes_a_wrong_clock() -> None:
    relay = FakeRelay()
    provider = relay.provider()
    assert plan_json(provider) == PLAN
    relay.master = b"rotated"  # the server secret was rotated: every install must register again
    assert plan_json(provider) == PLAN
    assert len(relay.registered) == 2

    relay.clock_skew = 3600  # this computer's clock is an hour behind
    assert plan_json(provider) == PLAN
    assert provider.cloud is not None and abs(provider.cloud.clock_offset - 3600) < 5

    relay.forget_once = True
    assert plan_json(provider) == PLAN  # one fresh registration and a retry, nothing shown to the person


def test_the_check_reads_the_relay_status_without_spending_tokens() -> None:
    relay = FakeRelay()
    provider = relay.provider()
    status = run(provider.check())
    assert status["state"] == "ok" and relay.statuses == 1 and not relay.generated
    offline = AgencyCloudProvider(
        model=MODEL,
        cloud=AgencyCloud(
            RELAY, MemoryIdentityStore(), transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("x")))
        ),
    )
    status = run(offline.check())
    assert status["state"] == "error" and status["last_error"] == "could not reach AGENCY Cloud (network)"


def test_through_the_app_synapse_routes_the_fast_lane_and_caches_the_answer(tmp_path: Path) -> None:
    assist.forget()
    relay = FakeRelay()
    layer = SynapseLayer(relay.provider(), SynapseRouter(monitor=NetworkMonitor()))
    with make_client(tmp_path, provider=layer) as client:
        first = client.post("/api/assist/plan", json={"goal": "Order soup through the cloud", "kind": "food"})
        again = client.post("/api/assist/plan", json={"goal": "Order soup through the cloud", "kind": "food"})
        health = client.get("/api/health").json()
    assert first.status_code == 200, first.text
    assert first.json()["label"] == f"AGENCY Cloud ({GEMINI_FAST_MODEL})"
    assert first.json()["speed"]["cached"] is False and again.json()["speed"]["cached"] is True
    assert len(relay.generated) == 1  # the second came from Synapse's cache
    assert relay.generated[0]["model"] == GEMINI_FAST_MODEL and relay.generated[0]["thinkingLevel"] == "LOW"
    assert "Synapse-Mesh routed this request" in relay.generated[0]["system"]
    assert health["reasoning"]["label"] == "AGENCY Cloud"


def test_a_busy_relay_means_the_built_in_plan_with_the_reason(tmp_path: Path) -> None:
    assist.forget()
    relay = FakeRelay(lambda body: refusal(429, "busy"))
    layer = SynapseLayer(relay.provider(), SynapseRouter(monitor=NetworkMonitor()))
    with make_client(tmp_path, provider=layer) as client:
        res = client.post("/api/assist/plan", json={"goal": "Order soup", "kind": "food"})
        health = client.get("/api/health").json()
    assert res.status_code == 502  # the web interface then uses its built-in plan
    assert "AGENCY's AI is busy" in res.json()["detail"]
    assert health["reasoning"]["state"] == "error" and health["reasoning"]["label"] == "AGENCY Cloud"
    assert "AGENCY's AI is busy. Try again in a minute." in health["reasoning"]["description"]


# ---------------------------------------------------------------------------------------------------------------


def test_build_provider_uses_agency_cloud_only_without_a_key(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "AGENCY_CLOUD_IDENTITY_FILE"):
        monkeypatch.delenv(name, raising=False)

    def build(reasoning: str = "auto", relay: str | None = RELAY) -> Any:
        return build_provider(
            reasoning, gemini_model=MODEL, anthropic_model="claude-opus-5-5", relay_url=relay, identity_dir=tmp_path
        )

    cloud = build()
    assert isinstance(cloud, AgencyCloudProvider) and cloud.cloud is not None and cloud.cloud.base_url == RELAY
    assert isinstance(build("gemini"), AgencyCloudProvider)
    assert isinstance(build("anthropic"), DisabledProvider)
    off = build(relay=None)
    assert isinstance(off, DisabledProvider) and "AGENCY_RELAY=off" in off.status()["description"]
    assert isinstance(build("deterministic"), DisabledProvider)

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-not-real")
    assert isinstance(build(), AnthropicProvider)  # a key of your own wins
    monkeypatch.setenv("GEMINI_API_KEY", "test-not-real")
    local = build()
    assert type(local) is GeminiProvider and local.status()["label"] == "Gemini"


def test_signs_the_fixed_vector_the_relay_and_the_mac_agent_check() -> None:
    from agency.reasoning.cloud import _sign

    # The same vector is checked in site/tests/unit/relay.test.ts and os/agent/tests/cloud.test.ts.
    assert (
        _sign("s3cret", "POST", "/api/relay/v1/generate", 1_700_000_000, b'{"a":1}')
        == "eb7f913af191f5d86cd4b354938bc3a52ebf5f117efaa7338052bd6c16db803c"
    )


def test_settings_read_the_relay_address_and_the_switch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from agency.config import DEFAULT_RELAY_URL, load_settings

    monkeypatch.delenv("AGENCY_RELAY", raising=False)
    monkeypatch.delenv("AGENCY_RELAY_URL", raising=False)
    assert load_settings().relay_url == DEFAULT_RELAY_URL == "https://getagencyos.pages.dev"
    monkeypatch.setenv("AGENCY_RELAY_URL", "http://127.0.0.1:8788/")
    assert load_settings().relay_url == "http://127.0.0.1:8788"
    monkeypatch.setenv("AGENCY_RELAY", "off")
    assert load_settings().relay_url is None


def test_the_install_lives_in_the_keychain_on_a_mac_and_in_a_file_elsewhere(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from agency.reasoning import cloud as cloud_module

    monkeypatch.setattr(cloud_module.sys, "platform", "linux")
    store = default_store(tmp_path, {})
    assert isinstance(store, FileIdentityStore) and store.path == tmp_path / "agency-cloud.json"
    assert default_store(tmp_path, {"AGENCY_CLOUD_IDENTITY_FILE": str(tmp_path / "x.json")}).path == tmp_path / "x.json"  # type: ignore[attr-defined]
    monkeypatch.setattr(cloud_module.sys, "platform", "darwin")
    monkeypatch.setattr(cloud_module.shutil, "which", lambda name: "/usr/bin/security")
    keychain = default_store(tmp_path, {})
    assert isinstance(keychain, cloud_module.KeychainIdentityStore)

    calls: list[list[str]] = []

    def fake_run(cmd: list[str], **_: Any) -> Any:
        calls.append(cmd)

        class Done:
            returncode = 0
            stdout = Identity("i_" + "a" * 22, "s", RELAY).to_json()

        return Done()

    monkeypatch.setattr(cloud_module.subprocess, "run", fake_run)
    assert keychain.load() == Identity("i_" + "a" * 22, "s", RELAY)
    keychain.save(Identity("i_" + "b" * 22, "s2", RELAY))
    assert calls[0][:6] == ["/usr/bin/security", "find-generic-password", "-s", "AGENCY", "-a", "agency-cloud-install"]
    assert calls[1][1] == "add-generic-password" and calls[1][-1] == "-U"
