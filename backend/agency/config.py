"""Runtime configuration, read from environment variables (and an optional .env file).

Nothing here is a secret except GEMINI_API_KEY, ANTHROPIC_API_KEY and AGENCY_API_TOKEN, which
are read from the environment only and never returned by any endpoint.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


def _load_dotenv() -> None:
    """Minimal .env loader (KEY=VALUE lines). Existing environment variables win."""
    for candidate in (REPO_DIR / ".env", BACKEND_DIR / ".env"):
        if not candidate.is_file():
            continue
        for raw in candidate.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    db_path: Path
    host: str
    port: int
    node_role: str
    api_token: str | None
    allowed_origins: list[str]
    demo_controls: bool
    step_delay_ms: int
    reasoning: str
    gemini_model: str
    anthropic_model: str
    reasoning_effort: str
    anthropic_fallbacks: bool
    reasoning_timeout_s: float
    frontend_dist: Path | None
    public_url: str | None = None
    lifeline_loop: bool = True
    lifeline_tick_s: float = 1.0
    inline_runner: bool = False
    extra: dict[str, str] = field(default_factory=dict)

    def response_base_url(self) -> str:
        """Where contacts' phones open response links (AGENCY_PUBLIC_URL wins)."""
        if self.public_url:
            return self.public_url.rstrip("/")
        host = self.host
        if host in {"0.0.0.0", "::"}:  # noqa: S104 - describing the bind address, not binding
            import socket

            name = socket.gethostname()
            host = name if name.endswith(".local") else f"{name}.local"
        return f"http://{host}:{self.port}"


def load_settings(**overrides: object) -> Settings:
    _load_dotenv()
    db_default = BACKEND_DIR / "data" / "agency.db"
    origins = os.environ.get(
        "AGENCY_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,"
        "http://localhost:8000,http://127.0.0.1:8000",
    )
    dist_env = os.environ.get("AGENCY_FRONTEND_DIST")
    dist_default = REPO_DIR / "frontend" / "dist"
    frontend_dist: Path | None
    if dist_env:
        frontend_dist = Path(dist_env)
    elif dist_default.is_dir():
        frontend_dist = dist_default
    else:
        frontend_dist = None
    settings = Settings(
        db_path=Path(os.environ.get("AGENCY_DB_PATH", str(db_default))),
        host=os.environ.get("AGENCY_HOST", "127.0.0.1"),
        port=_int("AGENCY_PORT", 8000),
        node_role=os.environ.get("AGENCY_NODE_ROLE", "auto"),
        api_token=os.environ.get("AGENCY_API_TOKEN") or None,
        allowed_origins=[o.strip() for o in origins.split(",") if o.strip()],
        demo_controls=_bool("AGENCY_DEMO_CONTROLS", True),
        step_delay_ms=_int("AGENCY_STEP_DELAY_MS", 650),
        reasoning=os.environ.get("AGENCY_REASONING", "auto").lower(),
        gemini_model=os.environ.get("AGENCY_GEMINI_MODEL") or "gemini-3.8-flash",
        anthropic_model=os.environ.get("AGENCY_ANTHROPIC_MODEL") or "claude-opus-5-5",
        reasoning_effort=(
            os.environ.get("AGENCY_REASONING_EFFORT") or os.environ.get("AGENCY_ANTHROPIC_EFFORT") or "medium"
        ).lower(),
        anthropic_fallbacks=_bool("AGENCY_ANTHROPIC_FALLBACKS", True),
        reasoning_timeout_s=float(
            os.environ.get("AGENCY_REASONING_TIMEOUT_S") or os.environ.get("AGENCY_ANTHROPIC_TIMEOUT_S") or "25"
        ),
        frontend_dist=frontend_dist,
        public_url=os.environ.get("AGENCY_PUBLIC_URL") or None,
    )
    if overrides:
        from dataclasses import replace

        settings = replace(settings, **overrides)  # type: ignore[arg-type]
    return settings
