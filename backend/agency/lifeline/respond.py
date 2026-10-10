"""The page a contact opens from their alert text: plain server-rendered HTML.

It works on any phone browser with no JavaScript, no login and no app. The unguessable token
in the link is the only credential, and it opens one alert only. When the alert has ended the
page stops showing the responder card, so an old link doesn't keep exposing medical details.
"""

from __future__ import annotations

from html import escape
from typing import Any

from .models import LifelineSettings
from .service import clock, parse

FLASH = {
    "ack": "Thank you. {name} can see that you're on the way.",
    "ack_also": "Thank you. Someone else already answered, and you're marked as on the way too.",
    "decline": "Thanks for letting us know. AGENCY is contacting the next person.",
    "resolve": "The alert has ended. Everyone who was alerted has been told.",
    "ended": "This alert had already ended.",
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
.flash{background:#fff;border:3px solid #1e6b3a;border-radius:12px;padding:12px 14px;margin:0 0 16px;font-weight:600}
form{margin:0 0 12px}
button,.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:64px;border:0;border-radius:14px;
font:inherit;font-weight:700;font-size:1.2rem;cursor:pointer;text-decoration:none;text-align:center;margin:0 0 12px}
form button{margin:0}
.go{background:#1e6b3a;color:#fff}.no{background:#fff;color:#151515;border:2px solid #8a8a8a}
.safe{background:#fff;color:#1e6b3a;border:3px solid #1e6b3a}
.call{display:block;text-align:center;background:#fff;color:#b3261e;border:3px solid #b3261e;border-radius:14px;
padding:14px;font-weight:700;text-decoration:none;margin:0 0 16px}
section{background:#fff;border-radius:14px;padding:14px 16px;margin:0 0 16px}
h2{font-size:1.05rem;margin:0 0 8px}dl{margin:0}dt{font-weight:700;margin-top:8px}dd{margin:0}
ol{margin:0;padding-left:1.2rem}li{margin:4px 0}.t{color:#555;font-variant-numeric:tabular-nums}
.small{font-size:.9rem;color:#444}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}section,.flash,.no,.safe,.call{background:#1d1d1d;color:#eee}
.t,.small{color:#bbb}.safe{color:#7ed39a;border-color:#7ed39a}.call{color:#ff8a80;border-color:#ff8a80}}
"""


def _page(title: str, body: str, *, refresh: bool) -> str:
    meta = '<meta http-equiv="refresh" content="15">' if refresh else ""
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
    return _page("AGENCY Lifeline", body, refresh=False)


def render(
    detail: dict[str, Any],
    notification: dict[str, Any],
    settings: LifelineSettings,
    token: str,
    flash: str | None,
    *,
    confirm_resolve: bool = False,
) -> str:
    name = settings.responder.person_name or "The person"
    status = detail["status"]
    test = detail["is_test"]
    mine = notification.get("response")
    ended = status in ("resolved", "cancelled")
    parts: list[str] = []

    if ended:
        by = detail.get("resolved_by") or "someone"
        parts.append(
            f'<div class="banner ended"><h1>This alert has ended</h1><p>Ended by {escape(by)} at '
            f"{escape(clock(parse(detail.get('resolved_at'))))}. {escape(name)} was marked safe.</p></div>"
        )
    elif status == "acknowledged":
        who = detail.get("acknowledged_by") or "Someone"
        cls = "test" if test else "ok"
        lead = "You're on the way" if mine == "acknowledged" else f"{escape(who)} is on the way"
        parts.append(f'<div class="banner {cls}"><h1>{"TEST: " if test else ""}{lead}</h1><p>{escape(detail["what"])}.</p></div>')
    else:
        cls = "test" if test else ""
        heading = "TEST alert (not an emergency)" if test else f"{escape(name)} needs help"
        parts.append(f'<div class="banner {cls}"><h1>{heading}</h1><p>{escape(detail["what"])}.</p></div>')

    if flash in FLASH:
        parts.append(f'<p class="flash" role="status">{escape(FLASH[flash].format(name=name))}</p>')

    action = f"/respond/{escape(token)}"
    if not ended and confirm_resolve:
        # Ending an alert stops escalation for everyone, so it takes a second, deliberate tap.
        parts.append(
            f"<section><h2>Are you with {escape(name)}, and are they safe?</h2>"
            "<p>Ending the alert stops AGENCY contacting people and sends everyone an all-clear.</p></section>"
            f'<form method="post" action="{action}/resolve"><button class="safe" type="submit">'
            f"Yes, {escape(name)} is safe: end the alert</button></form>"
            f'<a class="btn no" href="{action}">No, go back</a>'
        )
        return _page(f"End the alert? AGENCY Lifeline for {name}", "".join(parts), refresh=False)

    if not ended:
        if mine != "acknowledged":
            label = "I'm on my way (test)" if test else "I'm on my way"
            parts.append(f'<form method="post" action="{action}/ack"><button class="go" type="submit">{label}</button></form>')
            if mine != "declined" and status != "acknowledged":
                parts.append(
                    f'<form method="post" action="{action}/decline"><button class="no" type="submit">I can\'t come</button></form>'
                )
        parts.append(f'<a class="btn safe" href="{action}?confirm=resolve">{escape(name)} is safe: end the alert</a>')
        if not test:
            number = escape(settings.emergency_number)
            parts.append(
                f'<a class="call" href="tel:{number}">If {escape(name)} isn\'t breathing or won\'t respond, call {number} now</a>'
            )

        card = settings.responder
        rows = "".join(
            f"<dt>{label}</dt><dd>{escape(getattr(card, field))}</dd>" for field, label in CARD_FIELDS if getattr(card, field)
        )
        if rows:
            parts.append(f"<section><h2>About {escape(name)}</h2><dl>{rows}</dl></section>")

    events = [e for e in detail["events"] if e["kind"] not in ("signal_repeated",)][-12:]
    if events:
        items = "".join(f'<li><span class="t">{escape(clock(parse(e["ts"])))}</span> {escape(e["message"])}</li>' for e in events)
        parts.append(f"<section><h2>What has happened</h2><ol>{items}</ol></section>")

    parts.append(
        '<p class="small">Sent by AGENCY Lifeline for '
        f"{escape(name)}. This page updates every 15 seconds. AGENCY is not an emergency service.</p>"
    )
    title = f"{'TEST: ' if test else ''}{name}: AGENCY Lifeline"
    return _page(title, "".join(parts), refresh=not ended)
