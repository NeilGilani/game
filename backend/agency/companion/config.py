"""Where the phone server listens, read from the environment. Nothing here is a secret."""

from __future__ import annotations

import ipaddress
import os
import socket
from collections.abc import Mapping
from dataclasses import dataclass, field

from .security import parse_networks

DEFAULT_PORT = 8470


@dataclass(frozen=True)
class CompanionConfig:
    available: bool = True
    host: str = "0.0.0.0"  # noqa: S104 - the home network; requests from elsewhere are refused (security.py)
    port: int = DEFAULT_PORT
    tls_cert: str | None = None
    tls_key: str | None = None
    public_url: str | None = None
    extra_networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = field(default_factory=list)
    # Tests drive the phone app in-process and never open a port.
    listen: bool = True
    # Where companion.html is built (frontend/dist). The Mac app sets it, because there the coordinator itself
    # serves no interface (AGENCY_FRONTEND_DIST is off) but phones still need their page.
    dist: str | None = None

    @property
    def tls(self) -> bool:
        return bool(self.tls_cert and self.tls_key)

    def base_url(self) -> str:
        """The address a phone opens (it goes in the QR code)."""
        if self.public_url:
            return self.public_url.rstrip("/")
        scheme = "https" if self.tls else "http"
        host = self.host
        if host in {"0.0.0.0", "::", ""}:  # noqa: S104 - describing the bind address
            host = lan_address() or f"{socket.gethostname().removesuffix('.local')}.local"
        if ":" in host:
            host = f"[{host}]"
        return f"{scheme}://{host}:{self.port}"


def lan_address() -> str | None:
    """This computer's address on the home network. A UDP connect sends nothing; it only picks a route."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # TEST-NET-1: never routed anywhere real
            addr = str(s.getsockname()[0])
    except OSError:
        return None
    if addr.startswith("127.") or addr == "0.0.0.0":  # noqa: S104
        return None
    return addr


def load_config(env: Mapping[str, str] | None = None) -> CompanionConfig:
    env = os.environ if env is None else env
    off = (env.get("AGENCY_COMPANION") or "").strip().lower() in {"0", "off", "false", "no"}
    try:
        port = int(env.get("AGENCY_COMPANION_PORT") or DEFAULT_PORT)
    except ValueError:
        port = DEFAULT_PORT
    try:
        extra = parse_networks(env.get("AGENCY_COMPANION_ALLOW") or "")
    except ValueError:
        extra = []
    return CompanionConfig(
        available=not off,
        host=env.get("AGENCY_COMPANION_HOST") or "0.0.0.0",  # noqa: S104
        port=port,
        tls_cert=env.get("AGENCY_COMPANION_TLS_CERT") or None,
        tls_key=env.get("AGENCY_COMPANION_TLS_KEY") or None,
        public_url=env.get("AGENCY_COMPANION_URL") or None,
        extra_networks=extra,
        listen=(env.get("AGENCY_COMPANION_LISTEN") or "").strip().lower() not in {"0", "off", "false", "no"},
        dist=env.get("AGENCY_COMPANION_DIST") or None,
    )
