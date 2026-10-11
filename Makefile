# AGENCY: run everything from the repository root.
#   make setup     install backend (Python 3.11+) and frontend (Node 20+) dependencies
#   make demo      build the interface and serve everything at http://localhost:8000
#   make dev       backend on :8000 + live-reloading interface on http://localhost:5173
#   make check     lint, type-check, unit tests and production build
#   make e2e       browser end-to-end tests (Playwright)
#   make os-dev    run the AGENCY OS desktop app (Electron) from source
#   make os-build  build the desktop app; make os-dist packages a .dmg (macOS)
#   make os-test   desktop unit tests + Electron smoke tests (needs a display)
#   make sandbox   the simulated web stores (food, shopping...) for the agent and the Chrome bridge
# Raspberry Pi: see DEPLOY_PI.md (make pi-setup on the Pi, make dev-pi PI=<address> on the Mac).

SHELL := /bin/bash
PY := backend/.venv/bin/python
PI ?= agency-pi.local

.PHONY: help setup setup-backend setup-frontend dev demo backend frontend dev-pi test test-backend test-frontend \
        lint typecheck build check e2e e2e-fixtures reset-demo pi-setup pi-start pi-stop pi-status pi-logs clean \
        os-check os-dev os-build os-dist os-test os-e2e sidecar sandbox
.PHONY: demo-synapse

help:
	@grep -E '^#' Makefile | head -11 | sed 's/^# \{0,1\}//'

setup: setup-backend setup-frontend
	@echo "Setup complete. Next: make demo  (then open http://localhost:8000)"

# Long timeouts and retries for slow connections; exact versions so pip never backtracks.
PIP_INSTALL := $(PY) -m pip install --timeout 60 --retries 10 -c backend/constraints.txt

setup-backend:
	bash scripts/bootstrap-python.sh
	-$(PY) -m pip install --timeout 60 --retries 10 --upgrade pip
	@$(PIP_INSTALL) -r backend/requirements.txt || { \
	  echo ""; \
	  echo "Couldn't download the coordinator's Python packages. This is almost always a slow or"; \
	  echo "interrupted connection (pip reports a package as missing when its download times out)."; \
	  echo "Run make setup again; already-downloaded packages are reused."; \
	  exit 1; }
	@$(PIP_INSTALL) -r backend/requirements-dev.txt || { \
	  echo ""; \
	  echo "The developer tools (tests, linters) didn't install, probably a slow connection."; \
	  echo "The demo still works. Run make setup again later before make check."; }

setup-frontend:
	@node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<20||(a===20&&b<19)) { console.error("Node 20.19+ is required (found "+process.versions.node+"). brew install node"); process.exit(1) }'
	npm install --no-audit --no-fund
	npm run vendor -w frontend

backend:
	cd backend && .venv/bin/uvicorn agency.main:app --host 127.0.0.1 --port 8000 --reload

frontend:
	cd frontend && npm run dev

dev:
	@echo "Coordinator: http://127.0.0.1:8000   Interface: http://localhost:5173   (Ctrl-C stops both)"
	@trap 'kill 0' EXIT; \
	  (cd backend && AGENCY_FRONTEND_DIST=/nonexistent .venv/bin/uvicorn agency.main:app --host 127.0.0.1 --port 8000 --reload) & \
	  (cd frontend && npm run dev) & \
	  wait

demo: build
	@echo "AGENCY is running at http://localhost:8000  (Ctrl-C to stop)"
	cd backend && .venv/bin/uvicorn agency.main:app --host 127.0.0.1 --port 8000

# Synapse-Mesh already owns :8000. Serve AGENCY separately and keep the browser same-origin.
demo-synapse: build
	@echo "AGENCY questions: http://localhost:8781/#/ask   Synapse-Mesh kernel: $${AGENCY_SYNAPSE_URL:-http://127.0.0.1:8000}"
	cd backend && AGENCY_PORT=8781 .venv/bin/python -m agency

dev-pi:
	@echo "Interface on http://localhost:5173, coordinator on the Pi at http://$(PI):8000"
	@echo "Enter the Pi's access token in Settings > Coordinator connection."
	cd frontend && AGENCY_BACKEND_URL=http://$(PI):8000 npm run dev

test: test-backend test-frontend

test-backend:
	cd backend && .venv/bin/python -m pytest -q

test-frontend:
	cd frontend && npm test

lint:
	cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check .
	cd frontend && npx eslint . && npm run format:check

typecheck:
	cd backend && .venv/bin/mypy agency
	cd frontend && npx tsc -b

build:
	cd frontend && npm run build

check: lint typecheck test build os-check
	@echo "All checks passed."

# --- AGENCY OS (npm workspaces: frontend, os/*, site) -------------------------------------
# Runs anywhere (Linux CI included): contracts and desktop type-checks and unit tests.
os-check:
	npm run typecheck -w @agency/contracts
	npm run typecheck -w @agency/desktop
	npm test -w @agency/desktop
	@for ws in os/*/; do \
	  name=$$(node -p "require('./$$ws/package.json').name" 2>/dev/null) || continue; \
	  case "$$name" in @agency/contracts|@agency/desktop) continue;; esac; \
	  if node -e "process.exit(require('./$$ws/package.json').scripts?.check ? 0 : 1)"; then \
	    echo "== $$name: npm run check"; npm run check -w "$$name" || exit 1; fi; \
	done

os-build: build
	@for ws in os/*/; do \
	  name=$$(node -p "require('./$$ws/package.json').name" 2>/dev/null) || continue; \
	  case "$$name" in @agency/contracts|@agency/desktop) continue;; esac; \
	  if node -e "process.exit(require('./$$ws/package.json').scripts?.build ? 0 : 1)"; then \
	    echo "== $$name: npm run build"; npm run build -w "$$name" || exit 1; fi; \
	done
	@if [ "$$(uname)" = "Darwin" ] && command -v swift >/dev/null && [ -f os/native-macos/Package.swift ]; then \
	  echo "== agency-native: swift build -c release"; \
	  (cd os/native-macos && swift build -c release --product agency-native) || exit 1; fi
	npm run build -w @agency/desktop

# The simulated web world (food, shopping, pharmacy...) the agent and the bridge practise on.
sandbox:
	npm start -w @agency/sandbox-web

os-dev: os-build
	cd os/desktop && AGENCY_WINDOWED=1 npx electron .

os-test: os-check os-e2e

os-e2e:
	npm run build -w @agency/desktop
	cd os/desktop && npx playwright test

# The coordinator as a self-contained binary for the app bundle (PyInstaller, see os/sidecar/README.md).
sidecar:
	bash os/sidecar/build.sh

# A .dmg in os/desktop/dist (signed and notarized only when the signing secrets are set).
os-dist: os-build sidecar
	npm run dist -w @agency/desktop

e2e-fixtures:
	$(PY) frontend/e2e/fixtures/make_fake_camera.py frontend/e2e/fixtures/.cache/face.y4m

e2e: e2e-fixtures
	cd frontend && npx playwright test

reset-demo:
	curl -fsS -X POST http://127.0.0.1:8000/api/demo/reset && echo

# --- On the Raspberry Pi ------------------------------------------------------------------
pi-setup:
	bash deploy/pi/setup.sh

pi-start:
	sudo systemctl start agency-coordinator

pi-stop:
	sudo systemctl stop agency-coordinator

pi-status:
	systemctl status agency-coordinator --no-pager; curl -fsS http://127.0.0.1:8000/api/health && echo

pi-logs:
	journalctl -u agency-coordinator -n 100 --no-pager

clean:
	rm -rf os/desktop/out os/desktop/dist os/desktop/test-results os/sidecar/build os/sidecar/dist
	rm -rf frontend/dist frontend/test-results frontend/playwright-report backend/.pytest_cache backend/.mypy_cache backend/.ruff_cache
