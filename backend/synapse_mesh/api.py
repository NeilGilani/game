import asyncio
import json
from contextlib import aclosing, asynccontextmanager, suppress
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from .runtime import ROOT, Runtime
from .orchestrator import Orchestrator
from .cisco_sentinel import CiscoSentinel
from .intent_orchestrator import IntentOrchestrator

runtime = Runtime()
sentinel = CiscoSentinel.from_env()
reasoner = IntentOrchestrator(runtime, sentinel, remote_execution=True)
orchestrator = Orchestrator(runtime, intent_orchestrator=reasoner)


@asynccontextmanager
async def lifespan(app):
    await asyncio.to_thread(sentinel.poll)
    async def poll_network():
        while True:
            await asyncio.sleep(sentinel.poll_interval)
            await asyncio.to_thread(sentinel.poll)
    task = asyncio.create_task(poll_network())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        if hasattr(orchestrator, 'aclose'):
            await orchestrator.aclose()


app = FastAPI(title="Synapse-Mesh Edge Controller", lifespan=lifespan)


class CompareRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    max_new_tokens: int = Field(default=192, ge=16, le=512)
    weights: dict[str, float] | None = None
    experts: list[str] | None = None


class WeightRequest(CompareRequest):
    request_id: int = Field(default=0, ge=0)


@app.websocket('/ws/weights')
async def weight_stream(socket: WebSocket):
    """One ordered vector per prompt/slider update; local intent encoding only."""
    await socket.accept()
    await socket.send_json({'event': 'ready'})
    try:
        while True:
            request_id = 0
            try:
                body = WeightRequest.model_validate(await socket.receive_json())
                request_id = body.request_id
                result = await asyncio.to_thread(reasoner.plan, body.prompt, body.weights, body.experts)
                await socket.send_json({'event': 'weights', 'request_id': request_id, **result})
            except (ValueError, ValidationError, RuntimeError) as error:
                await socket.send_json({'event': 'error', 'request_id': request_id, 'message': str(error)})
    except WebSocketDisconnect:
        pass


@app.get("/health")
def health():
    return {"status": "ready" if runtime.model else "cold", "base_model": runtime.base_model,
            "device": "edge", "vault": runtime.vault_status(), "engine": "cloud-edge-client", "automatic_selection": True,
            "cloud_configured": bool(getattr(getattr(orchestrator, 'cloud', None), 'endpoint', '')),
            "network": sentinel.snapshot().to_dict(), "safe_mode_ready": runtime.generalist_ready,
            "fusion_layer_count": runtime.last_audit['layer_count'] if runtime.last_audit else None}


@app.get("/proof")
def proof():
    return json.loads((ROOT / "data/proof.json").read_text())


@app.post("/intent")
def intent(body: CompareRequest):
    try:
        return reasoner.plan(body.prompt, body.weights, body.experts)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error


@app.get('/network')
def network():
    return sentinel.snapshot().to_dict()


class MockNetworkRequest(BaseModel):
    state: Literal['OPTIMAL', 'CONGESTED', 'CRITICAL', 'OFFLINE']


@app.post('/network/mock')
def mock_network(body: MockNetworkRequest):
    try:
        return sentinel.set_mock_state(body.state).to_dict()
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@app.post("/compare")
async def compare(body: CompareRequest):
    return event_response(body, compare=True)


@app.post("/generate")
async def generate(body: CompareRequest):
    return event_response(body, compare=False)


def event_response(body, *, compare):
    async def stream():
        try:
            async with aclosing(orchestrator.events(body.prompt, body.max_new_tokens, body.weights,
                                                   body.experts, compare=compare)) as events:
                async for event in events:
                    yield json.dumps(event, allow_nan=False) + "\n"
        except Exception as error:
            yield json.dumps({"event": "error", "message": str(error)}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class AdapterRequest(BaseModel):
    repo_id: str = Field(min_length=3, max_length=200)
    subfolder: str = Field(default='', max_length=200)
    revision: str | None = Field(default=None, max_length=100)
    expertise: str = Field(default='', max_length=500)


def cloud_call(operation):
    if sentinel.snapshot().state == 'OFFLINE':
        raise HTTPException(503, 'Cloud discovery/downloads are paused during offline Safe-Mode')
    try:
        return operation()
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except Exception as error:
        raise HTTPException(502, 'Hugging Face request failed: ' + str(error)) from error


@app.get('/catalog')
def catalog(q: str = Query(default='', max_length=200),
            scope: str = Query(default='all', pattern='^(all|adapters|compatible)$'),
            cursor: str | None = Query(default=None, max_length=12000)):
    return cloud_call(lambda: runtime.catalog.search(q, scope, cursor))


@app.post('/catalog/inspect')
def inspect_adapter(body: AdapterRequest):
    return cloud_call(lambda: runtime.catalog.inspect(body.repo_id, body.subfolder, body.revision))


@app.post('/catalog/install')
def install_adapter(body: AdapterRequest):
    return cloud_call(lambda: runtime.catalog.install(body.repo_id, body.subfolder, body.revision, body.expertise))
