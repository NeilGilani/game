# Turning AGENCY into a nonprofit

*Written 12 October 2026 for Neil, Rayansh and Ryan. This is research to help you ask good questions. It is
**not legal, tax or regulatory advice**. Before you sign, file or market anything, talk to a lawyer who works with
nonprofits, and to a medical-device regulatory specialist about the FDA questions. Fees, deadlines and rules change;
every number below has a link so you can check it.*

## Summary

1. **Start fast with a fiscal sponsor, and incorporate in parallel.** A fiscal sponsor can let you accept
   tax-deductible grants and donations within weeks, for a fee (typically 5 to 15% of what comes in). Your own
   California nonprofit corporation plus IRS Form 1023 costs a few hundred dollars in filing fees but takes months:
   the IRS currently decides 80% of full Form 1023 applications within 191 days.
2. **One deadline is close:** the ALS Association's Assistive Technology Grants take letters of intent until
   **3 November 2026** (up to $400,000 over two years; the applicant must control the intellectual property). Decide
   within the next two weeks whether to apply and who the applicant is.
3. **Choose a license now, and settle the RealEye question.** AGENCY has no license for its own code, and it bundles
   RealEye's eye-image model, which is AGPL-3.0 or a commercial license. The commercial license's no-fee categories
   are for-profit small companies and academic or nonprofit *research* projects; a charity serving users isn't
   clearly covered. The simplest path is to license AGENCY under the AGPL (or GPLv3) and comply with it, and to ask
   RealEye in writing.
4. **The FDA question is real.** FDA classifies "powered communication systems" and "powered environmental control
   systems" (whose examples include "to sound an alarm for assistance") as Class II devices that are exempt from
   510(k) but still regulated. Whether AGENCY is a device depends on what you claim it is *for*. Avoid medical claims
   until you have regulatory advice.
5. **AI provider terms matter.** Gemini's terms require users to be 18+, bar use "in clinical practice" or where
   device clearance is required, and let Google use free-tier content to improve its products.
6. **Put people with ALS, caregivers and clinicians in your governance from day one,** as paid advisors and,
   eventually, board members. Keep paid staff (including founders) to 49% or less of the board, as California law
   requires.

---

## Contents

1. [What you're building as an organisation](#1-what-youre-building-as-an-organisation)
2. [Legal structure: fiscal sponsorship vs your own 501(c)(3)](#2-legal-structure-fiscal-sponsorship-vs-your-own-501c3)
3. [Governance](#3-governance)
4. [Open-source licensing](#4-open-source-licensing)
5. [Privacy and medical-device regulation](#5-privacy-and-medical-device-regulation)
6. [Funding](#6-funding)
7. [Partnerships](#7-partnerships)
8. [30/60/90-day plan](#8-306090-day-plan)
9. [Risks](#9-risks)
10. [Sources](#10-sources)

---

## 1. What you're building as an organisation

A draft to argue about:

> **Mission.** Give people who can only move their eyes free, open tools to communicate, call for help and get
> things done, built with them and the people who care for them.

What follows from that:

- **Free and open source.** The software is free to everyone. Money comes from grants and donations, not from
  users.
- **Built with users.** People with ALS, locked-in syndrome, spinal cord injury and cerebral palsy, and their
  caregivers and clinicians, shape priorities and are paid for their time.
- **Honest claims.** Say what has and hasn't been tested. The repository already does this well; keep it up in
  fundraising too.
- **Not a medical service.** Until you have regulatory advice and evidence, AGENCY is not marketed as a medical
  device, medical alarm or emergency service.

---

## 2. Legal structure: fiscal sponsorship vs your own 501(c)(3)

### The options

| | **Fiscal sponsorship** | **Your own 501(c)(3)** (California nonprofit public benefit corporation + IRS recognition) |
|---|---|---|
| **What it is** | An existing 501(c)(3) takes you on as a project (Model A, "comprehensive") or makes grants to you (Model C, "pre-approved grant relationship"). Donors give to the sponsor | You incorporate, adopt bylaws, form a board, then apply to the IRS for recognition of exemption |
| **Time to accept deductible donations** | Weeks, once a sponsor accepts you | Months (see IRS times below), although exemption can be retroactive (see below) |
| **Cost** | A share of incoming money, typically 5 to 15%; Model A often 10 to 15% ([Northeastern Law guide](https://law.northeastern.edu/wp-content/uploads/2025/11/Nonprofit-QA-Resource-Fiscal-Sponsorships.pdf)) | Filing fees of a few hundred dollars (table below), plus your time, accounting and annual filings |
| **Control** | The sponsor has legal control of the money and, in Model A, of the project; you follow its policies | You and your board control everything, and carry all the duties |
| **Good for** | Starting now, testing whether funding comes, applying to grants that need a 501(c)(3) | Long-term independence, holding IP, contracts with hospitals, building a board |
| **Watch out for** | Fees; sponsor's rules on IP; exit terms if you later spin out; sponsor stability (Open Collective Foundation, a large sponsor, dissolved in 2024 and froze its projects: [OCF update](https://opencollective.com/foundation/updates/an-update-from-open-collective-foundations-board-of-directors)) | Admin load on three students; personal time; you must file every year or lose exemption |

**Recommendation:** do both. Find a fiscal sponsor now so you can take grants and donations this year, and
incorporate your own nonprofit at the same pace as your study and partnerships. Agree up front with the sponsor how
the project (money, IP, contracts) moves to your own 501(c)(3) when it's ready.

### Fiscal sponsors worth a look

Fees and rules below come from each sponsor's own pages or directory listings; confirm them before applying.

| Sponsor | Notes |
|---|---|
| **Code for Science & Society** | 501(c)(3) for public-interest technology and open source (fiscal host for OpenRefine, M-Lab). Fee 15% of cash received, per its FAQ ([CS&S](https://www.codeforsociety.org/fsp/faq)) |
| **Software Freedom Conservancy** | 501(c)(3) for free/open-source software; selective; requires an OSI-approved license ([apply](https://sfconservancy.org/members/apply/)) |
| **HCB (The Hack Foundation / Hack Club)** | 7% fee, but **only for groups led by teenagers aged 13 to 18** ([HCB eligibility](https://help.hcb.hackclub.com/en/articles/15409923-who-can-apply-for-fiscal-sponsorship), [fee](https://help.hcb.hackclub.com/en/articles/13356219-what-does-the-7-fee-cover-is-it-annual-monthly-etc)). Relevant only if your team qualifies |
| **Open Source Collective** | A 501(c)(6), not a charity: donations to its projects are **not** tax-deductible ([Open Collective docs](https://docs.opencollective.com/help/financial-contributors/financial-contributors)). Fine for small donations, not for most foundation grants |
| **Regional sponsors** | Use the [Fiscal Sponsor Directory](https://fiscalsponsordirectory.org/) to search by area and focus (disability, health, technology, California). Example of a tiered fee: Mission Edge lists 9% on the first $500,000 plus an onboarding/annual charge ([directory listing](https://fiscalsponsordirectory.org/mission-edge/)) |

Questions to ask any sponsor: Model A or C? Fee on all income or only donations? Who owns the code and the name?
Can you hold contracts with hospitals and pay study participants and advisors? How fast do they pay invoices? What
happens when you leave?

### Your own nonprofit: steps, costs and timing (California)

| Step | Cost | Timing and notes |
|---|---|---|
| 1. File **Articles of Incorporation** (nonprofit public benefit corporation) with the Secretary of State on bizfile | About **$30** per guides (e.g. [Nolo](https://www.nolo.com/technical-support-main/online-california-nonprofit-faq.html)); confirm on bizfile | Days to weeks. Use the 501(c)(3) purpose and dedication-of-assets language the IRS expects |
| 2. Adopt **bylaws** and a **conflict-of-interest policy**; hold the first board meeting; get an **EIN** | $0 | The IRS publishes a sample conflict-of-interest policy in the [Form 1023 instructions](https://www.irs.gov/instructions/i1023) |
| 3. File the **Statement of Information** | **$20** ([guide](https://www.swyftfilings.com/learning-center/california-nonprofit-guide)) | Within 90 days of incorporating |
| 4. Register with the **Attorney General's Registry of Charities** (Form CT-1) | **$50** ([CA DOJ guide](https://www.oag.ca.gov/system/files/media/initialReg.pdf)) | Within 30 days of first receiving assets; then annual RRF-1 reports |
| 5. Apply to the IRS: **Form 1023** or **Form 1023-EZ** | **$600** or **$275** ([IRS](https://www.irs.gov/charities-non-profits/form-1023-and-1023-ez-amount-of-user-fee)) | See the next table |
| 6. California tax exemption: **FTB 3500A** with your IRS letter | Fee unclear in what we found ($0 or $25); check [FTB](https://ftb.ca.gov/forms/misc/3500A-instructions.html) | After the IRS letter; exemption dates back to the federal exemption date |
| 7. Every year: IRS **Form 990-N** if gross receipts are normally $50,000 or less, otherwise 990-EZ or 990; CA filings | $0 to file 990-N | Missing three years in a row means automatic loss of exemption ([IRS 990-N](https://www.irs.gov/charities-non-profits/annual-electronic-filing-requirement-for-small-exempt-organizations-form-990-n-e-postcard)) |

**Form 1023 vs 1023-EZ**

| | Form 1023-EZ | Form 1023 |
|---|---|---|
| Fee | $275 | $600 |
| Who can use it | Organisations that project gross receipts of **$50,000 or less in each of the next 3 years** (and haven't exceeded it in the past 3) and have **$250,000 or less in assets**, among other tests in the eligibility worksheet ([IRS instructions](https://www.irs.gov/instructions/i1023ez); thresholds summarised by [Harbor Compliance](https://www.harborcompliance.com/blog/form-1023-ez-understanding-eligibility/)) | Anyone |
| IRS processing (page updated 28 June 2026) | "80% of Form 1023-EZ application determinations within 22 days" | "80% of Form 1023 application determinations within 191 days" ([IRS, Where's my application](https://www.irs.gov/charities-non-profits/charitable-organizations/wheres-my-application)) |
| Fit for AGENCY | Only if you honestly expect to stay under $50,000 a year. A single grant like the ALS Association's would put you over | **Most likely the right form** if you plan to apply for larger grants |

Exemption generally dates back to the day you incorporated if you file within 27 months of the end of the month
you were formed ([IRS note on the effective-date rule](https://www.irs.gov/forms-pubs/changes-to-jan-2020-revision-of-instructions-for-form-1023-schedule-e-line-2-and-line-2a);
check the current [Form 1023 instructions](https://www.irs.gov/instructions/i1023)), so donations made while you
wait can still count.

### Things to check about yourselves first

- **Ages.** If any founder is under 18, ask a lawyer about serving as a director or signing contracts. Gemini's API
  terms also require users to be 18 or older ([Gemini API terms](https://ai.google.dev/gemini-api/terms)).
- **Immigration status.** If any founder is an international student, check with the international student office
  before taking any paid or unpaid role in the organisation.
- **University rules.** Ask whether UCSC has any claim on work done with university resources, courses or
  supervision, and how IRB review applies to student projects (see [Partnerships](#7-partnerships)).
- **Founders' agreement.** Write down who does what, how decisions get made, and what happens if someone leaves.
  Each founder (and Ray, for Synapse-Mesh) should assign or license their code to the organisation, so it can show
  it controls the IP. Some grants require this (see the ALS Association grant below).

---

## 3. Governance

### Board of directors

- **Size:** start with 3 to 5 directors, growing to 7 or so. California law requires that **no more than 49% of
  directors be "interested persons"**: anyone paid by the corporation in the past 12 months (as staff or
  contractor), and their close relatives ([Cal. Corp. Code § 5227](https://california.public.law/codes/ca_corp_code_section_5227)).
  If the three founders will ever be paid, you need at least four independent directors to stay compliant on a
  seven-person board.
- **Who:** aim for, over time, a person with lived experience of ALS, locked-in syndrome or SCI (or a close
  caregiver); a clinician (SLP or OT who works in AAC, or a neurologist); someone with nonprofit finance experience;
  someone with privacy/security or regulatory experience.
- **Policies to adopt early:** conflict of interest; whistleblower; document retention; privacy; a safety-incident
  process (who reviews every Lifeline failure or unintended action, and how fast).

### Advisory council (start now; it's easier than a board)

| Seat | Why |
|---|---|
| 2+ people with ALS, locked-in syndrome or high SCI (paid) | They know what matters and what's insulting or exhausting |
| 1 to 2 family caregivers (paid) | They set up, maintain and live with the system |
| SLP specialising in AAC | AAC assessment, vocabulary, training, study design |
| OT | Positioning, mounting, fatigue, access methods |
| ALS clinic neurologist or nurse | Disease progression, clinic workflow, referrals |
| AT specialist / rehab engineer | Trackers, switches, mounting, nurse-call adapters |
| Research ethics or IRB-experienced academic | Study design, consent |
| Lawyer (nonprofit/IP) and a regulatory advisor | Licensing, FDA, privacy |

**Make meetings accessible:** send questions ahead, accept written or recorded answers, keep sessions short, allow
extra time for AAC users, and pay for preparation time too.

---

## 4. Open-source licensing

### Where things stand

- **AGENCY's own code has no license.** The site's credits page says: until a license is chosen, "the code can be
  read but no license to reuse it is granted". There is no `LICENSE` file. Nobody can legally reuse or contribute
  to it under clear terms yet.
- **RealEye's eye-image model** (`@realeye-io/webcam-eyetracker-light-open`, called from `os/gaze/src/eyeImage.ts`)
  is dual-licensed: **AGPL-3.0-or-later**, or RealEye's commercial license
  ([repository](https://github.com/RealEye-io/webcam-eyetracker-light-open)).
- Other components are permissive (MediaPipe under Apache-2.0, chess.js under BSD-2-Clause, fonts under OFL); see
  [THIRD_PARTY.md](../THIRD_PARTY.md). chess.js is missing from that file.
- **Synapse-Mesh** lives in a teammate's separate repository, which we couldn't reach publicly; its license is
  unknown.

### What the AGPL means for AGENCY

- The AGPL is the GPL plus one extra rule (section 13): if you **modify** the program and let people use it **over
  a network**, you must offer those users the complete source code of your version
  ([AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.en.html)). Section 13 also allows combining AGPL code with
  GPLv3 code.
- AGENCY's interface is bundled with RealEye's code and served from the coordinator (including the web demo), so
  anyone distributing or serving AGENCY with that module should treat the whole interface as AGPL-covered and offer
  its source. THIRD_PARTY.md already says this.
- In practice, for a free, open-source nonprofit this is easy to comply with: publish all your source, keep a
  "Source code" link in the app, and keep notices intact.
- **Who it affects:** companies that want to build closed products on AGENCY, and some hospitals or partners whose
  policies avoid AGPL software. Talk to partners early.

### The commercial-license route isn't clearly open to you

RealEye's commercial license offers **no-fee use** to (a) a **for-profit** company under USD 1,000,000 by
valuation/revenue, or (b) an accredited university, public research institution or **nonprofit research
organisation**, for teaching, academic research, internal evaluation or grant-funded research, with project
funding under USD 1,000,000 ([LICENSE-COMMERCIAL.md](https://raw.githubusercontent.com/RealEye-io/webcam-eyetracker-light-open/main/LICENSE-COMMERCIAL.md)).
A charitable nonprofit distributing AGENCY to users is not clearly either. THIRD_PARTY.md's summary ("no fee for
companies and academic projects under USD 1M") is broader than the text. **Email RealEye and get any permission in
writing.**

### Options

| Option | Pros | Cons |
|---|---|---|
| **A. License AGENCY under AGPL-3.0-or-later** | Matches RealEye; simplest to explain; stops closed forks of your work | Some companies and institutions avoid AGPL |
| **B. GPL-3.0-or-later for your code, distributed together with the AGPL module** | Slightly friendlier for desktop use; allowed by section 13 | Two licenses to explain; the combined interface is still AGPL-bound |
| **C. Apache-2.0 or MIT for your code, with the RealEye module optional** | Maximum reuse (companies, Apple/Google partners) | You must keep the AGPL module separable; anyone shipping it with RealEye still takes on AGPL |
| **D. Drop the RealEye module** (THIRD_PARTY.md says removing `eyeImage.ts` turns the eye-image model off) | Free choice of license | Possibly less accurate gaze; measure the difference first |

**Suggested default, to confirm with a lawyer:** Option A for the app now (AGPL-3.0-or-later), CC BY 4.0 for
documentation, and a **Developer Certificate of Origin** sign-off on every contribution so the project keeps a
clean record of who contributed what. Revisit Option C if a partner needs it and the gaze data shows the RealEye
model is replaceable.

### Two more IP questions for your lawyer

- **AI-written code.** Much of the history is committed by an AI coding assistant. The US Copyright Office says
  AI-generated material is protected only where a human determined sufficient expressive elements
  ([Copyright Office, Part 2, Jan 2025](https://blogs.loc.gov/copyright/2025/02/inside-the-copyright-offices-report-copyright-and-artificial-intelligence-part-2-copyrightability/)).
  Ask how this affects licensing and "controlling the IP" for grants.
- **Names.** Search the USPTO for "AGENCY" (generic, likely hard to protect) and consider a distinctive product
  name. "Lifeline" is already used by the FCC's phone subsidy program and the 988 Suicide & Crisis Lifeline
  ([FCC Lifeline](https://www.fcc.gov/lifeline-consumers), [988](https://www.fcc.gov/sites/default/files/988-fact-sheet.pdf)).

---

## 5. Privacy and medical-device regulation

**Get legal and regulatory advice on everything in this section.** What follows is our reading of public sources.

### Is AGENCY a medical device?

- **Intended use decides.** Whether a product is a medical device depends on its intended use, judged from labelling,
  marketing and other statements ([FDA: is my product a device?](https://www.fda.gov/medical-devices/classify-your-medical-device/how-determine-if-your-product-medical-device);
  see also law-firm summaries of FDA's January 2026 general wellness guidance, e.g. [Covington](https://cov.com/en/news-and-insights/insights/2026/01/fda-issues-revised-guidance-on-general-wellness-products)).
- **Two existing FDA categories fit AGENCY's features closely:**
  - **Powered communication system** ([21 CFR 890.3710](https://www.law.cornell.edu/cfr/text/21/890.3710)): "an
    AC- or battery-powered device intended for medical purposes" used by people "unable to use normal communication
    methods because of physical impairment". **Class II, exempt from 510(k)**, subject to the limits in § 890.9.
    Product code ILQ ([FDA database](https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfPCD/classification.cfm?id=ILQ)).
  - **Powered environmental control system** ([21 CFR 890.3725](https://www.law.cornell.edu/cfr/text/21/890.3725)):
    lets a patient control household functions, with examples including room temperature, answering the door or
    phone, and **"to sound an alarm for assistance"**. Also Class II, 510(k)-exempt subject to § 890.9. That
    describes Lifeline plus the smart-home features almost exactly.
- **"Exempt" is limited.** Under [§ 890.9](https://www.law.cornell.edu/cfr/text/21/890.9), a 510(k) is still needed
  if a device has a different intended use from legally marketed devices of its type, or uses a "different
  fundamental scientific technology". Whether webcam gaze or an AI agent counts as different technology is a
  question for a regulatory expert.
- **Exempt devices are still regulated.** A device maker must register and list with FDA (annual establishment fee:
  $13,785 for FY2027, which runs 1 October 2026 to 30 September 2027, per
  [FDA's MDUFA fee page](https://www.fda.gov/industry/fda-user-fee-programs/medical-device-user-fee-amendments-mdufa-fees)),
  follow the Quality Management System Regulation (in effect since 2 February 2026 and aligned with ISO 13485:
  [FDA QMSR](https://www.fda.gov/quality-systems-regulation)), report adverse events, and meet labelling and UDI
  rules. Devices that connect to the internet also face FDA cybersecurity expectations if they ever go through
  premarket review ([FDA guidance, June 2025](https://www.hhs.gov/guidance/sites/default/files/hhs-guidance-documents/FDA/GUI00001825-final-PremarketCybersecurity-2025.pdf)).
- **FDA's list of software that is *not* a device doesn't mention AAC or accessibility tools**
  ([FDA examples](https://www.fda.gov/medical-devices/device-software-functions-including-mobile-medical-applications/examples-software-functions-are-not-medical-devices)),
  so there's no clear safe harbour to point to.
- **You can ask FDA.** A **513(g) request** asks FDA how it would classify a product. It has a user fee: $8,596
  (standard) or $4,298 (small business) for FY2027 ([FDA fee page](https://www.fda.gov/industry/fda-user-fee-programs/medical-device-user-fee-amendments-mdufa-fees),
  [513(g) fee guidance](https://fda.gov/media/78463/download)).

### What this means in practice

1. **Until you have advice:** describe AGENCY as free computer-access and communication software; don't claim it
   treats, monitors, diagnoses or alerts for any medical condition; keep the README's "not a medical device, not a
   ventilator alarm, not an emergency service" language everywhere, including grant applications and social media.
2. **Lifeline is the riskiest part.** LIFELINE.md positions it as a non-medical caregiver-alerting tool, and that's
   sensible, but 890.3725's wording ("to sound an alarm for assistance") and the "ventilator power watch" feature
   both need a regulatory opinion before real deployment.
3. **Some funding paths pull you towards the device route.** Insurance funding for speech-generating devices and
   hospital procurement may expect a registered device. Decide deliberately, with advice, rather than drifting into
   it.
4. **AI provider terms add their own limits.** Gemini's terms say you may not use the services "in clinical
   practice, to provide medical advice", or in a way that requires clearance from a medical device regulator; users
   must be 18+; and unpaid-tier content may be used to improve Google's products and read by human reviewers
   ([Gemini API terms](https://ai.google.dev/gemini-api/terms)). For hospital or device use, plan for on-device
   models or a provider agreement that allows it.
5. **Outside the US** (EU, UK, Canada and others) rules differ; we haven't researched them.

### Privacy laws that may apply

| Law | When it applies | What to do |
|---|---|---|
| **HIPAA** | Generally not to an app people choose and use themselves; it can apply when a hospital or clinic **hires** you to provide the service, making you a "business associate" ([HHS guidance summary](https://mobihealthnews.com/content/hhs-adds-more-guidance-health-app-developers-navigating-hipaa); [HHS access-right FAQ](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/access-right-health-apps-apis/index.html)) | Expect a business associate agreement in any hospital or clinic deployment |
| **FTC Health Breach Notification Rule** | Health apps and online services not covered by HIPAA. Since July 2024 a "breach" includes **unauthorised disclosures**, not just hacks ([Nixon Peabody summary](https://www.nixonpeabody.com/insights/alerts/2024/05/22/ftc-amends-and-broadens-health-breach-notification-rule)) | Never share health information (responder cards, phrases, care plans) with third parties, including AI providers, without clear authorisation; have a breach plan |
| **California CMIA, Civil Code § 56.06(b)** | A business offering software to consumers designed to maintain medical information, so the person can manage it or for managing a medical condition, is treated as a health care provider under the CMIA ([statute](https://california.public.law/codes/ca_civ_code_section_56.06)). Lifeline's responder card holds medications, allergies and breathing equipment | Ask your lawyer whether this reaches AGENCY; design as if it does |
| **Washington My Health My Data Act** | Covers "consumer health data" with no size threshold, and appears to cover nonprofits ([Sidley](https://www.sidley.com/en/insights/newsupdates/2023/05/washington-state-enacts-my-health-my-data-act), [Cooley FAQ](https://cdp.cooley.com/washington-states-my-health-my-data-act-faq-part-one-applicability-and-scope/)) | Matters once you have users in Washington; consent before collecting or sharing health data |

**Privacy posture we recommend:** on-device by default; AI off or on-device unless the person turns cloud AI on;
paid (no-training) AI tiers only; no analytics or ad trackers; encryption at rest; one-look "delete everything";
a short, plain-language privacy notice; and a written breach response plan.

### Operational rules that bite

- **Text messages:** US SMS from ordinary 10-digit numbers must be registered (A2P 10DLC) or it's blocked
  ([Twilio](https://support.twilio.com/hc/en-us/articles/14910496447771-Shutdown-of-Unregistered-10DLC-Messaging)).
  Register before anyone relies on Lifeline texts.
- **App stores:** Android's AccessibilityService needs a Play declaration; only tools built for people with
  disabilities may set `isAccessibilityTool` ([Google Play](https://support.google.com/googleplay/android-developer/answer/10964491)).
- **Insurance:** ask a broker about general liability, directors and officers, and cyber cover before deployments
  in homes and clinics. Ask specifically about Lifeline.

---

## 6. Funding

Only programs we could verify with a link are listed, with what we could confirm as of 12 October 2026. Always
check the funder's page before applying.

### Open now or soon

| Funder / program | Amount | Who can apply | Deadline / status | Fit and notes |
|---|---|---|---|---|
| **ALS Association, Assistive Technology Grants** ([program page](https://www.als.org/research/research-we-fund/our-awards-and-programs/assistive-technology-grants), [2026 RFA](http://www.als.org/AssistiveTech2026), [listing](https://atomgrants.com/grant/assistive-technology-grants-als-association)) | Up to **$400,000** total over up to 2 years | Organisations or individuals; the applicant must **control the IP** being developed | **LOI due 3 Nov 2026**, 1 pm ET; invited full proposals due 12 Jan 2027; decisions March 2027 (via ProposalCentral) | Strong fit (communication, daily activities). Funds development, efficacy testing and scale-up, not early discovery. The Association expects commercial availability 3 to 5 years after the award; ask how it views free, open-source distribution. Settle IP ownership first |
| **Ability Central, California Community Impact Grants** ([page](https://abilitycentral.org/philanthropy/community-impact-grant)) | $500 to $5,000 (max 2 awards, $10,000 a year) | 501(c)(3) or 501(h) nonprofits or educational institutions with budgets under $1M, serving Californians with communication disabilities | Rolling; decisions within 90 days; spend within 3 months | Good first grant once you have 501(c)(3) status (ask whether a fiscally sponsored project qualifies) |
| **Ability Central, annual grant cycle** ([2027–2028 RFP](https://abilitycentral.org/philanthropy/2027-2028-grant-cycle)) | $10,000 to $200,000 per project | Nonprofits and research institutions serving California residents | 2027–28 LOIs closed 31 Aug 2026; watch for the next cycle (this one opened 1 July) | Excellent fit ("Assistive & Digital Accessibility") |

### Recurring programs to plan for

| Funder / program | Amount | Who can apply | Timing | Fit and notes |
|---|---|---|---|---|
| **AWS Imagine Grant (US)** ([AWS](https://aws.amazon.com/government-education/nonprofits/aws-imagine-grant-program/)) | Pathfinder: up to $200,000 unrestricted + up to $100,000 AWS credits (generative/agentic AI as a core workload) | US 501(c) nonprofits; schools and universities excluded | 2026 cycle closed (it opened 19 March and Round One closed 5 June); watch for 2027 | Fits if your AI work runs on AWS; you'd need nonprofit status |
| **Fast Forward Accelerator** ([announcement of 2026 cohort](https://www.ffwd.org/blog/press-release-2026-accelerator-cohort), [2027 call summary](https://opportunitydesk.org/2026/08/19/fast-forward-accelerator-2027/)) | $25,000+ unrestricted, plus mentoring | Early-stage tech nonprofits with a working product | 2027 cohort deadline was 7 Sep 2026; watch for the next call | Very good fit; competition from AI nonprofits is rising (about half of 2026 applicants) |
| **Craig H. Neilsen Foundation, Creating Opportunity & Independence** ([funding page](https://chnfoundation.org/funding-opportunities/), [2025 guide](https://chnfoundation.org/wp-content/uploads/2024/12/COI-2025-Application-Guide_FINAL-12.2.24_accessible.pdf)) | Not stated on the current page; past notices said $25,000 to $100,000 | Nonprofits (US/Canada) running programs for people with **spinal cord injury**; assistive technology is a focus area | Annual cycle via ProposalCentral; check the 2026 guide | Fits only for a program that serves people with SCI (for example, setup and training) |
| **Reeve Foundation Quality of Life Grants** ([application process](https://www.christopherreeve.org/todays-care/get-support/grants-for-non-profits/application-process/), [listing](https://www.ruralhealthinfo.org/funding/626)) | Direct Effect $5,000 to $24,999; Priority Impact up to $50,000 | 501(c)(3)s and others; projects must serve people with **paralysis** (at least 5 people) | Last deadline 12 Mar 2026; check for the next cycle | Fits a local program (device setup, loaner kits) rather than software development |
| **NIDILRR Field Initiated Projects** (Administration for Community Living; [example FY2026 notice](https://simpler.grants.gov/opportunity/a07130c9-e1e8-487a-b5d7-20757d5ef21d)) | Around $250,000 per year per listings; 36-month projects | Varies by notice; check eligibility on Grants.gov | Annual; check Grants.gov | Federal grants are hard for a new organisation; partner with a university |
| **SBIR/STTR** ([NIH eligibility](https://www.grants.nih.gov/grants/policy/nihgps/html5/section_18/18.5.2_eligibility.htm)) | Varies | **For-profit small businesses only** (STTR adds a nonprofit research partner) | Reauthorized through 30 Sep 2031 in April 2026, per [law-firm commentary](https://www.mondaq.com/unitedstates/government-contracts-procurement-ppp/1774902/sbirsttr-programs-reauthorized-after-six-month-lapse) | Not available to a nonprofit; relevant only if you ever form a for-profit arm, or as a university partner |
| **UC and UCSC programs**: [CITRIS Tech for Social Good](https://citris-uc.org/ucsc-entrepreneurs-supported-by-citris-and-the-banatao-institute/), Big Ideas ([UCSC news](https://news.ucsc.edu/2020/10/big-ideas-contest/)), [UCSC CIED](https://cied.ucsc.edu/programs) | Small (CITRIS 2024–25: up to $5,000; Big Ideas: up to $20,000 in 2020) | UC students | Check current rounds | Good for early, small money and visibility |

### In-kind support

- **Apple Developer Program fee waiver** for eligible nonprofits, which covers code signing and notarization
  ([Apple](https://developer.apple.com/support/fee-waiver)).
- **Google for Nonprofits**: Google Workspace for Nonprofits, including Gemini for eligible 501(c)(3)s
  ([Google](https://www.google.com/nonprofits/about/program-overview)).
- **AWS credits** come with Imagine Grants (above).

### Could not verify (don't plan on these yet)

- **Microsoft AI for Accessibility grants**: Microsoft's accessibility innovation page doesn't mention an open grant
  program; only third-party aggregators list one.
- **Patrick J. McGovern Foundation**: a large AI-for-good funder, but third-party profiles say it is invitation-only
  ([example profile](https://opengrants.io/patrick-j-mcgovern-foundation-grant-funding/)).
- **Team Gleason**: helps people with ALS get equipment (and has partnered with Tobii Dynavox), but we found no
  open grant program for organisations. Treat it as a partner, not a funder.
- **Google.org**: funded 30 disability nonprofits through its Impact Challenge on Disabilities in the past
  ([Google](https://blog.google/company-news/inside-google/around-the-globe/google-europe/a-world-that-works-for-everyone-20m-in/));
  we found no open 2026 call.

### Other income

- Individual donations through your fiscal sponsor (the hackathon story and your grandmother's, told with her
  permission, will matter here).
- Sponsorship from companies, with written rules: no influence on safety decisions, no data sharing.

---

## 7. Partnerships

| Partner | Why | First step |
|---|---|---|
| **ALS Network** (California; formerly the ALS Association Golden West Chapter) | Runs a free AAC equipment loan program (eye and head trackers, switches, SGDs) and care management; links to certified treatment centres ([ALS Network AAC loans](https://alsnetwork.org/navigating-als/living-with-als/augmentative-communication-equipment-loan-program/)) | Ask to present to their AAC/AT staff; ask for advisors and feedback |
| **Forbes Norris MDA/ALS Research and Treatment Center** (CPMC/Sutter, San Francisco) | One of the largest ALS clinical research centres; its team includes speech, occupational and respiratory therapists ([Sutter](https://sutterhealth.org/services/neuroscience/cpmc-neuromuscular-peripheral-nerve-disorders)) | Ask an SLP there for a 30-minute feedback session; later, a study site |
| **UCSF ALS Center** and other Bay Area ALS clinics | Clinicians, patients, research infrastructure ([UCSF ALS](https://als.ucsf.edu/node/471)) | Same |
| **Ability Tools** (California's AT Act program, run by CFILC) | Device lending libraries (including AAC), demonstrations, statewide reach ([program data](https://catada.info/apr_reports25/california_2025)) | Borrow an infrared tracker for benchmarking; explore listing AGENCY as a free option |
| **RERC on AAC (2025–2030)** | The national research centre on AAC engineering (Penn State with Arkansas, Auburn, Florida State and Temple) ([RERC](https://rerc2025.aac-learning-center.org/)) | Ask for advice on study design and outcome measures |
| **ASHA SIG 12 (AAC)** and **USSAAC** | Where AAC clinicians and users meet ([SIG 12](https://www.asha.org/sig/12/about-sig-12/), [USSAAC](https://www.ussaac.org/speakup/aac-and-amyotrophic-lateral-sclerosis-als/)) | Recruit SLP advisors; present findings |
| **Voice partners**: Bridging Voice / ElevenLabs Impact Program | Free personal voices for people with permanent speech loss ([ElevenLabs](https://elevenlabs.io/blog/impact-program-announcement)) | Ask how AGENCY users can be referred |
| **Open-source AAC projects**: Cboard, AsTeRICS Grid, OptiKey | Shared formats (Open Board Format), lessons learned, possibly shared components ([AsTeRICS Grid](https://github.com/asterics/AsTeRICS-Grid), [OptiKey (GPLv3)](https://github.com/OptiKey/OptiKey)) | Open an issue or email; offer interoperability |
| **Researchers working on AI and AAC** (e.g. the SpeakFaster authors at Google, who worked with Team Gleason) | They've measured exactly what you want to improve ([paper](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11530652/)) | Share your study plan; ask for feedback |
| **UCSC** | IRB/ORCA ([irb.ucsc.edu](https://irb.ucsc.edu)), a faculty sponsor (HCI, assistive technology or health), [CIED](https://cied.ucsc.edu/programs) | Email ORCA (orca@ucsc.edu) about review for student research with disabled participants |
| **Home Assistant community** | Local, open-source smart home ([Home Assistant](https://www.home-assistant.io/components/matter)) | Build the integration in the open |

---

## 8. 30/60/90-day plan

Suggested owners: **Product & engineering**, **Research & partnerships**, **Operations & funding**. Pick who takes
which; rotate if you like. Dates count from 12 October 2026.

### Days 1–30 (to ~11 November)

| Owner | Task |
|---|---|
| All | Write a one-page founders' agreement: roles, decisions, time commitments around classes, what happens if someone leaves, and that code is assigned or licensed to the organisation. Include Ray's Synapse-Mesh if it stays |
| All | Check the [personal items](#things-to-check-about-yourselves-first): ages, immigration status, UCSC rules |
| Operations & funding | **Decide on the ALS Association LOI (due 3 November).** If yes: who is the applicant, how you show IP control, a 2.5-page LOI with aims and a distribution plan, a clinician co-investigator if possible |
| Operations & funding | Shortlist 3 fiscal sponsors; ask the questions in section 2; apply to one |
| Operations & funding | Find pro bono or low-cost nonprofit and IP legal help (law school clinics and bar association referral services are common starting points) |
| Product & engineering | Add a LICENSE (default suggestion: AGPL-3.0-or-later) and a DCO; email RealEye about the license; fix THIRD_PARTY.md |
| Product & engineering | Quick safety fixes from the roadmap: paid AI tier or AI off by default, demo controls off, eye keyboard digits and "@", plain-language privacy notice |
| Research & partnerships | Email UCSC ORCA; find a faculty sponsor |
| Research & partnerships | Contact ALS Network, Forbes Norris and 2 to 3 AAC SLPs for 30-minute feedback calls |
| Research & partnerships | Ask your grandmother what she wants from AGENCY, and whether (and how) she's happy for her story to be told |

### Days 31–60 (to ~11 December)

| Owner | Task |
|---|---|
| Operations & funding | If going ahead: file Articles of Incorporation, adopt bylaws and conflict-of-interest policy, hold the first board meeting, get an EIN, file the Statement of Information |
| Operations & funding | Build a funding calendar (Ability Central rolling grants, AWS Imagine, Fast Forward, the next Ability Central cycle, Neilsen/Reeve if a program fits) |
| Research & partnerships | Form the advisory council (paid seats for people with lived experience and caregivers); first meeting on the roadmap |
| Research & partnerships | Draft the study protocol, consent materials and data plan with an SLP and your faculty sponsor |
| Product & engineering | Gaze lab baseline on the team and volunteers; borrow an infrared tracker and benchmark; publish the real numbers |
| Product & engineering | Sign and notarize the Mac app (apply for Apple's nonprofit fee waiver once eligible); threat model and SECURITY.md |

### Days 61–90 (to ~10 January)

| Owner | Task |
|---|---|
| Operations & funding | File Form 1023 (most likely the full form); register with the CA Attorney General within 30 days of first receiving assets |
| Operations & funding | If invited: ALS Association full proposal (due 12 January 2027) |
| Research & partnerships | Submit the protocol to the IRB; line up a first study site |
| Research & partnerships | Get a regulatory opinion on positioning, Lifeline and the smart-home features |
| Product & engineering | A signed "pilot" release for supervised sessions with non-disabled volunteers; Lifeline drills with a real Pi + UPS; A2P 10DLC registration if using real SMS |
| All | A one-page public update: what works, what's been tested, what hasn't, what you need |

---

## 9. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Someone relies on Lifeline and it fails** | Could cost a life; also legal liability | Never market it as a medical alarm or emergency service; keep existing alarms in place; drills; hardware kit with UPS; insurance; regulatory advice |
| **The agent does something harmful** (wrong payment, wrong message, prompt injection) | The person may not be able to stop it in time | Keep approval binding and Stop; read-only first; spending limits; daily summaries; incident review |
| **Regulatory surprise** (FDA, state privacy laws) | Could force you to pull features or change claims | Advice before marketing; careful wording; 513(g) request if needed |
| **License conflict** (no license today; RealEye AGPL/commercial terms) | Blocks partners, contributors and grants that need IP control | Choose a license now; written answer from RealEye; DCO |
| **AI provider terms and cost** | Gemini bars clinical use and under-18 users; free tiers may use data for training | Paid tier; on-device models; a second provider |
| **Privacy breach** of intimate conversations or medical details | Harm to users; FTC/CMIA exposure; trust lost | On-device by default; encryption; minimal data; breach plan |
| **Built for one person** (n=1 design) | Your grandmother's needs may not match others' | Advisory council; study with diverse participants (ALS, LIS, SCI, CP) |
| **Webcam gaze isn't accurate enough for some users** | Frustration and abandonment | Support infrared trackers; switch fallback; honest accuracy grades |
| **Founder burnout and academic load** | Three students, exams, graduations | Narrow scope; say no to features; recruit volunteers and advisors; a realistic plan |
| **Bus factor** (Synapse-Mesh in one person's repo; model files not in git) | The AI path breaks if one person is unavailable | Make the default path simple; move needed code into the main repo or drop it |
| **Funding concentration** | One lost grant stalls the project | Several small grants plus individual donors |
| **Competition from free built-in features** (Apple Eye Tracking, Windows Eye Control, Look to Speak) | Funders will ask "why not just use those?" | Focus on what they don't do: approvals for real tasks, Lifeline, fast AI talk, open and cross-platform |
| **Overpromising in publicity** | Hurts trust with clinicians and families | Keep the repo's honesty: say what's simulated, untested and unproven |
| **Name confusion** ("Lifeline", "AGENCY") | Confusing in an emergency; hard to protect | Rename Lifeline; trademark search |
| **Caregiver misuse or financial abuse** | The person is vulnerable | Person-only approvals by default; visible audit log; alerts for unusual activity |

---

## 10. Sources

Checked or found on 12 October 2026. Secondary sources (law firms, aggregators, news) are marked in the text; prefer
the primary source when acting.

**Nonprofit formation**
- IRS user fees for Forms 1023 and 1023-EZ: https://www.irs.gov/charities-non-profits/form-1023-and-1023-ez-amount-of-user-fee
- IRS processing times (updated 28 June 2026): https://www.irs.gov/charities-non-profits/charitable-organizations/wheres-my-application
- Form 1023-EZ instructions: https://www.irs.gov/instructions/i1023ez ; eligibility summary: https://www.harborcompliance.com/blog/form-1023-ez-understanding-eligibility/
- Form 1023 instructions: https://www.irs.gov/instructions/i1023 ; 27-month effective-date rule: https://www.irs.gov/forms-pubs/changes-to-jan-2020-revision-of-instructions-for-form-1023-schedule-e-line-2-and-line-2a
- Form 990-N: https://www.irs.gov/charities-non-profits/annual-electronic-filing-requirement-for-small-exempt-organizations-form-990-n-e-postcard
- California nonprofit FAQ (Nolo): https://www.nolo.com/technical-support-main/online-california-nonprofit-faq.html ; guide: https://www.swyftfilings.com/learning-center/california-nonprofit-guide
- CA Attorney General initial registration: https://www.oag.ca.gov/system/files/media/initialReg.pdf
- FTB 3500A: https://ftb.ca.gov/forms/misc/3500A-instructions.html
- Cal. Corp. Code § 5227: https://california.public.law/codes/ca_corp_code_section_5227
- Fiscal sponsorship overview (Northeastern Law): https://law.northeastern.edu/wp-content/uploads/2025/11/Nonprofit-QA-Resource-Fiscal-Sponsorships.pdf
- Fiscal Sponsor Directory: https://fiscalsponsordirectory.org/ ; Mission Edge listing: https://fiscalsponsordirectory.org/mission-edge/
- Code for Science & Society FAQ: https://www.codeforsociety.org/fsp/faq
- Software Freedom Conservancy: https://sfconservancy.org/members/apply/
- HCB eligibility and fee: https://help.hcb.hackclub.com/en/articles/15409923-who-can-apply-for-fiscal-sponsorship and https://help.hcb.hackclub.com/en/articles/13356219-what-does-the-7-fee-cover-is-it-annual-monthly-etc
- Open Collective donations (tax status): https://docs.opencollective.com/help/financial-contributors/financial-contributors
- Open Collective Foundation dissolution: https://opencollective.com/foundation/updates/an-update-from-open-collective-foundations-board-of-directors

**Licensing**
- RealEye repository: https://github.com/RealEye-io/webcam-eyetracker-light-open ; commercial license: https://raw.githubusercontent.com/RealEye-io/webcam-eyetracker-light-open/main/LICENSE-COMMERCIAL.md
- GNU AGPL-3.0: https://www.gnu.org/licenses/agpl-3.0.en.html
- chess.js (BSD-2-Clause): https://github.com/jhlywa/chess.js
- US Copyright Office AI report, Part 2: https://blogs.loc.gov/copyright/2025/02/inside-the-copyright-offices-report-copyright-and-artificial-intelligence-part-2-copyrightability/

**Regulation and privacy**
- FDA, is my product a device: https://www.fda.gov/medical-devices/classify-your-medical-device/how-determine-if-your-product-medical-device
- 21 CFR 890.3710: https://www.law.cornell.edu/cfr/text/21/890.3710 ; 890.3725: https://www.law.cornell.edu/cfr/text/21/890.3725 ; 890.9: https://www.law.cornell.edu/cfr/text/21/890.9
- FDA product code ILQ: https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfPCD/classification.cfm?id=ILQ
- General wellness guidance, January 2026 (law-firm summary): https://cov.com/en/news-and-insights/insights/2026/01/fda-issues-revised-guidance-on-general-wellness-products
- FDA examples of software that is not a device: https://www.fda.gov/medical-devices/device-software-functions-including-mobile-medical-applications/examples-software-functions-are-not-medical-devices
- MDUFA fees: https://www.fda.gov/industry/fda-user-fee-programs/medical-device-user-fee-amendments-mdufa-fees ; 513(g) fee guidance: https://fda.gov/media/78463/download
- QMSR: https://www.fda.gov/quality-systems-regulation
- FDA premarket cybersecurity guidance (2025): https://www.hhs.gov/guidance/sites/default/files/hhs-guidance-documents/FDA/GUI00001825-final-PremarketCybersecurity-2025.pdf
- Gemini API terms: https://ai.google.dev/gemini-api/terms
- HIPAA and health apps: https://mobihealthnews.com/content/hhs-adds-more-guidance-health-app-developers-navigating-hipaa ; https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/access-right-health-apps-apis/index.html
- FTC Health Breach Notification Rule amendments: https://www.nixonpeabody.com/insights/alerts/2024/05/22/ftc-amends-and-broadens-health-breach-notification-rule
- California Civil Code § 56.06: https://california.public.law/codes/ca_civ_code_section_56.06
- Washington My Health My Data Act: https://www.sidley.com/en/insights/newsupdates/2023/05/washington-state-enacts-my-health-my-data-act ; https://cdp.cooley.com/washington-states-my-health-my-data-act-faq-part-one-applicability-and-scope/
- Twilio 10DLC: https://support.twilio.com/hc/en-us/articles/14910496447771-Shutdown-of-Unregistered-10DLC-Messaging
- Google Play AccessibilityService policy: https://support.google.com/googleplay/android-developer/answer/10964491
- FCC Lifeline: https://www.fcc.gov/lifeline-consumers ; 988: https://www.fcc.gov/sites/default/files/988-fact-sheet.pdf

**Funding**
- ALS Association Assistive Technology Grants: https://www.als.org/research/research-we-fund/our-awards-and-programs/assistive-technology-grants ; RFA: http://www.als.org/AssistiveTech2026 ; listing: https://atomgrants.com/grant/assistive-technology-grants-als-association
- Ability Central: https://abilitycentral.org/philanthropy/community-impact-grant ; https://abilitycentral.org/philanthropy/2027-2028-grant-cycle
- AWS Imagine Grant: https://aws.amazon.com/government-education/nonprofits/aws-imagine-grant-program/
- Fast Forward: https://www.ffwd.org/blog/press-release-2026-accelerator-cohort ; https://opportunitydesk.org/2026/08/19/fast-forward-accelerator-2027/
- Craig H. Neilsen Foundation: https://chnfoundation.org/funding-opportunities/ ; https://chnfoundation.org/wp-content/uploads/2024/12/COI-2025-Application-Guide_FINAL-12.2.24_accessible.pdf
- Reeve Foundation QOL grants: https://www.christopherreeve.org/todays-care/get-support/grants-for-non-profits/application-process/ ; https://www.ruralhealthinfo.org/funding/626
- NIDILRR FIP example notice: https://simpler.grants.gov/opportunity/a07130c9-e1e8-487a-b5d7-20757d5ef21d
- NIH SBIR/STTR eligibility: https://www.grants.nih.gov/grants/policy/nihgps/html5/section_18/18.5.2_eligibility.htm ; reauthorization: https://www.mondaq.com/unitedstates/government-contracts-procurement-ppp/1774902/sbirsttr-programs-reauthorized-after-six-month-lapse
- UC/UCSC: https://citris-uc.org/ucsc-entrepreneurs-supported-by-citris-and-the-banatao-institute/ ; https://news.ucsc.edu/2020/10/big-ideas-contest/ ; https://cied.ucsc.edu/programs
- Apple fee waiver: https://developer.apple.com/support/fee-waiver ; Google for Nonprofits: https://www.google.com/nonprofits/about/program-overview
- Patrick J. McGovern Foundation profile: https://opengrants.io/patrick-j-mcgovern-foundation-grant-funding/
- Google Impact Challenge: Disabilities: https://blog.google/company-news/inside-google/around-the-globe/google-europe/a-world-that-works-for-everyone-20m-in/

**Partners**
- ALS Network AAC loans: https://alsnetwork.org/navigating-als/living-with-als/augmentative-communication-equipment-loan-program/
- Forbes Norris (Sutter): https://sutterhealth.org/services/neuroscience/cpmc-neuromuscular-peripheral-nerve-disorders
- UCSF ALS: https://als.ucsf.edu/node/471
- Ability Tools data: https://catada.info/apr_reports25/california_2025
- RERC on AAC: https://rerc2025.aac-learning-center.org/
- ASHA SIG 12: https://www.asha.org/sig/12/about-sig-12/ ; USSAAC: https://www.ussaac.org/speakup/aac-and-amyotrophic-lateral-sclerosis-als/
- ElevenLabs Impact Program: https://elevenlabs.io/blog/impact-program-announcement
- AsTeRICS Grid: https://github.com/asterics/AsTeRICS-Grid ; OptiKey: https://github.com/OptiKey/OptiKey
- SpeakFaster paper: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11530652/
- UCSC IRB: https://irb.ucsc.edu
