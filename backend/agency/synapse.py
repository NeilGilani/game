"""The Synapse layer: Ray's Synapse-Mesh decides how every AI request is answered; Gemini answers it.

Synapse-Mesh (github.com/RayB-007/synapse-mesh) has two parts that run on this Mac with no GPU:

- the **Sifter**, a local intent classifier, which scores each request against a vault of experts (coding,
  medical, legal; more can be installed), and
- the **Cisco sentinel**, which measures the network (Cisco IOS XE RESTCONF counters, the cloud kernel's round
  trip, or mock telemetry) and sets a fusion budget: Ultra-Fusion (good, cap 1.0), Lean-Fusion (congested, 0.4),
  Critical-Fusion (critical, 0.1, strongest expert only) or Safe-Mode (offline).

`POST /intent` returns both: the expert mixture after the network budget. AGENCY routes every AI request through
it before Gemini sees it:

- The expert mixture becomes a weighted set of expert lenses in Gemini's system instruction (the prompt-level
  analogue of Synapse's LoRA fusion; Synapse's own GPU kernel fuses the weights themselves when one is deployed).
- The fusion mode sets how hard Gemini thinks (Lean-Fusion: low), or whether the cloud is used at all
  (Critical-Fusion and Safe-Mode: AGENCY's built-in plans and wording, at once, instead of a long wait).
- Every decision is recorded and shown: which experts, which mode, which network source, how long routing took.

If Synapse-Mesh isn't running, AGENCY's own small router stands in (keyword experts + AGENCY's network monitor)
and says so. Model output still never decides whether an action happened, and every plan still passes AGENCY's
validator.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import asdict, dataclass, field
from typing import Any

import httpx

from .db import utcnow
from .network import CISCO, NetworkMonitor

log = logging.getLogger("agency.synapse")

MODES = {
    "good": ("Ultra-Fusion", 1.0),
    "slow": ("Lean-Fusion", 0.4),
    "critical": ("Critical-Fusion", 0.1),
    "offline": ("Safe-Mode", 0.1),
    "unknown": ("Ultra-Fusion", 1.0),
}
# Everyday requests (a short plan, a few replies, a sentence ending, reading a goal) need a fast answer more than
# deep thought: Synapse sends them down the fast lane, low thinking. Explanations of papers and the like keep the
# full budget the network allows.
FAST_PURPOSES = frozenset(
    {"plan_task", "suggest_replies", "complete_sentence", "interpret_goal", "draft_plan", "answer_question"}
)
# After Synapse-Mesh fails to answer, route with the stand-in for this long instead of waiting on it each time.
SYNAPSE_RETRY_S = 30.0

STATE_OF_MODE = {"Ultra-Fusion": "good", "Lean-Fusion": "slow", "Critical-Fusion": "critical", "Safe-Mode": "offline"}

# What each expert means for Gemini: the lens it should apply, in proportion to the expert's weight.
LENSES = {
    "medical": (
        "Clinical lens: plain, calm health language; never diagnose or change treatment; anything urgent goes to "
        "Lifeline and the care team; say what a clinician should confirm."
    ),
    "legal": (
        "Legal and paperwork lens: be exact about what a form, letter or agreement commits the person to, its "
        "deadlines and what happens if they say no; never sign or agree on the person's behalf; say when a human "
        "advocate should check."
    ),
    "coding": (
        "Technical lens: precise and structured; name exact steps, fields and tools; prefer the most reliable way to do it."
    ),
    "general": "Everyday lens: short, warm and practical.",
    "generalist": "Everyday lens: short, warm and practical.",
}

# AGENCY's stand-in router (only when Synapse-Mesh isn't running): keyword evidence per expert.
KEYWORDS = {
    "medical": (
        r"\b(health|doctor|clinic|nurse|hospital|medic\w*|pharmac\w*|prescri\w*|pain|symptom\w*|ventilator|"
        r"breath\w*|therap\w*|appointment|dose|pill\w*|caregiver)\b"
    ),
    "legal": (
        r"\b(form\w*|sign\w*|contract\w*|agreement\w*|benefit\w*|consent|law\w*|legal|rights?|placard|"
        r"paratransit|renew\w*|polic\w*|letter\w*|appeal\w*|claim\w*|insurance|funding|assistance|deadline\w*)\b"
    ),
    "coding": r"\b(code|script|python|software|app|website|computer|spreadsheet|data|program\w*|bug|install\w*)\b",
}


@dataclass
class Route:
    """How one AI request was routed."""

    purpose: str
    router: str  # "synapse" (Ray's Sifter + Cisco sentinel) or "agency" (stand-in)
    mode: str  # Ultra-Fusion | Lean-Fusion | Critical-Fusion | Safe-Mode
    network: str  # good | slow | critical | offline | unknown
    network_source: str
    simulated_network: bool
    cap: float
    experts: dict[str, float]  # applied (after the network budget)
    ideal: dict[str, float]  # before the budget
    method: str
    decision: str  # "gemini" | "gemini-lean" | "built-in"
    reason_ms: float | None
    lane: str = "deep"  # "fast": low thinking for an everyday request; "deep": the budget the network allows
    at: str = field(default_factory=utcnow)

    @property
    def active(self) -> list[str]:
        return [n for n, w in sorted(self.experts.items(), key=lambda kv: -kv[1]) if w > 0]

    def mixture(self) -> dict[str, float]:
        """Applied weights as shares of the budget actually spent (what Gemini's lenses are weighted by)."""
        total = sum(w for w in self.experts.values() if w > 0)
        ranked = sorted(((n, w) for n, w in self.experts.items() if w > 0), key=lambda nw: -nw[1])
        return {n: round(w / total, 3) for n, w in ranked} if total else {}

    def note(self) -> str:
        if self.decision == "built-in":
            why = "the network is offline" if self.mode == "Safe-Mode" else "the network is barely working"
            return f"{self.mode}: {why}, so AGENCY used its built-in plans and wording without waiting for the cloud."
        shares = ", ".join(f"{name} {share:.0%}" for name, share in self.mixture().items()) or "general"
        light = " with light thinking" if self.decision == "gemini-lean" or self.lane == "fast" else ""
        return f"{self.mode}: Gemini{light}, weighted {shares}."

    def brief(self) -> str:
        """The system-instruction addendum Gemini receives for this request."""
        mix = self.mixture()
        if not mix:
            return ""
        lines = [
            f"Synapse-Mesh routed this request ({self.mode}). Weigh these expert lenses by their share:",
            *(f"- {name} ({share:.0%}): {LENSES.get(name, f'Draw on {name} expertise.')}" for name, share in mix.items()),
        ]
        if self.decision == "gemini-lean":
            lines.append("The network is congested: keep the answer short.")
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        out = asdict(self)
        out.update(active=self.active, mixture=self.mixture(), note=self.note())
        return out


def decision_for(mode: str) -> str:
    if mode in {"Critical-Fusion", "Safe-Mode"}:
        return "built-in"
    return "gemini-lean" if mode == "Lean-Fusion" else "gemini"


def keyword_experts(text: str) -> dict[str, float]:
    counts = {name: len(re.findall(pattern, text, flags=re.IGNORECASE)) for name, pattern in KEYWORDS.items()}
    total = sum(counts.values())
    if not total:
        return {"general": 1.0}
    return {name: round(c / total, 3) for name, c in counts.items() if c}


def budget(ideal: dict[str, float], cap: float, strongest_only: bool) -> dict[str, float]:
    """Same rule as Synapse's budget_weights: normalise, then spend at most the cap."""
    total = sum(v for v in ideal.values() if v > 0)
    if not total or cap <= 0:
        return dict.fromkeys(ideal, 0.0)
    if strongest_only:
        winner = max(ideal, key=lambda k: ideal[k])
        return {name: cap if name == winner else 0.0 for name in ideal}
    return {name: round(max(0.0, v) / total * cap, 4) for name, v in ideal.items()}


@dataclass
class SynapseRouter:
    monitor: NetworkMonitor
    url: str | None = None
    timeout_s: float = 2.5
    client: Any = None
    connected: bool | None = None
    last_error: str | None = None
    history: list[dict[str, Any]] = field(default_factory=list)
    down_until: float = 0.0

    def __post_init__(self) -> None:
        if self.url:
            self.url = self.url.rstrip("/")
        if self.client is None:
            self.client = httpx.AsyncClient(timeout=self.timeout_s)

    def status(self) -> dict[str, Any]:
        last = self.history[-1] if self.history else None
        return {
            "configured": bool(self.url),
            "connected": self.connected,
            "router": "Synapse-Mesh" if self.connected else "AGENCY stand-in router",
            "last_error": self.last_error,
            "last_route": last,
            "routes": len(self.history),
        }

    def recent(self, n: int = 10) -> list[dict[str, Any]]:
        return list(reversed(self.history[-n:]))

    async def route(self, text: str, purpose: str) -> Route:
        started = time.perf_counter()
        text = (text or "").strip()[:8000] or purpose
        route = await self._synapse(text, purpose) if self.url and time.monotonic() >= self.down_until else None
        if route is None:
            route = self._stand_in(text, purpose, started)
        # A presenter override of the network always wins, so both screens tell the same story.
        if self.monitor.demo and STATE_OF_MODE.get(route.mode) != self.monitor.demo:
            mode, cap = MODES[self.monitor.demo]
            route.mode, route.cap, route.network = mode, cap, self.monitor.demo
            route.network_source, route.simulated_network = "demo", True
            route.experts = budget(route.ideal, cap, strongest_only=mode == "Critical-Fusion")
            route.decision = decision_for(mode)
        # Decided here, before the route is recorded, so the history shows the lane each request really took.
        if route.decision != "built-in" and purpose in FAST_PURPOSES:
            route.lane = "fast"
        self.history = (self.history + [route.to_dict()])[-50:]
        return route

    async def _synapse(self, text: str, purpose: str) -> Route | None:
        started = time.perf_counter()
        try:
            response = await self.client.post(f"{self.url}/intent", json={"prompt": text})
        except (httpx.HTTPError, OSError) as exc:
            self.connected, self.last_error = False, f"Synapse-Mesh isn't reachable ({type(exc).__name__})"
            self.down_until = time.monotonic() + SYNAPSE_RETRY_S
            return None
        if response.status_code == 503 and "offline" in response.text.lower():
            # The edge refuses to route while the cloud kernel is unreachable: that is Safe-Mode.
            self.connected, self.last_error = True, None
            ideal = keyword_experts(text)
            return Route(
                purpose=purpose,
                router="synapse",
                mode="Safe-Mode",
                network="offline",
                network_source="cisco",
                simulated_network=self.monitor.simulated,
                cap=0.1,
                experts=dict.fromkeys(ideal, 0.0),
                ideal=ideal,
                method="Synapse-Mesh reports the network offline",
                decision="built-in",
                reason_ms=round((time.perf_counter() - started) * 1000, 1),
            )
        try:
            data = response.json() if response.status_code == 200 else None
        except ValueError:
            data = None
        if not isinstance(data, dict) or not isinstance(data.get("weights"), dict):
            self.connected = True
            self.last_error = f"Synapse-Mesh couldn't route this request ({response.status_code})"
            return None
        self.connected, self.last_error = True, None
        raw_net = data.get("network")
        net: dict[str, Any] = raw_net if isinstance(raw_net, dict) else {}
        state = CISCO.get(str(net.get("state") or "").upper(), self.monitor.state)
        mode = str(data.get("fusion_mode") or MODES.get(state, MODES["unknown"])[0])
        experts = {str(k): float(v) for k, v in data["weights"].items() if isinstance(v, int | float)}
        raw_ideal = data.get("ideal_weights")
        ideal_src: dict[str, Any] = raw_ideal if isinstance(raw_ideal, dict) else data["weights"]
        ideal = {str(k): float(v) for k, v in ideal_src.items() if isinstance(v, int | float)}
        reason = data.get("reason_ms")
        return Route(
            purpose=purpose,
            router="synapse",
            mode=mode,
            network=state,
            network_source="cisco",
            simulated_network=str(net.get("source") or "") == "mock",
            cap=float(data.get("network_cap") or MODES.get(state, MODES["unknown"])[1]),
            experts=experts,
            ideal=ideal,
            method=str(data.get("method") or "Synapse-Mesh Sifter (local intent classifier)"),
            decision=decision_for(mode),
            reason_ms=round(float(reason), 1) if isinstance(reason, int | float) else None,
        )

    def _stand_in(self, text: str, purpose: str, started: float) -> Route:
        state = self.monitor.state
        mode, cap = MODES.get(state, MODES["unknown"])
        ideal = keyword_experts(text)
        return Route(
            purpose=purpose,
            router="agency",
            mode=mode,
            network=state,
            network_source=self.monitor.source,
            simulated_network=self.monitor.simulated,
            cap=cap,
            experts=budget(ideal, cap, strongest_only=mode == "Critical-Fusion"),
            ideal=ideal,
            method="AGENCY's stand-in router (keywords), because Synapse-Mesh isn't running",
            decision=decision_for(mode),
            reason_ms=round((time.perf_counter() - started) * 1000, 2),
        )


@dataclass
class SynapseLayer:
    """Wraps the reasoning provider: route through Synapse, then let Gemini answer with that mixture and budget."""

    inner: Any
    router: SynapseRouter
    last_route: Route | None = None
    skipped: str | None = None
    base_effort: str | None = None

    @property
    def monitor(self) -> NetworkMonitor:
        return self.router.monitor

    @property
    def available(self) -> bool:
        return bool(self.inner.available)

    @property
    def can_explain(self) -> bool:
        return bool(getattr(self.inner, "can_explain", self.inner.available))

    @property
    def history(self) -> list[dict[str, Any]]:
        return list(getattr(self.inner, "history", []))

    @property
    def last_explained_by(self) -> dict[str, Any] | None:
        value = getattr(self.inner, "last_explained_by", None)
        if not isinstance(value, dict):
            return None
        return {**value, "route": self.last_route.to_dict() if self.last_route else None}

    def _cloud(self) -> Any:
        return getattr(self.inner, "primary", self.inner)

    async def _prepare(self, text: str, purpose: str) -> bool:
        self.last_route = None
        route = await self.router.route(text, purpose)
        self.last_route = route
        cloud = self._cloud()
        if route.decision == "built-in":
            self.skipped = f"routed to built-in by Synapse ({route.mode})"
            if hasattr(cloud, "expert_brief"):
                cloud.expert_brief = ""
            return False
        self.skipped = None
        if hasattr(cloud, "expert_brief"):
            cloud.expert_brief = route.brief()
        if hasattr(cloud, "lane"):
            cloud.lane = route.lane
        if hasattr(cloud, "effort"):
            if self.base_effort is None:
                self.base_effort = cloud.effort
            fast = route.decision == "gemini-lean" or route.lane == "fast"
            cloud.effort = "low" if fast else self.base_effort
        return True

    def status(self) -> dict[str, Any]:
        out = dict(self.inner.status())
        out["synapse"] = self.router.status()
        out["network"] = self.monitor.snapshot()
        out["route"] = self.last_route.to_dict() if self.last_route else None
        if self.skipped:
            out["last_error"] = self.skipped
        return out

    async def interpret_goal(
        self, request_text: str, selections: dict[str, str], profile: dict[str, Any]
    ) -> dict[str, Any] | None:
        self.last_route = None
        if not self.inner.available or not await self._prepare(request_text, "interpret_goal"):
            return None
        result: dict[str, Any] | None = await self.inner.interpret_goal(request_text, selections, profile)
        return result

    async def draft_plan(self, goal: Any, baseline: Any, catalog: list[dict[str, Any]]) -> Any:
        text = " ".join(
            str(x) for x in (getattr(goal, "outcome", ""), getattr(goal, "goal_type", ""), getattr(goal, "entities", ""))
        )
        self.last_route = None
        if not self.inner.available or not await self._prepare(text, "draft_plan"):
            return None
        return await self.inner.draft_plan(goal, baseline, catalog)

    async def explain(self, topic: dict[str, Any]) -> list[str] | None:
        text = " ".join(str(topic.get(k) or "") for k in ("headline", "details", "effect", "integration"))
        self.last_route = None
        if not self.can_explain or not await self._prepare(text, "explain"):
            return None
        result: list[str] | None = await self.inner.explain(topic)
        return result

    async def check(self) -> dict[str, Any]:
        await self.inner.check()
        await self.monitor.poll()
        return self.status()


def synapse_url_from_env(env: dict[str, str]) -> str | None:
    """Synapse-Mesh's edge API on this Mac (AGENCY_SYNAPSE_URL, else AGENCY_LOCAL_MODEL_URL)."""
    from .reasoning.local import is_loopback

    url = (env.get("AGENCY_SYNAPSE_URL") or env.get("AGENCY_LOCAL_MODEL_URL") or "").strip()
    if not url or not url.startswith(("http://", "https://")):
        return None
    if not is_loopback(url) and env.get("AGENCY_LOCAL_MODEL_ALLOW_REMOTE") != "1":
        log.warning("AGENCY_SYNAPSE_URL is not on this computer; using AGENCY's stand-in router")
        return None
    return url
