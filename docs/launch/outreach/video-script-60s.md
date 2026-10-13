# 60-second video script

*Draft, 12 October 2026. About 140 spoken words, which is roughly 60 seconds at a calm pace. Every shot is of the
real app on a real Mac. The person on screen is a team member, and the caption says so. Nobody in the video is
presented as someone with ALS unless they are, and they have agreed in writing.*

**Rules for this video**

- Show only what works today. Anything simulated says "simulated" on screen (Lifeline contacts, the demo shop,
  dispatch).
- No stock footage of patients. No music swells over claims. No "life-saving".
- Captions burned in, and a separate `.vtt` file. Audio description of the visuals in the narration itself, so the
  video works with no picture.
- End card with the website and the words "Free. Open source. Not a medical device." ("Open source" only once a
  licence is added; see `../licence-decision-memo.md`.)

`[[TEAM: who narrates? A team member's own voice is best. If you use a synthetic voice, say so in the credits.]]`

| Time | Picture | Narration (spoken) | On-screen text |
|---|---|---|---|
| 0:00–0:06 | Close-up of a laptop webcam, then the AGENCY Home screen with its large tiles | Some people can only move their eyes. AGENCY is a free program that lets them use a computer anyway. | AGENCY. Free eye control for the Mac |
| 0:06–0:16 | A team member sits back from the laptop. The nine-point calibration dots appear one by one, then a grade: "Good" | It uses the camera already in the laptop. You look at nine dots, and it learns where you're looking. No special hardware. | Team member demonstrating. Webcam gaze is approximate |
| 0:16–0:28 | Talk: the eye keyboard, a quick phrase chosen by looking, AI-suggested replies appearing, one chosen, the Mac speaks it | To talk, you look at words, or at whole phrases you use every day. AI can suggest how to finish what you started, and the Mac says it out loud. | Talk |
| 0:28–0:40 | A task: "Order my usual". The plan appears, then an approval screen showing the exact order and price, confirmed by a second look elsewhere on the screen | AGENCY can also do tasks for you. But it always stops and shows you exactly what will happen, and nothing happens until you say yes. | Practice shop (simulated) |
| 0:40–0:52 | Three long blinks. A countdown. The simulated phones window: a contact taps "I'm on my way" | If you need someone, close your eyes for a second, three times. AGENCY keeps calling your people, one after another, until someone says they're coming. | Lifeline. Contacts simulated in this demo. Not an emergency service |
| 0:52–1:00 | End card | We built AGENCY first for a team member's grandmother. Now we're making it free for everyone who needs it. | Free. Open source. Not a medical device. `[[TEAM: website]]` |

**Before you publish**

- `[[TEAM: ask the grandmother (or her family) whether this one sentence about her may be used. If not, cut it and
  end on "Now we're making it free for everyone who needs it."]]`
- `[[TEAM: if a person with ALS ever appears, get written consent for the video specifically, and let them see the
  cut before it goes out.]]`
- Check every claim in the narration against the app on the day you film. If a feature changed, change the line.
- The site already has a placeholder for a demo video (`PUBLIC_DEMO_VIDEO` in `site/src/data/site.ts`).
