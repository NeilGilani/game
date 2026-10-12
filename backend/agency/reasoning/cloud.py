"""AGENCY Cloud: Gemini through AGENCY's relay, so nobody needs an API key of their own.

When no GEMINI_API_KEY (or ANTHROPIC_API_KEY) is set, the coordinator asks AGENCY's relay
(site/functions/_lib/relay.ts, default https://getagencyos.pages.dev, AGENCY_RELAY_URL to change it,
AGENCY_RELAY=off to switch it off). A key of your own still wins (developers).

- Identity: on first use this computer registers an anonymous install (a random id and a secret the relay
  derives from it). No account and nothing about the person. It is kept in the macOS keychain (service AGENCY,
  account agency-cloud-install, shared with the Mac agent), elsewhere in a 0600 file next to the database.
- Every request is signed: HMAC-SHA256(secret, "AGENCY-CLOUD-1\\nMETHOD\\n/path\\nunix-time\\nsha256(body)").
- The relay's own refusals (busy, daily limit, switched off) come back as plain words, and stop at once instead
  of trying the other model; Gemini's own errors (busy, model not found) keep the fast lane's failover.

What is sent is exactly what Gemini would get with a local key (the goal, the plan, the words heard); the relay
keeps no content (docs/AI_RELAY.md).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar, Protocol

import httpx
from google.genai import errors, types
from pydantic import ValidationError

from ..config import DEFAULT_RELAY_URL, relay_url_from_env
from .provider import FAST_TIMEOUT_S, MIN_DEADLINE_S, GeminiProvider

__all__ = ["DEFAULT_RELAY_URL", "AgencyCloud", "AgencyCloudProvider", "RelayError", "relay_url_from_env"]

log = logging.getLogger("agency.cloud")

KEYCHAIN_SERVICE = "AGENCY"
KEYCHAIN_ACCOUNT = "agency-cloud-install"
IDENTITY_FILE = "agency-cloud.json"
REGISTER = "/api/relay/v1/register"
STATUS = "/api/relay/v1/status"
GENERATE = "/api/relay/v1/generate"
# The relay's time for its own checks and the trip to it, on top of Gemini's deadline.
OVERHEAD_S = 5.0


# ------------------------------------------------------------------------------------------------------------
# The install identity


@dataclass(frozen=True)
class Identity:
    install_id: str
    secret: str
    relay: str

    def to_json(self) -> str:
        return json.dumps({"installId": self.install_id, "secret": self.secret, "relay": self.relay})

    @staticmethod
    def from_json(text: str) -> Identity | None:
        try:
            data = json.loads(text)
            return Identity(str(data["installId"]), str(data["secret"]), str(data["relay"]))
        except (ValueError, KeyError, TypeError):
            return None


class IdentityStore(Protocol):
    def load(self) -> Identity | None: ...

    def save(self, identity: Identity) -> None: ...


@dataclass
class MemoryIdentityStore:
    identity: Identity | None = None

    def load(self) -> Identity | None:
        return self.identity

    def save(self, identity: Identity) -> None:
        self.identity = identity


@dataclass
class FileIdentityStore:
    """A small JSON file only this user can read (0600)."""

    path: Path

    def load(self) -> Identity | None:
        try:
            return Identity.from_json(self.path.read_text())
        except OSError:
            return None

    def save(self, identity: Identity) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(identity.to_json())
        os.replace(tmp, self.path)


class KeychainIdentityStore:
    """The macOS keychain through /usr/bin/security, the same item the Mac agent reads."""

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - fixed binary, no shell
            ["/usr/bin/security", *args], capture_output=True, text=True, timeout=10, check=False
        )

    def load(self) -> Identity | None:
        result = self._run("find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w")
        return Identity.from_json(result.stdout.strip()) if result.returncode == 0 else None

    def save(self, identity: Identity) -> None:
        result = self._run("add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", identity.to_json(), "-U")
        if result.returncode != 0:
            raise OSError("couldn't save the AGENCY Cloud install in the keychain")


def default_store(data_dir: Path | None, env: Mapping[str, str] | None = None) -> IdentityStore:
    env = os.environ if env is None else env
    if env.get("AGENCY_CLOUD_IDENTITY_FILE"):
        return FileIdentityStore(Path(env["AGENCY_CLOUD_IDENTITY_FILE"]))
    if sys.platform == "darwin" and shutil.which("security"):
        return KeychainIdentityStore()
    return FileIdentityStore((data_dir or Path.home() / ".agency") / IDENTITY_FILE)


# ------------------------------------------------------------------------------------------------------------
# Errors

PLAIN = {
    "busy": "AGENCY's AI is busy. Try again in a minute.",
    "daily_limit": "AGENCY's AI has reached today's limit for this computer, so the built-in plan is used until tomorrow.",
    "budget": "AGENCY's AI has reached its daily limit, so the built-in plan is used until tomorrow.",
    "disabled": "AGENCY's AI is switched off for now, so the built-in plan is used.",
    "auth": "AGENCY's AI couldn't confirm this computer. It will try again.",
    "clock": "This computer's clock is wrong, so AGENCY's AI can't be used. Set the date and time automatically.",
    "blocked": "This computer can't use AGENCY's AI.",
    "too_large": "The request was too large for AGENCY's AI.",
    "bad_request": "AGENCY's AI couldn't take this request.",
    "upstream_key": "AGENCY's AI isn't available right now.",
}
# The relay's own refusals: the other model would get the same answer, so AGENCY stops at once.
STOP_REASONS = frozenset(PLAIN)


class RelayError(errors.APIError):
    """A refusal from the relay itself (not from Gemini), with the plain words to show."""

    def __init__(self, code: int, reason: str, message: str, server_time: float | None = None) -> None:
        super().__init__(code, {"error": {"code": code, "message": message, "status": reason}})
        self.reason = reason
        self.plain = PLAIN.get(reason, message)
        self.server_time = server_time


def _error(res: httpx.Response) -> errors.APIError:
    try:
        err = res.json().get("error") or {}
    except (ValueError, AttributeError):
        err = {}
    if not isinstance(err, dict):
        err = {}
    reason = str(err.get("reason") or "")
    message = str(err.get("message") or f"AGENCY Cloud answered {res.status_code}")[:300]
    if reason in STOP_REASONS:
        server_time = err.get("serverTime")
        return RelayError(res.status_code, reason, message, float(server_time) if server_time else None)
    # Gemini's own answer (busy, not found, request rejected) or a model AGENCY Cloud doesn't offer: the
    # provider's usual handling applies, including trying the other model.
    return errors.APIError(res.status_code, {"error": {"code": res.status_code, "message": message, "status": reason}})


def _unreadable() -> errors.APIError:
    return errors.APIError(502, {"error": {"code": 502, "message": "AGENCY Cloud's answer wasn't readable"}})


def _json_object(res: httpx.Response) -> dict[str, Any]:
    try:
        data = res.json()
    except ValueError as exc:
        raise _unreadable() from exc
    if not isinstance(data, dict):
        raise _unreadable()
    return data


# ------------------------------------------------------------------------------------------------------------
# The relay client


def _sign(secret: str, method: str, path: str, stamp: int, body: bytes) -> str:
    canonical = "\n".join(["AGENCY-CLOUD-1", method.upper(), path, str(stamp), hashlib.sha256(body).hexdigest()])
    return hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()


@dataclass
class AgencyCloud:
    """Signed requests to the relay, registering this computer the first time."""

    base_url: str
    store: IdentityStore = field(default_factory=MemoryIdentityStore)
    transport: httpx.AsyncBaseTransport | None = None  # tests
    clock: Callable[[], float] = time.time
    clock_offset: float = 0.0
    _identity: Identity | None = field(default=None, init=False, repr=False)
    _http: httpx.AsyncClient | None = field(default=None, init=False, repr=False)
    _loop: Any = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")

    def _client(self) -> httpx.AsyncClient:
        # One connection pool per event loop (the app has one; tests start several).
        loop = asyncio.get_running_loop()
        if self._http is None or self._loop is not loop:
            self._http = httpx.AsyncClient(transport=self.transport, follow_redirects=False)
            self._loop = loop
        return self._http

    def _path(self, path: str) -> str:
        return httpx.URL(self.base_url + path).path

    async def _register(self, client: httpx.AsyncClient) -> Identity:
        res = await client.post(self.base_url + REGISTER, json={}, timeout=15.0)
        if res.status_code != 200:
            raise _error(res)
        data = _json_object(res)
        if not isinstance(data.get("installId"), str) or not isinstance(data.get("secret"), str):
            raise _unreadable()
        identity = Identity(data["installId"], data["secret"], self.base_url)
        try:
            self.store.save(identity)
        except (OSError, subprocess.SubprocessError) as exc:
            log.warning("AGENCY Cloud install kept for this session only (%s)", exc)
        log.info("registered this computer with AGENCY Cloud")
        return identity

    async def identity(self, client: httpx.AsyncClient, *, renew: bool = False) -> Identity:
        if not renew:
            if self._identity and self._identity.relay == self.base_url:
                return self._identity
            try:
                stored = self.store.load()
            except (OSError, subprocess.SubprocessError):
                stored = None
            if stored and stored.relay == self.base_url:
                self._identity = stored
                return stored
        self._identity = await self._register(client)
        return self._identity

    async def request(self, method: str, path: str, payload: Any, *, timeout_s: float) -> dict[str, Any]:
        """One signed request; re-registers once if the relay no longer knows this computer."""
        body = b"" if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        client = self._client()
        renew = clock_fixed = False
        while True:
            who = await self.identity(client, renew=renew)
            stamp = int(self.clock() + self.clock_offset)
            headers = {
                "content-type": "application/json",
                "x-agency-install": who.install_id,
                "x-agency-time": str(stamp),
                "x-agency-signature": _sign(who.secret, method, self._path(path), stamp, body),
            }
            res = await client.request(method, self.base_url + path, content=body or None, headers=headers, timeout=timeout_s)
            if res.status_code == 200:
                return _json_object(res)
            err = _error(res)
            if isinstance(err, RelayError) and err.reason == "auth" and not renew:
                renew = True  # the server secret was rotated, or the stored install is from elsewhere
                continue
            if isinstance(err, RelayError) and err.reason == "clock" and err.server_time and not clock_fixed:
                self.clock_offset = err.server_time - self.clock()
                clock_fixed = True
                continue
            raise err


class _Models:
    """Just enough of ``genai.Client().aio.models`` for GeminiProvider, sent through the relay."""

    def __init__(self, cloud: AgencyCloud, timeout_s: float) -> None:
        self.cloud = cloud
        self.timeout_s = max(timeout_s, MIN_DEADLINE_S)

    async def generate_content(self, *, model: str, contents: Any, config: Any) -> types.GenerateContentResponse:
        payload: dict[str, Any] = {
            "model": model,
            "user": contents if isinstance(contents, str) else str(contents),
            "maxOutputTokens": min(int(getattr(config, "max_output_tokens", None) or 4096), 32768),
            "timeoutMs": int(min(self.timeout_s, 60.0) * 1000),
        }
        system = getattr(config, "system_instruction", None)
        if system:
            payload["system"] = str(system)
        schema = getattr(config, "response_json_schema", None)
        if schema is not None:
            payload["schema"] = schema
        thinking = getattr(config, "thinking_config", None)
        level = getattr(thinking, "thinking_level", None) if thinking is not None else None
        if level is not None:
            payload["thinkingLevel"] = str(getattr(level, "value", level))
        data = await self.cloud.request("POST", GENERATE, payload, timeout_s=self.timeout_s + OVERHEAD_S)
        try:
            # The SDK's own parser: it tolerates fields newer than this SDK (thought signatures, usage details),
            # which the strict pydantic models refuse.
            return types.GenerateContentResponse._from_response(response=data, kwargs={})
        except (ValidationError, TypeError, ValueError) as exc:
            raise _unreadable() from exc

    async def get(self, *, model: str) -> dict[str, Any]:
        """The credential check: is this computer known and the relay on (no tokens)."""
        return await self.cloud.request("GET", STATUS, None, timeout_s=15.0)


class RelayGenAIClient:
    def __init__(self, cloud: AgencyCloud, timeout_s: float) -> None:
        self.aio = SimpleNamespace(models=_Models(cloud, timeout_s))


@dataclass
class AgencyCloudProvider(GeminiProvider):
    """Gemini on AGENCY's key through the relay: the same prompts, lanes, failover and checks as a local key."""

    cloud: AgencyCloud | None = None

    label: ClassVar[str] = "AGENCY Cloud"

    def __post_init__(self) -> None:
        if self.cloud is None:
            raise ValueError("AgencyCloudProvider needs an AgencyCloud")
        if self.client is None:
            self.client = RelayGenAIClient(self.cloud, max(self.timeout_s, MIN_DEADLINE_S))
        if self.fast_client is None:
            self.fast_client = RelayGenAIClient(self.cloud, FAST_TIMEOUT_S)

    def status(self) -> dict[str, Any]:
        out = super().status()
        out["via"] = "agency-cloud"
        return out

    def _api_error(self, exc: Exception, model: str | None = None) -> str:
        if isinstance(exc, RelayError):
            return exc.plain
        if not isinstance(exc, errors.APIError):
            return "could not reach AGENCY Cloud (network)"
        return super()._api_error(exc, model)

    @staticmethod
    def _key_problem(exc: Exception) -> bool:
        return (isinstance(exc, RelayError) and exc.reason in STOP_REASONS) or GeminiProvider._key_problem(exc)
