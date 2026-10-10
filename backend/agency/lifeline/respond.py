"""The page a contact opens from their alert text: plain server-rendered HTML.

It works on any phone browser with no JavaScript, no login and no app. The unguessable token
in the link is the only credential, and it opens one alert only. When the alert has ended the
page stops showing the responder card, so an old link doesn't keep exposing medical details.

Besides "I'm on my way", the page is where a helper runs the rescue: they see what the person
said is wrong, ask them yes/no questions (answered with their eyes on AGENCY), follow the steps
from the person's care plan, unlock the door, request emergency services, and show paramedics a
summary.
"""

from __future__ import annotations

from html import escape
from typing import TYPE_CHECKING, Any

from .rescue import ANSWERS
from .service import clock, parse

if TYPE_CHECKING:
    from .service import LifelineService

VIEWS = {"resolve", "dispatch", "dispatch-cancel", "ask"}

FLASH = {
    "ack": "Thank you. {name} can see that you're on the way.",
    "ack_also": "Thank you. Someone else already answered, and you're marked as on the way too.",
    "decline": "Thanks for letting us know. AGENCY is contacting the next person.",
    "resolve": "The alert has ended. Everyone who was alerted has been told.",
    "ended": "This alert had already ended.",
    "asked": "Sent. {name} sees your question now and answers with their eyes. The answer appears below.",
    "too_many": "{name} already has questions waiting. Wait for an answer first.",
    "ask_invalid": "Type a question with at least a few words.",
    "step": "Marked as done. {name} and everyone helping can see it.",
    "arrived": "Thank you. Everyone can see that you're with {name}.",
    "unlocked": "The front door is unlocked for you. It locks again by itself.",
    "unlock_failed": "The door couldn't be unlocked. Use the key safe or another way in.",
    "unlock_not_allowed": "{name} hasn't allowed AGENCY to unlock the door.",
    "unlock_needs_ack": "Press I'm on my way first, then you can unlock the door.",
    "unlock_test": "Test alert: in a real alert the door would be unlocked for you now.",
    "dispatched": "Emergency services have been requested. Stay with {name} if you can.",
    "dispatch_test": "Test alert: in a real alert emergency services would be requested now.",
    "dispatch_failed": "Emergency services could NOT be requested. Call {number} yourself now.",
    "dispatch_cancelled": "The emergency services request was cancelled.",
    "dispatch_cancel_failed": "The request couldn't be cancelled. Contact emergency services directly.",
}

CARD_FIELDS = (
    ("address", "Where"),
    ("communication", "How to communicate"),
    ("breathing", "Breathing and equipment"),
    ("medical", "Medical"),
    ("allergies", "Allergies"),
    ("medications", "Medications"),
    ("advance_directive", "Advance directive"),
    ("notes", "Notes"),
)

CSS = """
*{box-sizing:border-box}
body{margin:0;font:18px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f4f4f0;color:#151515}
main{max-width:34rem;margin:0 auto;padding:16px}
.banner{border-radius:14px;padding:18px;margin:0 0 16px;color:#fff;background:#b3261e}
.banner.test{background:#5b4bb7}.banner.ok{background:#1e6b3a}.banner.ended{background:#4a4a4a}
.banner h1{margin:0 0 6px;font-size:1.45rem;line-height:1.2}.banner p{margin:0}
.says{margin:10px 0 0;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.22);font-weight:700}
.flash{background:#fff;border:3px solid #1e6b3a;border-radius:12px;padding:12px 14px;margin:0 0 16px;font-weight:600}
form{margin:0 0 12px}
button,.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:64px;border:0;border-radius:14px;
font:inherit;font-weight:700;font-size:1.2rem;cursor:pointer;text-decoration:none;text-align:center;margin:0 0 12px;padding:8px 12px}
form button{margin:0}
.go{background:#1e6b3a;color:#fff}.no{background:#fff;color:#151515;border:2px solid #8a8a8a}
.safe{background:#fff;color:#1e6b3a;border:3px solid #1e6b3a}
.amb{background:#b3261e;color:#fff}
.call{display:block;text-align:center;background:#fff;color:#b3261e;border:3px solid #b3261e;border-radius:14px;
padding:14px;font-weight:700;text-decoration:none;margin:0 0 16px}
section{background:#fff;border-radius:14px;padding:14px 16px;margin:0 0 16px}
h2{font-size:1.05rem;margin:0 0 8px}dl{margin:0}dt{font-weight:700;margin-top:8px}dd{margin:0}
ol,ul{margin:0;padding-left:1.2rem}li{margin:4px 0}.t{color:#555;font-variant-numeric:tabular-nums}
.small{font-size:.9rem;color:#444}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.grid form{margin:0}
.grid button{min-height:56px;font-size:1rem;background:#eef1f6;color:#151515;border:2px solid #c9ced8}
.steps{list-style:none;padding:0}.steps li{display:flex;gap:10px;align-items:center;justify-content:space-between;
padding:8px 0;border-bottom:1px solid #e3e3e3}.steps li:last-child{border-bottom:0}
.steps form{margin:0;flex:none}.steps button{min-height:48px;width:auto;padding:0 18px;font-size:1rem;background:#1e6b3a;color:#fff}
.done{color:#1e6b3a;font-weight:700}
.answer{font-weight:700}.wait{color:#8a5200;font-weight:700}
textarea{width:100%;font:inherit;padding:12px;border-radius:12px;border:2px solid #8a8a8a;min-height:110px}
details{background:#fff;border-radius:14px;padding:14px 16px;margin:0 0 16px}summary{font-weight:700;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}section,details,.flash,.no,.safe,.call{background:#1d1d1d;color:#eee}
.t,.small{color:#bbb}.safe{color:#7ed39a;border-color:#7ed39a}.call{color:#ff8a80;border-color:#ff8a80}
.grid button{background:#262b33;color:#eee;border-color:#3b4250}.steps li{border-color:#333}.done{color:#7ed39a}}
"""


def _page(title: str, body: str, *, refresh: int | None) -> str:
    meta = f'<meta http-equiv="refresh" content="{refresh}">' if refresh else ""
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="robots" content="noindex">'
        f"{meta}<title>{escape(title)}</title><style>{CSS}</style></head><body><main>{body}</main></body></html>"
    )


def render_invalid() -> str:
    body = (
        '<div class="banner ended"><h1>This link isn\'t valid</h1>'
        "<p>It may have been mistyped. If you think someone needs help, call or go to them directly.</p></div>"
    )
    return _page("AGENCY Lifeline", body, refresh=None)


def _post(action: str, label: str, cls: str) -> str:
    return f'<form method="post" action="{action}"><button class="{cls}" type="submit">{label}</button></form>'


def render(
    detail: dict[str, Any],
    notification: dict[str, Any],
    service: LifelineService,
    token: str,
    flash: str | None,
    *,
    view: str | None = None,
) -> str:
    settings = service.settings()
    name = settings.responder.person_name or "The person"
    n = escape(name)
    number = escape(settings.emergency_number)
    status = detail["status"]
    test = detail["is_test"]
    mine = notification.get("response")
    ended = status in ("resolved", "cancelled")
    critical = detail.get("urgency") == "critical" and not test
    dispatch = detail.get("dispatch")
    action = f"/respond/{escape(token)}"
    parts: list[str] = []

    # -- what is happening ----------------------------------------------------------------
    says = ""
    if detail.get("situation"):
        says = f'<p class="says">{n} says: {escape(detail["situation_label"].lower())}{" (critical)" if critical else ""}</p>'
    elif detail.get("detail") and not ended:
        says = f'<p class="says">{escape(detail["detail"])}</p>'
    if ended:
        by = detail.get("resolved_by") or "someone"
        parts.append(
            f'<div class="banner ended"><h1>This alert has ended</h1><p>Ended by {escape(by)} at '
            f"{escape(clock(parse(detail.get('resolved_at'))))}. {n} was marked safe.</p></div>"
        )
    elif status == "acknowledged":
        who = detail.get("acknowledged_by") or "Someone"
        cls = "test" if test else ("" if critical else "ok")
        lead = "You're on the way" if mine == "acknowledged" else f"{escape(who)} is on the way"
        parts.append(
            f'<div class="banner {cls}"><h1>{"TEST: " if test else ""}{lead}</h1><p>{escape(detail["what"])}.</p>{says}</div>'
        )
    else:
        cls = "test" if test else ""
        heading = "TEST alert (not an emergency)" if test else f"{'CRITICAL: ' if critical else ''}{n} needs help"
        parts.append(f'<div class="banner {cls}"><h1>{heading}</h1><p>{escape(detail["what"])}.</p>{says}</div>')

    if flash in FLASH:
        parts.append(
            f'<p class="flash" role="status">{escape(FLASH[flash].format(name=name, number=settings.emergency_number))}</p>'
        )

    # -- confirmation and form views (no auto-refresh while someone is deciding or typing) --
    if not ended and view == "resolve":
        # Ending an alert stops escalation for everyone, so it takes a second, deliberate tap.
        parts.append(
            f"<section><h2>Are you with {n}, and are they safe?</h2>"
            "<p>Ending the alert stops AGENCY contacting people and sends everyone an all-clear.</p></section>"
            + _post(f"{action}/resolve", f"Yes, {n} is safe: end the alert", "safe")
            + f'<a class="btn no" href="{action}">No, go back</a>'
        )
        return _page(f"End the alert? AGENCY Lifeline for {name}", "".join(parts), refresh=None)
    if not ended and view == "dispatch":
        sim = " This is a demo: the dispatch centre is simulated and no one is sent." if service.dispatch.simulated else ""
        address = settings.dispatch.address.one_line() or "the address in Lifeline setup"
        parts.append(
            f"<section><h2>Request an ambulance for {n}?</h2>"
            f"<p>AGENCY asks {escape(service.dispatch.name)} to send emergency services to {escape(address)}.{sim}</p>"
            f"<p>If {n} isn't breathing or won't respond, also call {number} yourself now.</p></section>"
            + _post(f"{action}/dispatch", "Yes, request an ambulance", "amb")
            + f'<a class="btn no" href="{action}">No, go back</a>'
        )
        return _page(f"Request an ambulance? AGENCY Lifeline for {name}", "".join(parts), refresh=None)
    if not ended and view == "dispatch-cancel":
        parts.append(
            "<section><h2>Cancel the emergency services request?</h2>"
            f"<p>Only cancel if you are with {n} and they don't need emergency help.</p></section>"
            + _post(f"{action}/dispatch-cancel", "Yes, cancel the request", "no")
            + f'<a class="btn go" href="{action}">No, keep it</a>'
        )
        return _page(f"Cancel emergency services? AGENCY Lifeline for {name}", "".join(parts), refresh=None)
    if not ended and view == "ask":
        parts.append(
            f"<section><h2>Ask {n} a yes/no question</h2>"
            f'<p class="small">{n} answers yes, no or not sure with their eyes. Keep it to one thing.</p>'
            f'<form method="post" action="{action}/ask"><textarea name="text" maxlength="140" required '
            f'placeholder="Is the mask hurting you?"></textarea><p></p>'
            f'<button class="go" type="submit">Send to {n}</button></form></section>'
            f'<a class="btn no" href="{action}">Back</a>'
        )
        return _page(f"Ask {name}: AGENCY Lifeline", "".join(parts), refresh=None)

    if not ended:
        # -- the helper's own next step --------------------------------------------------
        arrived = bool(notification.get("arrived_at"))
        if mine != "acknowledged":
            label = "I'm on my way (test)" if test else "I'm on my way"
            parts.append(_post(f"{action}/ack", label, "go"))
            if mine != "declined" and status != "acknowledged":
                parts.append(_post(f"{action}/decline", "I can't come", "no"))
        if not arrived:
            parts.append(_post(f"{action}/arrived", f"I'm with {n} now", "go" if mine == "acknowledged" else "no"))
        if not test:
            parts.append(f'<a class="call" href="tel:{number}">If {n} isn\'t breathing or won\'t respond, call {number} now</a>')

        unlocked_for = detail.get("door_unlocked_for")
        if unlocked_for:
            relock = clock(parse(detail.get("door_relocks_at")))
            parts.append(
                f'<p class="flash">Front door unlocked for {escape(unlocked_for)}. It locks again at {escape(relock)}.</p>'
            )
        elif settings.home.unlock_for_responders and service.home.has_lock and mine == "acknowledged":
            parts.append(_post(f"{action}/unlock", "I'm at the door: unlock it", "no"))

        # -- talk to the person: yes/no questions answered with their eyes ---------------
        questions = detail.get("questions") or []
        rows = []
        for q in questions[-5:]:
            if q["answer"]:
                ans = f'<span class="answer">{escape(ANSWERS.get(q["answer"], q["answer"]))}</span>'
            else:
                ans = '<span class="wait">waiting for an answer…</span>'
            rows.append(f"<li>{escape(q['asked_by'])} asked: {escape(q['text'])} {ans}</li>")
        presets = "".join(
            _post(f"{action}/ask/{key}", escape(text), "")
            for key, text in (
                ("breathing", "Is it your breathing?"),
                ("pain", "Are you in pain?"),
                ("hurry", "Should I hurry?"),
                ("ambulance", "Do you want an ambulance?"),
            )
        )
        parts.append(
            f"<section><h2>Ask {n}</h2>"
            + (
                f"<ul>{''.join(rows)}</ul><p></p>"
                if rows
                else f'<p class="small">{n} can\'t speak, but can answer yes or no with their eyes on AGENCY.</p>'
            )
            + f'<div class="grid">{presets}</div><p></p><a class="btn no" href="{action}?confirm=ask">Ask something else</a></section>'
        )

        # -- emergency services ------------------------------------------------------------
        sim = " (simulated)" if service.dispatch.simulated else ""
        if dispatch and dispatch.get("active"):
            parts.append(
                f"<section><h2>Emergency services{sim}</h2><p>{escape(dispatch['summary'])}</p>"
                f'<a class="btn no" href="{action}?confirm=dispatch-cancel">Cancel the request</a></section>'
            )
        elif settings.dispatch.consent:
            note = f'<p class="small">{escape(dispatch["summary"])}</p>' if dispatch else ""
            parts.append(
                f"<section><h2>Emergency services{sim}</h2>{note}"
                f'<a class="btn amb" href="{action}?confirm=dispatch">Request an ambulance</a></section>'
            )

        # -- what to do: the person's own care plan ----------------------------------------
        plan = detail.get("plan") or {}
        steps = plan.get("steps") or []
        if steps:
            items = []
            for st in steps:
                if st["done_at"]:
                    mark = f'<span class="done">Done ({escape(st["done_by"])}, {escape(clock(parse(st["done_at"])))})</span>'
                else:
                    mark = _post(f"{action}/step/{st['index']}", "Done", "")
                items.append(f"<li><span>{escape(st['label'])}</span>{mark}</li>")
            note = f'<p class="small">{escape(detail["plans_note"])}</p>' if detail.get("plans_note") else ""
            parts.append(
                f'<section><h2>What to do: {escape(plan.get("label", ""))}</h2><ol class="steps">{"".join(items)}</ol>{note}</section>'
            )

        parts.append(f'<a class="btn safe" href="{action}?confirm=resolve">{n} is safe: end the alert</a>')

        card = settings.responder
        card_rows = "".join(
            f"<dt>{label}</dt><dd>{escape(getattr(card, field))}</dd>" for field, label in CARD_FIELDS if getattr(card, field)
        )
        if card_rows:
            parts.append(f"<section><h2>About {n}</h2><dl>{card_rows}</dl></section>")
        summary = detail.get("handoff") or []
        if summary:
            lines = "".join(f"<dt>{escape(item['label'])}</dt><dd>{escape(item['text'])}</dd>" for item in summary)
            parts.append(f"<details><summary>For paramedics: show them this</summary><dl>{lines}</dl></details>")

    events = [e for e in detail["events"] if e["kind"] not in ("signal_repeated",)][-12:]
    if events:
        items_html = "".join(
            f'<li><span class="t">{escape(clock(parse(e["ts"])))}</span> {escape(e["message"])}</li>' for e in events
        )
        parts.append(f"<section><h2>What has happened</h2><ol>{items_html}</ol></section>")

    waiting_mine = any(q["contact_id"] == notification["contact_id"] and not q["answer"] for q in detail.get("questions") or [])
    refresh = None if ended else (5 if waiting_mine else 15)
    parts.append(
        f'<p class="small">Sent by AGENCY Lifeline for {n}. This page updates every {refresh or 15} seconds. '
        "AGENCY is not an emergency service.</p>"
    )
    title = f"{'TEST: ' if test else ''}{name}: AGENCY Lifeline"
    return _page(title, "".join(parts), refresh=refresh)
