"""HTTP routes for Lifeline.

``/api/lifeline/*`` is the person's interface (behind the coordinator token like the rest of
``/api``). ``/respond/{token}`` is for contacts' phones: outside ``/api``, so it needs no
coordinator token; the unguessable per-message token in the path is the credential.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from .models import CheckinResponse, Heartbeat, HelpRequest, LifelineSettings, MonitoringRequest
from .respond import render, render_invalid
from .service import LifelineError, LifelineService

RESPONSE_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
}


def lifeline(request: Request) -> LifelineService:
    service: LifelineService = request.app.state.agency.lifeline
    return service


def build_routers(*, demo_controls: bool) -> tuple[APIRouter, APIRouter]:
    api = APIRouter(prefix="/api/lifeline")

    @api.get("/status")
    async def status(request: Request) -> dict[str, Any]:
        return lifeline(request).status()

    @api.get("/settings")
    async def get_settings(request: Request) -> dict[str, Any]:
        return lifeline(request).settings().model_dump()

    @api.put("/settings")
    async def put_settings(body: LifelineSettings, request: Request) -> dict[str, Any]:
        return lifeline(request).save_settings(body).model_dump()

    @api.post("/help")
    async def help_request(body: HelpRequest, request: Request) -> dict[str, Any]:
        alert, created = await lifeline(request).trigger("help", body.source, is_test=body.test)
        return {"alert": alert, "created": created}

    @api.get("/alerts")
    async def alerts(request: Request, limit: int = 20) -> list[dict[str, Any]]:
        return lifeline(request).recent(max(1, min(limit, 100)))

    @api.get("/alerts/{alert_id}")
    async def alert(alert_id: str, request: Request) -> dict[str, Any]:
        try:
            return lifeline(request).alert_detail(alert_id)
        except LifelineError as exc:
            raise HTTPException(404, str(exc)) from exc

    @api.post("/alerts/{alert_id}/cancel")
    async def cancel(alert_id: str, request: Request) -> dict[str, Any]:
        return await lifeline(request).cancel(alert_id)

    @api.post("/alerts/{alert_id}/now")
    async def call_now(alert_id: str, request: Request) -> dict[str, Any]:
        return await lifeline(request).activate_now(alert_id)

    @api.post("/alerts/{alert_id}/resolve")
    async def resolve(alert_id: str, request: Request) -> dict[str, Any]:
        service = lifeline(request)
        return await service.resolve(alert_id, by=service.settings().responder.person_name or "the person", actor="user")

    @api.post("/heartbeat")
    async def heartbeat(body: Heartbeat, request: Request) -> dict[str, Any]:
        return await lifeline(request).heartbeat(body.model_dump())

    @api.post("/monitoring")
    async def monitoring(body: MonitoringRequest, request: Request) -> dict[str, Any]:
        return await lifeline(request).set_armed(body.armed)

    @api.post("/checkin")
    async def checkin(body: CheckinResponse, request: Request) -> dict[str, Any]:
        return await lifeline(request).checkin_ok(body.source)

    @api.get("/outbox")
    async def outbox(request: Request) -> dict[str, Any]:
        return {"simulated": True, "real_world_delivery": False, "messages": lifeline(request).outbox()}

    @api.get("/report")
    async def report(request: Request) -> dict[str, Any]:
        return lifeline(request).report()

    @api.post("/demo/checkin-now")
    async def checkin_now(request: Request) -> dict[str, Any]:
        if not demo_controls:
            raise HTTPException(403, "Demo controls are disabled on this coordinator.")
        return await lifeline(request).checkin_now()

    public = APIRouter(prefix="/respond")

    def _page(html: str, status: int = 200) -> HTMLResponse:
        return HTMLResponse(html, status_code=status, headers=RESPONSE_HEADERS)

    @public.get("/{token}", response_class=HTMLResponse)
    async def respond_page(token: str, request: Request, done: str | None = None, confirm: str | None = None) -> HTMLResponse:
        service = lifeline(request)
        found = service.find_notification(token)
        if not found:
            return _page(render_invalid(), 404)
        notification, detail = found
        return _page(render(detail, notification, service.settings(), token, done, confirm_resolve=confirm == "resolve"))

    @public.post("/{token}/{action}", response_model=None)
    async def respond_action(token: str, action: str, request: Request) -> RedirectResponse | HTMLResponse:
        if action not in {"ack", "decline", "resolve"}:
            return _page(render_invalid(), 404)
        try:
            _, _, outcome = await lifeline(request).respond(token, action)
        except LifelineError:
            return _page(render_invalid(), 404)
        return RedirectResponse(f"/respond/{token}?done={outcome}", status_code=303, headers=RESPONSE_HEADERS)

    return api, public
