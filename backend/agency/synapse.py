"""Question answering through the resident Synapse-Mesh tensor fusion service.

This is transport to our kernel, not a second LLM provider. The question goes
unchanged to /generate; intent, Cisco budgeting and LoRA math stay in the kernel.
No profile, camera frames, conversation history or tool permissions are attached.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator


class QuestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=8000)
    max_new_tokens: int | None = Field(default=None, ge=16, le=32768, strict=True)

    @field_validator("question")
    @classmethod
    def nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Enter a question.")
        return value


def encode(event: dict[str, Any]) -> str:
    return json.dumps(event, allow_nan=False) + "\n"


def build_router(url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> APIRouter:
    router = APIRouter(prefix="/api/synapse", tags=["Synapse-Mesh"])

    def client() -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=url, transport=transport, timeout=httpx.Timeout(120, connect=3), trust_env=False)

    @router.get("/status")
    async def status() -> dict[str, Any]:
        try:
            async with client() as connection:
                response = await connection.get("/health", timeout=3)
                response.raise_for_status()
                health = response.json()
            if health.get("engine") not in {"raw-tensor-fusion", "cloud-edge-client"}:
                return {"state": "offline", "message": "This address is not a Synapse-Mesh kernel."}
            network = health.get("network", {})
            return {
                "state": "busy" if health.get("busy") else "ready" if health.get("status") == "ready" else "cold",
                "model": health.get("base_model"),
                "device": health.get("device"),
                "execution_mode": health.get("execution_mode"),
                "network": {key: network.get(key) for key in ("state", "source", "network_cap")},
            }
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            return {"state": "offline", "message": "Start the Synapse-Mesh kernel or check AGENCY_SYNAPSE_URL."}

    @router.post("/questions")
    async def question(body: QuestionRequest) -> StreamingResponse:
        connection = client()
        upstream: httpx.Response | None = None
        try:
            upstream = await connection.send(
                connection.build_request(
                    "POST", "/generate", json={"prompt": body.question, "max_new_tokens": body.max_new_tokens}
                ),
                stream=True,
            )
            upstream.raise_for_status()
        except httpx.HTTPError as error:
            if upstream is not None:
                await upstream.aclose()
            await connection.aclose()
            raise HTTPException(503, "Synapse-Mesh couldn't answer. Check that the kernel is running.") from error

        async def events() -> AsyncIterator[str]:
            response_seen = False
            fusion_seen = False
            completed = False
            try:
                async for line in upstream.aiter_lines():
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    if not isinstance(event, dict) or not isinstance(event.get("event"), str):
                        raise ValueError("Invalid kernel event")
                    kind = event["event"]
                    if kind == "fusion":
                        fusion_seen = isinstance(event.get("layer_count"), int) and event["layer_count"] > 0
                    if kind == "response":
                        response_seen = isinstance(event.get("text"), str) and bool(event["text"].strip())
                    if kind == "complete":
                        if not fusion_seen or not response_seen or event.get("base_restored") is not True:
                            raise ValueError("The kernel didn't confirm tensor fusion, an answer and restored base weights")
                        completed = True
                    # Pass the kernel's actual coefficients and audit through unchanged.
                    yield encode(event)
                    if kind in {"error", "complete"}:
                        return
                if not completed:
                    raise ValueError("The kernel stream ended before completion")
            except (httpx.HTTPError, ValueError, TypeError):
                yield encode({"event": "error", "message": "The answer was interrupted. You can try again."})
            finally:
                # Disconnecting/Stop closes the upstream stream, signalling its
                # worker to stop generation and restore the original base weights.
                await upstream.aclose()
                await connection.aclose()

        return StreamingResponse(
            events(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return router
