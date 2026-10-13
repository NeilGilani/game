# The caregiver's phone companion

The person using AGENCY can't set it up alone, and the people who help them are busy and often somewhere else. The
companion lets a carer do the setup from their own phone, see that AGENCY is all right, get Lifeline alerts, send a
message or photo to the person's screen, and leave notes for the next shift.

It is a web page that AGENCY serves on your home Wi-Fi. There is no app to install and no account to make.

> AGENCY is not a medical device or an emergency service. The companion is an extra way to stay in touch. It does not
> replace Lifeline's texts and calls, clinical alarms, or calling 911.

---

## Set it up (about two minutes)

**At the Mac**

1. Open **Settings**, then **For a helper**, then **Caregiver phones**.
2. Turn on **Let carers' phones connect**. The first time, macOS may ask whether AGENCY (or Python, when running from
   source) may accept incoming network connections. Choose **Allow**, or phones can't reach it.
3. Choose **Show a pairing code**. A QR code and a six-digit code appear for five minutes.

**On the carer's phone**

1. Join the same Wi-Fi as the Mac.
2. Point the phone's camera at the QR code and open the link. (Or type the address shown under the QR code, for
   example `http://192.168.1.20:8470`, and type the six-digit code.)
3. Type your name and choose **Pair this phone**.
4. If you're on the person's Lifeline list, choose your name. Then this phone can open your alerts.
5. Optional: use **Add to Home Screen** in the phone's browser so it opens like an app.

Each phone gets its own key. Pair each carer's phone separately, up to eight.

---

## What a carer can do

| Place | What it does |
|---|---|
| **Home** | Whether a Lifeline alert is open (with **Open the alert** when Lifeline has asked you), whether AGENCY is running, the camera, the Mac's battery, Watch over me and check-ins, recent alerts |
| **Send** | A short message and/or a photo. It appears big on the person's screen with your name, until they look at **Got it**. You see when it was seen |
| **Notes** | Hand-over notes for the next carer, kept on the Mac. Everyone paired can read them, and so can anyone at the Mac (Settings, Caregiver phones) |
| **Set up** | Lifeline contacts, safety settings, Talk phrases, favourite sites, the person's details for forms, the Papers folder |

### Carers suggest, the person decides

Every change shows on the person's screen with the carer's name, and is listed under **Who changed what** in Settings,
Caregiver phones. Some changes wait until the person allows them with a look:

| Applies at once | Waits for the person to allow it |
|---|---|
| Adding or editing a contact on a practice (simulated) phone; changing the order | Adding or changing a **real** phone number (real texts or calls) |
| Turning Watch over me, check-ins or the "can't see their eyes" alert **on**; more frequent check-ins; shorter waits | Removing a contact, or stopping one from being contacted |
| Talk phrases, favourite sites, details for forms, the Papers folder (the Mac applies them within seconds and reports back) | Turning any of those protections **off**, less frequent check-ins, longer waits |

The person sees **Allow**, **Don't allow** and **Later**. Later keeps the change waiting. Things only the person or a
helper at the Mac can do: give or withdraw Lifeline's permission to contact people, emergency-services settings, the
care plan and the responder card, and choosing any folder other than Documents or Downloads for Papers.

Talk phrases from carers go on their own Talk board, **From your carers**, so carers never change the person's own
phrases.

### Alerts on the phone

- While the companion page is open, it checks every few seconds. A new alert makes the phone buzz and beep (after
  you've tapped the page once, a browser rule) and shows **Open the alert**, which opens the same Lifeline response
  page that the alert text links to: **I'm on my way**, **I can't come**, questions, the care plan.
- The link only appears once Lifeline has actually asked you. Lifeline still asks people in order.
- A closed or locked phone page can't alert you: phone browsers stop web pages in the background, and push
  notifications need an internet service AGENCY doesn't use. **Keep Lifeline's real texts and calls set up** (see
  [LIFELINE.md](../LIFELINE.md)); the companion is in addition to them.

---

## How it's kept safe

- **Off until a helper turns it on** at the Mac. While it's off, nothing on the network can reach the phone page at
  all: its server isn't running.
- **Nothing without pairing.** Without a phone key, the phone server answers only the pairing screen. A pairing code
  lasts 5 minutes, works once, and is cancelled after 5 wrong tries. Showing a new code cancels the old one.
- **Each phone has its own key**, kept only on that phone. The Mac stores a scrambled (SHA-256) copy, so a copy of
  AGENCY's database can't be used to pretend to be a phone. **Remove** a phone in Settings, Caregiver phones, and it
  can't see or change anything from that moment. A carer can also **Unpair this phone** themselves.
- **Home network only.** Requests from addresses outside the private home ranges (for example through a router
  port-forward) are refused. The page must be opened by the Mac's address or `.local` name, which stops other
  websites from reaching it through tricks with domain names (DNS rebinding).
- **Rate limits.** Pairing tries are limited per phone and overall; messages and notes are limited per phone; every
  phone is limited overall. Requests over 2 MB are refused.
- **A separate server.** The phone server runs on its own port (8470) and has no route into AGENCY's own `/api`,
  which stays on the Mac behind the coordinator's token. It serves only the companion page, its own small API and
  Lifeline's response pages.
- **Strict page rules.** No other site can frame the page or read its answers; its answers are never cached; scripts only come
  from AGENCY itself.
- **No real message without a person.** The companion never sends a text, call or email. A new real phone number for
  Lifeline waits for the person to allow it, and Lifeline's own rules still apply.

### Plain HTTP, and how to turn on HTTPS

By default phones connect over plain HTTP on your home Wi-Fi. Someone else on the same Wi-Fi with the right tools
could read what passes (for example a phone's key, or a message). Use it only on Wi-Fi you trust, and remove a phone
at once if it's lost.

To use HTTPS instead, give the coordinator a certificate the phones trust. One way is
[mkcert](https://github.com/FiloSottile/mkcert):

```sh
brew install mkcert
mkcert -install
mkcert -cert-file ~/agency-companion.pem -key-file ~/agency-companion-key.pem riley-mac.local 192.168.1.20
```

Then in `.env` (or the coordinator's environment):

```sh
AGENCY_COMPANION_TLS_CERT=/Users/you/agency-companion.pem
AGENCY_COMPANION_TLS_KEY=/Users/you/agency-companion-key.pem
AGENCY_COMPANION_URL=https://riley-mac.local:8470
```

Each phone must trust mkcert's root certificate (`mkcert -CAROOT` shows where it is): on an iPhone, AirDrop
`rootCA.pem` to it, install the profile in Settings, then turn on full trust under General, About, Certificate Trust
Settings. On Android, install it under Security, Encryption and credentials. **This HTTPS path was not tested on a
real phone for this build** (see "What was and wasn't checked").

---

## Settings

| Setting | Where | Default |
|---|---|---|
| Caregiver phones on/off | Settings, For a helper, Caregiver phones | Off |
| `AGENCY_COMPANION` | Coordinator environment | On (set `off` to remove the feature entirely) |
| `AGENCY_COMPANION_PORT` | Coordinator environment | `8470` |
| `AGENCY_COMPANION_HOST` | Coordinator environment | `0.0.0.0` (the home network; other addresses are refused anyway) |
| `AGENCY_COMPANION_URL` | Coordinator environment | `http://<the Mac's Wi-Fi address>:8470` (the address in the QR code) |
| `AGENCY_COMPANION_TLS_CERT`, `AGENCY_COMPANION_TLS_KEY` | Coordinator environment | Not set: plain HTTP |
| `AGENCY_COMPANION_ALLOW` | Coordinator environment | Not set. Extra address ranges to accept, e.g. `100.64.0.0/10` for a VPN like Tailscale. This reaches beyond the home network: only set it on purpose |

The companion runs inside the coordinator. With a Raspberry Pi coordinator, phones connect to the Pi's address, and
the Mac's screen still applies the changes it keeps (phrases, sites, details, Papers folder) whenever AGENCY is open.

## What is stored, and where

All on the coordinator (the Mac, or the Pi), in AGENCY's database: paired phones (name, the Lifeline contact they
chose, when they were paired and last seen, the scrambled key), every change with who made it, hand-over notes, and
messages (photos are kept only for the 20 most recent messages). Details for forms pass through the coordinator on
their way to the Mac and are erased from it once the Mac has saved them (or the change was turned down). While
caregiver phones are on, the Mac shares its current phrases, sites, Papers folder and details with the coordinator so
phones can show them; turning caregiver phones off erases that copy. Nothing is sent to the cloud.

## What was and wasn't checked

Checked for this build: backend tests for pairing, refusals (unpaired, removed, turned off, outside addresses, other
host names, oversized requests), rate limits, the "person decides" rules, notes, messages, the status a phone sees,
and the real phone server starting, stopping and coming back after a restart; Playwright tests on a phone-size touch
screen against the real coordinator for pairing through the QR link, setup, messages and photos, notes, a Lifeline
alert answered through the real response page, and the security path.

Not checked: real iPhones and Android phones on a real home Wi-Fi (the tests use Chromium with a phone-size screen
on the same computer), HTTPS with a real certificate, the macOS firewall prompt, the packaged Mac app (the
companion runs inside its coordinator, as in development, but that wasn't run here), and how the page reads in
bright sunlight (the colours are chosen for strong contrast, not measured outdoors).
