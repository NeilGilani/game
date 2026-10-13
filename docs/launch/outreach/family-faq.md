# Questions families ask

*Draft, 12 October 2026. Honest answers about AGENCY as it is today. Check each answer against the app before you
publish it, and update it whenever the app changes.*

## Is it ready to use?

Not for everyday use yet. AGENCY works, and it's tested by computer, but **nobody with ALS or locked-in syndrome
has used it yet.** We want to test it with people who live with ALS, with their speech therapists, before anyone
relies on it. If you'd like to help shape it, we'd love to hear from you. `[[TEAM: contact]]`

## Is it safe?

We've built it to be careful, and we're honest about what isn't proven yet.

**What we've built in:**

- **You stay in charge.** Before AGENCY sends, buys, signs, calls or submits anything, it shows you exactly what
  will happen and waits for you to say yes. The "yes" appears in a different place on the screen, so a look that
  lingers can't say yes by accident.
- **Stop always works.** One look at Stop halts the AI helper at once.
- **It won't touch passwords, security codes or card numbers,** won't call emergency services and won't unlock real
  doors.
- **Real things are switched off to start with.** Out of the box, contacts are pretend phones and shops are
  practice shops. Someone has to deliberately turn real messages or orders on.

**What isn't proven yet:**

- **Eye tracking with a laptop camera is approximate.** It's less precise than the infrared eye trackers on
  dedicated communication devices, and our accuracy figures so far come from simulations, not real people.
- **The blink signal for help** (closing your eyes for about a second, three times) uses settings we chose
  carefully but haven't tested with people with ALS, including when they're tired or at night, or with drooping
  eyelids or dry eyes.
- **Real text messages and phone calls** for Lifeline haven't been tested with a real account yet.

**Lifeline is not a medical alarm or an emergency service.** It tries to reach the people you choose, and keeps
trying until one of them says they're coming. But it can fail if the computer, the internet or the power fails.
**Keep every alarm and call system you already have.** Never switch off a ventilator alarm or stop using a call
bell because of AGENCY.

## Is it a medical device?

No. AGENCY doesn't diagnose, treat or monitor any condition, and its suggestions are never medical advice. Talk to
your care team about medical decisions.

## What does it cost?

AGENCY is **free**, and we intend it to stay free. We're setting up a nonprofit so it can be paid for by grants and
donations, never by the people who use it.

What you need:

- **A Mac** (macOS 13 or later) with a camera. The camera built into a MacBook or iMac works.
- **Google Chrome**, if you want to use eye control on web pages.
- Nothing else for the basic features. There's no subscription. The AI features work through our service at no cost
  to you.
- **Optional:** a Raspberry Pi (a small, cheap computer) so Lifeline keeps working if the laptop stops; a Twilio
  account if you want Lifeline to send real text messages, which Twilio charges for.

If you already have an infrared eye tracker, we plan to support it, but that isn't built yet.

## What happens to my information?

**What stays on your computer:**

- **Camera video never leaves your computer.** AGENCY uses it to follow your eyes, then throws it away. It's never
  saved or sent.
- **Speech recognition happens on the Mac.** Audio is never recorded.
- Your phrases, what AGENCY learns about your usual choices, your Lifeline contacts and your responder card are kept
  on your computer. We never see them. AGENCY doesn't send us anything about how you use it.

**What goes to an AI company (Google), and only for these features:**

- **Finishing your sentences in Talk:** the words you've chosen so far and your recent phrases. This is on unless
  you turn it off.
- **Suggested replies in Talk:** what was heard and some of your phrases, only after you agree.
- **Explaining a letter:** the letter's text, each time you ask.
- **The AI helper doing a task:** pictures of your main screen while it works, including any other windows that are
  open, so close anything private first.

These go through our relay, which doesn't keep what passes through it, to Google's paid service. Google says its
paid service doesn't use what's sent to improve its products. `[[TEAM: confirm AGENCY's key is on the paid tier before publishing this.]]` Camera video and eye data are never sent.

**What your Lifeline contacts see:** your name, what happened, and, while the alert is open, the responder card you
wrote (how you communicate, breathing equipment, allergies, medications, how to get in).

The full details, including how to delete everything, are in our privacy policy. `[[TEAM: link]]`

## Who can see what I say?

Nobody at AGENCY. Words you speak with AGENCY stay on your computer, except for the AI features listed above. If
you'd rather nothing ever goes to an AI company, `[[TEAM: today this needs a technical setting; once there's a
switch in Settings, say "turn off AI in Settings"]]`.

## Can my caregiver control it for me?

A caregiver can set AGENCY up, change settings and use the mouse to help. But AGENCY is built so that **the
person who uses it decides.** Real actions need that person's approval.

## Will it work as my ALS changes?

We're designing for change: you can control AGENCY with your eyes, your head, a long blink or a switch, and dwell
times can be made longer. When eye control gets hard, switch scanning still reaches Help and Stop. But we haven't
tested this with people over time yet, and eye trackers of every kind can stop working in the late stages of ALS.
Talk to your speech therapist about planning ahead, including voice banking while you can still speak.

## Does it replace my speech therapist or my communication device?

No. Speech therapists who specialise in communication (AAC) assess what will work for you, and dedicated devices
have years of testing behind them. AGENCY may become a free option alongside those, or something to use while you
wait for a device. Ask your SLP.

## Who makes it?

Three students at UC Santa Cruz: Neil Gilani, Rayansh "Ray" Bakshi and Ryan Cho. We built it first for a team
member's grandmother. It won 1st place in the Cloud AI track at the UCSC AI Hackathon. All the code is public.

## Can I help?

Yes, especially if you live with ALS, care for someone who does, or work in AAC. We pay advisors with lived
experience for their time. `[[TEAM: contact, and how advisors are paid]]`
