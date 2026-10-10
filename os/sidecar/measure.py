"""Measures the frozen coordinator: folder size and time from launch to a healthy /api/health (3 runs)."""

from __future__ import annotations

import json
import os
import platform
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def startup_ms(binary: str) -> float:
    port = free_port()
    with tempfile.TemporaryDirectory() as data:
        env = {
            **os.environ,
            "AGENCY_HOST": "127.0.0.1",
            "AGENCY_PORT": str(port),
            "AGENCY_API_TOKEN": secrets.token_urlsafe(16),
            "AGENCY_DB_PATH": f"{data}/agency.db",
            "AGENCY_FRONTEND_DIST": "/nonexistent",
        }
        t0 = time.monotonic()
        proc = subprocess.Popen([binary], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # noqa: S603
        try:
            while time.monotonic() - t0 < 60:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:  # noqa: S310
                        if r.status == 200:
                            return (time.monotonic() - t0) * 1000
                except OSError:
                    time.sleep(0.05)
            raise RuntimeError("coordinator did not become healthy within 60 s")
        finally:
            proc.terminate()
            proc.wait(10)


def main() -> int:
    binary = sys.argv[1]
    folder = Path(binary).parent
    size = sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())
    runs = [round(startup_ms(binary)) for _ in range(3)]
    print(
        json.dumps(
            {
                "tool": "PyInstaller --onedir",
                "machine": platform.machine(),
                "macos": platform.mac_ver()[0] or None,
                "python": platform.python_version(),
                "size_mb": round(size / 1_000_000, 1),
                "files": sum(1 for p in folder.rglob("*") if p.is_file()),
                "startup_ms_runs": runs,
                "startup_ms_median": sorted(runs)[1],
                "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
