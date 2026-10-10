"""HTTP routes for Lifeline.

``/api/lifeline/*`` is the person's interface (behind the coordinator token like the rest of
``/api``). ``/respond/{token}`` is for contacts' phones: outside ``/api``, so it needs no
coordinator token; the unguessable per-message token in the path is the credential.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from .models import (
    CheckinResponse,
    DispatchRequest,
    Heartbeat,
    HelpRequest,
    LifelineSettings,
    MonitoringRequest,
    QuestionAnswer,
    SituationRequest,
)
from .rescue import PRESET_QUESTIONS
from .respond import VIEWS, render, render_invalid
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

    @api.post("/alerts/{alert_id}/situation")
    async def situation(alert_id: str, body: SituationRequest, request: Request) -> dict[str, Any]:
        return await lifeline(request).set_situation(alert_id, body.situation)

    @api.post("/questions/{question_id}/answer")
    async def answer(question_id: str, body: QuestionAnswer, request: Request) -> dict[str, Any]:
        return await lifeline(request).answer(question_id, body.answer)

    @api.post("/alerts/{alert_id}/dispatch")
    async def dispatch(alert_id: str, body: DispatchRequest, request: Request) -> dict[str, Any]:
        service = lifeline(request)
        name = service.settings().responder.person_name or "The person"
        return await service.request_dispatch(
            alert_id, requested_by=name, reason=body.reason or f"{name} asked for emergency services"
        )

    @api.post("/alerts/{alert_id}/dispatch/cancel")
    async def dispatch_cancel(alert_id: str, request: Request) -> dict[str, Any]:
        service = lifeline(request)
        return await service.cancel_dispatch(alert_id, by=service.settings().responder.person_name or "the person")

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
        view = confirm if confirm in VIEWS else None
        return _page(render(detail, notification, service, token, done, view=view))

    def _back(token: str, outcome: str) -> RedirectResponse:
        return RedirectResponse(f"/respond/{token}?done={outcome}", status_code=303, headers=RESPONSE_HEADERS)

    @public.post("/{token}/{action}", response_model=None)
    async def respond_action(token: str, action: str, request: Request) -> RedirectResponse | HTMLResponse:
        service = lifeline(request)
        try:
            if action in {"ack", "decline", "resolve"}:
                _, _, outcome = await service.respond(token, action)
            elif action == "arrived":
                _, _, outcome = await service.arrived(token)
            elif action == "unlock":
                _, _, outcome = await service.unlock_for(token)
            elif action == "dispatch":
                _, _, outcome = await service.dispatch_by_token(token)
            elif action == "dispatch-cancel":
                _, _, outcome = await service.cancel_dispatch_by_token(token)
            elif action == "ask":
                raw = (await request.body())[:2048].decode(errors="replace")
                text = (parse_qs(raw).get("text") or [""])[0]
                try:
                    _, _, outcome = await service.ask(token, text)
                except LifelineError:
                    outcome = "ask_invalid"
            else:
                return _page(render_invalid(), 404)
        except LifelineError:
            return _page(render_invalid(), 404)
        return _back(token, outcome)

    @public.post("/{token}/{action}/{arg}", response_model=None)
    async def respond_action_arg(token: str, action: str, arg: str, request: Request) -> RedirectResponse | HTMLResponse:
        service = lifeline(request)
        try:
            if action == "ask" and arg in PRESET_QUESTIONS:
                _, _, outcome = await service.ask(token, PRESET_QUESTIONS[arg])
            elif action == "step" and arg.isdigit() and len(arg) < 3:
                _, _, outcome = await service.step_done(token, int(arg))
            else:
                return _page(render_invalid(), 404)
        except LifelineError:
            return _page(render_invalid(), 404)
        return _back(token, outcome)

    return api, public
