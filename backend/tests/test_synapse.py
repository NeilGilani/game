from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agency.synapse import build_router
from conftest import make_client


class TrackingStream(httpx.AsyncByteStream):
    def __init__(self, events: list[Any]) -> None:
        self.events = events
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for event in self.events:
            yield (json.dumps(event) + "\n").encode()

    async def aclose(self) -> None:
        self.closed = True


def events_of(response: httpx.Response) -> list[dict[str, Any]]:
    return [json.loads(line) for line in response.text.splitlines()]


def app_with(handler: Any) -> FastAPI:
    app = FastAPI()
    app.include_router(build_router("http://kernel.test", transport=httpx.MockTransport(handler)))
    return app


def test_question_is_unchanged_and_tensor_audit_is_preserved() -> None:
    audit = {"event": "fusion", "layer_count": 196, "weights": {"code": 0.24, "legal": 0.16}}
    spend = {
        "event": "token_fusion",
        "weights": audit["weights"],
        "ideal_weights": {"code": 0.6, "legal": 0.4},
        "network_cap": 0.4,
    }
    stream = TrackingStream(
        [
            audit,
            spend,
            {"event": "token", "text": "Answer"},
            {"event": "response", "text": "Answer"},
            {"event": "complete", "base_restored": True, "timing": {"restore_ms": 9}},
        ]
    )
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, json.loads(request.content)))
        return httpx.Response(200, stream=stream)

    with TestClient(app_with(handler)) as client:
        response = client.post("/api/synapse/questions", json={"question": "  Explain HIPAA audit logging.  "})
    assert response.status_code == 200
    assert seen == [("/generate", {"prompt": "  Explain HIPAA audit logging.  ", "max_new_tokens": None})]
    assert events_of(response)[0] == audit
    assert events_of(response)[1] == spend
    assert events_of(response)[-1]["base_restored"] is True
    assert stream.closed


@pytest.mark.parametrize(
    "events",
    [
        [{"event": "response", "text": "Fake answer"}, {"event": "complete", "base_restored": True}],
        [
            {"event": "fusion", "layer_count": 196},
            {"event": "response", "text": "Answer"},
            {"event": "complete", "base_restored": False},
        ],
        [{"event": "token", "text": "Partial"}],
        [None],
        [{"event": "complete", "base_restored": True}],
    ],
)
def test_unconfirmed_or_broken_stream_never_claims_completion(events: list[Any]) -> None:
    stream = TrackingStream(events)
    with TestClient(app_with(lambda _: httpx.Response(200, stream=stream))) as client:
        response = client.post("/api/synapse/questions", json={"question": "Question"})
    actual = events_of(response)
    assert actual[-1]["event"] == "error"
    assert all(event["event"] != "complete" for event in actual)
    assert stream.closed


def test_kernel_errors_and_http_failures_are_visible() -> None:
    with TestClient(
        app_with(lambda _: httpx.Response(200, json=None, content=b'{"event":"error","message":"Missing adapter"}\n'))
    ) as client:
        response = client.post("/api/synapse/questions", json={"question": "Question"})
    assert events_of(response) == [{"event": "error", "message": "Missing adapter"}]
    with TestClient(app_with(lambda _: httpx.Response(503))) as client:
        assert client.post("/api/synapse/questions", json={"question": "Question"}).status_code == 503


@pytest.mark.parametrize(
    "body",
    [
        {"question": " "},
        {"question": "x" * 8001},
        {"question": "x", "max_new_tokens": 15},
        {"question": "x", "max_new_tokens": True},
        {"question": "x", "weights": {"code": 1}},
        {"question": "x", "profile": {"name": "Riley"}},
    ],
)
def test_invalid_questions_never_reach_kernel(body: dict[str, Any]) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        pytest.fail("Invalid request reached the kernel")

    with TestClient(app_with(handler)) as client:
        assert client.post("/api/synapse/questions", json=body).status_code == 422


def test_status_has_network_budget_without_vault_paths() -> None:
    health = {
        "status": "ready",
        "engine": "raw-tensor-fusion",
        "device": "mps",
        "base_model": "Qwen",
        "execution_mode": "local",
        "network": {"state": "CONGESTED", "source": "mock", "network_cap": 0.4},
        "vault": [{"path": "/private/weights", "metadata": {"private": "data"}}],
    }
    with TestClient(app_with(lambda _: httpx.Response(200, json=health))) as client:
        response = client.get("/api/synapse/status")
    assert response.json()["network"]["network_cap"] == 0.4
    assert response.json()["state"] == "ready"
    assert "/private" not in response.text


def test_both_endpoints_require_existing_coordinator_token(tmp_path: Path) -> None:
    with make_client(tmp_path, token="test-token") as client:
        assert client.get("/api/synapse/status").status_code == 401
        assert client.post("/api/synapse/questions", json={"question": "Question"}).status_code == 401
