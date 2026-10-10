"""Optional second model: Synapse-Mesh (github.com/RayB-007/synapse-mesh).

Synapse-Mesh blends code, medical and legal LoRA experts into a small base model (Qwen2.5-1.5B) per request,
and adapts how much fusion it does to the network state its Cisco sentinel measures. Older versions generate on
this Mac; newer versions are an edge client that classifies the request on this Mac and sends it to a cloud GPU
kernel. AGENCY reads which from /health and says so: "On-device" only when generation really runs here.

AGENCY uses it for one job only: explaining an approval in plain words when the main cloud model can't be
reached or isn't configured. With private explanations on, only a truly on-device Synapse-Mesh is used. It never
interprets goals or drafts plans (a 1.5B model is not reliable enough for that); those fall back to the
deterministic built-in rules and plans.

The server must be on this machine (a loopback address) unless AGENCY_LOCAL_MODEL_ALLOW_REMOTE=1.
"""

from __future__ import annotations

import ipaddress
import json
import logging
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

from ..db import utcnow
from ..models import Goal, PlanDraft

log = logging.getLogger("agency.reasoning.local")

LABEL = "On-device"


def is_loopback(url: str) -> bool:
    host = urlparse(url).hostname or ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def split_paragraphs(text: str) -> list[str]:
    parts = [p.strip() for p in text.replace("\r\n", "\n").split("\n\n")]
    if len(parts) == 1:  # a small model often uses single newlines
        parts = [p.strip() for p in text.split("\n")]
    return [p[:600] for p in parts if p][:4]


@dataclass
class SynapseMeshProvider:
    url: str
    timeout_s: float = 50.0
    max_new_tokens: int = 192
    client: Any = None
    calls: int = 0
    last_ok_at: str | None = None
    last_error: str | None = None
    last_error_at: str | None = None
    state: str = "configured"
    base_model: str | None = None
    # Newer Synapse-Mesh runs as an edge client that sends prompts to a cloud GPU kernel. Learned from /health:
    # True = prompts leave this computer, False = generation runs here, None = not known yet.
    remote: bool | None = None
    network: dict[str, Any] | None = None
    history: list[dict[str, Any]] = field(default_factory=list)

    name = "synapse-mesh"

    @property
    def on_device(self) -> bool:
        return self.remote is False

    @property
    def label(self) -> str:
        return LABEL if self.on_device else "Synapse-Mesh"

    def __post_init__(self) -> None:
        self.url = self.url.rstrip("/")
        if self.client is None:
            self.client = httpx.AsyncClient(timeout=self.timeout_s)

    @property
    def available(self) -> bool:
        return True

    @property
    def model(self) -> str:
        where = "cloud GPU via this Mac" if self.remote else self.base_model
        return f"Synapse-Mesh ({where})" if where else "Synapse-Mesh"

    def status(self) -> dict[str, Any]:
        if self.remote:
            done = "Synapse-Mesh answered the last request through its cloud GPU kernel (the text left this computer)."
        elif self.on_device:
            done = "On-device model (Synapse-Mesh) answered the last request. Nothing left this computer."
        else:
            done = "Synapse-Mesh answered the last request."
        descriptions = {
            "configured": f"Synapse-Mesh configured at {self.url}; not used yet in this session.",
            "ok": done,
            "error": f"Synapse-Mesh unavailable: {self.last_error}",
        }
        good = "local" if self.on_device else "cloud"
        return {
            "mode": good if self.state != "error" else f"{good}_degraded",
            "on_device": self.on_device,
            "network": self.network,
            "provider": self.name,
            "label": self.label,
            "model": self.model,
            "state": self.state,
            "description": descriptions.get(self.state, self.state),
            "last_ok_at": self.last_ok_at,
            "last_error": self.last_error,
            "last_error_at": self.last_error_at,
            "calls": self.calls,
        }

    def _record(self, ok: bool, purpose: str, error: str | None = None) -> None:
        self.calls += 1
        if ok:
            self.state, self.last_ok_at = "ok", utcnow()
        else:
            self.state, self.last_error, self.last_error_at = "error", error, utcnow()
        self.history = (self.history + [{"at": utcnow(), "purpose": purpose, "ok": ok, "error": error}])[-20:]

    async def interpret_goal(
        self, request_text: str, selections: dict[str, str], profile: dict[str, Any]
    ) -> dict[str, Any] | None:
        return None  # deterministic rules handle it

    async def draft_plan(self, goal: Goal, baseline: PlanDraft, catalog: list[dict[str, Any]]) -> PlanDraft | None:
        return None  # built-in plans handle it

    async def _generate(self, purpose: str, prompt: str) -> str | None:
        body = {"prompt": prompt[:8000], "max_new_tokens": self.max_new_tokens}
        text: str | None = None
        try:
            async with self.client.stream("POST", f"{self.url}/generate", json=body) as response:
                if response.status_code != 200:
                    self._record(False, purpose, f"the Synapse-Mesh server answered {response.status_code}")
                    return None
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    kind = event.get("event")
                    if kind == "error":
                        self._record(False, purpose, f"Synapse-Mesh failed: {str(event.get('message', ''))[:160]}")
                        return None
                    if kind == "response":
                        text = str(event.get("text") or "")
        except httpx.TimeoutException:
            self._record(False, purpose, "Synapse-Mesh took too long")
            return None
        except (httpx.HTTPError, OSError):
            self._record(False, purpose, f"the Synapse-Mesh server isn't running at {self.url}")
            return None
        if not text or not text.strip():
            self._record(False, purpose, "Synapse-Mesh returned nothing")
            return None
        self._record(True, purpose)
        return text

    async def probe(self) -> None:
        """Read /health: where generation runs (this Mac or a cloud kernel) and the network state it sees."""
        try:
            response = await self.client.get(f"{self.url}/health")
            if response.status_code != 200:
                return
            data = response.json()
        except (httpx.HTTPError, OSError, ValueError):
            return
        if not isinstance(data, dict):
            return
        self.base_model = str(data.get("base_model") or "") or self.base_model
        self.remote = data.get("engine") == "cloud-edge-client" or data.get("cloud_configured") is True
        network = data.get("network")
        self.network = network if isinstance(network, dict) else None

    async def explain(self, topic: dict[str, Any]) -> list[str] | None:
        if self.remote is None:
            await self.probe()
        prompt = (
            "Explain this to a person who uses an accessibility assistant, in 2 or 3 short paragraphs of plain, "
            "kind language: what will happen, why they are being asked, and what happens if they say no. "
            "Say that it uses a demonstration service. Only use the facts below; do not add any.\n\n"
            + json.dumps(topic, indent=1, default=str)
        )
        text = await self._generate("explain", prompt)
        return split_paragraphs(text) if text else None

    async def check(self) -> dict[str, Any]:
        try:
            response = await self.client.get(f"{self.url}/health")
            if response.status_code != 200:
                self._record(False, "check", f"the Synapse-Mesh server answered {response.status_code}")
                return self.status()
        except (httpx.HTTPError, OSError):
            self._record(False, "check", f"the Synapse-Mesh server isn't running at {self.url}")
            return self.status()
        await self.probe()
        self._record(True, "check")
        return self.status()


# Errors from the cloud model that mean "can't reach it right now" rather than "it refused".
UNREACHABLE = ("network", "rate limited", "service error", "took too long")


@dataclass
class WithLocalFallback:
    """The configured cloud provider (or deterministic mode), plus the on-device model for explanations.

    - Goals and plans: the cloud provider only; if it fails, AGENCY's built-in rules and plans.
    - Explanations: the cloud model first; the on-device model if the cloud can't be reached or
      isn't configured. With ``private=True`` the cloud is never asked to explain.
    """

    primary: Any
    local: SynapseMeshProvider
    private: bool = False
    last_explained_by: dict[str, Any] | None = None

    @property
    def available(self) -> bool:
        """Whether goals and plans can use a model: only the cloud provider does that."""
        return bool(self.primary.available)

    @property
    def can_explain(self) -> bool:
        return True

    @property
    def history(self) -> list[dict[str, Any]]:
        return list(getattr(self.primary, "history", [])) + self.local.history

    def status(self) -> dict[str, Any]:
        if self.primary.available:
            out = dict(self.primary.status())
        else:
            out = dict(self.local.status())
            out["description"] = (
                "No cloud model is configured. Built-in plans; explanations come from the on-device model. " + out["description"]
            )
        out["local"] = self.local.status()
        out["private_explanations"] = self.private
        return out

    async def interpret_goal(
        self, request_text: str, selections: dict[str, str], profile: dict[str, Any]
    ) -> dict[str, Any] | None:
        if not self.primary.available:
            return None
        result: dict[str, Any] | None = await self.primary.interpret_goal(request_text, selections, profile)
        return result

    async def draft_plan(self, goal: Goal, baseline: PlanDraft, catalog: list[dict[str, Any]]) -> PlanDraft | None:
        if not self.primary.available:
            return None
        result: PlanDraft | None = await self.primary.draft_plan(goal, baseline, catalog)
        return result

    async def explain(self, topic: dict[str, Any]) -> list[str] | None:
        self.last_explained_by = None
        if self.primary.available and not self.private:
            cloud: list[str] | None = await self.primary.explain(topic)
            if cloud:
                status = self.primary.status()
                self.last_explained_by = {"label": status.get("label"), "model": status.get("model"), "on_device": False}
                return cloud
            error = str(self.primary.status().get("last_error") or "")
            if not any(word in error for word in UNREACHABLE):
                return None  # the cloud answered but declined or was malformed: don't route around it
        if self.private:
            # Private means the text stays on this Mac. Synapse-Mesh as a cloud-kernel client doesn't qualify,
            # and neither does a server whose setup we couldn't read: AGENCY explains in its own words instead.
            await self.local.probe()
            if not self.local.on_device:
                return None
        local = await self.local.explain(topic)
        if local:
            self.last_explained_by = {
                "label": self.local.label,
                "model": self.local.model,
                "on_device": self.local.on_device,
            }
        return local

    async def check(self) -> dict[str, Any]:
        await self.local.check()
        if self.primary.available:
            await self.primary.check()
        return self.status()


def local_from_env(env: dict[str, str]) -> SynapseMeshProvider | None:
    url = (env.get("AGENCY_LOCAL_MODEL_URL") or "").strip()
    if not url:
        return None
    if not url.startswith(("http://", "https://")):
        log.warning("AGENCY_LOCAL_MODEL_URL must start with http:// or https://; on-device model disabled")
        return None
    if not is_loopback(url) and env.get("AGENCY_LOCAL_MODEL_ALLOW_REMOTE") != "1":
        log.warning(
            "AGENCY_LOCAL_MODEL_URL is not on this computer; on-device model disabled (set "
            "AGENCY_LOCAL_MODEL_ALLOW_REMOTE=1 to allow it)"
        )
        return None
    try:
        timeout = float(env.get("AGENCY_LOCAL_MODEL_TIMEOUT_S") or 50)
    except ValueError:
        timeout = 50.0
    return SynapseMeshProvider(url=url, timeout_s=timeout)


def with_local_model(provider: Any, env: dict[str, str]) -> Any:
    """Add the on-device model when AGENCY_LOCAL_MODEL_URL is set; otherwise return the provider as is."""
    local = local_from_env(env)
    if local is None:
        return provider
    private = (env.get("AGENCY_PRIVATE_EXPLANATIONS") or "").strip().lower() in {"1", "true", "yes", "on"}
    return WithLocalFallback(primary=provider, local=local, private=private)
