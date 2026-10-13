# Nonprofit launch kit

*Drafted 12 October 2026 for Neil, Ray and Ryan. Everything here is a draft to edit. Every place a person must
decide or fill something in is marked `[[TEAM: ...]]`; search for `[[TEAM` before sending anything. Not legal,
regulatory or tax advice. Background research is in [`docs/NONPROFIT_PLAN.md`](../NONPROFIT_PLAN.md) and
[`docs/ROADMAP.md`](../ROADMAP.md).*

## What's here

| Document | What it's for |
|---|---|
| [als-association-loi.md](als-association-loi.md) | ALS Association Assistive Technology Grants LOI, in the FY27 RFA's exact structure, with the rules, decisions and a budget outline |
| [grant-pipeline.md](grant-pipeline.md) | 16 funders checked on 12 October 2026, by urgency, with eligibility routes and a 90-day calendar |
| [outreach/emails.md](outreach/emails.md) | Emails to ALS clinic SLPs, ALS Network's AAC equipment loan program, Ability Tools, and open-source AAC projects |
| [outreach/one-page-summary.md](outreach/one-page-summary.md) | One page to attach to emails (export to PDF) |
| [outreach/video-script-60s.md](outreach/video-script-60s.md) | A 60-second video script that shows only what works |
| [outreach/family-faq.md](outreach/family-faq.md) | Honest answers: is it safe, what does it cost, what happens to my data |
| [pilot-study-plan.md](pilot-study-plan.md) | Feasibility study plan for UCSC's IRB: questions, measures, consent by eye gaze, data, risks, stopping rules |
| [licence-decision-memo.md](licence-decision-memo.md) | Code licence options given RealEye's AGPL model; recommendation: AGPL-3.0-or-later |
| [privacy-and-terms/privacy-policy.md](privacy-and-terms/privacy-policy.md) | Privacy policy matched to what the code does today, plus 18 gaps between the code and the promises |
| [privacy-and-terms/terms-of-use.md](privacy-and-terms/terms-of-use.md) | Terms of use, including the AI relay and what AGENCY is not |

## What we learned that changes plans

1. **The ALS Association pays organisations, not people, and the applicant organisation must control the IP**
   (FY27 RFA §2.3.2, §2.6.1). AGENCY has no organisation and nobody has assigned the code to one. This is the
   decision everything else waits on.
2. **UCSC doesn't let undergraduates be PI**, on IRB protocols or on grant proposals. A faculty sponsor unlocks the
   IRB and five funders in the pipeline.
3. **UCSC's IRB doesn't review FDA-regulated research** (it sends it to the commercial IRB WCG). Whether a study of
   AGENCY counts depends on how AGENCY is described. Ask ORCA early.
4. **UCSC doesn't allow the "short form" consent route,** so consent by eye gaze needs a full form with an
   alternative way of signing, or a waiver.
5. **The live privacy page overstates some things.** Notably: the agent sends pictures of the *whole* screen, not
   just the app; Talk's AI sentence finishing is on by default and sends recent phrases without a consent step;
   Synapse-Mesh isn't used unless someone runs it; there's no user-facing "AI off" switch; and Settings' "Erase
   everything" button always fails. Details and file references in
   [the privacy draft, Part 2](privacy-and-terms/privacy-policy.md#part-2-for-the-team-gaps-to-close-before-publishing).
6. **"Open-source" isn't true yet.** The code is public but has no licence. Don't use the word in grants or
   outreach until a LICENSE file exists.

## Most urgent next actions

| By | Action | Why | Doc |
|---|---|---|---|
| **Wed 14 Oct** | Email ResearchGrants@als.org: who can be the applicant, and how free open-source distribution fits "commercialization" | The answer decides whether the LOI is possible | [LOI, "Email to send this week"](als-association-loi.md#email-to-send-this-week) |
| **Wed 14 Oct** | Email orca@ucsc.edu (or book an analyst slot): PI, which IRB, FDA question | Every study and five grants need this | [Pilot plan, "Three things to settle first"](pilot-study-plan.md#three-things-to-settle-first) |
| **Fri 16 Oct** | Ask a UCSC faculty member to be faculty sponsor and PI | Needed for the IRB, CITRIS (15 Nov), NIDILRR (about 14 Dec), PVA, VentureWell | [Grant pipeline](grant-pipeline.md) |
| **Fri 16 Oct** | Open a ProposalCentral account; copy the LOI's per-section character limits into the draft | They aren't public | [LOI](als-association-loi.md) |
| **Fri 16 Oct** | Send the RealEye licence email | Needed before saying "we control the IP" or choosing a licence | [Licence memo](licence-decision-memo.md#email-to-realeye-ready-to-edit) |
| **Mon 19 Oct** | CITRIS Tech for Social Good info session (check the call page) | Fast first grant, due 15 Nov | [Grant pipeline](grant-pipeline.md) |
| **Fri 23 Oct** | Talk to a nonprofit/IP lawyer (law school clinic or bar referral): applicant entity, IP assignment, UC claims, licence | Before the LOI states any of it | [Licence memo, "Questions for your lawyer"](licence-decision-memo.md#questions-for-your-lawyer) |
| **Mon 26 Oct** | **Decide:** apply to the ALS Association or not; applicant organisation; PI; licence | LOI needs a week of writing after this | [LOI, "Decisions"](als-association-loi.md#decisions-the-team-must-make-before-writing-the-final-text) |
| **Mon 26 Oct** | If the applicant is your own nonprofit: file Articles of Incorporation; founders sign IP assignments | The applicant must control the IP | `docs/NONPROFIT_PLAN.md` §2 |
| **Fri 30 Oct** | Submit the LOI (the real deadline is **Tue 3 Nov, 1 p.m. Eastern = 10 a.m. Pacific**) | Leave a margin for ProposalCentral problems | [LOI](als-association-loi.md) |
| **Mon 2 Nov, 12 p.m. ET** | MIT Solve, only if you decide it's worth it | Optional | [Grant pipeline](grant-pipeline.md) |
| **Before any outreach** | Choose a public contact email; fill `[[TEAM]]` markers in the one-pager and emails; send SLP and ALS Network emails | Advisors before users | [Emails](outreach/emails.md) |
| **Before publishing the privacy policy** | Fix or accept the 18 gaps (at minimum: correct `site/src/pages/privacy.astro`, fix "Erase everything", add an AI-off switch, rethink default-on AI finishing and whole-screen screenshots) | The live page doesn't match the code | [Privacy draft, Part 2](privacy-and-terms/privacy-policy.md#part-2-for-the-team-gaps-to-close-before-publishing) |
| **Sun 15 Nov** | CITRIS Tech for Social Good application | $500 to $5,000, quick | [Grant pipeline](grant-pipeline.md) |
| **Early Dec** | Protocol and consent materials drafted with an SLP and the faculty PI | IRB submission in January | [Pilot plan](pilot-study-plan.md) |

## Things that weren't verified

- ProposalCentral's per-section character limits for the LOI (behind a login).
- Whether any Ability Tools lending centre lends eye-gaze devices.
- Sutter Health (Forbes Norris) IRB and reliance process.
- Licence terms for QUEST 2.0, PIADS, ALSFRS-R and the Zarit Burden Interview.
- Several grant details marked "partial" in the pipeline (2027 dates, sponsor eligibility).
- The privacy draft describes the code on `main` at `df6c814`; it wasn't checked by running the app.
