# Report: `agent/nonprofit` (task 6, nonprofit launch kit)

*12 October 2026. The file name flattens the branch name's slash.*

## What I built

Ten ready-to-edit Markdown documents in `docs/launch/`. No code, site pages or shared files were changed, and no
LICENSE file was added.

| File | Contents |
|---|---|
| `README.md` | Index, the six findings that change plans, and a dated table of the most urgent next actions |
| `als-association-loi.md` | LOI following the FY27 RFA's exact LOI structure (§2.4.1.1: administrative information; Scientific Abstract, Scientific Rationale and Potential Impact, Technology Summary, Specific Aims, Commercialization Plan in 2.5 pages; PI biosketch). Includes the eligibility, IP, revenue-sharing and budget rules with RFA section numbers, the team's decisions, an email to the Association, and a budget outline within the RFA's caps |
| `grant-pipeline.md` | 16 funders checked on their own pages, with amount, next deadline, eligibility route (UCSC, fiscal sponsor, own nonprofit, own 501(c)(3)), fit and verification status; others checked and set aside, with reasons; a 90-day calendar |
| `outreach/emails.md` | Emails to ALS clinic SLPs, ALS Network's AAC equipment loan program, Ability Tools, and Cboard/AsTeRICS Grid/OptiKey, plus a follow-up; verified contact details |
| `outreach/one-page-summary.md` | PDF-ready one-pager |
| `outreach/video-script-60s.md` | 60-second script, shot by shot, showing only what works and labelling what's simulated |
| `outreach/family-faq.md` | Is it safe, what does it cost, what happens to my data, and more |
| `pilot-study-plan.md` | Feasibility study for UCSC's IRB: research questions, progression criteria, eligibility, sample size reasoning, procedures, consent for people who can't speak or write (UCSC's rules, FDA guidance, impartial witness, Civil Code §14, capacity, H&S §24178 surrogates), cited outcome measures with eye-gaze notes and licences, data handling, risks, stopping rules, regulatory questions, timeline |
| `licence-decision-memo.md` | Options A to D given the RealEye AGPL/commercial dual licence (its commercial terms quoted), recommendation (AGPL-3.0-or-later, CC BY 4.0 docs, DCO), lawyer questions, an email to RealEye |
| `privacy-and-terms/privacy-policy.md` | Part 1: privacy policy describing what the code on `main` does. Part 2: 20 gaps between the code and the promises, with file references |
| `privacy-and-terms/terms-of-use.md` | Terms of use, including AGENCY Cloud, what AGENCY is not, and what the agent does before approval |

Every decision or blank is marked `[[TEAM: ...]]`.

## How to try it

Read `docs/launch/README.md`, then follow the "Most urgent next actions" table. The first two emails (to the ALS
Association and UCSC ORCA) are ready to send once a name and contact are filled in.

## How it was checked (real results)

- **Sources.** Web research on 12 October 2026: the ALS Association FY27 RFA PDF (revised 21 September 2026) and
  Grants Policy Statement were read in full in a browser (als.org blocks automated fetches); each grant was checked
  on the funder's own page; reference DOIs were checked against Crossref and PubMed (16 titles re-checked by me
  against Crossref; two titles corrected). UCSC's IRB SOP wording on FDA-regulated research, the short form and wet
  signatures was checked directly in the SOP text. RealEye's commercial licence (v1.0, 9 June 2026) was read
  directly. Licences of Cboard, AsTeRICS Grid, OptiKey and Project Gameface were read from GitHub's API.
- **Code facts.** The privacy and terms drafts come from a read-only audit of `main` at `df6c814`, with file and line
  references. I re-read the source for the most important claims (full-display screen capture, default-on Talk AI
  finishing, seeded Lifeline consent, the failing "Erase everything" call, memory suggestions to the agent, agent
  defaults, demo IP rate limiting) and they hold.
- **Numbers.** The Wilson confidence intervals in the pilot plan were recomputed and match.
- **Repository checks.** I changed only Markdown under `docs/`, which no lint, format or test target covers
  (`frontend/tests/fileNames.test.ts` only scans `frontend/`). I checked that no two tracked paths in the repository
  differ only in case (none do), that every relative link and anchor in `docs/launch` resolves (one fixed), and that
  the new files contain no em dashes. I did not run `make check`, `make build` or the site checks, because no code,
  site or test file changed; the worktree has no `node_modules`.

## What I couldn't verify

- ProposalCentral's per-section character limits (behind a login), and any font or format rules for the LOI.
- Whether a free, open-source model satisfies the ALS Association's "commercially available" expectation: the RFA is
  silent; the LOI file has the email to ask.
- Whether any Ability Tools lending centre lends eye-gaze devices; the Central Coast centre's contact details.
- Sutter Health's (Forbes Norris) IRB and reliance process.
- Licence terms for QUEST 2.0, PIADS, ALSFRS-R, Zarit Burden Interview, MQOL.
- 2027 dates for several funders (marked "partial").
- The privacy draft describes the code by reading it; I didn't run the app to watch its network traffic.
- Nothing here is legal advice; the drafts say where a lawyer is needed.

## Things the team should know (found while reading the code; not fixed, outside this task's area)

- `site/src/pages/privacy.astro` overstates several things (whole-screen screenshots described as "the app it's
  working in"; Synapse-Mesh routing described as always on; memory described as never leaving the Mac; the web demo
  sending more than task text).
- Settings' "Erase everything" always failed (no `{"confirm": true}` body); fixed on `main` in `4cad676`, but it
  still only erases Memory.
- The demo seed pre-sets Lifeline and dispatch consent (`backend/agency/services/seed.py:74-76`, `108-113`), and
  that consent carries over when real contacts are added (`backend/agency/lifeline/service.py:117-124`).
- Talk AI finishing is on by default without a consent step (`frontend/src/talk/Board.tsx:52-58`); Talk replies'
  consent preview doesn't show everything sent (`frontend/src/talk/Listen.tsx:81-97`).
- There's no user-facing AI-off switch, and no age check despite Gemini's 18+ rule.
- `site/src/data/site.ts` said a Gemini key is needed; fixed on `main` in `4cad676`.
- `THIRD_PARTY.md` describes RealEye's no-fee licence more broadly than its text.

Full list with references: `docs/launch/privacy-and-terms/privacy-policy.md`, Part 2.

## Next steps

1. Send the ALS Association and ORCA emails this week; find a faculty sponsor.
2. Decide the applicant organisation, PI and licence by 26 October; LOI in by 30 October (deadline 3 November,
   1 p.m. Eastern).
3. Fix the privacy gaps (at least correct the live privacy page and the erase button) before any outreach that
   points people to the app.
4. Work with an SLP advisor on the pilot plan's measures and consent materials; submit in January.

## Update, 13 October 2026

The branch had already been merged into `main`. Merging the latest `origin/main` (to `412b760`) was a fast-forward.
The privacy draft now covers the caregiver phones and My day features that landed with it (from their reports and
spot checks of their code, not a full audit), and records the fixes in `4cad676`. Check results after the merge are
below.
