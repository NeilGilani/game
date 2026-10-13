# Licence decision memo

*Drafted 12 October 2026 for Neil, Ray and Ryan. This is a decision aid, not legal advice. Have a lawyer who works
with open source read it before you choose. Nothing here adds a LICENSE file: the team decides.*

## The decision

AGENCY's own code has no licence today. The repository is public on GitHub, but without a licence nobody may legally
reuse, change or redistribute it, and contributors have no clear terms. The site's credits page says so. A grant
funder that asks you to show you "control the IP" will also want to see what licence you give others.

**Recommendation:** license AGENCY's code under **AGPL-3.0-or-later**, documentation under **CC BY 4.0**, and require
a **Developer Certificate of Origin** sign-off on every commit. Write to RealEye now to ask how its terms apply to a
charity. Revisit only if a partner you really need can't accept the AGPL and the gaze numbers show the RealEye model
can be dropped.

`[[TEAM: decide by 26 October 2026, so the ALS Association LOI (due 3 November) can state the licence.]]`

## The facts that constrain the choice

1. **The RealEye eye-image model is AGPL or commercial.** `@realeye-io/webcam-eyetracker-light-open` 1.1.0 is called
   unchanged from `os/gaze/src/eyeImage.ts` and bundled into the interface (`THIRD_PARTY.md`). Its README offers the
   code under "either" the GNU AGPL v3 or later, or RealEye's commercial licence
   ([repository](https://github.com/RealEye-io/webcam-eyetracker-light-open)).
2. **RealEye's no-fee commercial licence probably doesn't cover a charity that gives software to users.** Its
   commercial licence (version 1.0, dated 9 June 2026) grants no-fee use to two groups only
   ([LICENSE-COMMERCIAL.md](https://raw.githubusercontent.com/RealEye-io/webcam-eyetracker-light-open/main/LICENSE-COMMERCIAL.md)):
   - a **"Qualified Small Company"**: a *for-profit* group under USD 1,000,000 by valuation, acquisition price or
     trailing revenue;
   - a **"Qualified Academic Grant User"**: an accredited university, public research institution, nonprofit
     research organisation, or a lab or project under one of them, using it for "teaching, academic research,
     internal evaluation, or grant-funded research", with project funding under USD 1,000,000.

   A nonprofit public-benefit corporation that distributes AGENCY to families is not clearly either. A study run
   under UCSC may fit the second group; everyday distribution probably doesn't. The licence gives no email address;
   it says to use "the contact details published by RealEye or in the repository" for written eligibility
   confirmation. It also says that if you later cross a threshold you must contact RealEye within 30 days.
   `THIRD_PARTY.md` currently summarises this as "no fee for companies and academic projects under USD 1M", which
   is broader than the text. `[[TEAM: fix THIRD_PARTY.md wording; that file is outside this task's area.]]`
3. **What the AGPL asks of you.** It's the GPL plus section 13: if you modify the program and people use it over a
   network, you must offer them the source of your version
   ([AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.en.html)). AGENCY's interface is served to a browser by the
   coordinator and by the web demo, so section 13 is relevant. For a project that already publishes everything, the
   practical cost is small: keep the source public, keep a "Source code" link in the app and on the site, keep
   notices intact.
4. **Everything else that ships is permissive** (Apache-2.0, MIT, BSD-2-Clause, OFL; see `THIRD_PARTY.md`). We
   checked the installed npm packages for copyleft licences on 12 October 2026: the only hits were build and test
   tools that aren't shipped in the app (`lightningcss` and `axe-core`, MPL-2.0; `@img/sharp-libvips`, LGPL-3.0).
   Python runtime dependencies (FastAPI, Uvicorn, Pydantic, google-genai, anthropic, cryptography, httpx) are
   permissive. `[[TEAM: confirm with a proper licence scan (for example an SBOM tool in CI) before the first signed
   release.]]`
5. **Synapse-Mesh** lives in Ray's separate repository. Its licence is unknown to us.
   `[[TEAM: Ray, what licence is Synapse-Mesh under, and will you license or assign it to the organisation?]]`
6. **The neighbours are copyleft too.** The open-source AAC projects you'd most like to work with use GPL-family
   licences: Cboard is GPL-3.0, AsTeRICS Grid is AGPL-3.0, OptiKey is GPL-3.0 (GitHub licence metadata, checked
   12 October 2026: [Cboard](https://github.com/cboard-org/cboard),
   [AsTeRICS Grid](https://github.com/asterics/AsTeRICS-Grid), [OptiKey](https://github.com/OptiKey/OptiKey)).
   Google's Project Gameface is Apache-2.0 ([repo](https://github.com/google/project-gameface)). Code can flow from
   these GPL projects into an AGPL AGENCY (GPLv3 section 13 and AGPL section 13 allow combining), but not into a
   permissively licensed one.

## What the organisation wants from a licence

| Goal | Why it matters |
|---|---|
| Free forever for the people who use it | The mission. Nobody should be able to take AGENCY, close it and sell it back to families |
| Partners and contributors can join on clear terms | Clinics, universities, other AAC projects, volunteers |
| The nonprofit can show it controls the IP | The ALS Association requires the applicant to control the IP; other funders ask too |
| Room to work with companies later | Hardware makers, AI providers, hospital IT |
| Compliance a small team can actually manage | Three students, part time |

## Options

| | A. AGPL-3.0-or-later for everything | B. GPL-3.0-or-later for AGENCY's code, AGPL module kept as is | C. Apache-2.0 (or MIT) for AGENCY's code, RealEye optional | D. Remove RealEye, then choose freely |
|---|---|---|---|---|
| **Matches RealEye's AGPL** | Yes | Yes (section 13 allows the combination) | Only if the module is separable; any build that includes it is AGPL as a whole | Not needed |
| **Stops closed forks** | Yes, including hosted versions | Yes for distributed copies; hosted versions of the interface still bound by AGPL while the module is in | No | Depends on the new choice |
| **Easy to explain** | Easiest: one licence | Two licences, one combined work | Two licences and two kinds of builds | Easy, after an engineering change |
| **Friendly to companies and hospitals** | Least: some organisations have no-AGPL policies | A little better for desktop use | Most | Most, if you then pick C |
| **Can take code from Cboard, OptiKey, AsTeRICS Grid** | Yes | Yes | No | Only with a copyleft choice |
| **Engineering work** | None | None | Keep `eyeImage.ts` behind a clear build switch; ship two builds or ask users to opt in | Remove `os/gaze/src/eyeImage.ts` (`THIRD_PARTY.md` says this turns the eye-image model off and leaves the landmark model as it was), then re-measure gaze |
| **Risk** | A partner says no | Confusion about which licence applies to what | You give up protection against closed forks of the mission; still need the AGPL build for best gaze | Gaze may get worse. Not measured: every gaze number is simulated today (`os/gaze/BENCHMARKS.md`) |

A fifth path, **buying or negotiating a commercial licence from RealEye**, could make C possible without losing the
model. Ask for it in the same email; don't plan on it.

## Recommendation, in detail

1. **Code: AGPL-3.0-or-later.** It is the only option that needs no engineering change, matches the dependency you
   already ship, lines up with the AAC projects you want to work with, and protects the "free for families" promise.
   The cost (some companies avoid AGPL) matters less to a charity than to a startup.
2. **Docs, guides and images you made: CC BY 4.0.** Clinicians and other projects can reuse your setup guides with
   credit. Keep photos of real people out of this; they need their own permissions.
3. **Contributions: DCO sign-off** (`git commit -s`). It's a one-line statement on each commit that the contributor
   has the right to submit it. Lighter than a contributor licence agreement.
   `[[TEAM: if you ever want to relicense (for example to Option C), you'd need every contributor's agreement or a
   CLA. Decide now whether you want that flexibility. A CLA is heavier for volunteers.]]`
4. **IP ownership: assign to the organisation.** Each founder signs an assignment (or, while you're fiscally
   sponsored, a licence that the sponsor's agreement respects) covering their past and future contributions. This is
   what lets an applicant say it "controls the IP" for the ALS Association.
   `[[TEAM: who is the IP holder today: the three of you jointly, a fiscal sponsor, or a new nonprofit? Ask the
   lawyer and the sponsor.]]`
5. **Name:** licences cover code, not names. Keep "AGENCY" and any logo out of the licence and add a short
   trademark note later if you register a mark (see `docs/NONPROFIT_PLAN.md`, section 4).

## Questions for your lawyer

- Does UCSC have any claim on the code (course work, university resources, supervision)? Check UC's patent and
  copyright policies and any hackathon terms you agreed to. `[[TEAM: find the hackathon's participant terms.]]`
- Much of the repository history is committed by an AI coding assistant (153 of 268 commits on `main` as of
  12 October 2026 list "Claude" as the author). How does the US Copyright Office's position on AI-generated material
  ([Part 2 report, January 2025](https://blogs.loc.gov/copyright/2025/02/inside-the-copyright-offices-report-copyright-and-artificial-intelligence-part-2-copyrightability/))
  affect what you can license and what "controlling the IP" means for a grant?
- Does the AGPL suit hospital deployments you might do later, and what would a hospital's legal team ask?
- If a fiscal sponsor holds the project, who holds the copyright assignments, and how do they move to your own
  nonprofit?

## Email to RealEye (ready to edit)

> **Subject:** Licence question: free, open-source eye-control software for people with ALS
>
> Hello,
>
> We are three students at UC Santa Cruz building AGENCY, a free, open-source program that lets people who can only
> move their eyes use a computer. It calls your eye-image feature extractor
> (`@realeye-io/webcam-eyetracker-light-open` 1.1.0) unchanged, with credit, alongside Google's MediaPipe.
>
> We are setting up a nonprofit to give AGENCY away free. We plan to license our code under the AGPL-3.0-or-later and
> publish all of it. Could you confirm:
>
> 1. that distributing AGENCY under the AGPL with your module, free of charge, is fine with you;
> 2. whether a charitable nonprofit that distributes software to users (not only for research) could ever qualify for
>    your no-fee commercial licence, and if not, what a commercial licence would cost; and
> 3. how you'd like to be credited.
>
> Source: https://github.com/NeilGilani/game
>
> Thank you,
> `[[TEAM: name, role, contact email]]`

`[[TEAM: RealEye's licence gives no email. Find the contact on realeye.io or open an issue on their repository; keep
the written answer with the IP records.]]`

## After you decide

- Add `LICENSE` (full AGPL text) at the root, a short licence section in `README.md`, SPDX headers if you like
  (`SPDX-License-Identifier: AGPL-3.0-or-later`), and a "Source code" link in the app's About screen.
- Update the site's credits page and `THIRD_PARTY.md` (both say no licence is granted yet).
- Add `CONTRIBUTING.md` with the DCO rule.
- Record the decision and RealEye's reply in the founders' IP file.
