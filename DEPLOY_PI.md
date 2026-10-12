# Running the coordinator on a Raspberry Pi 4

The Pi runs the coordinator: workflow engine, demo services, SQLite and the audit trail. The MacBook runs the
interface in Chrome, because the camera only works on a secure page (`localhost`). The Pi has no camera and none is
needed.

```
MacBook: Chrome on http://localhost:5173  ──/api──▶  Vite (on the Mac) ──▶  Pi: coordinator on :8000 (token required)
```

The Pi is optional. If it's unavailable, `make demo` runs everything on the MacBook.

## What's needed

- Raspberry Pi 4 with **Raspberry Pi OS Bookworm, 64-bit** (ships Python 3.11), on the same network as the MacBook.
- The repository on the Pi (git clone or copy).

All Python dependencies install from prebuilt `aarch64` wheels; nothing compiles on the Pi.

## Set up the Pi

On the Pi:

```sh
git clone https://github.com/NeilGilani/game.git ~/agency
cd ~/agency
make pi-setup
```

`deploy/pi/setup.sh` will:

1. install `python3-venv` if missing (asks for sudo),
2. create `backend/.venv` and install `backend/requirements.txt`,
3. write `/etc/agency/agency.env` (mode 600) with `AGENCY_HOST=0.0.0.0`, `AGENCY_NODE_ROLE=raspberry-pi`, the
   SQLite path and a **newly generated access token** (only if the file doesn't already exist),
4. install and start the `agency-coordinator` systemd service (restarts on failure, starts on boot, hardened with
   `ProtectSystem=strict` and write access only to `backend/data`),
5. call `/api/health` and print the token and the Pi's addresses.

Service control on the Pi:

```sh
cd ~/agency
make pi-status
make pi-logs
make pi-stop
make pi-start
```

To change settings (for example to add `GEMINI_API_KEY` or turn off presenter controls with
`AGENCY_DEMO_CONTROLS=0`), edit `/etc/agency/agency.env` and run `make pi-stop` then `make pi-start`.

## Connect the MacBook

On the Mac (after `make setup`), start the interface pointed at the Pi (replace the address with the one setup printed, or the Pi's
`hostname.local`):

```sh
cd ~/agency
make dev-pi PI=agency-pi.local
```

Open **http://localhost:5173**, go to **Settings → Coordinator connection**, paste the access token, and press
**Save and test**. The status bar shows **Coordinator: Raspberry Pi**, and **Status** shows the Pi's model, host,
database and reasoning mode, all reported by the Pi itself.

Alternative without the Vite proxy: in Settings set the address to `http://<pi-address>:8000` and the token. The Pi
allows requests from the origins in `AGENCY_ALLOWED_ORIGINS` (localhost on ports 5173, 4173 and 8000 by default).

## Lifeline on the Pi: the independent watchdog

Running the coordinator on the Pi is what makes Lifeline's **Watch over me** meaningful: the Pi notices when the
MacBook goes silent (crash, frozen screen, flat battery) and calls for help by itself. The Lifeline screen shows
**Independent watchdog** when the coordinator is a Pi, and a warning when it runs on the same computer.

- **Power.** Give the Pi its own UPS or a power bank with pass-through charging. A Pi without power can't call
  anyone. (Not tested here.)
- **Response links.** Contacts open `/respond/<token>` on the coordinator. On the Pi it is reachable at
  `http://<hostname>.local:8000` by default. If phones can't resolve `.local` names (common on Android), set
  `AGENCY_PUBLIC_URL=http://<pi-ip-address>:8000` in `/etc/agency/agency.env`. The response page needs no
  coordinator token; each link's own unguessable token is the credential, and it only opens that one alert.
  `/api` still requires the token.
- **Real texts and calls (optional).** Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` to
  `/etc/agency/agency.env`, restart (`make pi-stop`, `make pi-start`), then switch a contact to *Text message* or
  *Text message and phone call* in Lifeline setup. For phones outside the home network to open the links, the
  coordinator must be reachable from the internet over https (for example through a tunnel or reverse proxy); that
  is outside the scope of this demo.
- **Simulated phones with a real phone.** With the coordinator on the network, the simulated phones window shows a
  QR code for each response link, so anyone on the same Wi-Fi can answer from their own phone.

## If the Pi drops off the network

The interface shows a red banner ("Can't reach the coordinator… nothing runs until it's back") and keeps working
locally; it doesn't queue task actions. A Lifeline help request is the exception: it is kept on the MacBook, the
alarm sounds there at once, and it is sent as soon as the Pi is back. Cases are safe in the Pi's SQLite database. When the Pi comes back the banner
clears on its own. If the coordinator restarted while a case was running, the case is held as **Interrupted** after
AGENCY checks with each service what had already happened; press **Resume** to continue without repeating anything.

To fall back to the MacBook entirely: stop `make dev-pi` and run `make demo`.

## Security notes

- The coordinator refuses to listen on a non-loopback address without `AGENCY_API_TOKEN`. Every `/api` route except
  `/api/health` requires the `X-Agency-Token` header; `/api/health` exposes no personal data.
- CORS is limited to the configured localhost origins.
- The token travels over plain HTTP. That's acceptable on a home network for a demo. For anything wider, put the
  coordinator behind TLS (for example a reverse proxy) and keep the Pi off untrusted networks.
- Presenter controls (fault injection, network override, reset) are off unless `AGENCY_DEMO_CONTROLS=1`. The Pi setup
  writes `AGENCY_DEMO_CONTROLS=1` into `/etc/agency/agency.env` for the hackathon (behind the token); set it to `0`
  for everyday use.
- Without a token (a coordinator on this computer only), changes from another website open in the same browser are
  refused: a request whose `Origin` is neither an allowed origin nor the coordinator itself gets 403.
- No camera data ever reaches the Pi.

## What has been verified

- `setup.sh` was run end to end in an **arm64 Debian Bookworm** container (emulated with QEMU), with the systemd step
  replaced by a direct start (`AGENCY_SKIP_SYSTEMD=1`): dependencies installed from aarch64 wheels on Python 3.11.2,
  the token was generated, `/api/health` answered, requests without the token got 401 and with it 200, and a repair
  case ran to the approval step.
- **Lifeline on arm64**, in the same container: a test alert was delivered to Jordan's simulated phone by the
  supervisor loop; the response page answered without the coordinator token (200) and "I'm on my way" acknowledged
  the alert; then, with Watch over me on and no heartbeats, the watchdog raised an alert on its own and alerted
  Jordan.
- The full backend test suite (83 tests, including 38 for Lifeline) passed on arm64 Python 3.11.2.
- The rendered systemd unit passes `systemd-analyze verify`.
- The backend suite also passes on Python 3.11 and 3.13 on x86_64.
- **Not verified here:** physical Raspberry Pi 4 hardware, the systemd unit under a real systemd, network discovery
  of `*.local` names, phones opening response links over Wi-Fi, and behaviour on a power cut (use a UPS).

Check `make pi-status` and `make pi-logs` on first boot.
