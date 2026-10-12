"""AGENCY coordinator: the FastAPI application.

Run locally:   uvicorn agency.main:app --port 8000
On a Pi:       see DEPLOY_PI.md (binds to the LAN, requires AGENCY_API_TOKEN)
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
import os
import platform
import socket
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .assist import router as assist_router
from .config import Settings, load_settings
from .db import Database, dumps, loads, utcnow
from .engine.engine import Engine, EngineError
from .engine.runner import CaseRunner
from .lifeline.api import build_routers as lifeline_routers
from .lifeline.channels import ChannelRouter, TwilioChannel
from .lifeline.home import HomeAssistantHome
from .lifeline.service import LifelineError, LifelineService
from .memory import memory_router
from .models import (
    ACTIVE_CASE_STATUSES,
    AnswerRequest,
    BatchDecisionRequest,
    CaseStatus,
    CreateCaseRequest,
    DecisionRequest,
    EditRequest,
    FaultConfig,
    GoalRequest,
    Preferences,
    StepStatus,
)
from .network import NetworkMonitor, monitor_from_env
from .planning.planner import GOAL_CARDS, PHRASES, case_title, interpret, make_plan
from .reasoning.local import with_local_model
from .reasoning.provider import ReasoningProvider, build_provider
from .services.common import INTEGRATIONS, ServiceError
from .services.seed import ensure_seeded, seed_demo_data
from .synapse import SynapseLayer, SynapseRouter, synapse_url_from_env
from .tools.catalog import ASK_TOOL, TOOLS


class SynapseRouteRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    purpose: str = Field(default="task", max_length=40)


class NetworkDemoRequest(BaseModel):
    state: Literal["good", "slow", "critical", "offline"] | None = None


def _route_summary(route: Any) -> dict[str, Any] | None:
    if not isinstance(route, dict):
        return None
    return {k: route.get(k) for k in ("mode", "router", "network", "mixture", "decision", "note", "at", "purpose")}


log = logging.getLogger("agency")

STATUS_LABELS = {
    StepStatus.PENDING: "Planned",
    StepStatus.WAITING_INPUT: "Needs your answer",
    StepStatus.AWAITING_APPROVAL: "Needs your approval",
    StepStatus.APPROVED: "Approved, about to run",
    StepStatus.RUNNING: "Working on it",
    StepStatus.RETRYING: "Trying again",
    StepStatus.SUCCEEDED: "Done, checking",
    StepStatus.VERIFIED: "Verified",
    StepStatus.FAILED: "Failed",
    StepStatus.REJECTED: "Declined",
    StepStatus.SKIPPED: "Skipped",
    StepStatus.SUPERSEDED: "Replaced",
    StepStatus.BLOCKED: "Not done",
    StepStatus.CANCELLED: "Cancelled",
}

CASE_LABELS = {
    CaseStatus.PLANNING: "Planning",
    CaseStatus.RUNNING: "Working",
    CaseStatus.WAITING_INPUT: "Needs your answer",
    CaseStatus.WAITING_APPROVAL: "Needs your approval",
    CaseStatus.NEEDS_ATTENTION: "Needs attention",
    CaseStatus.PAUSED: "Paused",
    CaseStatus.INTERRUPTED: "Interrupted, press Resume",
    CaseStatus.COMPLETED: "Done",
    CaseStatus.COMPLETED_PARTIAL: "Finished with open items",
    CaseStatus.CANCELLED: "Cancelled",
}


def node_info(settings: Settings) -> dict[str, Any]:
    model_path = Path("/proc/device-tree/model")
    device_model = None
    if model_path.exists():
        try:
            device_model = model_path.read_text(errors="ignore").strip("\x00").strip()
        except OSError:
            device_model = None
    is_pi = bool(device_model and "Raspberry Pi" in device_model)
    role = settings.node_role if settings.node_role != "auto" else ("raspberry-pi" if is_pi else "local")
    return {
        "role": role,
        "hostname": socket.gethostname(),
        "system": platform.system(),
        "machine": platform.machine(),
        "device_model": device_model,
        "is_raspberry_pi": is_pi,
        "python": platform.python_version(),
    }


class AppState:
    def __init__(
        self,
        settings: Settings,
        db: Database,
        engine: Engine,
        runner: CaseRunner,
        provider: ReasoningProvider,
        lifeline: LifelineService,
        network: NetworkMonitor | None = None,
    ) -> None:
        self.settings = settings
        self.db = db
        self.engine = engine
        self.runner = runner
        self.provider = provider
        self.lifeline = lifeline
        layer = provider if isinstance(provider, SynapseLayer) else None
        self.network: NetworkMonitor = layer.monitor if layer else network or NetworkMonitor()
        self.synapse: SynapseRouter = layer.router if layer else SynapseRouter(monitor=self.network)
        self.started_at = utcnow()
        self.held_on_start: list[str] = []


def create_app(
    settings: Settings | None = None, *, provider: ReasoningProvider | None = None, inline_runner: bool = False
) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db = Database(settings.db_path)
        db.migrate()
        ensure_seeded(db)
        engine = Engine(db, step_delay_ms=settings.step_delay_ms)
        chosen = provider or build_provider(
            settings.reasoning,
            gemini_model=settings.gemini_model,
            anthropic_model=settings.anthropic_model,
            effort=settings.reasoning_effort,
            fallbacks=settings.anthropic_fallbacks,
            timeout_s=settings.reasoning_timeout_s,
        )
        if provider is None:
            chosen = with_local_model(chosen, dict(os.environ))
        local_model = getattr(chosen, "local", None)
        if local_model is not None and hasattr(local_model, "probe"):
            await local_model.probe()  # where it generates (this Mac or a cloud kernel); fine if it isn't up yet
        if provider is None:
            # Ray's Synapse-Mesh routes every AI request (experts + Cisco network budget); Gemini answers.
            env = dict(os.environ)
            monitor = monitor_from_env(env, cloud_configured=chosen.available)
            chosen = SynapseLayer(chosen, SynapseRouter(monitor=monitor, url=synapse_url_from_env(env)))
        layer = chosen if isinstance(chosen, SynapseLayer) else None
        network = layer.monitor if layer else NetworkMonitor()
        lifeline = LifelineService(
            db,
            ChannelRouter(engine.faults, TwilioChannel.from_env()),
            public_url=settings.response_base_url(),
            home=HomeAssistantHome.from_env(),
            network=network,
        )
        lifeline.on_startup()
        state = AppState(settings, db, engine, CaseRunner(engine, inline=inline_runner), chosen, lifeline, network)
        state.held_on_start = engine.reconcile_on_startup()
        app.state.agency = state
        supervisor = asyncio.create_task(lifeline.run(settings.lifeline_tick_s)) if settings.lifeline_loop else None

        retries: set[asyncio.Task[Any]] = set()  # held until done, so a retry can't be garbage-collected midway

        def on_network(old: str, new: str) -> None:
            # Back online after an outage: alerts that couldn't get out are sent again at once, instead of
            # waiting for the next escalation.
            if old in {"offline", "critical"} and new in {"good", "slow"}:
                task = asyncio.get_running_loop().create_task(lifeline.network_back())
                retries.add(task)
                task.add_done_callback(retries.discard)

        state.network.on_change(on_network)
        watcher = asyncio.create_task(state.network.run()) if settings.lifeline_loop and state.network.configured else None
        log.info(
            "AGENCY coordinator ready (db=%s, reasoning=%s, lifeline links=%s, twilio=%s)",
            settings.db_path,
            chosen.status()["mode"],
            lifeline.public_url,
            "configured" if lifeline.channels.twilio_configured else "off",
        )
        try:
            yield
        finally:
            for task in (supervisor, watcher):
                if task:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
            await state.runner.shutdown()
            db.close()

    app = FastAPI(title="AGENCY coordinator", version=__version__, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-Agency-Token"],
    )

    allowed_origins = set(settings.allowed_origins)

    @app.middleware("http")
    async def require_token(request: Request, call_next: Any) -> Any:
        path = request.url.path
        if settings.api_token and path.startswith("/api/") and path != "/api/health" and request.method != "OPTIONS":
            supplied = request.headers.get("X-Agency-Token", "")
            if not hmac.compare_digest(supplied, settings.api_token):
                return JSONResponse({"detail": "This coordinator needs an access token. Add it in Settings."}, status_code=401)
        elif path.startswith("/api/") and request.method not in {"GET", "HEAD", "OPTIONS"}:
            # Without a token, CORS alone doesn't stop another website open in the same browser from sending a
            # "simple" request (a POST with no body or a form body), e.g. resetting everything. Browsers say where
            # such a request comes from: only the allowed origins and the coordinator's own pages may change things.
            origin = request.headers.get("origin")
            if origin is not None and origin not in allowed_origins and urlsplit(origin).netloc != request.headers.get("host"):
                return JSONResponse({"detail": "Changes are only accepted from AGENCY's own pages."}, status_code=403)
        return await call_next(request)

    @app.exception_handler(EngineError)
    async def engine_error(_: Request, exc: EngineError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(LifelineError)
    async def lifeline_error(_: Request, exc: LifelineError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(ServiceError)
    async def service_error(_: Request, exc: ServiceError) -> JSONResponse:
        return JSONResponse({"detail": exc.message, "code": exc.code}, status_code=exc.status)

    def st(request: Request) -> AppState:
        state: AppState = request.app.state.agency
        return state

    api = APIRouter(prefix="/api")

    # -- status ---------------------------------------------------------------------------
    @api.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        s = st(request)
        try:
            schema = s.db.schema_version()
            db_ok = True
        except Exception:
            schema, db_ok = 0, False
        return {
            "status": "ok" if db_ok else "degraded",
            "service": "agency-coordinator",
            "version": __version__,
            "time": utcnow(),
            "started_at": s.started_at,
            "node": node_info(settings),
            "database": {"ok": db_ok, "schema_version": schema},
            "reasoning": {
                k: v
                for k, v in s.provider.status().items()
                if k in {"mode", "provider", "label", "model", "state", "description", "local", "private_explanations"}
            },
            "network": s.network.snapshot(),
            "synapse": {k: v for k, v in s.synapse.status().items() if k != "last_route"}
            | {"last_route": _route_summary(s.synapse.status().get("last_route"))},
            "automation_paused": s.engine.automation_paused(),
            "auth_required": bool(settings.api_token),
            "demo_controls": settings.demo_controls,
        }

    @api.get("/synapse")
    async def synapse_status(request: Request) -> dict[str, Any]:
        s = st(request)
        return {**s.synapse.status(), "network": s.network.snapshot(), "recent": s.synapse.recent(10)}

    @api.post("/synapse/route")
    async def synapse_route(body: SynapseRouteRequest, request: Request) -> dict[str, Any]:
        """Route a request through Synapse-Mesh (experts + network budget). Used by the agent before each task."""
        route = await st(request).synapse.route(body.text, body.purpose)
        return {**route.to_dict(), "brief": route.brief()}

    @api.get("/runtime")
    async def runtime(request: Request) -> dict[str, Any]:
        s = st(request)
        return {
            "node": node_info(settings),
            "database": {"path": str(settings.db_path), "schema_version": s.db.schema_version()},
            "reasoning": s.provider.status() | {"history": getattr(s.provider, "history", [])},
            "integrations": [i.as_dict() for i in INTEGRATIONS],
            "automation_paused": s.engine.automation_paused(),
            "held_on_start": s.held_on_start,
            "privacy": {
                "camera_processing": "In the browser on this device. No frames, face or eye data are sent to the coordinator or the cloud.",
                "sent_to_cloud_when_configured": "Goal text and selections, the fictional demo profile summary, the tool catalog and plan.",
                "stored": "Cases, plans, approvals, tool calls and audit events in SQLite on the coordinator.",
            },
            "settings": {
                "step_delay_ms": settings.step_delay_ms,
                "allowed_origins": settings.allowed_origins,
                "auth_required": bool(settings.api_token),
                "demo_controls": settings.demo_controls,
            },
        }

    @api.post("/runtime/check-cloud")
    async def check_cloud(request: Request) -> dict[str, Any]:
        return await st(request).provider.check()

    @api.get("/integrations")
    async def integrations() -> list[dict[str, Any]]:
        return [i.as_dict() for i in INTEGRATIONS]

    @api.get("/profile")
    async def profile(request: Request) -> dict[str, Any]:
        return st(request).engine.profile()

    @api.get("/preferences")
    async def get_preferences(request: Request) -> dict[str, Any]:
        row = st(request).db.query_one("SELECT data FROM preferences WHERE id = 1")
        return Preferences.model_validate(loads(row["data"]) if row else {}).model_dump()

    @api.put("/preferences")
    async def put_preferences(prefs: Preferences, request: Request) -> dict[str, Any]:
        st(request).db.execute(
            "INSERT INTO preferences(id, data, updated_at) VALUES (1, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (dumps(prefs.model_dump()), utcnow()),
        )
        return prefs.model_dump()

    @api.post("/system/pause")
    async def pause_all(request: Request) -> dict[str, Any]:
        st(request).engine.set_automation_paused(True)
        return {"automation_paused": True}

    @api.post("/system/resume")
    async def resume_all(request: Request) -> dict[str, Any]:
        s = st(request)
        for case_id in s.engine.set_automation_paused(False):
            await s.runner.kick(case_id)
        return {"automation_paused": False}

    # -- goals ----------------------------------------------------------------------------
    @api.get("/goals/catalog")
    async def goal_catalog(request: Request) -> dict[str, Any]:
        s = st(request)
        suggestions: list[dict[str, Any]] = []
        pending = s.engine.store.list_approvals(status="pending")
        if pending:
            suggestions.append(
                {
                    "kind": "approvals",
                    "title": f"Review {len(pending)} action{'s' if len(pending) != 1 else ''} waiting for you",
                    "case_id": pending[0]["case_id"],
                }
            )
        letter_case = None
        for case in s.engine.store.list_cases():
            if case["status"] in {CaseStatus.INTERRUPTED, CaseStatus.PAUSED, CaseStatus.NEEDS_ATTENTION}:
                suggestions.append({"kind": "resume", "title": f"Resume: {case['title']}", "case_id": case["id"]})
            summary = case.get("summary") or {}
            if letter_case is None and any("medical necessity" in f for f in summary.get("follow_ups", [])):
                letter_case = case
        if letter_case:
            suggestions.append(
                {
                    "kind": "goal",
                    "title": "Ask the clinic for the letter of medical necessity",
                    "goal_type": "message_followup",
                    "selections": {"contact_id": "c_clinic", "template": "letter_request", "follow_up": "in_3_days"},
                }
            )
        if not suggestions:
            suggestions.append(
                {
                    "kind": "goal",
                    "title": "Get my wheelchair repaired before Friday",
                    "goal_type": "equipment_repair",
                    "selections": {},
                }
            )
        return {"cards": GOAL_CARDS, "phrases": PHRASES, "suggestions": suggestions[:4]}

    @api.post("/goals/interpret")
    async def interpret_goal(body: GoalRequest, request: Request) -> dict[str, Any]:
        s = st(request)
        return await interpret(body, s.engine.profile(), s.provider)

    @api.get("/activity")
    async def activity(request: Request, limit: int = 8) -> list[dict[str, Any]]:
        """Recent verified outcomes and notable events across cases, newest first."""
        s = st(request)
        kinds = {"verified", "case_completed", "recovery_planned", "step_failed", "reconciled"}
        titles = {c["id"]: c["title"] for c in s.engine.store.list_cases()}
        events = [e for e in s.engine.store.audit_events(None, limit=400) if e["kind"] in kinds and e["case_id"]]
        return [e | {"case_title": titles.get(e["case_id"] or "", "")} for e in events[: max(1, min(limit, 30))]]

    # -- cases ----------------------------------------------------------------------------
    def case_payload(s: AppState, case_id: str) -> dict[str, Any]:
        case = s.engine.store.get_case(case_id)
        if not case:
            raise HTTPException(404, "Case not found.")
        steps = s.engine.store.get_steps(case_id)
        replaced_by = {st_["recovery_of"]: st_["id"] for st_ in steps if st_["recovery_of"]}
        for step in steps:
            spec = TOOLS.get(step["tool"])
            step["status_label"] = STATUS_LABELS[StepStatus(step["status"])]
            step["consequential"] = bool(spec and spec.consequential)
            step["read_only"] = bool(spec and spec.read_only) or step["tool"] == ASK_TOOL
            step["integration"] = next((i.name for i in INTEGRATIONS if spec and i.key == spec.integration), "AGENCY")
            step["replaced_by"] = replaced_by.get(step["id"])
            step["inputs"] = None if step["tool"] == ASK_TOOL else step["inputs"]
        approvals = s.engine.store.list_approvals(case_id=case_id, status="pending")
        counts: dict[str, int] = {}
        for step in steps:
            counts[step["status"]] = counts.get(step["status"], 0) + 1
        return case | {
            "status_label": CASE_LABELS[CaseStatus(case["status"])],
            "steps": steps,
            "pending_approvals": approvals,
            "next_actions": s.engine.next_actions(case, steps),
            "counts": counts,
            "busy": s.runner.busy(case_id),
            "last_event": s.engine.store.last_audit(case_id),
            "automation_paused": s.engine.automation_paused(),
        }

    @api.post("/cases", status_code=201)
    async def create_case(body: CreateCaseRequest, request: Request) -> dict[str, Any]:
        s = st(request)
        if body.goal.missing_info:
            raise HTTPException(422, f"Please answer first: {', '.join(body.goal.missing_info)}")
        plan, reasoning = await make_plan(body.goal, s.provider, use_cloud=body.use_cloud_plan)
        case_id = s.engine.store.create_case(
            goal=body.goal.model_dump(), title=case_title(body.goal), reasoning=reasoning, plan=plan
        )
        s.engine.store.audit(case_id, "case_created", f"Case started: {body.goal.outcome}", actor="user")
        s.engine.store.audit(
            case_id,
            "plan_created",
            f"Plan ready: {len(plan.steps)} steps, made by the {reasoning['planner']}. " + " ".join(reasoning.get("notes", [])),
            data={"mode": reasoning["mode"], "steps": [st_.id for st_ in plan.steps]},
        )
        await s.runner.kick(case_id)
        return case_payload(s, case_id)

    @api.get("/cases")
    async def list_cases(request: Request, status: str | None = None) -> list[dict[str, Any]]:
        s = st(request)
        cases = s.engine.store.list_cases()
        if status == "active":
            cases = [c for c in cases if c["status"] in ACTIVE_CASE_STATUSES]
        out = []
        for case in cases:
            steps = s.engine.store.get_steps(case["id"])
            done = sum(1 for x in steps if x["status"] in {StepStatus.VERIFIED, StepStatus.SKIPPED})
            out.append(
                case
                | {
                    "status_label": CASE_LABELS[CaseStatus(case["status"])],
                    "progress": {"done": done, "total": len(steps)},
                    "pending_approvals": len(s.engine.store.list_approvals(case_id=case["id"], status="pending")),
                }
            )
        return out

    @api.get("/cases/{case_id}")
    async def get_case(case_id: str, request: Request) -> dict[str, Any]:
        return case_payload(st(request), case_id)

    @api.get("/cases/{case_id}/timeline")
    async def timeline(case_id: str, request: Request, after: int = 0) -> dict[str, Any]:
        s = st(request)
        if not s.engine.store.get_case(case_id):
            raise HTTPException(404, "Case not found.")
        return {
            "events": s.engine.store.audit_events(case_id, after_id=after),
            "invocations": s.engine.store.invocations(case_id),
            "verifications": s.engine.store.verifications(case_id),
            "approvals": s.engine.store.list_approvals(case_id=case_id),
        }

    @api.post("/cases/{case_id}/pause")
    async def pause_case(case_id: str, request: Request) -> dict[str, Any]:
        s = st(request)
        s.engine.pause_case(case_id)
        return case_payload(s, case_id)

    @api.post("/cases/{case_id}/resume")
    async def resume_case(case_id: str, request: Request) -> dict[str, Any]:
        s = st(request)
        s.engine.resume_case(case_id)
        await s.runner.kick(case_id)
        return case_payload(s, case_id)

    @api.post("/cases/{case_id}/cancel")
    async def cancel_case(case_id: str, request: Request) -> dict[str, Any]:
        s = st(request)
        s.engine.cancel_case(case_id)
        return case_payload(s, case_id)

    @api.post("/cases/{case_id}/steps/{step_id}/answer")
    async def answer(case_id: str, step_id: str, body: AnswerRequest, request: Request) -> dict[str, Any]:
        s = st(request)
        s.engine.answer(case_id, step_id, body.value)
        await s.runner.kick(case_id)
        return case_payload(s, case_id)

    @api.post("/cases/{case_id}/steps/{step_id}/skip")
    async def skip(case_id: str, step_id: str, request: Request) -> dict[str, Any]:
        s = st(request)
        s.engine.skip(case_id, step_id)
        await s.runner.kick(case_id)
        return case_payload(s, case_id)

    # -- approvals ------------------------------------------------------------------------
    @api.get("/approvals")
    async def approvals(request: Request, status: str | None = "pending") -> list[dict[str, Any]]:
        s = st(request)
        items = s.engine.store.list_approvals(status=status or None)
        for item in items:
            case = s.engine.store.get_case(item["case_id"])
            item["case_title"] = case["title"] if case else ""
        return items

    @api.post("/approvals/{approval_id}/decision")
    async def decide(approval_id: str, body: DecisionRequest, request: Request) -> dict[str, Any]:
        s = st(request)
        approval = s.engine.decide(approval_id, body.decision, body.note)
        await s.runner.kick(approval["case_id"])
        return {"approval": approval, "case": case_payload(s, approval["case_id"])}

    @api.post("/approvals/batch")
    async def decide_batch(body: BatchDecisionRequest, request: Request) -> dict[str, Any]:
        s = st(request)
        decided = []
        for approval_id in body.approval_ids:
            decided.append(s.engine.decide(approval_id, body.decision))
        case_ids = sorted({a["case_id"] for a in decided})
        for case_id in case_ids:
            await s.runner.kick(case_id)
        return {"approvals": decided, "cases": [case_payload(s, c) for c in case_ids]}

    @api.post("/approvals/{approval_id}/edit")
    async def edit(approval_id: str, body: EditRequest, request: Request) -> dict[str, Any]:
        s = st(request)
        approval = s.engine.edit(approval_id, body.edits)
        return {"approval": approval, "case": case_payload(s, approval["case_id"])}

    @api.get("/approvals/{approval_id}/explain")
    async def explain(approval_id: str, request: Request, use_cloud: bool = True) -> dict[str, Any]:
        s = st(request)
        approval = s.engine.store.get_approval(approval_id)
        if not approval:
            raise HTTPException(404, "Approval not found.")
        d = approval["details"]
        paragraphs: list[str] = []
        rc = d.get("recovery_context") or {}
        if rc.get("reason"):
            paragraphs.append(f"What went wrong: {rc['reason']} {rc.get('what_happened', '')}".strip())
        paragraphs += [
            f"What will happen: {d.get('effect', '')}",
            f"Why I'm asking: this changes something outside AGENCY ({d.get('integration')}), so I never do it without your yes.",
            f"If you say no: {d.get('if_rejected', '')}",
            f"Can it be undone? {d.get('reversible', '')}.",
            "This uses a demonstration service. No real company, office or person is contacted.",
        ]
        result: dict[str, Any] = {"paragraphs": paragraphs, "source": "deterministic", "model": None}
        if use_cloud and getattr(s.provider, "can_explain", s.provider.available):
            cloud = await s.provider.explain(
                {
                    "headline": approval["summary"],
                    **{
                        k: d.get(k) for k in ("details", "effect", "if_rejected", "reversible", "integration", "recovery_context")
                    },
                }
            )
            if cloud:
                status = getattr(s.provider, "last_explained_by", None) or s.provider.status()
                result = {
                    "paragraphs": cloud,
                    "source": "cloud",
                    "label": status.get("label"),
                    "model": status.get("model"),
                    "on_device": bool(status.get("on_device")),
                    "facts": paragraphs,
                }
            result["route"] = s.provider.status().get("route")
        return result

    # -- demo controls (presenter only) ---------------------------------------------------
    def require_demo(s: AppState) -> None:
        if not settings.demo_controls:
            raise HTTPException(403, "Demo controls are disabled on this coordinator.")

    @api.put("/demo/network")
    async def put_network(body: NetworkDemoRequest, request: Request) -> dict[str, Any]:
        """Presenter: simulate the network (also moves Synapse-Mesh's mock telemetry); null returns to live."""
        s = st(request)
        require_demo(s)
        snapshot = await s.network.set_demo(body.state)
        s.engine.store.audit(None, "demo_network", f"Presenter set the network to {body.state or 'live'}", actor="presenter")
        return snapshot

    @api.get("/demo/faults")
    async def get_faults(request: Request) -> dict[str, Any]:
        return st(request).engine.faults.snapshot()

    @api.put("/demo/faults")
    async def put_faults(body: FaultConfig, request: Request) -> dict[str, Any]:
        s = st(request)
        require_demo(s)
        snapshot = s.engine.faults.configure(body.model_dump())
        s.engine.store.audit(None, "demo_fault", f"Presenter set demo faults: {snapshot}", actor="presenter")
        return snapshot

    @api.post("/demo/reset")
    async def reset(request: Request) -> dict[str, Any]:
        s = st(request)
        require_demo(s)
        await s.runner.shutdown()
        s.runner = CaseRunner(s.engine, inline=s.runner.inline)
        s.db.set_state("automation_paused", False)
        async with s.lifeline.lock:
            info = seed_demo_data(s.db)
        s.engine.store.audit(None, "demo_reset", "Demo data reset.", actor="presenter")
        return info

    # -- demo integration services (their own endpoints and state) ------------------------
    svc = APIRouter(prefix="/api/demo-services")

    @svc.get("/repair/slots")
    async def repair_slots(request: Request) -> dict[str, Any]:
        return {"service": "Demo Repair Provider", "simulated": True, "slots": st(request).engine.repair.list_slots()}

    @svc.get("/repair/requests")
    async def repair_requests(request: Request) -> dict[str, Any]:
        return {"service": "Demo Repair Provider", "simulated": True, "requests": st(request).engine.repair.list_requests()}

    @svc.get("/repair/requests/{request_id}")
    async def repair_request(request_id: str, request: Request) -> dict[str, Any]:
        record = st(request).engine.repair.get_request(request_id)
        if not record:
            raise HTTPException(404, "Not found")
        return record

    @svc.get("/funding/programs")
    async def funding_programs(request: Request) -> dict[str, Any]:
        return {"service": "Demo Funding Service", "simulated": True, "programs": st(request).engine.funding.list_programs()}

    @svc.get("/funding/cases")
    async def funding_cases(request: Request) -> dict[str, Any]:
        return {"service": "Demo Funding Service", "simulated": True, "cases": st(request).engine.funding.list_cases()}

    @svc.get("/calendar/events")
    async def calendar_events(request: Request) -> dict[str, Any]:
        return {
            "service": "Demo Calendar",
            "simulated": True,
            "events": st(request).engine.calendar.list_events(include_cancelled=True),
        }

    @svc.get("/calendar/openings")
    async def calendar_openings(request: Request) -> dict[str, Any]:
        return {"service": "Demo Calendar", "simulated": True, "openings": st(request).engine.calendar.list_openings()}

    @svc.get("/messaging/contacts")
    async def contacts(request: Request) -> dict[str, Any]:
        return {"service": "Demo Messaging Service", "simulated": True, "contacts": st(request).engine.messaging.list_contacts()}

    @svc.get("/home/devices")
    async def home_devices(request: Request) -> dict[str, Any]:
        rows = st(request).db.query("SELECT * FROM svc_home_devices ORDER BY id")
        return {
            "service": "Demo Smart Home",
            "simulated": True,
            "devices": [{**dict(r), "attributes": loads(r["attributes"])} for r in rows],
        }

    @svc.get("/messaging/outbox")
    async def outbox(request: Request) -> dict[str, Any]:
        return {
            "service": "Demo Messaging Service",
            "simulated": True,
            "real_world_delivery": False,
            "messages": st(request).engine.messaging.list_messages(),
        }

    app.include_router(api)
    app.include_router(svc)
    lifeline_api, respond_pages = lifeline_routers(demo_controls=settings.demo_controls)
    app.include_router(lifeline_api)
    app.include_router(respond_pages)
    app.include_router(memory_router())
    app.include_router(assist_router())

    if settings.frontend_dist and (settings.frontend_dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=settings.frontend_dist, html=True), name="frontend")

    return app


app = create_app()
