# AGENCY roadmap

*Written 12 October 2026. A living document: change it when what you learn from users changes it.*

## Summary

- **The first priority is evidence, not features.** Nobody with ALS, locked-in syndrome or a high spinal cord injury
  has used AGENCY yet, and every accuracy number for the gaze engine comes from a simulated face. The next three
  months should go on making the existing build safe to put in front of real people, and then putting it in front of
  them: with consent, with clinicians in the room, and with a protocol.
- **Some quick fixes come before anyone else uses it:** choose a license, stop sending real conversations to a
  free-tier AI key (Google may use free-tier prompts to improve its products, and people may read them), turn demo
  fault-injection off by default, sign the Mac app, and give the eye keyboard digits and "@".
- **Webcam gaze will always be approximate.** Published comparisons put webcam trackers at roughly 2 to 4 degrees of
  error against well under 1 degree for infrared trackers. So the roadmap supports infrared trackers people already
  own, plans for the eyes getting tired and for eye control declining as the disease progresses, and always keeps a
  switch fallback.
- **Speed of communication is the need people mention most.** Everyday eye-gaze typing has been measured at about
  8 words per minute, against roughly 180 for speech. AI sentence completion is AGENCY's strongest card here,
  and it should run on the device as well as in the cloud.
- **Next (about 3 to 9 months):** Windows, then iPad and Android; other languages; voice banking; a caregiver
  companion; smart home through Home Assistant/Matter; a hospital bedside mode that uses certified nurse-call
  adapters rather than wiring into nurse call; real-service integrations behind strict approvals.
- **Regulation shapes the roadmap.** Several planned features (summoning help, environmental control, hospital use)
  sit close to FDA device categories. See [NONPROFIT_PLAN.md](NONPROFIT_PLAN.md#5-privacy-and-medical-device-regulation)
  and get regulatory advice before you market any of them.

---

## How to read this

- **Now** is roughly the next 3 months, **Next** is 3 to 9 months, **Later** is 9 months and beyond. These assume
  three students working part-time.
- **Effort**: **S** is under a week for one person, **M** is 2 to 6 weeks, **L** is 1 to 3 months, **XL** is more
  than 3 months or needs partners or hardware you don't have.
- Each item says **why it matters** in one line. Items are in priority order within each section.
- A ⚖️ marks items with legal or regulatory questions. Read the nonprofit plan before shipping them.

---

## What people with ALS and locked-in syndrome need (what the research says)

These points come from the literature. Use them to guide decisions until you have your own user data, and then
let your own data win.

- **Almost everyone with ALS loses functional speech.** 80 to 95% of people with ALS become unable to meet their
  daily communication needs with natural speech ([Beukelman, Fager & Nordness 2011](https://pmc.ncbi.nlm.nih.gov/articles/PMC3096454/)).
  In ALS, AAC is ordinary, expected care, not an edge case.
- **Eye gaze is slow.** A long-term field study logged everyday eye-gaze typing at **8.1 ± 3.9 words per minute**
  ([Cai et al., SpeakFaster Observer, CHI 2023](https://research.google/pubs/speakfaster-observer-long-term-instrumentation-of-eye-gaze-typing-for-measuring-aac-communication/)),
  and interviews with people with ALS put eye-gaze keyboards at about 10 to 20 wpm against roughly 180 wpm for speech
  ([Kane et al., CSCW 2017](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/10/aacselfexpression-1.pdf)).
- **AI can help a lot, but so far only in very small studies.** An LLM abbreviation interface raised text-entry rates
  by 29 to 60% for two eye-gaze users with ALS ([Cai et al., Nature Communications 2024](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11530652/)).
- **People want to sound like themselves, not just be understood.** Self-expression, humour and timing matter as
  much as raw speed ([Kane et al. 2017](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/10/aacselfexpression-1.pdf)).
  This is the argument for voice banking, personal phrase history and fast "quick replies".
- **Eye control can decline too.** In advanced ALS, eye movements can slow and undershoot targets
  ([J Neurol 2023](https://link.springer.com/article/10.1007/s00415-023-11957-y)), and in the completely locked-in
  state eye trackers stop working; researchers have turned to EOG and brain-computer interfaces
  ([PMC7242332](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7242332/), [PMC4560087](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4560087/)).
  Design for change over time: several input methods, adjustable dwell, and no feature that only works with
  perfect eyes.
- **Caregivers carry a heavy load.** A German multicentre study found a median of 3 hours of care a day, with about
  1.3 more hours a day when the person needs ventilation, and a high burden overall
  ([Schischlevskij et al., Brain Sciences 2021](https://pmc.ncbi.nlm.nih.gov/articles/PMC8228206)). Anything that
  saves caregivers time, or lets them sleep knowing Lifeline is watching, matters to them as much as to the person.
- **In hospital, communication problems are a safety problem.** Patients with communication problems were three
  times as likely to have a preventable adverse event ([Bartlett et al., CMAJ 2008](https://pmc.ncbi.nlm.nih.gov/articles/PMC2396356)).
  Training nurses and adding AAC tools in ICUs has been studied in the SPEACS trials
  ([protocol](https://pmc.ncbi.nlm.nih.gov/articles/PMC2570317), [results](https://pmc.ncbi.nlm.nih.gov/articles/PMC4053558)).
- **Free, built-in tools now exist.** iPhone and iPad have built-in camera eye tracking
  ([Apple, May 2024](https://www.apple.com/newsroom/2024/05/apple-announces-new-accessibility-features-including-eye-tracking/));
  Windows has Eye Control for supported Tobii and EyeTech trackers
  ([Microsoft](https://support.microsoft.com/windows/get-started-with-eye-control-in-windows-1a170a20-1083-2452-8f42-17a7d4fe89a9));
  Google offers Look to Speak and open-sourced Project Gameface
  ([Google](https://blog.google/outreach-initiatives/accessibility/look-to-speak/)). AGENCY shouldn't try to beat
  these at being a cursor. Its value is in what it adds on top: tasks done with safe approvals, Lifeline, fast
  AI-assisted talk, and a free, open, cross-platform design that families and clinicians can trust.

---

## Now (next ~3 months)

### A. Make the current build safe to put in front of real people

| # | Item | Why it matters | Effort |
|---|---|---|---|
| A1 | **Choose and add a LICENSE** (see the nonprofit plan for the AGPL question raised by RealEye) and a contributor sign-off rule (DCO) | Without a license, nobody, including partners and contributors, may legally reuse the code ([site credits page says so](../site/src/pages/credits.astro)) ⚖️ | S |
| A2 | **Stop using free-tier AI keys for anything a real person says.** Use a paid Gemini project (or Vertex AI) and make "AI off" or "on-device only" easy to choose | Under the [Gemini API terms](https://ai.google.dev/gemini-api/terms), unpaid-service prompts may be used to improve Google's products and read by human reviewers; Talk sends what was heard and the person's recent phrases ⚖️ | S |
| A3 | **Write down the AI provider rules that affect you**: Gemini's terms require users to be 18+ and bar use "in clinical practice" or where device clearance is required | These rules collide with a hospital mode and with any device route; know them before choosing a provider for each feature ⚖️ | S |
| A4 | **Turn demo controls off by default** (`AGENCY_DEMO_CONTROLS` is on unless set; `backend/agency/config.py`) and add a clear "practice mode" banner | Fault injection and demo reset should never be one request away on a real person's machine | S |
| A5 | **Sign and notarize the Mac app.** Apple waives the Developer Program fee for eligible nonprofits ([Apple](https://developer.apple.com/support/fee-waiver)) | Unsigned apps show scary Gatekeeper warnings; families shouldn't have to bypass security settings | S–M |
| A6 | **Privacy notice in plain language**: what stays on the device, what goes to which AI provider, what Lifeline contacts see, how to delete everything | Required for consent in any study, and it builds trust with families and clinics | S |
| A7 | **Threat model and SECURITY.md** (how to report a vulnerability; what an attacker on the home network could do with the coordinator token over HTTP) | The agent can spend money and send messages; the person can't easily intervene | M |
| A8 | **Bring docs up to date**: `docs/os/STATUS.md` (dated 10 Oct and still lists Talk, task packs etc. as not integrated), THIRD_PARTY.md (chess.js missing) | Partners and reviewers will read these first | S |

### B. Eye tracking you can trust

| # | Item | Why it matters | Effort |
|---|---|---|---|
| B1 | **Measure real people, starting with yourselves.** Run the existing Gaze lab (Settings › Gaze lab) on the team, then on non-disabled volunteers, across laptops, lighting, glasses and distances. Publish the numbers next to the simulated ones | Every accuracy figure today is simulated ([os/gaze/BENCHMARKS.md](../os/gaze/BENCHMARKS.md)); you need a real baseline before a study | M |
| B2 | **Benchmark against an infrared tracker.** Borrow one, for example through California's AT Act program device lending libraries ([Ability Tools](https://catada.info/apr_reports25/california_2025)) or a clinic, and record both at once | Lets you state accuracy in degrees honestly; webcam trackers typically measure 2 to 4° of error ([UNL dissertation](https://digitalcommons.unl.edu/computerscidiss/255), [Utrecht thesis](https://studenttheses.uu.nl/handle/20.500.12932/40709)) | M |
| B3 | **Support infrared trackers as an input provider** (Tobii/EyeTech through their SDKs or the OS) alongside the webcam | Some people already own an infrared tracker (the [Steve Gleason Act of 2015](https://www.govinfo.gov/link/statute/129/441) added eye-tracking accessories for speech-generating devices to Medicare coverage); webcam should be the free entry point, not the ceiling | L |
| B4 | **Fatigue-aware settings**: dwell that lengthens on request or after errors, a one-look "rest my eyes" mode that keeps Lifeline active, larger targets late in the day, reminders to blink and rest | Fatigue limits how long people can use eye gaze; the system should adapt instead of making more errors | M |
| B5 | **Finish calibration in the desktop app** (the gaze window has no calibration channel yet, so calibration v2 can't run inside the OS: [os/gaze/README.md](../os/gaze/README.md)) and add per-person profiles | The packaged app should be as accurate as the web demo | M |
| B6 | **Always a non-facial alternative** to squint-to-scroll and blink gestures (scroll targets on screen; switch scanning) | Facial and eyelid muscles can weaken in ALS; LIFELINE.md already flags drooping lids and dry eyes | S |
| B7 | **Keep the switch fallback first-class**: test key-switch and blink-switch scanning end to end on every screen, and add USB/Bluetooth assistive switches | When eyes get tired or tracking fails, the person must still reach Help and Stop | M |

### C. Communication speed (Talk and the eye keyboard)

| # | Item | Why it matters | Effort |
|---|---|---|---|
| C1 | **Eye keyboard: add digits, "@", common punctuation and a symbols page.** It opens for email, phone and URL fields but has only letters, "." and "?" (`frontend/src/components/EyeKeyboard.tsx`) | People can't type an email address or a phone number today | S |
| C2 | **Word and sentence prediction in the eye keyboard**, reusing Talk's on-device predictions and AI completion | Prediction is one of the main speed levers for eye typing (see the SpeakFaster results above) | M |
| C3 | **Quick replies and "partner mode"**: one look for yes/no/wait/repeat, a large text display facing the listener, and a "say it again louder" button | Much of conversation is quick back-and-forth; the partner also needs to see the message | S |
| C4 | **Message history and personal phrase banks the person controls** (edit, delete, "never use this to suggest") | Personal phrases speed things up, and they're intimate; the person must own them | M |

### D. Lifeline: ready for a real home

| # | Item | Why it matters | Effort |
|---|---|---|---|
| D1 | **Real text messages**: US SMS from ordinary 10-digit numbers needs A2P 10DLC registration or it's blocked ([Twilio](https://support.twilio.com/hc/en-us/articles/14910496447771-Shutdown-of-Unregistered-10DLC-Messaging)); consider toll-free numbers or voice calls | Without registration, an emergency text fails with error 30034 | S–M |
| D2 | **A tested hardware kit**: Raspberry Pi with a UPS, a loud local sounder, a setup guide a non-technical relative can follow | The Pi with no backup power is a single point of failure ([LIFELINE.md](../LIFELINE.md#if-something-fails)) | M |
| D3 | **Long-running tests**: hours with the tab hidden, sleep/wake, Wi-Fi drops, power cuts | Heartbeat behaviour over hours has never been verified; the docs ask users to keep AGENCY visible | M |
| D4 | **Remove or re-label the "ventilator power watch"** until you have regulatory advice; keep it a smart-plug "power went off" notice | Monitoring life-support equipment is close to medical-alarm territory ⚖️ | S |
| D5 | **Consider renaming "Lifeline"** | "Lifeline" is also the FCC's phone subsidy program ([FCC](https://www.fcc.gov/lifeline-consumers)) and the 988 Suicide & Crisis Lifeline ([FCC](https://www.fcc.gov/sites/default/files/988-fact-sheet.pdf)); confusion in an emergency product is a real risk | S |

### E. Prepare the user study (details in [Plan for an ethical user study](#plan-for-an-ethical-user-study))

| # | Item | Why it matters | Effort |
|---|---|---|---|
| E1 | **Recruit advisors first**: at least one SLP who works in AAC, one OT, one person with ALS or locked-in syndrome (paid), one caregiver | You need experts and users shaping the study, not just signing off | M |
| E2 | **Talk to UCSC's Office of Research Compliance Administration (ORCA)** about IRB review ([irb.ucsc.edu](https://irb.ucsc.edu)); find a faculty sponsor | UCSC doesn't allow retroactive approval; anything that might be published needs review first ([UCSC guidance](https://officeofresearch.ucsc.edu/?p=4329)) | S |
| E3 | **Write the protocol, consent materials and data plan** | IRB review takes time; start early | M |
| E4 | **Build study tooling**: on-device event logging (opt-in, numbers only), fatigue ratings by eye, export for researchers | Measure without recording video or private words | M |

---

## Next (about 3 to 9 months)

### Platforms

| Item | Why it matters | Effort |
|---|---|---|
| **Windows version.** Electron and the web app already run there; replace the Swift native helper with one built on Windows UI Automation ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/desktop/WinAuto/entry-uiautocore-overview)); support trackers that Windows Eye Control supports | Many dedicated eye-gaze communication devices run Windows (Microsoft lists several Tobii Dynavox units as supported by Eye Control) | L |
| **iPad app, scoped to what iPadOS allows**: Talk, Lifeline, phrase boards, caregiver link. Use Apple's built-in Eye Tracking for system control rather than trying to control other apps | iPads are cheap, portable and common in clinics; iPadOS apps can't drive other apps the way the Mac native helper does | L |
| **Android app** using an AccessibilityService for cross-app control (as Project Gameface does). Google Play requires a declaration and allows the `isAccessibilityTool` flag only for tools built for people with disabilities ([Play policy](https://support.google.com/googleplay/android-developer/answer/10964491)) | Lowest-cost hardware; widest global reach | XL |
| **Linux/Raspberry Pi kiosk** for the coordinator only (already partly done) | A cheap, always-on Lifeline hub | M |

### Language and voice

| Item | Why it matters | Effort |
|---|---|---|
| **Internationalisation**: move all strings to translation files, set `lang` correctly (today `<html lang="en">`), right-to-left support, per-language keyboards and predictions. Pick the first languages with your users and partners | The interface, keyboard and AI prompts are all English-only today; families often speak more than one language | L |
| **Voice banking and message banking guide in the app**: point people to options early, while they can still speak. The MND Association keeps a comparison of services ([chart, Oct 2025](https://www.mndassociation.org/sites/default/files/public/2025-10/Voice%20banking%20services%20comparison%20chart%20-%20Oct%202025.pdf)) | Banking has to happen before speech is lost, so people need to hear about it early | S |
| **Personal Voice and third-party voices**: AGENCY already offers Apple's Personal Voice in the Mac app; add voices from services such as the ElevenLabs Impact Program, which offers free licenses to people with permanent speech loss through partner nonprofits such as Bridging Voice ([ElevenLabs](https://elevenlabs.io/blog/impact-program-announcement)) | Speaking in your own voice is about identity, not convenience | M |
| **Recorded message playback**: play the person's own banked recordings for favourite phrases | Some phrases should sound exactly like them | S |
| **Board import/export in Open Board Format** (used by Cboard, CoughDrop, LibreAAC: [Cboard](https://www.cboard.io/en/blog/2018-06-30-cboard-openboard-support/)) | SLPs can bring existing boards; users aren't locked in | M |

### Caregivers and clinicians

| Item | Why it matters | Effort |
|---|---|---|
| **Caregiver companion (web app/PWA)**: see that AGENCY is running and the eyes are tracked, get Lifeline alerts, read the "what happened" log, edit phrase boards and contacts remotely | Saves caregiver time; lets them sleep | L |
| **Clear rule: caregivers suggest, the person decides.** A caregiver can't approve payments or messages on the person's behalf unless the person has set that up, and the person can always see what was done | Autonomy, and protection against financial abuse of a vulnerable adult | M |
| **Clinician setup mode** for SLPs/OTs: tune dwell, target size, scanning, vocabulary; print a one-page settings summary for the care team | Clinicians set up AAC; they need a fast, safe way to adjust it | M |

### Hospital bedside mode ⚖️

| Item | Why it matters | Effort |
|---|---|---|
| **Bedside communication board**: pain scale, yes/no, suction, position, too hot/cold, call family; large type for staff; works offline | A bedside tool that needs no network is easier for a hospital to approve, and it works on day one | M |
| **Nurse call through certified adapters, not your own wiring.** Nurse call systems are built to UL 1069 ([UL](https://explorestandards.ul.org/signaling-nurse-call-equipment.html)); assistive nurse-call adapters exist and some are FDA-regulated and UL 1069 listed (example: [Curbell AC20 brochure](https://curbellmedical.com/wp-content/uploads/pdfs/nurse_call/map1776a_ac20_assistive_control_adaptor_brochure-1.pdf)). AGENCY could trigger such an adapter's switch input | A hospital's biomedical engineering team won't (and shouldn't) accept an unlisted device on nurse call | L, needs a hospital partner |
| **Room controls** (bed, TV, lights) only through the hospital's existing interfaces and with the hospital's approval | Same reason | XL |
| **Infection control and mounting**: wipeable setup, mount guidance, quick re-calibration after repositioning | Hospital reality | S |
| Note: the Gemini terms bar use "in clinical practice"; a hospital mode must run its AI on the device or with a provider whose terms allow it | Avoid breaching your AI provider's terms ⚖️ | — |

### Home and the agent

| Item | Why it matters | Effort |
|---|---|---|
| **Smart home through Home Assistant and Matter**, local first ([Home Assistant Matter integration](https://www.home-assistant.io/components/matter)): lights, fan, TV, thermostat, door. Read-only status first, then control with confirmation for doors and locks. Avoid medical claims; "powered environmental control systems" are an FDA device category ([21 CFR 890.3725](https://www.law.cornell.edu/cfr/text/21/890.3725)) ⚖️ | Independence at home with hardware people can buy anywhere, and it keeps working without the internet | M |
| **Messaging done safely**: start with the Mac's own Messages and Mail apps through the native helper, and email through the provider's official OAuth; always draft, show, approve; never send on the AI's own initiative; show "sent with help from AGENCY" if the person wants | Messaging is one of the most useful tasks and one of the easiest to get wrong (wrong person, wrong words, impersonation) | L |
| **Real services, one at a time, with strict approvals**: start read-only (track an order, check an appointment), then low-risk writes, then payments. Keep the rules that exist: no passwords, 2FA codes or card numbers handled; approval bound to the exact page element; per-site allow-list; spending limits; a daily summary to the person | Real-world value without real-world harm | L per service |
| **Prompt-injection defences tested with real pages**, plus the agent evals run against a live model (only scripted runs exist today: [os/agent/EVALS.md](../os/agent/EVALS.md)) | Web pages and emails will try to steer the agent | M |

### On-device AI and privacy

| Item | Why it matters | Effort |
|---|---|---|
| **On-device models for completion and quick replies**: Apple's Foundation Models framework on macOS/iOS 26 runs offline at no inference cost ([coverage](https://adtmag.com/articles/2025/06/10/apple-launches-ondevice-ai-framework-and-tools.aspx)); Gemini Nano on supported Android devices ([Android Developers](https://android-developers.googleblog.com/2025/08/the-latest-gemini-nano-with-on-device-ml-kit-genai-apis.html)) | Private, works without internet, no per-request cost, and avoids cloud terms that bar clinical use | L |
| **Simplify the AI path.** Keep the Synapse-Mesh routing layer optional and clearly documented; make the default path (one provider, or on-device) easy for anyone to run | The Synapse model files aren't in git, the linked repo wasn't publicly reachable when we checked, and the cloud kernel "hasn't been provisioned" ([LOCAL_MODEL.md](../LOCAL_MODEL.md)); a family can't depend on that | M |
| **Data at rest**: encrypt the coordinator database and memory store; one-look "delete everything"; export for the person | Health-adjacent data on a shared family computer | M |
| **TLS for the coordinator on the network** and per-device tokens instead of one shared secret | The token currently travels over plain HTTP on the home network (README, Known limitations) | M |
| **Software bill of materials and dependency scanning in CI** | Needed for any device route, and good practice anyway | S |

---

## Later (9 months and beyond)

| Item | Why it matters | Effort |
|---|---|---|
| **Inputs for when eye control fades**: EOG, single-muscle EMG switches, and partnerships with BCI research groups | Eye trackers stop working in the completely locked-in state | XL, partners |
| **Multi-person households and multiple users per coordinator** | Today it's one user per coordinator, no accounts | L |
| **Clinical evidence package** (if you pursue the device route): design controls, risk management, usability engineering, quality system | Required for insurance funding through the device route ⚖️ | XL |
| **Funding pathways for users** (for example, insurance coverage of an AAC setup that includes AGENCY), only after legal and regulatory advice | Cost is a barrier; but this changes your regulatory position | XL |
| **Open, consented research dataset** of gaze/selection numbers (never video) to help others improve webcam tracking | Advances the field; build only with explicit consent and IRB approval | L |
| **Wearables and AR glasses** as displays or trackers | Mobility outside the home | XL |
| **Games and leisure with friends**: turn-based online play with family, accessible creative tools | Quality of life and connection, not just tasks | M |

---

## Plan for an ethical user study

The paper says plainly that no study with disabled users has been run. Here is a path to one that protects
participants and produces data you can trust. It is a plan to discuss with your IRB and advisors, not a
substitute for them.

### Principles

- **Co-design, not just testing.** People with ALS, locked-in syndrome and spinal cord injury, and their caregivers,
  help decide what to build and how to measure it. Pay them for their time as advisors.
- **Clinicians in the loop.** An SLP (AAC specialist) and an OT help set up each participant and stop a session if
  needed.
- **AGENCY never replaces existing safety equipment** during a study. Ventilator alarms, existing communication aids
  and call systems stay in place. Lifeline is tested with drills, not relied on.
- **Fatigue is a risk.** Short sessions, breaks on request, a "stop now" signal agreed in advance (with an
  independent method, for example the person's usual yes/no), and no penalty for stopping.
- **Your grandmother is family, not a study participant.** Using AGENCY with her at home is personal. Using her data
  in a paper or presentation needs her informed consent and, if it's research, IRB review. Family members also
  shouldn't act as the impartial witness in consent.

### Phases

1. **Team and volunteer testing (no disabled participants yet).** Gaze lab numbers, task timings, bug fixing.
   Check with ORCA whether this needs review if you might publish it.
2. **Advisory co-design sessions.** Paid advisors with lived experience and clinicians review the interface and the
   protocol. Treat it as consultation; check with ORCA where consultation ends and research begins.
3. **Feasibility study (IRB approved).** About 8 to 15 participants (your advisors and statistician should set the
   number), in clinic or at home with a clinician, a few sessions each. Measures below.
4. **Home deployment study.** Several weeks of real use with check-ins, opt-in logging and caregiver interviews.

### Consent and regulatory questions to settle with the IRB

- **Accessible consent.** US rules expect written consent signed by the participant or a legally authorized
  representative ([45 CFR 46.117](https://chanrobles.com/usa/uslaws/cfr/title45/45-1.0.1.1.24.1.1.15.php)). FDA
  guidance (as summarised by IRBs) confirms that a person who understands but can't speak or write can be enrolled
  if they can indicate agreement by other means, with an impartial witness attesting
  ([UVA HRPP](https://hrpp.research.virginia.edu/node/2151)). Plan to give consent materials in large print and
  read aloud, and to take the answer through the person's usual yes/no method.
- **Capacity.** Some people with ALS have cognitive or behavioural changes. Ask the IRB how to assess capacity
  respectfully.
- **Device study risk.** If the study evaluates AGENCY as a device, the IRB decides whether it is a "significant
  risk" or "nonsignificant risk" device study; nonsignificant risk studies follow abbreviated rules in
  21 CFR 812.2(b) ([summary](https://ssri.psu.edu/significant-risk-vs-non-significant-risk)). Keeping Lifeline as a
  drill-only feature and leaving existing safety equipment in place should help this conversation, but it's the
  IRB's call.
- **Data.** Never record video or audio unless the protocol says so and the participant agrees. Prefer numbers
  (timings, error counts) over content. Decide retention and who can see what.

### What to measure

| Area | Measures |
|---|---|
| **Gaze input** | Calibration accuracy (degrees and pixels), precision, time to select, accidental selections per minute, recalibrations per hour, fallbacks to switch scanning |
| **Communication** | Words per minute, keystrokes saved by prediction, share of AI suggestions accepted, edits after acceptance, and how the person rates "it said what I meant" |
| **Tasks** | Task completion rate, time per task, number of looks per task, approvals declined or edited, errors caught by verification |
| **Fatigue and workload** | A 0 to 10 fatigue rating by eye before and after each session; NASA-TLX workload; session length the person chooses |
| **Usability and satisfaction** | SUS; QUEST 2.0 (device and service satisfaction); PIADS (psychosocial impact of assistive devices) ([overview](https://www.health.qld.gov.au/__data/assets/pdf_file/0034/1477186/Outcome-Measures-for-AT.pdf)) |
| **Lifeline** | Blink-signal success and false-trigger rates (also when tired and at night), time from signal to "I'm on my way" in drills, alerts cancelled in the countdown |
| **Caregivers** | Time spent helping with communication and tasks, burden (validated scale chosen with advisors), interviews |
| **Safety** | Every unintended consequential action, near miss, or Lifeline failure, reviewed with advisors |

---

## Known bugs and rough edges

Found in a quick read of the code and docs on 12 October 2026. None are fixed here.

1. **No license for AGENCY's own code.** The credits page says so; there is no `LICENSE` file at the repository
   root.
2. **The RealEye license note may not cover a charity.** THIRD_PARTY.md says RealEye's commercial license is free
   "for companies and academic projects under USD 1M". The license text's no-fee categories are for-profit small
   companies and academic or nonprofit *research* projects
   ([LICENSE-COMMERCIAL.md](https://github.com/RealEye-io/webcam-eyetracker-light-open)). A charitable nonprofit
   serving users isn't clearly in either. Until resolved, treat AGPL as the license that applies.
3. **THIRD_PARTY.md and the credits page don't list chess.js** (BSD-2-Clause), added with the games.
4. **Demo controls are on by default**: `demo_controls=_bool("AGENCY_DEMO_CONTROLS", True)` in
   `backend/agency/config.py`, and `.env.example` sets it to 1.
5. **Real words go to the cloud on free-tier keys**: `backend/agency/assist.py` sends what was heard and recent
   phrases; with an unpaid key, Google may use and human-review that content.
6. **Eye keyboard can't type digits or "@"**, though it opens for `email`, `tel` and `url` fields
   (`frontend/src/components/EyeKeyboard.tsx`); QWERTY English only; no prediction in the keyboard.
7. **English only**: `<html lang="en">`, hard-coded strings, no i18n framework.
8. **`docs/os/STATUS.md` is stale**: "Last updated 2026-10-10" and lists Instances 2 to 9 as not integrated, while
   main has Talk, task packs, the eye keyboard and games.
9. **Calibration v2 can't run in the desktop app** (no calibration channel in the gaze window:
   `os/gaze/README.md`).
10. **No real-person gaze data**: every accuracy number in `os/gaze/BENCHMARKS.md` is simulated; the Gaze lab has
    never been used by a real person.
11. **Agent evals are scripted only**; the live-model run "costs money (not run yet)" (`os/agent/EVALS.md`).
12. **Synapse-Mesh is a fragile dependency**: the GitHub link returned 404 when we checked (private or moved?), its
    model files aren't in git, and `LOCAL_MODEL.md` describes it both as on-device and as an edge controller for a
    cloud GPU kernel that "hasn't been provisioned yet".
13. **Lifeline limits that need fixing or very clear warnings**: sound needs a real click after each page load;
    heartbeats untested over hours with a hidden tab; the Pi needs a UPS; real Twilio untested and US SMS needs
    A2P 10DLC registration; blink thresholds are reasoned defaults, untested with ptosis or dry eyes.
14. **Ventilator "power watch"** wording edges towards a medical alarm claim.
15. **Coordinator token over plain HTTP** on the local network; single user, no accounts.
16. **Mac app unsigned and not notarized** (`docs/os/STATUS.md`).
17. **Squint-to-scroll depends on facial muscles** (MediaPipe `eyeSquint` blendshapes) that may weaken in ALS;
    make sure an on-screen scroll alternative is always available.
18. **Games are hard to find**: they're reached through Watch & listen because Home's 12 tiles are full (commit
    `00865ec`).
19. **Author name spelling**: the paper lists "Reyansh Bhakshi" (`docs/paper/agency-os.tex`); check it with
    Rayansh before the paper circulates further.
20. **Duplicated heading** "What was not measured" in `os/gaze/README.md`.

---

## Sources

All links were checked or found on 12 October 2026. Where a source is secondary (a law firm, news site or
aggregator), the text says so or links the primary source too.

- Beukelman, Fager & Nordness (2011), Communication Support for People with ALS: https://pmc.ncbi.nlm.nih.gov/articles/PMC3096454/
- Cai et al. (2023), SpeakFaster Observer: https://research.google/pubs/speakfaster-observer-long-term-instrumentation-of-eye-gaze-typing-for-measuring-aac-communication/
- Cai et al. (2024), LLMs to accelerate communication for eye gaze typing users with ALS: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11530652/
- Kane et al. (2017), self-expression through AAC devices: https://www.microsoft.com/en-us/research/wp-content/uploads/2016/10/aacselfexpression-1.pdf
- Oculomotor decline in advanced ALS (J Neurol 2023): https://link.springer.com/article/10.1007/s00415-023-11957-y
- Transition to the completely locked-in state: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7242332/ and https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4560087/
- Schischlevskij et al. (2021), informal caregiving in ALS: https://pmc.ncbi.nlm.nih.gov/articles/PMC8228206
- Bartlett et al. (2008), communication problems and adverse events: https://pmc.ncbi.nlm.nih.gov/articles/PMC2396356
- SPEACS: https://pmc.ncbi.nlm.nih.gov/articles/PMC2570317 and https://pmc.ncbi.nlm.nih.gov/articles/PMC4053558
- Apple Eye Tracking announcement: https://www.apple.com/newsroom/2024/05/apple-announces-new-accessibility-features-including-eye-tracking/
- Windows Eye Control: https://support.microsoft.com/windows/get-started-with-eye-control-in-windows-1a170a20-1083-2452-8f42-17a7d4fe89a9
- Google Look to Speak: https://blog.google/outreach-initiatives/accessibility/look-to-speak/
- Webcam vs infrared tracking: https://digitalcommons.unl.edu/computerscidiss/255, https://studenttheses.uu.nl/handle/20.500.12932/40709, https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11627531/
- Gemini API terms (last modified 28 April 2026): https://ai.google.dev/gemini-api/terms
- Apple Developer Program fee waiver: https://developer.apple.com/support/fee-waiver
- Steve Gleason Act of 2015 (Medicare coverage of eye-tracking accessories for SGDs): https://www.govinfo.gov/link/statute/129/441
- Twilio unregistered 10DLC blocking: https://support.twilio.com/hc/en-us/articles/14910496447771-Shutdown-of-Unregistered-10DLC-Messaging
- FCC Lifeline program: https://www.fcc.gov/lifeline-consumers ; 988 fact sheet: https://www.fcc.gov/sites/default/files/988-fact-sheet.pdf
- UCSC IRB: https://irb.ucsc.edu ; student research guidance: https://officeofresearch.ucsc.edu/?p=4329
- MND Association voice banking comparison (Oct 2025): https://www.mndassociation.org/sites/default/files/public/2025-10/Voice%20banking%20services%20comparison%20chart%20-%20Oct%202025.pdf
- ElevenLabs Impact Program: https://elevenlabs.io/blog/impact-program-announcement
- Open Board Format in Cboard: https://www.cboard.io/en/blog/2018-06-30-cboard-openboard-support/
- Windows UI Automation: https://learn.microsoft.com/en-us/windows/desktop/WinAuto/entry-uiautocore-overview
- Google Play AccessibilityService policy: https://support.google.com/googleplay/android-developer/answer/10964491
- UL 1069: https://explorestandards.ul.org/signaling-nurse-call-equipment.html ; Curbell AC20 brochure: https://curbellmedical.com/wp-content/uploads/pdfs/nurse_call/map1776a_ac20_assistive_control_adaptor_brochure-1.pdf
- 21 CFR 890.3725 (environmental control): https://www.law.cornell.edu/cfr/text/21/890.3725
- Home Assistant Matter integration: https://www.home-assistant.io/components/matter
- Apple Foundation Models framework (coverage): https://adtmag.com/articles/2025/06/10/apple-launches-ondevice-ai-framework-and-tools.aspx
- Gemini Nano / ML Kit GenAI: https://android-developers.googleblog.com/2025/08/the-latest-gemini-nano-with-on-device-ml-kit-genai-apis.html
- Consent for people who can't speak or write: https://hrpp.research.virginia.edu/node/2151 ; 45 CFR 46.117 text: https://chanrobles.com/usa/uslaws/cfr/title45/45-1.0.1.1.24.1.1.15.php
- Significant vs nonsignificant risk device studies: https://ssri.psu.edu/significant-risk-vs-non-significant-risk
- AT outcome measures (QUEST 2.0, PIADS): https://www.health.qld.gov.au/__data/assets/pdf_file/0034/1477186/Outcome-Measures-for-AT.pdf
- California AT Act program data (Ability Tools): https://catada.info/apr_reports25/california_2025
