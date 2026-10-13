"""HTTP routes for My day.

``/api/daily/*`` is the person's interface (behind the coordinator token like the rest of ``/api``).
``/carer/{token}`` is the page a carer opens from a request's text: outside ``/api``, so it needs no coordinator
token; the unguessable per-request token in the path is the credential, and it opens that one request only.
"""

from __future__ import annotations

import re
from html import escape
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from ..lifeline.api import RESPONSE_HEADERS
from .models import DAY, DailySettings, ItemsBody, MarkBody, RequestBody, RoutineLaterBody, RoutinesBody
from .service import REPLY_WORDS, DailyError, DailyService

DAY_RE = re.compile(DAY)


def daily(request: Request) -> DailyService:
    """The service, made on first use from the coordinator's database and Lifeline's channels."""
    existing: DailyService | None = getattr(request.app.state, "daily", None)
    if existing is not None:
        return existing
    agency = request.app.state.agency
    service = DailyService(
        agency.db,
        agency.lifeline.channels,
        agency.lifeline.settings,
        public_url=agency.lifeline.public_url,
    )
    request.app.state.daily = service
    return service


def _refuse(exc: DailyError) -> HTTPException:
    return HTTPException(409, str(exc))


def build_routers() -> tuple[APIRouter, APIRouter]:
    api = APIRouter(prefix="/api/daily")

    @api.get("")
    async def state(request: Request, day: str) -> dict[str, Any]:
        if not DAY_RE.match(day):
            raise HTTPException(422, "day must look like 2026-10-12")
        return daily(request).state(day)

    @api.put("/settings")
    async def put_settings(body: DailySettings, request: Request) -> dict[str, Any]:
        try:
            return daily(request).save_settings(body).model_dump()
        except DailyError as exc:
            raise _refuse(exc) from exc

    @api.put("/items")
    async def put_items(body: ItemsBody, request: Request) -> dict[str, Any]:
        return {"items": [i.model_dump() for i in daily(request).save_items(body.items)]}

    @api.put("/routines")
    async def put_routines(body: RoutinesBody, request: Request) -> dict[str, Any]:
        return {"routines": [r.model_dump() for r in daily(request).save_routines(body.routines)]}

    @api.post("/marks")
    async def mark(body: MarkBody, request: Request) -> dict[str, Any]:
        try:
            return {"marks": daily(request).mark(body)}
        except DailyError as exc:
            raise _refuse(exc) from exc

    @api.post("/routines/{routine_id}/done")
    async def routine_done(routine_id: str, request: Request) -> dict[str, Any]:
        try:
            return daily(request).routine_done(routine_id)
        except DailyError as exc:
            raise _refuse(exc) from exc

    @api.post("/routines/{routine_id}/later")
    async def routine_later(routine_id: str, body: RoutineLaterBody, request: Request) -> dict[str, Any]:
        try:
            return daily(request).routine_later(routine_id, body.minutes)
        except DailyError as exc:
            raise _refuse(exc) from exc

    @api.post("/requests")
    async def make_request(body: RequestBody, request: Request) -> dict[str, Any]:
        try:
            return await daily(request).request(body)
        except DailyError as exc:
            raise _refuse(exc) from exc

    @api.get("/requests")
    async def requests(request: Request, limit: int = 20) -> list[dict[str, Any]]:
        return daily(request).requests(max(1, min(limit, 50)))

    @api.get("/outbox")
    async def outbox(request: Request) -> dict[str, Any]:
        return {"simulated": True, "messages": daily(request).outbox()}

    public = APIRouter(prefix="/carer")

    def _page(html: str, status: int = 200) -> HTMLResponse:
        return HTMLResponse(html, status_code=status, headers=RESPONSE_HEADERS)

    @public.get("/{token}", response_class=HTMLResponse)
    async def carer_page(token: str, request: Request, done: str | None = None) -> HTMLResponse:
        service = daily(request)
        found = service.find(token)
        if not found:
            return _page(render_invalid(), 404)
        return _page(render(found, service.person(), expired=service.expired(found), done=done))

    @public.post("/{token}/{reply}", response_model=None)
    async def carer_reply(token: str, reply: str, request: Request) -> RedirectResponse | HTMLResponse:
        service = daily(request)
        try:
            found = service.reply(token, reply)
        except DailyError:
            return RedirectResponse(f"/carer/{token}?done=old", status_code=303, headers=RESPONSE_HEADERS)
        if not found:
            return _page(render_invalid(), 404)
        return RedirectResponse(f"/carer/{token}?done={reply}", status_code=303, headers=RESPONSE_HEADERS)

    return api, public


CSS = """
*{box-sizing:border-box}
body{margin:0;font:18px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f4f4f0;color:#151515}
main{max-width:34rem;margin:0 auto;padding:16px}
.banner{border-radius:14px;padding:18px;margin:0 0 16px;color:#fff;background:#2f5d8a}
.banner.ended{background:#4a4a4a}
.banner h1{margin:0 0 6px;font-size:1.45rem;line-height:1.2}.banner p{margin:0}
.says{margin:10px 0 0;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,.22);font-weight:700;font-size:1.2rem}
.flash{background:#fff;border:3px solid #1e6b3a;border-radius:12px;padding:12px 14px;margin:0 0 16px;font-weight:600}
form{margin:0 0 12px}
button{display:flex;align-items:center;justify-content:center;width:100%;min-height:64px;border:0;border-radius:14px;
font:inherit;font-weight:700;font-size:1.2rem;cursor:pointer;padding:8px 12px}
.go{background:#1e6b3a;color:#fff}.soon{background:#fff;color:#1e6b3a;border:3px solid #1e6b3a}
.no{background:#fff;color:#151515;border:2px solid #8a8a8a}
.small{font-size:.9rem;color:#444}
"""

FLASH = {
    "coming": "Thank you. {name} can see that you're on your way.",
    "soon": "Thank you. {name} can see that you'll come in a few minutes.",
    "cant": "Thanks for letting {name} know. They can ask someone else.",
    "old": "This request is too old to answer. If you're worried, call or visit.",
}


def _doc(title: str, body: str) -> str:
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{escape(title)}</title><style>{CSS}</style></head><body><main>{body}</main></body></html>"
    )


def render_invalid() -> str:
    return _doc(
        "AGENCY",
        '<div class="banner ended"><h1>This link doesn\'t work</h1><p>It may be mistyped or very old.</p></div>',
    )


def render(r: dict[str, Any], person: str, *, expired: bool, done: str | None) -> str:
    name = escape(person)
    parts: list[str] = []
    if done in FLASH:
        parts.append(f'<p class="flash" role="status">{escape(FLASH[done].format(name=person))}</p>')
    banner = "banner ended" if expired else "banner"
    parts.append(
        f'<div class="{banner}"><h1>{name} is asking for you</h1><p>Not an emergency.</p>'
        f'<p class="says">"{escape(r["text"])}"</p></div>'
    )
    if r["reply"]:
        parts.append(f'<p class="small">Your answer: <strong>{escape(REPLY_WORDS[r["reply"]])}</strong>. You can change it.</p>')
    if expired:
        parts.append('<p class="small">This request is too old to answer.</p>')
    else:
        token = escape(r["token"])
        for reply, cls in (("coming", "go"), ("soon", "soon"), ("cant", "no")):
            parts.append(
                f'<form method="post" action="/carer/{token}/{reply}"><button class="{cls}">{REPLY_WORDS[reply]}</button></form>'
            )
    parts.append(
        '<p class="small">Sent by AGENCY, the computer they use with their eyes. Your answer shows on their screen. '
        "For emergencies AGENCY uses Lifeline, which sends a different message.</p>"
    )
    return _doc(f"{person} is asking for you", "".join(parts))
