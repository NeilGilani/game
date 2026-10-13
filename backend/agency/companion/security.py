"""Guards for the phone server: who may connect, how often, and how device tokens are kept.

- **Home network only.** Requests from an address outside the private ranges (a router port-forward, a tunnel) are
  refused, so the companion is never reachable from the internet by default.
- **No DNS rebinding.** The Host header must be an IP address, ``localhost`` or a ``.local`` name (or the address
  set in ``AGENCY_COMPANION_URL``), so a web page can't point a domain it controls at the Mac and talk to it.
- **Rate limits.** Pairing is limited per address and overall; every other call per address.
- **Tokens are hashed.** The coordinator keeps only a SHA-256 of each device token, so a copy of the database can't
  be used to act as a paired phone.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import secrets
import time
from collections import deque
from collections.abc import Callable
from urllib.parse import urlsplit

# Tailscale and other carrier-grade NAT ranges (100.64.0.0/10) are deliberately not "home": they reach across the
# internet. A family that wants that can set AGENCY_COMPANION_ALLOW to the range on purpose.
HOME_NETWORKS = [
    ipaddress.ip_network(n)
    for n in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
]


def parse_networks(raw: str) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    out = []
    for part in raw.split(","):
        part = part.strip()
        if part:
            out.append(ipaddress.ip_network(part, strict=False))
    return out


def is_home_address(host: str | None, extra: list[ipaddress.IPv4Network | ipaddress.IPv6Network] | None = None) -> bool:
    if not host:
        return False
    try:
        addr = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return any(addr in net for net in [*HOME_NETWORKS, *(extra or [])])


def host_allowed(host_header: str | None, public_url: str | None = None) -> bool:
    """The Host header names this Mac on the home network, not some other site's domain."""
    if not host_header:
        return False
    host = urlsplit(f"//{host_header}").hostname or ""
    if public_url and host == (urlsplit(public_url).hostname or ""):
        return True
    if host == "localhost" or host.endswith(".local"):
        return True
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def same(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


class RateLimiter:
    """At most ``limit`` events per ``window_s`` per key (a sliding window). Small and in memory: one home."""

    def __init__(self, limit: int, window_s: float, now: Callable[[], float] = time.monotonic) -> None:
        self.limit = limit
        self.window_s = window_s
        self.now = now
        self._hits: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        t = self.now()
        hits = self._hits.setdefault(key, deque())
        while hits and t - hits[0] >= self.window_s:
            hits.popleft()
        if len(hits) >= self.limit:
            return False
        hits.append(t)
        if len(self._hits) > 1000:  # forget quiet keys so the table can't grow without bound
            for k in [k for k, v in self._hits.items() if not v]:
                del self._hits[k]
        return True

    def retry_after(self, key: str) -> int:
        hits = self._hits.get(key)
        if not hits:
            return 0
        return max(1, int(self.window_s - (self.now() - hits[0])) + 1)

    def reset(self) -> None:
        self._hits.clear()
