"""Run the coordinator: `python -m agency` (used by the Raspberry Pi service).

Refuses to listen on a non-loopback address without AGENCY_API_TOKEN, so a writable API
is never exposed to the local network by accident.
"""

from __future__ import annotations

import ipaddress
import os
import sys

import uvicorn

from .config import load_settings


def _is_loopback(host: str) -> bool:
    if host in {"localhost"}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def main() -> int:
    settings = load_settings()
    if not _is_loopback(settings.host) and not settings.api_token and os.environ.get("AGENCY_ALLOW_INSECURE_LAN") != "1":
        print(
            f"Refusing to listen on {settings.host} without AGENCY_API_TOKEN.\n"
            "Set AGENCY_API_TOKEN (see DEPLOY_PI.md) or bind to 127.0.0.1.",
            file=sys.stderr,
        )
        return 2
    uvicorn.run("agency.main:app", host=settings.host, port=settings.port, log_level="info", proxy_headers=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
