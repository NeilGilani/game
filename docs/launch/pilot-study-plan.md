# Pilot study plan: AGENCY with people with ALS

*Draft, 12 October 2026. A plan to take to UCSC's Office of Research Compliance Administration (ORCA), a faculty
sponsor and clinical advisors. It isn't a protocol yet, and it doesn't replace their judgement. Every source was
checked on 12 October 2026; anything we couldn't confirm is marked "unverified". This builds on the study outline in
`docs/ROADMAP.md` ("Plan for an ethical user study").*

## Three things to settle first

1. **Which IRB reviews this.** UCSC's IRB "currently does not review FDA regulated research"; for studies of
   investigational devices UCSC uses the commercial IRB WCG
   ([UCSC IRB SOP](https://docs.google.com/document/d/1VDr4K4pFF2BnRv_nyHjflW__KiMVkBOZnMwWtkTLAmI), section 5.2,
   linked from [UCSC IRB policies](https://officeofresearch.ucsc.edu/compliance/irb/policies/)). FDA classifies
   "powered communication systems" ([21 CFR 890.3710](https://www.law.cornell.edu/cfr/text/21/890.3710)) and
   "powered environmental control systems" ([21 CFR 890.3725](https://www.law.cornell.edu/cfr/text/21/890.3725)) as
   devices when "intended for medical purposes". So the first question for ORCA is whether a study of AGENCY is
   FDA-regulated research. The answer depends on AGENCY's intended use and the claims made about it (see
   [Regulatory questions](#10a-regulatory-questions)). If it is, review goes to WCG (which costs money) or to a clinical
   partner's IRB.
2. **Who is PI.** At UCSC "your faculty sponsor should be listed as PI and will certify the submission"; the student
   is co-PI ([UCSC initial submission](https://officeofresearch.ucsc.edu/compliance/irb/initial-submission/)).
   Undergraduates aren't eligible to be PI ([PI eligibility](https://officeofresearch.ucsc.edu/principal-investigators/)).
   `[[TEAM: find a faculty sponsor in HCI, assistive technology or health.]]`
3. **Where sessions happen.** At a clinic with its own IRB, the UCSC PI needs that IRB's approval or written word
   that it isn't needed (UCSC SOP). With UCSF, UC campuses rely on each other through the UC MOU and the
   [UC IRB Reliance Registry](https://irbreliance.ucop.edu/site/about); UCSC also takes part in SMART IRB
   ([UCSC collaboration page](https://officeofresearch.ucsc.edu/compliance/irb/collaboration/)). Sutter CPMC's
   (Forbes Norris) process is unverified. Clinic records are protected health information, which needs that site's
   authorisation or a waiver.

**Email to send this week:** orca@ucsc.edu, or book an analyst appointment (Tuesday to Thursday,
[booking form](https://ucsantacruz.co1.qualtrics.com/jfe/form/SV_09v4s5ULRAQITzM)). Ask the three questions above,
attaching this plan.

---

## 1. Title and design

**Title:** Feasibility and acceptability of AGENCY, free webcam eye-gaze software for communication and everyday
computer tasks, for adults with ALS who rely on eye movement: a single-arm, mixed-methods pilot study.

**Design:** single arm, repeated sessions, mixed methods, reported following the CONSORT extension for pilot and
feasibility studies (Eldridge et al., 2016). Each participant compares AGENCY with their own usual communication
method within sessions where that's practical. No randomisation; no claims of effectiveness.

**Phases (only phase 3 is the study described here):**

| Phase | Who | Review |
|---|---|---|
| 0. Bench testing | The team and non-disabled volunteers, using the Gaze lab | Ask ORCA whether this needs review if it may be published |
| 1. Advisory co-design | Paid advisors with ALS, caregivers, SLP, OT | Consultation, not research; confirm with ORCA where the line is |
| 2. Software readiness | The team | See [section 12](#12-software-must-haves-before-the-first-participant) |
| **3. Feasibility study** | **10 to 15 adults with ALS and a caregiver each** | **IRB** |
| 4. Home deployment (later) | Several weeks of real use | New protocol or amendment |

## 2. Research questions

Feasibility (primary):

1. **Recruitment and retention.** How many eligible people are reached, consent, and complete all sessions? Why do
   people decline or stop?
2. **Procedures.** Can consent by eye gaze, the questionnaires and the session length work for this group?

Preliminary signals (secondary, descriptive only):

3. **Selection.** With a laptop webcam, how accurately and reliably can participants calibrate and select targets?
   How often do accidental selections, recalibrations and fallbacks to switch scanning happen?
4. **Communication.** What is the text-entry rate with and without AI sentence completion, how often are AI
   suggestions accepted or edited, and do participants feel the result "said what I meant"?
5. **Tasks.** Can participants complete practice tasks (simulated services) with approvals, and do any unintended
   consequential actions happen?
6. **Help signal.** In drills, how often does the three-long-blink signal succeed, and how often does it trigger by
   accident, including when the participant is tired?
7. **Acceptability.** How do participants and caregivers rate usability, satisfaction, psychosocial impact,
   workload and fatigue? What do they want changed?

**Progression criteria** (set with advisors before the study; Avery et al., 2017). Suggested starting points:
`[[TEAM: agree with advisors]]` at least 70% of enrolled participants complete all sessions; no serious adverse event
related to the study; no unintended consequential action by the agent; a median calibration grade of "fair" or
better.

## 3. Participants

**Inclusion:**

- Adult (18 or older). This also matters because the AI provider's terms bar under-18 users.
- Diagnosis of ALS (or a related motor neurone disease), confirmed by the participant's clinician.
- Communicates mainly or partly through eye movement, or is expected to soon, as judged by their SLP.
- A reliable yes/no signal through their usual method, confirmed before consent (see section 6).
- Able to give informed consent (see section 6 for capacity), or, only if the IRB allows it, consent from a legally
  authorised representative plus the participant's own assent.
- A caregiver or family member willing to take part (optional; the participant can join without one).

**Exclusion:**

- Photosensitive epilepsy.
- Medically unstable, as judged by their clinician.
- Unable to see a laptop screen at a usable distance, even with correction.
- Completely locked-in (no reliable eye-movement signal). Note: eye trackers stop working in the completely
  locked-in state; this study can't serve that group, and the report should say so.

**Sample size:** 10 to 15 participants. A pilot isn't powered to test effects; it estimates feasibility proportions.
With 12 participants and 10 completing (83%), the Wilson 95% confidence interval is 55% to 95%; with 15 and 12
completing (80%), 55% to 93% (our calculation). Published studies in this group are small: 2 participants with ALS
in SpeakFaster (Cai et al., 2024), 11 completers in Linse et al. (2018), 30 in Spataro et al. (2014), 35 in Caligari
et al. (2013), 19 end users across four BCI studies in Kübler et al. (2014). General pilot guidance ranges from 12
per group (Julious, 2005) upward (Billingham et al., 2013).

**Expect many people not to complete.** In one eye-tracking quality-of-life study, only 11 of 30 screened locked-in
patients completed it (Linse et al., 2017). Plan recruitment for about three times the target.

**Recruitment:** through clinicians (SLPs at ALS clinics) and, if they agree, ALS Network care managers, who pass
on an information sheet; the person contacts the team. No cold contact with patients. No recruitment through the
team's own family (the grandmother is family, not a participant; see `docs/ROADMAP.md`).

**Payment:** `[[TEAM: amount per session, set with the IRB]]` for participants and caregivers, paid however suits
them. Payment never depends on completing.

## 4. Setting, equipment and safety arrangements

- **At home or in clinic,** whichever suits the participant. Sessions at home include a clinician (SLP or OT) or a
  trained team member with a clinician on call `[[TEAM: decide with advisors]]`.
- **A dedicated study Mac** with no personal accounts or data. This matters because the agent sends pictures of the
  whole screen to the AI provider (see the [privacy policy draft](privacy-and-terms/privacy-policy.md)).
- **AGENCY in a study configuration:** practice services only; Lifeline contacts are the simulated phones on screen
  (drills only, never relied on); no real messages, calls or orders; no emergency dispatch; no Home Assistant.
- **Existing equipment stays in place and in use:** the participant's own AAC device, call bell, ventilator alarms
  and caregiver arrangements. AGENCY never replaces any of them during the study.
- **The usual caregiver is present** and sessions are scheduled around ventilation, suction and rest.
- **An agreed "stop now" signal** using the participant's usual method, not AGENCY.

## 5. Procedures

| Session | What happens | Length |
|---|---|---|
| Screening (call or visit) | Eligibility with the referring clinician; check the yes/no signal | 30 to 45 min |
| 1. Consent and setup | Consent (section 6); describe the participant (ALSFRS-R, communication history, ECAS if the clinician advises it); position the laptop; camera setup; calibration; free practice | Up to 60 min, split over two visits if needed |
| 2. Talk | Copy-typing and conversation tasks with and without AI sentence completion; quick phrases; suggested replies | Up to 45 min with breaks |
| 3. Tasks and help signal | Practice tasks on simulated services with approvals and Stop; help-signal drills, including near the end of the session when tired | Up to 45 min with breaks |
| 4. Wrap-up | Questionnaires; interview with the participant (by AAC) and the caregiver | Up to 60 min, split if needed |

- Fatigue and eye discomfort are rated 0 to 10 before and after every session, and at any break.
- Participants choose when to rest, and can end any session at any time.
- **Questionnaires are given through the participant's usual method or partner-assisted scanning, not through
  AGENCY,** so a problem with AGENCY can't skew the ratings of AGENCY. Any change in how a validated questionnaire
  is given is reported as an adaptation (as Linse et al., 2018, and Peters et al., 2023, did).

## 6. Consent for people who can't speak or write

**The principle:** being unable to speak or write doesn't mean being unable to consent. FDA's 2023 consent guidance
says a person "physically unable to talk or write ... can enroll ... if competent and able to signal consent
consistent with applicable law", and recommends recording "the specific means by which the prospective subject
communicated agreement" ([FDA guidance](https://www.fda.gov/media/88915/download), FAQ 7). Common Rule
requirements are in [45 CFR 46.116](https://www.law.cornell.edu/cfr/text/45/46.116) and
[46.117](https://www.law.cornell.edu/cfr/text/45/46.117).

**UCSC-specific rules** (UCSC IRB SOP):

- UCSC **does not allow the "short form" consent document** (45 CFR 46.117(b)(2)).
- Consent forms must show "lines for wet signature", **unless the study requests a waiver or alteration** and shows
  it meets the criteria. So we need either (a) a full written form with an alternative way to sign that the IRB
  accepts, or (b) a waiver of documentation under 46.117(c)(1)(ii) if the IRB agrees the study is minimal risk.
- Investigators using a legally authorised representative "must describe how they intend to assess the subject's
  capacity". The IRB "may require periodic re-consenting, 3rd party monitors for consent process, and/or waiting
  periods". A subject who resists "must not be compelled".

**Proposed procedure** (our synthesis of the sources below; to refine with the IRB and an SLP):

1. **Check the signal first.** Before consent, ask about 10 yes/no questions with known answers through the
   person's established method (their own eye-gaze device, an eye-transfer board or partner-assisted scanning), with
   a pass mark set in advance. Never use AGENCY, the thing being studied, as the consent channel. Haselager et al.
   (2009) warn that personal yes/no signs "may require some study before they can be recognized reliably", and
   that questions should be asked one at a time, without leading.
2. **Give information in short parts.** Key information first (46.116(a)(5)(i)), in large print and read aloud,
   with plain words and pictures. After each part, two or three yes/no or multiple-choice comprehension questions;
   re-explain after a wrong answer (a teach-back approach; Flory & Emanuel, 2004; Fink et al., 2010).
3. **Time to think.** Offer a second visit before signing.
4. **An impartial witness** who is neither family nor study staff is present for the whole discussion (as UCSF's
   IRB requires for people who can't talk or write:
   [UCSF guidance](https://irb.ucsf.edu/enrolling-subjects-who-are-legally-blind-illiterate-or-cannot-talk-or-write)).
   With permission, record the consent discussion on video, kept separately and only for consent records.
5. **Signing.** The participant signs by typing their name through their own AAC device (an electronic signature,
   allowed by 46.117(a)), or makes a mark with help; under California Civil Code §14 a "signature" includes a mark
   when someone can't write, with their name written nearby by a witness who also signs
   ([Civil Code §14](https://california.public.law/codes/civil_code_section_14)). The form records how the
   participant agreed, who was present, and who wrote the participant's name. `[[TEAM: confirm with ORCA which of
   these satisfies UCSC's wet-signature rule, or request an alteration.]]`
6. **Capacity.** Some people with ALS have cognitive or behavioural changes; in the ECAS validation sample, 29% had
   abnormal ALS-specific scores (Abrahams et al., 2014). Capacity is presumed; if the clinician or the
   comprehension questions raise doubt, use a three-step approach: make sure communication is reliable, widen the
   ways of communicating, then use capacity measures adapted to the person (Cairncross et al., 2016). UC's
   [Guidance Memo 21-01](https://researchmemosapi.ucop.edu/index.php/site/document?memo=UlBBQy0yMS0wMQ==&doc=3789)
   asks for a protocol-specific plan: criteria, who assesses, and how.
7. **Surrogate consent only if needed and allowed.** California Health and Safety Code §24178 sets who may consent
   for an adult who can't, for "medical experiments" relating to serious or life-threatening conditions: in order,
   an advance-directive agent, a conservator or guardian with health-care authority, spouse, registered domestic
   partner, adult child, custodial parent, adult sibling, adult grandchild, closest available adult relative; any
   disagreement among people of equal rank means no consent; surrogates may not be paid
   ([§24178](https://california.public.law/codes/health_and_safety_code_section_24178)). The UCSC SOP adopts this
   for surrogate consent. Even with a surrogate, the participant's assent is sought and any dissent, "by word or
   gesture", ends their participation. `[[TEAM: a feasibility study can reasonably be limited to people who can
   consent for themselves; decide with the IRB.]]`
8. **Ongoing consent.** Check willingness at the start of every session. Re-check consent if eye movement declines.
   Agree in advance what happens to the person's data if they can no longer communicate.
9. **Caregivers** consent separately, in the usual way, for their own questionnaires and interview.
10. **California's Experimental Subject's Bill of Rights** (H&S §24172) must be given for "medical experiments".
    Ask the IRB whether this study is one.

Further reading the team should know: Klein, Peters & Higger (2018) on ending BCI studies with locked-in
participants and planning for what happens afterwards (AGENCY is free, so participants can keep it if they want);
Taylor & Balandin (2020) and Walsh et al. (2024) on including people with complex communication needs in research.

## 7. Outcome measures

| Area | Measure | Items and how given | By eye gaze? | Licence | Source |
|---|---|---|---|---|---|
| **Feasibility** | Screened, eligible, consented, completed; reasons for declining and stopping; questionnaire completion; session time used | Study log | n/a | n/a | Eldridge et al., 2016 |
| **Selection** | Calibration accuracy (grade, pixels, degrees), precision, time to select, accidental selections per minute, recalibrations per hour, fallbacks to scanning | Logged by AGENCY (numbers only) | n/a | n/a | AGENCY Gaze lab definitions (`os/gaze/BENCHMARKS.md`) |
| **Text entry** | Words per minute (1 word = 5 characters); error rates (minimum string distance, keystrokes per character, total error rate); keystroke savings counting all interface actions | Copy-typing with a standard phrase set, and conversation tasks | n/a | Phrase set free to use for research | Soukoreff & MacKenzie, 2003; MacKenzie & Soukoreff, 2003; Cai et al., 2024 |
| **AI help** | Share of suggestions accepted, edited, rejected; "it said what I meant" (0 to 10) | Logged; one rating per task | Yes | n/a | Our measures |
| **Tasks** | Completion, time, looks per task, approvals declined or edited, errors caught; any unintended consequential action | Logged and observed | n/a | n/a | Our measures |
| **Help signal** | Success and false-trigger rates in drills, early and late in sessions; time to signal | Logged and observed | n/a | n/a | `LIFELINE.md` drills |
| **Usability** | System Usability Scale | 10 items, 5-point, 0 to 100 | Yes, with a 5-choice board; items alternate positive and negative, so check answers are reliable | Commonly described as free with attribution (unverified from Brooke's text) | Brooke, 1996; Bangor et al., 2008 |
| **Workload** | NASA-TLX (raw, unweighted) | 6 subscales | Adapted: choose a number on the person's own AAC rather than a slider | Free from NASA | Hart & Staveland, 1988; Hart, 2006 |
| **Device satisfaction** | QUEST 2.0 | 12 items, 5-point, plus top 3 items | Yes; used with anarthric people with late-stage ALS (Caligari et al., 2013) | Unverified | Demers et al., 2000, 2002. Note a reported ceiling effect |
| **Psychosocial impact** | PIADS | 26 items, −3 to +3, three subscales | Yes; used in late-stage ALS (Caligari et al., 2013) | Unverified; contact the authors | Jutai & Day, 2002 |
| **Communicative participation** | CPIB general short form | 10 items, T-score | Yes, with the ALS-AAC adaptation of Peters et al. (2023) | Free for clinical and research use, per the UW lab | Baylor et al., 2013; Peters et al., 2023 |
| **Health status (optional)** | ALSAQ-5 | 5 items | Yes | Licence through Oxford University Innovation | Jenkinson & Fitzpatrick, 2001 |
| **Fatigue and eye strain** | 0 to 10 fatigue and eye-discomfort ratings before and after each session; optional NFI-MND | Single items | Yes | NFI-MND unverified | Gibbons et al., 2011; eye-gaze tiredness was the main reason for low use in Spataro et al. (2014) |
| **Individual goals** | Goal Attainment Scaling | 2 to 3 goals set with the participant | Yes | Free method; needs training | Kiresuk & Sherman, 1968; Turner-Stokes, 2009 |
| **Describing participants** | ALSFRS-R; communication history; ECAS if advised | 12 items (self or caregiver report is valid) | Caregiver can report | Unverified | Cedarbaum et al., 1999; Montes et al., 2006; Abrahams et al., 2014 |
| **Caregivers** | Zarit Burden Interview, 12-item short form; time spent helping; interview | Self-report | n/a | Licensed through Mapi Research Trust (fees unverified) | Zarit et al., 1980; Bédard et al., 2001 |
| **Experience** | Semi-structured interviews (participant by AAC, caregiver) | Short questions, written in advance and sent ahead | Yes, with extra time | n/a | Kübler et al. (2014) used a similar effectiveness, efficiency and satisfaction framework |

**Keep the burden low.** Pick the smallest set that answers the questions. Suggested core: feasibility, logged
selection and text-entry measures, fatigue ratings, SUS, QUEST 2.0, CPIB, interviews. PIADS, ALSAQ-5 and GAS are
optional. `[[TEAM: decide with the SLP advisor; check licence terms before using QUEST 2.0, PIADS, ZBI, ALSFRS-R.]]`

## 8. Data

**What's collected:**

- Numbers logged by AGENCY: timings, counts, calibration grades, error rates. **Not** the content of what
  participants say, except during copy-typing of standard phrases.
- Questionnaire answers, session notes, interview notes.
- Interview audio **only** with separate consent, transcribed and then deleted `[[TEAM: decide]]`. No video except
  the optional consent recording.
- No camera video, face images or eye images: AGENCY doesn't store them, and the study adds nothing that would.

**Software prerequisites:** study logging must be opt-in, numbers only and exportable (roadmap item E4). The cloud AI
features send text and screen pictures to Google through AGENCY Cloud (see the privacy policy draft). For the study:
use the paid AI tier, a dedicated study Mac with nothing personal on it, practice services only; and either disclose
the AI data flow in the consent form or run AI features in an "AI off" mode for participants who prefer. The consent
form must name Google as a recipient if AI features are used.

**Storage:** identifiers (consent forms, contact details) kept apart from study data, which carries only a study ID.
`[[TEAM: UCSC-approved encrypted storage; ask ORCA and UCSC IT which service.]]` Access limited to named study staff.
Retention `[[TEAM: per UC records schedule and any funder rules]]`. Breaches and incidents reported to the IRB within
one week (UCSC SOP).

**Sharing:** de-identified, aggregate results published openly. Any participant-level dataset only with explicit
consent for sharing.

## 9. Risks and how we reduce them

| Risk | How likely, how serious | Mitigation |
|---|---|---|
| **Eye fatigue and discomfort** | Likely; usually mild | Short sessions, breaks on request, fatigue ratings, stopping rule; dwell time adjustable |
| **Frustration or distress** (tracking fails; questions touch on the illness) | Possible | Clinician present; written distress protocol (Draucker et al., 2009); stop and resume another day; questionnaires chosen to avoid end-of-life topics unless needed |
| **Breathing or other medical needs during a session** | Possible in ALS | Usual caregiver present; sessions planned around ventilation and suction; existing alarms untouched; stop at once for any concern |
| **Photosensitive seizure** | Very unlikely | Exclude photosensitive epilepsy; check AGENCY's interface has no flashing above 3 per second (WCAG 2.3.1; Fisher et al., 2005) |
| **False reassurance from the help signal** | Possible if misunderstood | Drills only with simulated phones; told clearly, in consent and every session, that it isn't an alarm and doesn't contact anyone during the study |
| **AI suggestions misrepresent the person** | Likely sometimes | The person chooses every word that's spoken; measure accept, edit and reject rates |
| **The agent does something unintended** | Unlikely; consequence limited | Practice services only; approvals and Stop; every unintended action recorded and reviewed |
| **Privacy** (intimate content; AI provider) | Possible | Numbers-only logging; dedicated study Mac; paid AI tier; consent names the AI provider; AI-off option |
| **Raised expectations; losing a tool that helped** | Possible | Explain AGENCY is unproven; participants may keep using it free after the study, with the same safety advice |
| **Burden on caregivers** | Likely mild | Optional participation; paid; flexible scheduling |
| **Coercion** (referred by own clinician) | Low | Clinicians pass on information only; the person contacts us; declining has no effect on care |

## 10. Stopping rules

The literature doesn't offer a standard set for eye-gaze AAC studies; these are proposed, to refine with advisors
and the IRB.

**Stop a session** on: the participant's stop signal or a caregiver's request; fatigue or eye discomfort of 7 or
more out of 10, or 3 or more above that day's starting rating; any breathing concern, need for suction or ventilator
alarm; signs of distress; any seizure-like event.

**Withdraw a participant** (with thanks, keeping data they agreed to) on: losing a reliable yes/no signal; hospital
admission; two sessions in a row stopped for fatigue; or any sign they no longer wish to continue.

**Pause the whole study and report to the IRB** on: any serious adverse event possibly related to the study; any
consequential action by the agent that the participant didn't approve; any case where someone relied on the help
signal as a real alarm; any data breach.

## 10a. Regulatory questions

- **Is this FDA-regulated?** Depends on intended use and claims (see "Three things to settle first"). A careful
  intended-use statement, for example "general-purpose computer access and communication software, not intended to
  diagnose, treat, monitor or alert for any medical condition", helps; the IRB decides.
- **If it is a device study:** the sponsor makes a first call on significant risk; the IRB reviews it; FDA is "the
  final arbiter" ([FDA information sheet](https://www.fda.gov/files/about%20fda/published/Significant-Risk-and-Nonsignificant-Risk-Medical-Device-Studies---Information-Sheet.pdf)).
  A significant-risk device includes one "represented to be for a use in supporting or sustaining human life" or
  that "otherwise presents a potential for serious risk" ([21 CFR 812.3(m)](https://www.law.cornell.edu/cfr/text/21/812.3)).
  The keyboard, phrases and replies are low risk. **Lifeline is the risk point:** used only as a drill with
  simulated contacts, never presented as an alarm, with existing alarms kept, it supports a nonsignificant-risk
  argument. Nonsignificant-risk studies follow the abbreviated rules in
  [21 CFR 812.2(b)](https://www.law.cornell.edu/cfr/text/21/812.2) (labelling, IRB approval, consent, monitoring,
  records, no promotion) and need no IDE submission.
- **HIPAA:** UCSC itself isn't a covered entity for this work; a clinic partner is, so any data from clinic records
  needs that site's authorisation or waiver.

## 11. Analysis

- Feasibility proportions with Wilson 95% confidence intervals, compared with the progression criteria.
- Selection, text-entry and task measures summarised per participant and overall (medians and ranges); within-person
  comparison of text entry with and without AI completion, descriptive only.
- Questionnaires scored as published, with adaptations reported.
- Interviews analysed thematically by two team members, with an advisor with lived experience reviewing the themes.
- Every adverse event, near miss and unintended action listed in full.
- Results published openly, including what didn't work.

## 11a. Team, training and timeline

| Role | Who |
|---|---|
| PI (certifies the submission) | `[[TEAM: UCSC faculty sponsor]]` |
| Co-PI(s) | `[[TEAM: student(s)]]` |
| Clinical co-investigator (SLP specialising in AAC) | `[[TEAM]]` |
| OT or AT specialist | `[[TEAM]]` |
| Advisors with lived experience (paid) | `[[TEAM]]` |
| Impartial witness pool | `[[TEAM: e.g. staff from another department]]` |

- **Training:** everyone "engaged" in the research, including the faculty advisor, completes CITI before any
  determination: Group 2 Biomedical (course 96466) is probably the better fit than Group 1 Social/Behavioral
  (96465); 80% pass; renew every 5 years ([UCSC training](https://officeofresearch.ucsc.edu/compliance/irb/training/)).
- **Submission:** in Cayuse Human Ethics; each team member requests a Cayuse account
  ([UCSC Cayuse](https://officeofresearch.ucsc.edu/compliance/irb/cayuse-human-ethics/)). ORCA "typically" sends
  feedback within ten business days after the PI certifies; submissions with no response for 90 days are withdrawn
  ([review and approval](https://officeofresearch.ucsc.edu/compliance/irb/review-approval/)). Student studies must
  close or transfer before the student graduates (UCSC SOP).

| When | What |
|---|---|
| October 2026 | Email ORCA; find a faculty PI; everyone starts CITI |
| November 2026 | Advisory group formed; outcome measures chosen with the SLP; licences checked |
| December 2026 | Protocol, consent materials (standard and easy-read), data plan drafted with advisors |
| January 2027 | Submit (UCSC IRB, or WCG/clinic IRB if FDA-regulated) |
| Spring 2027 | Software must-haves done; bench testing; first participant after approval |
| Summer to autumn 2027 | Sessions; analysis; publish |

`[[TEAM: adjust to the IRB route and funding. The ALS Association grant, if awarded, starts no earlier than June
2027.]]`

## 12. Software must-haves before the first participant

From `docs/ROADMAP.md` and the [privacy policy draft](privacy-and-terms/privacy-policy.md), Part 2:

- A study configuration: practice services only, simulated Lifeline contacts, no real messages, orders or dispatch,
  and a visible "study mode" banner.
- A user-facing AI-off switch; paid AI tier.
- Opt-in, numbers-only study logging with export (roadmap E4).
- Fatigue-friendly settings: adjustable dwell, rest mode (roadmap B4).
- Calibration working inside the Mac app (roadmap B5), or the study uses the web version.
- A signed, notarized build (roadmap A5).
- A check that nothing in the interface flashes more than 3 times a second.
- Gaze lab baseline on non-disabled volunteers, published (roadmap B1).

---

## References

All checked 12 October 2026 (DOIs and PubMed IDs confirmed against PubMed or Crossref).

**Pilot and feasibility methods**
- Eldridge SM et al. (2016). CONSORT 2010 statement: extension to randomised pilot and feasibility trials. *BMJ* 355:i5239. https://pmc.ncbi.nlm.nih.gov/articles/PMC5076380/
- Avery KNL et al. (2017). Informing efficient randomised controlled trials: exploration of challenges in developing progression criteria. https://pmc.ncbi.nlm.nih.gov/articles/PMC5318608/
- Julious SA (2005). Sample size of 12 per group rule of thumb for a pilot study. *Pharm Stat*. https://doi.org/10.1002/pst.185
- Billingham SAM et al. (2013). An audit of sample sizes for pilot and feasibility trials. https://pmc.ncbi.nlm.nih.gov/articles/PMC3765378/

**Eye-gaze AAC in ALS**
- Cai S et al. (2024). Using large language models to accelerate communication for eye gaze typing users with ALS. *Nat Commun* 15:9449. https://doi.org/10.1038/s41467-024-53873-3
- Caligari M et al. (2013). Eye tracking communication devices in amyotrophic lateral sclerosis: impact on disability and quality of life. *ALS FTD* 14:546-552. https://doi.org/10.3109/21678421.2013.803576
- Linse K et al. (2017). Eye-tracking-based assessment suggests preserved well-being in locked-in patients. *Ann Neurol* 81:310. https://doi.org/10.1002/ana.24871
- Linse K et al. (2018). Usability of eyetracking computer systems and impact on psychological wellbeing in patients with advanced ALS. *ALS FTD* 19:212. https://doi.org/10.1080/21678421.2017.1392576
- Spataro R et al. (2014). The eye-tracking computer device for communication in amyotrophic lateral sclerosis. *Acta Neurol Scand* 130:40. https://doi.org/10.1111/ane.12214
- Kübler A et al. (2014). The user-centered design as novel perspective for evaluating the usability of BCI-controlled applications. *PLoS One*. https://doi.org/10.1371/journal.pone.0112392

**Measures**
- Soukoreff RW, MacKenzie IS (2003). Metrics for text entry research. CHI. https://doi.org/10.1145/642611.642632
- MacKenzie IS, Soukoreff RW (2003). Phrase sets for evaluating text entry techniques. https://doi.org/10.1145/765891.765971
- Brooke J (1996). SUS: a "quick and dirty" usability scale. https://doi.org/10.1201/9781498710411-35
- Bangor A, Kortum PT, Miller JT (2008). An empirical evaluation of the System Usability Scale. https://doi.org/10.1080/10447310802205776
- Hart SG, Staveland LE (1988). Development of NASA-TLX. https://doi.org/10.1016/s0166-4115(08)62386-9 ; Hart SG (2006). NASA-TLX: 20 years later. https://doi.org/10.1177/154193120605000909 ; NASA TLX page: https://humansystems.arc.nasa.gov/groups/TLX/
- Demers L et al. (2000). Item analysis of the Quebec User Evaluation of Satisfaction with Assistive Technology (QUEST). *Assist Technol*. https://doi.org/10.1080/10400435.2000.10132015 ; Demers L et al. (2002). QUEST 2.0. *Technol Disabil* 14:101-105. https://doi.org/10.3233/TAD-2002-14304 ; Rasch analysis: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9859407/
- Jutai J, Day H (2002). PIADS. *Technol Disabil*. https://doi.org/10.3233/tad-2002-14305
- Baylor C et al. (2013). The Communicative Participation Item Bank (CPIB). *JSLHR* 56:1190. https://doi.org/10.1044/1092-4388(2012/12-0140) ; short form and permission: https://sites.uw.edu/speaclab/cpib/cpib-general-short-form-paper-version-and-scoring-table
- Peters B, Wiedrick J, Baylor C (2023). Communicative participation in ALS with AAC. *AJSLP*. https://pmc.ncbi.nlm.nih.gov/articles/PMC10473367/
- Jenkinson C, Fitzpatrick R (2001). ALSAQ-5. https://doi.org/10.1136/jnnp.70.1.70 ; licensing: https://innovation.ox.ac.uk/outcome-measures/amyotrophic-lateral-sclerosis-assessment-questionnaire-alsaq/
- Cedarbaum JM et al. (1999). ALSFRS-R. https://doi.org/10.1016/s0022-510x(99)00210-5 ; Montes J et al. (2006). https://doi.org/10.1212/01.wnl.0000238505.22066.fc
- Gibbons CJ et al. (2011). NFI-MND. https://doi.org/10.1186/1477-7525-9-101
- Kiresuk TJ, Sherman RE (1968). Goal attainment scaling. https://doi.org/10.1007/BF01530764 ; Turner-Stokes L (2009). https://doi.org/10.1177/0269215508101742
- Abrahams S et al. (2014). ECAS. https://doi.org/10.3109/21678421.2013.805784
- Zarit SH et al. (1980). https://doi.org/10.1093/geront/20.6.649 ; Bédard M et al. (2001). https://doi.org/10.1093/geront/41.5.652 ; licensing: Mapi Research Trust

**Consent and ethics**
- FDA (2023). Informed Consent: Guidance for IRBs, Clinical Investigators, and Sponsors. https://www.fda.gov/media/88915/download
- 45 CFR 46.102, 46.116, 46.117: https://www.law.cornell.edu/cfr/text/45/46.117
- California Civil Code §14: https://california.public.law/codes/civil_code_section_14 ; Health and Safety Code §24178: https://california.public.law/codes/health_and_safety_code_section_24178 ; §24174: https://california.public.law/codes/health_and_safety_code_section_24174
- UC Office of the President, Guidance Memo 21-01 (surrogate consent): https://researchmemosapi.ucop.edu/index.php/site/document?memo=UlBBQy0yMS0wMQ==&doc=3789
- UCSF IRB, enrolling subjects who cannot talk or write: https://irb.ucsf.edu/enrolling-subjects-who-are-legally-blind-illiterate-or-cannot-talk-or-write
- Haselager P et al. (2009). A note on ethical aspects of BCI. *Neural Netw* 22:1352. https://doi.org/10.1016/j.neunet.2009.06.046
- Cairncross M, Peterson A et al. (2016). Assessing decision-making capacity in patients with communication impairments. *Camb Q Healthc Ethics* 25:691. https://doi.org/10.1017/S0963180116000414
- Klein E, Peters B, Higger M (2018). Ethical considerations in ending exploratory brain-computer interface research studies in locked-in syndrome. *Camb Q Healthc Ethics* 27:660. https://pmc.ncbi.nlm.nih.gov/articles/PMC8219386/
- Taylor S, Balandin S (2020). https://doi.org/10.16993/sjdr.637 ; Walsh et al. (2024). https://doi.org/10.1177/16094069241234190
- Flory J, Emanuel E (2004). Interventions to improve research participants' understanding in informed consent. *JAMA*. https://doi.org/10.1001/jama.292.13.1593 ; Fink AS et al. (2010). https://doi.org/10.1097/SLA.0b013e3181e3ec61
- Draucker CB, Martsolf DS, Poole C (2009). Developing distress protocols for research on sensitive topics. *Arch Psychiatr Nurs*. https://doi.org/10.1016/j.apnu.2008.10.008

**Safety and regulation**
- Fisher RS et al. (2005). Photic- and pattern-induced seizures. *Epilepsia*. https://doi.org/10.1111/j.1528-1167.2005.31405.x ; WCAG 2.2 SC 2.3.1: https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html
- 21 CFR 812.2 and 812.3: https://www.law.cornell.edu/cfr/text/21/812.3 ; FDA SR/NSR information sheet: https://www.fda.gov/files/about%20fda/published/Significant-Risk-and-Nonsignificant-Risk-Medical-Device-Studies---Information-Sheet.pdf
- UCSC IRB: https://officeofresearch.ucsc.edu/compliance/irb/ ; SOP (Google Doc linked from the policies page)

`[[TEAM: before submitting, open each reference and check titles and author lists; several titles above are
paraphrased short titles.]]`
