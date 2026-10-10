# os/sidecar: the coordinator inside AGENCY.app

`make sidecar` freezes `backend/` (the FastAPI coordinator, Lifeline included) into
`os/sidecar/dist/agency-coordinator/` with **PyInstaller `--onedir`**; electron-builder copies it to
`AGENCY.app/Contents/Resources/sidecar/` and signs every binary in it with the app's identity.

## Why PyInstaller (onedir) and not python-build-standalone

| | PyInstaller onedir | python-build-standalone + site-packages |
|---|---|---|
| Size | only the modules the app imports | the whole standard library and interpreter |
| Startup | no unpacking (onefile would unpack to a temp dir on every launch, and is awkward to sign) | similar |
| Signing | ~95 files, all Mach-O signed by electron-builder | thousands of files to sign and notarize |
| Risk | must collect dynamically imported modules (`--collect-submodules agency uvicorn`); `--selftest` imports the whole app at build time to catch misses | none of that, but heavier |

## Measured

Measured with `os/sidecar/measure.py` (folder size; time from launch to a healthy `/api/health`, three runs):

| Where | Machine | Python | Size | Startup (median of 3) |
|---|---|---|---|---|
| Developer Mac, 2026-10-10 | Apple M5 Pro, macOS 26.6.2, arm64 | 3.12.14 | 47.7 MB, 95 files | 397 ms (runs: 564, 397, 395 ms) |
| Inside the packaged app (unsigned arm64 build), same Mac | | | | 889 to 1016 ms from app launch to "coordinator ready" |

The CI macOS job runs `make sidecar` on every push and prints the numbers for that runner in the job summary.

## How the app runs it

- `127.0.0.1` only, a random free port, and a fresh random `AGENCY_API_TOKEN` every launch. Only the main process
  knows the token; it adds it to requests from the shell (through `agency://shell/api`).
- Data in `~/Library/Application Support/AGENCY/agency.db`.
- Supervised: health check every 5 s, restarted with backoff if it dies or stops answering.

## Raspberry Pi instead (recommended for Lifeline)

A coordinator on the Mac dies with the Mac. With a Raspberry Pi coordinator (see [DEPLOY_PI.md](../../DEPLOY_PI.md))
Lifeline's watchdog keeps running and alerts helpers if the Mac stops sending heartbeats.

- From the interface: `window.agency.host.setCoordinator({ mode: "remote", url: "http://agency-pi.local:8000", token })`
  checks the Pi, stores the token in the macOS keychain (Electron `safeStorage`) and restarts AGENCY. The Settings
  screen (Instance 7) exposes this.
- For development: `AGENCY_COORDINATOR_URL=http://agency-pi.local:8000 AGENCY_COORDINATOR_TOKEN=... make os-dev`.
