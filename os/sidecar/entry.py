"""Entry point of the frozen coordinator (PyInstaller) that ships inside AGENCY.app.

The desktop app starts it with AGENCY_HOST=127.0.0.1, a random AGENCY_PORT, a generated AGENCY_API_TOKEN and
AGENCY_DB_PATH in ~/Library/Application Support/AGENCY. `--version` and `--selftest` exist for packaging checks.
"""

from __future__ import annotations

import sys


def _main() -> int:
    if "--version" in sys.argv:
        from agency import __version__

        print(__version__)
        return 0
    if "--selftest" in sys.argv:
        # Import the whole application (catches modules PyInstaller missed) without serving.
        import agency.main  # noqa: F401

        print("ok")
        return 0
    from agency.__main__ import main

    return main()


if __name__ == "__main__":
    raise SystemExit(_main())
