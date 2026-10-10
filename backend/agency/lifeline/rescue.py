"""Turning an alert into a rescue: what's wrong, what to do, and what to tell paramedics.

Nothing here invents medical advice. The steps a helper sees come from the person's own care
plan, written in Lifeline setup together with their care team. The demo ships an example
plan for the fictional profile, labelled as such everywhere it appears.
"""

from __future__ import annotations

from typing import Any, Literal

Situation = Literal["breathing", "choking", "equipment", "pain", "position", "other"]
Urgency = Literal["standard", "urgent", "critical"]

# What the person can say with their eyes, and how urgent each is. "critical" means it may be
# minutes from life-threatening: everyone is alerted at once and emergency services can be
# requested automatically if nobody answers.
SITUATIONS: dict[str, dict[str, str]] = {
    "breathing": {"label": "Breathing or mask", "urgency": "critical"},
    "choking": {"label": "Choking or secretions", "urgency": "critical"},
    "equipment": {"label": "Ventilator or equipment", "urgency": "critical"},
    "pain": {"label": "Pain", "urgency": "urgent"},
    "position": {"label": "Position or discomfort", "urgency": "urgent"},
    "other": {"label": "Something else", "urgency": "urgent"},
}

URGENCY_RANK = {"standard": 0, "urgent": 1, "critical": 2}

# Questions a helper can send to the person with one tap. The person answers yes / no / not sure
# with their eyes. "ambulance" is special: a "yes" requests emergency services.
PRESET_QUESTIONS: dict[str, str] = {
    "breathing": "Is it your breathing?",
    "better": "Is it getting better?",
    "pain": "Are you in pain?",
    "ambulance": "Do you want an ambulance?",
    "hurry": "Should I hurry?",
    "ok": "Are you OK right now?",
}
AMBULANCE_QUESTION = PRESET_QUESTIONS["ambulance"]
ANSWERS = {"yes": "Yes", "no": "No", "not_sure": "Not sure"}

# Example care plan for the fictional demo profile. Real steps must come from the person and
# their care team; the setup screen says so.
DEMO_PLANS: dict[str, list[str]] = {
    "general": [
        "Go to Riley straight away.",
        "Talk to Riley and ask yes/no questions: Riley looks up for yes and closes their eyes for no.",
        "If Riley isn't breathing or won't respond, call 911 now.",
        "Check the ventilator mask and tubing.",
    ],
    "breathing": [
        "If Riley isn't breathing or won't respond, call 911 now.",
        "Check the mask is on and sealed. Re-seat it if it has slipped.",
        "Check the tubing is connected at the mask and at the ventilator.",
        "Check the ventilator is on, plugged in and not alarming.",
        "Ask Riley if breathing is better now.",
    ],
    "choking": [
        "If Riley isn't breathing or won't respond, call 911 now.",
        "Sit Riley upright if you can.",
        "Use the suction machine the way Riley's care team showed you.",
        "Ask Riley if it is better now.",
    ],
    "equipment": [
        "Read the alarm message on the ventilator screen.",
        "Check it is plugged in and the power is on. Switch to the backup battery if needed.",
        "Check the mask and tubing connections.",
        "If the ventilator won't run and Riley is struggling to breathe, call 911.",
    ],
    "pain": [
        "Ask Riley yes/no questions to find where it hurts.",
        "Help Riley change position if that is part of the care plan.",
        "If the pain is in the chest or severe, call 911.",
    ],
    "position": [
        "Check Riley isn't trapped, slipping or pressed against anything.",
        "Reposition Riley the way the care team showed you.",
        "Ask Riley if it is better now.",
    ],
    "other": [
        "Go to Riley and ask yes/no questions to find out what's wrong.",
    ],
}


def situation_label(situation: str | None) -> str:
    return SITUATIONS[situation]["label"] if situation in SITUATIONS else "Not said yet"


def situation_urgency(situation: str | None) -> str:
    return SITUATIONS[situation]["urgency"] if situation in SITUATIONS else "standard"


def plan_key(situation: str | None) -> str:
    return situation if situation in SITUATIONS else "general"


def handoff(
    *,
    name: str,
    what: str,
    situation: str | None,
    detail: str | None,
    card: dict[str, str],
    questions: list[dict[str, Any]],
    steps: list[dict[str, Any]],
    dispatch: dict[str, Any] | None,
    times: dict[str, str],
) -> list[tuple[str, str]]:
    """A short, factual summary a helper can show paramedics. Only recorded facts, no guesses."""
    lines: list[tuple[str, str]] = []
    if card.get("communication"):
        lines.append(("Communication", card["communication"]))
    lines.append(("What happened", f"{what}." + (f" {detail}" if detail else "")))
    if situation in SITUATIONS:
        lines.append((f"{name} said", situation_label(situation)))
    answered = [q for q in questions if q.get("answer")]
    if answered:
        lines.append(
            (
                f"{name}'s answers",
                "; ".join(f"{q['text']} {ANSWERS.get(q['answer'], q['answer'])} ({times.get(q['id'], '')})" for q in answered),
            )
        )
    done = [s for s in steps if s.get("done_at")]
    if done:
        lines.append(("Done so far", "; ".join(f"{s['label']} ({s['done_by']}, {times.get(s['key'], '')})" for s in done)))
    if dispatch:
        lines.append(("Emergency services", dispatch["summary"]))
    for key, label in (
        ("breathing", "Breathing and equipment"),
        ("medical", "Medical"),
        ("allergies", "Allergies"),
        ("medications", "Medications"),
        ("advance_directive", "Advance directive"),
    ):
        if card.get(key):
            lines.append((label, card[key]))
    return lines
