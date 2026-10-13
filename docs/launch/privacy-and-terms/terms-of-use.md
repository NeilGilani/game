# AGENCY terms of use (draft)

*Draft, 12 October 2026, written to match what the code on `main` does (see the [privacy policy draft](privacy-policy.md),
Part 2, for where code and promises still differ). Not legal advice. A lawyer must review the warranty, liability,
governing-law and health sections, and how these terms sit next to the open-source licence the team chooses (see
[licence-decision-memo.md](../licence-decision-memo.md)). Written in plain words on purpose: the people reading it may
be reading one word at a time with their eyes.*

`[[TEAM: replace "we" with the organisation's legal name once it exists.]]`

---

## 1. What AGENCY is

AGENCY is free software that lets people who can only move their eyes use a Mac: to talk, to get everyday things
done with an AI helper that asks first, and to call people for help. It's made by a small team and given away free.

## 2. What AGENCY is not

Please read this part carefully.

- **AGENCY is not a medical device.** It doesn't diagnose, treat, monitor or prevent any illness, and it doesn't
  give medical advice. Nothing it says or suggests, including from AI, is medical advice.
- **Lifeline is not an emergency service and not a medical alarm.** It tries to reach the people you chose. It
  doesn't call 911 or any emergency service itself, it isn't connected to a ventilator or any medical equipment, and
  it can fail: if the computer, the internet, the phone network, a Raspberry Pi or its power fails, or if a contact
  doesn't answer. **Keep every alarm, call system and communication aid you already use.** Don't rely on AGENCY
  alone where a missed alert could cause harm.
- **Eye tracking with a webcam is approximate.** It can select the wrong thing. AGENCY asks you to confirm anything
  that matters, but you should check what it's about to do.
- **AI makes mistakes.** Suggested words, replies, plans and explanations can be wrong. You decide what to say and
  what to do.

## 3. Who can use AGENCY

- AGENCY is for adults. Its cloud AI features use Google's Gemini, whose terms don't allow users under 18. Don't use
  AGENCY's AI features if you're under 18. `[[TEAM: decide whether the whole app is 18+ or only the AI features, and
  add a check in the app.]]`
- A family member, caregiver or clinician may set AGENCY up for someone. If you do, you agree to these terms for
  yourself and you'll explain them to the person in a way that works for them. **The person who uses AGENCY decides
  what it does for them.** Caregivers may suggest; they don't approve real actions on the person's behalf unless the
  person has chosen that.

## 4. Your licence to use the software

AGENCY's code is published at https://github.com/NeilGilani/game. `[[TEAM: once chosen, e.g. "It is free software
under the GNU Affero General Public License, version 3 or later. You may use, study, share and change it under that
licence. If anything in these terms conflicts with that licence for the software itself, the licence wins."]]`
Parts of AGENCY are other people's open-source software, listed in `THIRD_PARTY.md`, under their own licences.

These terms cover the things the licence doesn't: the AGENCY Cloud service, the website, and how we describe what
AGENCY does.

## 5. You stay in control, and that means some things are up to you

AGENCY is built so that nothing consequential happens without your approval: sending or posting something, buying,
signing, placing a call, submitting a form, deleting, or sharing personal information. Each approval shows exactly
what will happen and is tied to that exact action; if anything changes, AGENCY asks again. **Stop** always halts the
agent.

What's up to you:

- **Read approvals before you confirm them.** When you approve an action, you're telling AGENCY to do it on your
  behalf, with your accounts.
- **Real actions are off until someone turns them on.** Out of the box, contacts are simulated phones, shops are
  practice shops, and emergency dispatch and door unlocking are simulated. Turning on real messages, real orders or
  real text alerts is your choice. When you do, the messages, orders and costs are real, and your agreements with
  those services (Apple, DoorDash, Uber Eats, Amazon, Instacart, Twilio, your phone company) apply.
- **Spending limits** you set are a safety net, not a guarantee.
- **Close anything private on screen before an agent task.** The agent works by looking at your main screen, and
  pictures of it go to the AI provider (see the privacy policy).
- **Even before you approve anything, the agent can open apps and websites, read pages, click links and type into
  ordinary fields** while it works on your task. It refuses to type passwords, codes or card numbers, and it refuses
  to contact emergency services or unlock real doors.
- **Set up Lifeline with the people it will contact,** make sure they know what a Lifeline message means, and run
  the practice alert regularly. Tell them it's not an emergency service.
- **Keep your Mac secure:** a password on your account, FileVault on, and software updates installed.

## 6. AGENCY Cloud

AGENCY Cloud is the free relay that lets AGENCY's AI features work without an AI key of your own.

- It's provided free, **as is, and may be limited, changed or switched off at any time,** for example if it's being
  abused or costs too much. When it's off or busy, AGENCY uses its built-in plans and suggestions instead, and says
  so.
- Fair-use limits apply per installation, per network and per day. Don't try to get around them, use AGENCY Cloud
  for anything other than AGENCY, or send content that breaks Google's
  [Gemini API terms](https://ai.google.dev/gemini-api/terms) or its
  [prohibited use policy](https://policies.google.com/terms/generative-ai/use-policy).
- What happens to what you send is in the privacy policy.

## 7. Things you agree not to do

- Use AGENCY to harm, harass, deceive or impersonate anyone. When AGENCY speaks or writes for you to another
  person, it tells them AI is helping; don't remove that.
- Use AGENCY to control someone else's computer, accounts or money without their agreement.
- Present AGENCY to others as a medical device, a medical alarm or an emergency service.
- Attack or overload AGENCY Cloud or our website.

## 8. No warranty

`[[TEAM: lawyer to finalise. Draft below follows the shape of the AGPL's own disclaimer (sections 15 and 16).]]`

AGENCY and AGENCY Cloud are provided free, "as is" and "as available", without any warranty, express or implied,
including that they will work without interruption or error, that they're fit for a particular purpose, or that an
alert, message or action will succeed. You use them at your own risk.

## 9. Limits on our responsibility

`[[TEAM: lawyer to finalise. Consumer and disability-rights laws limit what can be excluded, and some liability can't
be excluded at all. Ask specifically about Lifeline, and about insurance (general liability, D&O, cyber).]]`

To the extent the law allows, we aren't responsible for indirect or consequential loss, or for loss caused by: a
missed or delayed alert; an action you approved; a third-party service (an AI provider, Twilio, a shop, Apple,
Google, Cloudflare); a computer, network or power failure; or software changes you or someone else made.

## 10. Third-party services

AGENCY can connect to services we don't control. Their own terms and privacy policies apply, including Google
Gemini (and Anthropic, if you use your own key), Twilio, Apple, Home Assistant, the websites you visit and the shops
you order from.

## 11. Research

Using AGENCY doesn't make you part of any research study. If we run a study, you'll be asked separately, with its
own consent process, approved by an ethics board, and you can say no without losing access to AGENCY.

## 12. Changes to these terms

We'll post changes on our website with the date, and the change will be visible in the project's public history on
GitHub. If a change matters, the app will say so the next time it starts. `[[TEAM: the app has no terms screen today;
decide whether to add one.]]`

## 13. Governing law and disputes

`[[TEAM: lawyer to fill in, e.g. California law; consider an informal-resolution step first. Avoid anything that
makes it harder for a disabled person to raise a problem.]]`

## 14. Contact

`[[TEAM: organisation name, email, postal address; and an accessible way to reach you that doesn't need speech
(email or a web form).]]`

*Last updated: `[[TEAM: date]]`*

---

## Notes for the team

- **Where these terms come from in the code:** approvals bound to a fingerprint (`docs/os/PLAN.md`, safety
  constitution 1; `os/agent/src/guard.ts`); refusal of secret fields, card numbers, emergency services and real doors
  (`os/agent/src/policy/secrets.ts`, `policy/forbidden.ts`); simulated by default (`os/agent/src/policy/settings.ts`:
  `simulatedOnly: true`; real ordering and messaging off); spending defaults of $50 per purchase and $100 a day
  (`policy/settings.ts:43-48`), which reset when the agent restarts (`guard.ts:46-56`); AI disclosure on sends and
  calls (`guard.ts:221-223`); AGENCY Cloud limits (`docs/AI_RELAY.md`).
- **Section 5's "before you approve anything"** describes `agentAnySite: true` in AGENCY Browser
  (`os/desktop/src/main/browser/store.ts:22`) and the agent's native click and type tools. If the team narrows that,
  update this section.
- **Where to show the terms:** the app has no first-run terms or consent screen (privacy draft, Part 2). The
  onboarding (`os/desktop/src/renderer/onboarding/`) is the natural place for a one-screen summary of sections 2
  and 5, readable by eye, with the full text linked.
- **Easy-read version:** write a one-page easy-read summary with an SLP advisor. People with ALS may have cognitive
  changes, and everyone reads slowly by eye.
