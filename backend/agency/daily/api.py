"""HTTP routes for daily living's "tell my carer": ``/api/daily/*``.

Behind the coordinator token like the rest of ``/api``. The service is built lazily from the
coordinator's database and Lifeline, so mounting it is one line in ``main.py``. Tests replace the
clock by setting ``app.state.daily_clock`` before the first request.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from .models import DailySettings, PrepareRequest, SendRequest
from .service import DailyError, DailyService


def get_service(request: Request) -> DailyService:
    state = request.app.state
    agency = state.agency
    svc: DailyService | None = getattr(state, "daily", None)
    if svc is None or svc.db is not agency.db:
        svc = DailyService(agency.db, channels=lambda: agency.lifeline.channels, lifeline=lambda: agency.lifeline.settings())
        clock = getattr(state, "daily_clock", None)
        if clock is not None:
            svc.clock = clock
        state.daily = svc
    return svc


def daily_router() -> APIRouter:
    api = APIRouter(prefix="/api/daily")

    def refuse(exc: DailyError) -> HTTPException:
        return HTTPException(status_code=409, detail=str(exc))

    @api.get("/settings")
    async def get_settings(request: Request) -> dict[str, Any]:
        return get_service(request).view()

    @api.put("/settings")
    async def put_settings(body: DailySettings, request: Request) -> dict[str, Any]:
        svc = get_service(request)
        try:
            svc.save_settings(body)
        except DailyError as exc:
            raise refuse(exc) from exc
        return svc.view()

    @api.post("/prepare")
    async def prepare(body: PrepareRequest, request: Request) -> dict[str, Any]:
        try:
            return get_service(request).prepare(body)
        except DailyError as exc:
            raise refuse(exc) from exc

    @api.post("/send")
    async def send(body: SendRequest, request: Request) -> dict[str, Any]:
        try:
            return await get_service(request).send(body.ticket)
        except DailyError as exc:
            raise refuse(exc) from exc

    @api.post("/cancel")
    async def cancel(body: SendRequest, request: Request) -> dict[str, Any]:
        get_service(request).cancel(body.ticket)
        return {"ok": True}

    @api.get("/messages")
    async def messages(request: Request, limit: int = Query(default=50, ge=1, le=200)) -> dict[str, Any]:
        return {"messages": get_service(request).messages(limit)}

    return api
