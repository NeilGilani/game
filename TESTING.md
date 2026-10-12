# Trying AGENCY OS on your Mac

Plain steps, in order. Everything marked **simulated** does nothing in the real world.

## 1. Setup (once)

You need macOS 13 or later, Node 20.19+, Python 3.11+ and Xcode Command Line Tools (`xcode-select --install`).

```bash
git clone https://github.com/NeilGilani/game && cd game
make setup        # Python and npm packages
make check        # optional: every test that runs without a display
```

## 2. The AI (no key needed)

Nobody needs an API key: without one, the coordinator and the agent use **AGENCY Cloud**, Gemini on AGENCY's key
through AGENCY's relay ([docs/AI_RELAY.md](docs/AI_RELAY.md)). The status bar says **AI: AGENCY Cloud**. If the relay
is busy, at its daily limit or switched off, AGENCY says so in plain words and uses its built-in plans.

Advanced, for developers: a key of your own wins over AGENCY Cloud and costs money on your Google account.

- For the coordinator: copy `.env.example` to `.env` and set `GEMINI_API_KEY=...`.
- For the agent inside the app: either start the app from a terminal where you ran `export GEMINI_API_KEY=...`, or
  store it once in the keychain:

  ```bash
  security add-generic-password -s AGENCY -a gemini-api-key -w   # paste the key when asked
  ```

`AGENCY_RELAY=off` switches AGENCY Cloud off (then, without a key, only built-in plans and task packs run).

## 3. Start it

```bash
make os-dev       # builds everything (including the Swift helper) and opens AGENCY in a window
make sandbox      # in a second terminal: the simulated stores at http://food.localhost:8787 and friends
```

The web prototype still works on its own: `make demo`, then open http://localhost:8000.

## 4. Mac permissions

The first screen walks through them; each has an **Allow** and an **Open System Settings** button.

| Permission | Needed for |
|---|---|
| Camera | eye tracking (pictures stay on the Mac) |
| Accessibility | pressing buttons in other apps with your eyes |
| Screen Recording | the agent checking its work during a task (optional) |
| Microphone, Speech Recognition | calls (optional) |

In development macOS shows the requests as coming from **Electron** (or your terminal). After changing a permission,
quit and run `make os-dev` again. Help and Stop work without any permission.

## 5. Load the Chrome extension (AGENCY Bridge)

1. Run `make os-dev` once: it installs the bridge's native-messaging host for Chrome (and other Chromium browsers).
2. In Chrome open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick
   `os/browser-bridge/dist/extension`.
3. Restart Chrome. The extension icon shows when it is paired with AGENCY.

## 6. Try each part

Input: the mouse works as the gaze pointer (rest on a button to select it). To use your eyes, open the camera setup
from Settings and calibrate.

**Home tiles**

| Tile | What to try | Real or simulated |
|---|---|---|
| Talk | Pick phrases from the boards; they're spoken aloud. Listen shows what the other person says | Real speech on your Mac |
| Call someone | Pick Jordan, then a reason: a scripted call with replies you choose | **Simulated** call |
| Food | Choose Thai, a dish and a time; the agent plans the order, asks you to approve the total | **Simulated** store (needs `make sandbox`); nothing is paid |
| Messages, Shopping | Choose who or what; the agent asks before sending or buying | **Simulated** |
| Watch & listen, Browse | Some choices open a real app (Music, Safari...); others hand the task to the agent | Real apps; agent tasks need a key |
| Papers | Pick the benefits letter: it's explained in plain words, filled, then signed in the signing ceremony (read, then a deliberate confirmation) | Sample documents; nothing is sent |
| Apps | Open or switch apps | Real apps |
| Errands | The original repair demo with approvals and recovery | **Simulated** services |
| Lifeline | See below | |

**Gaze lab**: Settings, then Gaze lab (eye gaze, calibrated). Run the 9-dot test: it measures accuracy, shake (raw
and filtered), settle time and whether the engine's error radius is honest, on you and your camera. It then replays
your own recording through 27 filter settings and suggests snap and steadiness; nothing changes until you press
"Use these settings". "Save the numbers" exports anonymous metrics only (no images, no samples). The same screen
switches context priors (full, half, off), prediction and adaptive layout. Real numbers on a real person come
only from here: see `os/gaze/README.md` › Context, prediction and the Gaze lab.

**Memory**: Settings, then Memory, or the full explorer at `#/memory`. After a few choices it suggests "your usual" with a
reason; you can rename, hide, forget one thing, or forget everything.

**The overlay in other apps**: switch to Finder or Chrome. The rail on the right (Help, Stop, Home, Keyboard, More,
Pause eyes) stays on top. Rest the pointer (or your gaze) on a Finder button to press it. Keyboard types into the
focused field (never into password fields). Stop, or ⌘⇧⎋ anywhere, halts the agent and all synthetic input at once.

**Lifeline**: press **Help** on the rail, or close your eyes for about a second three times. AGENCY comes to the front
with the emergency screen and starts an alert. Contacts are **simulated phones**: open http://localhost:8000/#/phones (with `make demo`)
or `#/phones` in the app to answer as a helper. No emergency service is ever called; dispatch is **simulated**. Cancel the
alert from the emergency screen. For a Lifeline that keeps watching if the Mac dies, see `DEPLOY_PI.md`.

## 7. What is simulated, in one list

Stores, payments, calls, messages, emergency dispatch, Lifeline contacts' phones, the smart home and the repair
services. Real: speech, opening apps, pressing buttons in apps (with Accessibility), the browser bridge in your Chrome,
the camera pipeline (on the Mac only), and the AI model when you set a key.

## 8. If something goes wrong

Logs are in `~/Library/Logs/AGENCY/` (`main`, `coordinator`, `native`, `agent`, `bridge`). Status of every part:
`docs/os/STATUS.md`.
