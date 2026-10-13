"""``/api/companion``: the person's own screen (and a helper at the Mac) manages the companion.

These routes sit behind the coordinator token like the rest of ``/api`` and are never served to phones.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field

from .models import Applied, Decision, Details, EnableRequest, Favourite, MacNoteRequest, Presence
from .runtime import CompanionRuntime


class PapersFolderView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display: str = Field(max_length=300)
    choice: str | None = Field(default=None, max_length=20)


class Snapshot(BaseModel):
    """What the Mac keeps that a phone may edit: shown on the phone so it edits what's really there."""

    model_config = ConfigDict(extra="forbid")

    phrases: list[str] = Field(default_factory=list, max_length=200)
    favourites: list[Favourite] = Field(default_factory=list, max_length=48)
    papers_folder: PapersFolderView | None = None
    details: Details | None = None


def runtime(request: Request) -> CompanionRuntime:
    rt: CompanionRuntime = request.app.state.agency.companion
    return rt


def build_router() -> APIRouter:
    api = APIRouter(prefix="/api/companion")

    @api.get("/status")
    async def status(request: Request) -> dict[str, Any]:
        return runtime(request).status()

    @api.post("/enabled")
    async def enabled(body: EnableRequest, request: Request) -> dict[str, Any]:
        rt = runtime(request)
        await rt.set_enabled(body.enabled)
        return rt.status()

    @api.post("/pair")
    async def pair(request: Request) -> dict[str, Any]:
        rt = runtime(request)
        code = rt.service.start_pairing()
        rt.limits.reset()  # a fresh code gets fresh tries
        url = rt.config.base_url()
        return code | {"url": url, "link": f"{url}/#pair={code['code']}"}

    @api.post("/pair/cancel")
    async def cancel_pair(request: Request) -> dict[str, Any]:
        rt = runtime(request)
        rt.service.cancel_pairing()
        return rt.status()

    @api.delete("/devices/{device_id}")
    async def revoke(device_id: str, request: Request) -> dict[str, Any]:
        return runtime(request).service.revoke(device_id)

    @api.get("/changes")
    async def changes(request: Request, limit: int = 50) -> list[dict[str, Any]]:
        return runtime(request).service.changes(limit)

    @api.get("/open")
    async def open_changes(request: Request) -> list[dict[str, Any]]:
        return runtime(request).service.open_changes()

    @api.post("/changes/{change_id}/decision")
    async def decide(change_id: int, body: Decision, request: Request) -> dict[str, Any]:
        return await runtime(request).service.decide(change_id, body.allow)

    @api.post("/changes/{change_id}/applied")
    async def applied(change_id: int, body: Applied, request: Request) -> dict[str, Any]:
        return runtime(request).service.applied_on_mac(change_id, body.ok, body.reason)

    @api.put("/snapshot")
    async def snapshot(body: Snapshot, request: Request) -> dict[str, Any]:
        runtime(request).service.set_snapshot(body.model_dump())
        return {"ok": True}

    @api.post("/presence")
    async def presence(body: Presence, request: Request) -> dict[str, Any]:
        runtime(request).service.set_presence(body)
        return {"ok": True}

    @api.get("/inbox")
    async def inbox(request: Request) -> list[dict[str, Any]]:
        return runtime(request).service.inbox()

    @api.post("/messages/{message_id}/seen")
    async def seen(message_id: int, request: Request) -> dict[str, Any]:
        return runtime(request).service.mark_seen(message_id)

    @api.get("/notes")
    async def notes(request: Request) -> list[dict[str, Any]]:
        return runtime(request).service.notes()

    @api.post("/notes")
    async def add_note(body: MacNoteRequest, request: Request) -> dict[str, Any]:
        author = body.author.strip() or "At the Mac"
        return runtime(request).service.add_note(author, body.text)

    return api
