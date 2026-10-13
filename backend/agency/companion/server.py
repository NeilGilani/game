"""The phone server: a second, small web server on the home network, only while caregiver phones are on.

It serves the companion web app (``frontend/companion.html``), its JSON API under ``/phone/api`` and Lifeline's
response pages (``/respond/{token}``, the same pages a contact's text message links to). It has no route into
``/api``: the person's own interface stays on this computer only, behind the coordinator token.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from ..lifeline.api import build_routers as lifeline_routers
from .config import CompanionConfig
from .models import LinkRequest, MessageRequest, NoteRequest, PairRequest
from .security import RateLimiter, host_allowed, is_home_address
from .service import CompanionError, CompanionService

log = logging.getLogger("agency.companion")

MAX_BODY = 2_000_000
PAGE_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
)
HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
}
NOT_PAIRED = "This phone isn't paired with AGENCY. Ask for a pairing code at the Mac."


class Limits:
    """Rate limits for the phone server. Pairing is the only door without a token, so it is the tightest."""

    def __init__(self) -> None:
        self.pair_per_address = RateLimiter(10, 60)
        self.pair_overall = RateLimiter(30, 600)
        self.per_address = RateLimiter(240, 60)
        self.messages = RateLimiter(12, 600)
        self.notes = RateLimiter(30, 600)

    def reset(self) -> None:
        for limiter in (self.pair_per_address, self.pair_overall, self.per_address, self.messages, self.notes):
            limiter.reset()


def _too_many(seconds: int) -> JSONResponse:
    return JSONResponse(
        {"detail": f"Too many tries. Wait {seconds} seconds and try again."},
        status_code=429,
        headers={"Retry-After": str(seconds), **HEADERS},
    )


def build_phone_app(
    state: Any, service: CompanionService, config: CompanionConfig, frontend_dist: Path | None, limits: Limits
) -> FastAPI:
    app = FastAPI(title="AGENCY caregiver companion", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.agency = state  # Lifeline's response pages read the coordinator from here

    @app.middleware("http")
    async def guard(request: Request, call_next: Callable[[Request], Any]) -> Any:
        client = request.client.host if request.client else None
        if not is_home_address(client, config.extra_networks):
            return PlainTextResponse("AGENCY's caregiver companion only answers on the home network.", 403, headers=HEADERS)
        if not host_allowed(request.headers.get("host"), config.public_url):
            return PlainTextResponse("Open the companion with the address shown on the Mac.", 421, headers=HEADERS)
        if not service.enabled():
            return PlainTextResponse("Caregiver phones are turned off on the Mac.", 503, headers=HEADERS)
        if request.method in {"POST", "PUT", "DELETE", "PATCH"}:
            length = request.headers.get("content-length")
            if length is None and request.url.path.startswith("/phone/api/"):
                return JSONResponse({"detail": "Missing request size."}, 411, headers=HEADERS)
            if length is not None and (not length.isdigit() or int(length) > MAX_BODY):
                return JSONResponse({"detail": "That's too big to send. Try a smaller photo."}, 413, headers=HEADERS)
        key = client or "?"
        if not limits.per_address.allow(key):
            return _too_many(limits.per_address.retry_after(key))
        response = await call_next(request)
        for k, v in HEADERS.items():
            response.headers.setdefault(k, v)
        if request.url.path.startswith("/phone/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(CompanionError)
    async def companion_error(_: Request, exc: CompanionError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    api = APIRouter(prefix="/phone/api")

    def device_of(request: Request) -> dict[str, Any]:
        auth = request.headers.get("authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        device = service.authenticate(token)
        if device is None:
            raise CompanionError(NOT_PAIRED, 401)
        return device

    @api.post("/pair")
    async def pair(body: PairRequest, request: Request) -> dict[str, Any]:
        key = request.client.host if request.client else "?"
        if not limits.pair_per_address.allow(key):
            raise CompanionError(f"Too many tries. Wait {limits.pair_per_address.retry_after(key)} seconds.", 429)
        if not limits.pair_overall.allow("all"):
            raise CompanionError("Too many pairing tries. Show a new code on the Mac in a few minutes.", 429)
        device, token = service.pair(body.code, body.name, body.contact_id)
        return {"token": token, "device": device}

    @api.get("/me")
    async def me(request: Request) -> dict[str, Any]:
        return service.device(device_of(request)["id"])

    @api.post("/me/link")
    async def link(body: LinkRequest, request: Request) -> dict[str, Any]:
        return service.link(device_of(request), body.contact_id)

    @api.post("/me/forget")
    async def forget(request: Request) -> dict[str, Any]:
        device = device_of(request)
        service.revoke(device["id"])
        return {"ok": True}

    @api.get("/home")
    async def home(request: Request) -> dict[str, Any]:
        return service.home(device_of(request))

    @api.get("/setup")
    async def setup(request: Request) -> dict[str, Any]:
        device_of(request)
        return service.setup()

    @api.put("/setup/{kind}")
    async def change(kind: str, request: Request) -> dict[str, Any]:
        device = device_of(request)
        try:
            body = await request.json()
        except ValueError as exc:
            raise CompanionError("That wasn't understood.", 400) from exc
        if not isinstance(body, dict):
            raise CompanionError("That wasn't understood.", 400)
        return await service.submit(device, kind, body)

    @api.get("/notes")
    async def notes(request: Request) -> list[dict[str, Any]]:
        device_of(request)
        return service.notes()

    @api.post("/notes")
    async def add_note(body: NoteRequest, request: Request) -> dict[str, Any]:
        device = device_of(request)
        if not limits.notes.allow(device["id"]):
            raise CompanionError("That's a lot of notes at once. Wait a few minutes.", 429)
        return service.add_note(device["name"], body.text, device["id"])

    @api.get("/messages")
    async def messages(request: Request) -> list[dict[str, Any]]:
        return service.sent_by(device_of(request)["id"])

    @api.post("/messages")
    async def send(body: MessageRequest, request: Request) -> dict[str, Any]:
        device = device_of(request)
        if not limits.messages.allow(device["id"]):
            raise CompanionError("That's a lot of messages at once. Wait a few minutes.", 429)
        return service.send_message(device, body.text, body.photo)

    app.include_router(api)
    _, respond_pages = lifeline_routers(demo_controls=False)
    app.include_router(respond_pages)

    page = frontend_dist / "companion.html" if frontend_dist else None
    if frontend_dist and (frontend_dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=frontend_dist / "assets"), name="assets")

    @app.get("/", response_model=None)
    async def index() -> FileResponse | PlainTextResponse:
        if page is None or not page.is_file():
            return PlainTextResponse("The companion app isn't built on this computer yet (make build).", 503)
        return FileResponse(page, headers={"Content-Security-Policy": PAGE_CSP, "Cache-Control": "no-cache"})

    return app


class _QuietServer(uvicorn.Server):
    """A uvicorn server that leaves signal handling to the coordinator it runs inside."""

    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        yield


class CompanionListener:
    """Starts and stops the phone server inside the coordinator's own event loop."""

    def __init__(self, config: CompanionConfig) -> None:
        self.config = config
        self.app: FastAPI | None = None
        self._server: _QuietServer | None = None
        self._task: asyncio.Task[None] | None = None
        self.error: str | None = None

    @property
    def listening(self) -> bool:
        return bool(self._server and self._server.started and self._task and not self._task.done())

    async def start(self, app: FastAPI) -> bool:
        if self.listening:
            return True
        await self.stop()
        self.error = None
        cfg = uvicorn.Config(
            app,
            host=self.config.host,
            port=self.config.port,
            log_level="warning",
            lifespan="off",
            proxy_headers=False,
            server_header=False,
            ssl_certfile=self.config.tls_cert,
            ssl_keyfile=self.config.tls_key,
        )
        server = _QuietServer(cfg)
        self._server = server

        async def run() -> None:
            try:
                await server.serve()
            except (SystemExit, OSError) as exc:  # uvicorn exits when the port is taken or the certificate is bad
                self.error = f"The phone server couldn't start on port {self.config.port} ({exc or 'address in use'})."
                log.warning(self.error)

        self._task = asyncio.create_task(run())
        for _ in range(200):  # up to ~5 s
            if server.started or self._task.done():
                break
            await asyncio.sleep(0.025)
        if not server.started and not self.error:
            self.error = f"The phone server couldn't start on port {self.config.port}."
        if self.error:
            await self.stop()
            return False
        log.info("Caregiver companion listening on %s", self.config.base_url())
        return True

    async def stop(self) -> None:
        server, task = self._server, self._task
        self._server, self._task = None, None
        if server is not None:
            server.should_exit = True
        if task is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(task, timeout=5)
