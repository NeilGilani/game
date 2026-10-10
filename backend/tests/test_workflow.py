"""End-to-end workflow tests through the HTTP API (inline runner, temp SQLite)."""

from __future__ import annotations

import asyncio
import time
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from agency.tools.catalog import TOOLS
from conftest import make_client, start_repair, step, tune

REPAIR_STEPS = [
    "details",
    "find_slots",
    "prepare_request",
    "get_policy",
    "check_documents",
    "prepare_inquiry",
    "book_repair",
    "submit_inquiry",
    "add_to_calendar",
    "draft_caregiver",
    "send_caregiver",
    "verify_all",
    "save_notes",
]


def start_repair_async(client: TestClient) -> dict:
    preview = client.post(
        "/api/goals/interpret",
        json={
            "goal_type": "equipment_repair",
            "selections": {"issue": "battery", "check_funding": "false", "notify_caregiver": "false"},
        },
    ).json()
    case = client.post("/api/cases", json={"goal": preview["goal"]}).json()
    deadline = time.monotonic() + 5
    while not case["pending_approvals"] and time.monotonic() < deadline:
        time.sleep(0.05)
        case = client.get(f"/api/cases/{case['id']}").json()
    return case


def approve_all(client: TestClient, case: dict) -> dict:
    ids = [a["id"] for a in case["pending_approvals"]]
    assert ids, "expected pending approvals"
    res = client.post("/api/approvals/batch", json={"approval_ids": ids, "decision": "approve"})
    assert res.status_code == 200, res.text
    return res.json()["cases"][0]


def test_repair_plan_has_expected_steps_and_runs_until_approval(client: TestClient) -> None:
    case = start_repair(client)
    assert [s["id"] for s in case["steps"]] == REPAIR_STEPS
    assert case["status"] == "waiting_approval"
    assert case["reasoning"]["mode"] == "deterministic"
    for sid in ["details", "find_slots", "prepare_request", "get_policy", "check_documents", "prepare_inquiry"]:
        assert step(case, sid)["status"] == "verified", sid
    assert step(case, "book_repair")["status"] == "awaiting_approval"
    assert step(case, "submit_inquiry")["status"] == "awaiting_approval"
    # Nothing consequential has happened at the provider yet: only a draft exists.
    requests = client.get("/api/demo-services/repair/requests").json()["requests"]
    assert [r["status"] for r in requests] == ["draft"]
    funding = client.get("/api/demo-services/funding/cases").json()["cases"]
    assert [f["status"] for f in funding] == ["draft"]


def test_missing_documents_identified_without_claiming_coverage(client: TestClient) -> None:
    case = start_repair(client)
    check = step(case, "check_documents")["output"]
    assert check["eligibility"] == "possibly_eligible_pending_documents"
    assert check["decision"] is None
    assert check["missing_ids"] == ["letter_of_medical_necessity"]


def test_full_happy_path_is_verified_and_persisted(client: TestClient) -> None:
    case = start_repair(client)
    case = approve_all(client, case)
    assert step(case, "book_repair")["status"] == "verified"
    assert step(case, "submit_inquiry")["status"] == "verified"
    assert step(case, "send_caregiver")["status"] == "awaiting_approval"
    case = approve_all(client, case)
    assert case["status"] == "completed"
    assert all(s["status"] == "verified" for s in case["steps"])

    # The services' own records agree with the case.
    booking = step(case, "book_repair")["output"]
    record = client.get(f"/api/demo-services/repair/requests/{booking['request_id']}").json()
    assert record["status"] == "confirmed" and record["reference"] == booking["reference"]
    inquiry = client.get("/api/demo-services/funding/cases").json()["cases"][0]
    assert inquiry["status"] == "received" and inquiry["decision"] is None
    outbox = client.get("/api/demo-services/messaging/outbox").json()
    assert outbox["real_world_delivery"] is False
    assert outbox["messages"][0]["status"] == "delivered_simulated"
    events = client.get("/api/demo-services/calendar/events").json()["events"]
    assert any(e["title"].startswith("Wheelchair repair") for e in events)

    summary = case["summary"]
    assert len(summary["done"]) == 4
    assert any("medical necessity" in f for f in summary["follow_ups"])
    assert "No real company" in summary["simulated_note"]
    # No simulated action is described as a real-world transaction.
    for line in summary["done"]:
        assert "approved" not in line.lower()


def test_slot_taken_failure_triggers_recovery_and_nothing_is_double_booked(client: TestClient) -> None:
    case = start_repair(client)
    first_slot = step(case, "find_slots")["output"]["recommended"]["slot_id"]
    client.put("/api/demo/faults", json={"repair_slot_taken": True})
    case = approve_all(client, case)

    failed = step(case, "book_repair")
    assert failed["status"] == "failed"
    assert failed["error"]["code"] == "slot_unavailable"
    assert failed["replaced_by"] == "book_repair_r1"
    recovery = step(case, "book_repair_r1")
    assert recovery["status"] == "awaiting_approval"
    assert recovery["recovery_context"]["verified_nothing_happened"] is True
    # Funding inquiry is independent of the booking and still went through.
    assert step(case, "submit_inquiry")["status"] == "verified"
    # Dependents were rewired to the recovery step.
    assert step(case, "add_to_calendar")["depends_on"] == ["book_repair_r1"]

    approval = case["pending_approvals"][0]
    assert "taken" in approval["details"]["recovery_context"]["reason"]
    new_slot = step(case, "find_slots_r1")["output"]["recommended"]["slot_id"]
    assert new_slot != first_slot

    case = approve_all(client, case)
    case = approve_all(client, case)
    assert case["status"] == "completed"
    confirmed = [r for r in client.get("/api/demo-services/repair/requests").json()["requests"] if r["status"] == "confirmed"]
    assert len(confirmed) == 1 and confirmed[0]["slot_id"] == new_slot

    kinds = [e["kind"] for e in client.get(f"/api/cases/{case['id']}/timeline").json()["events"]]
    assert "step_failed" in kinds and "recovery_planned" in kinds and kinds[-1] == "case_completed"


def test_timeout_after_commit_is_reconciled_not_repeated(client: TestClient) -> None:
    case = start_repair(client, check_funding="false", notify_caregiver="false")
    client.put("/api/demo/faults", json={"repair_timeout_after_commit": True})
    case = approve_all(client, case)
    book = step(case, "book_repair")
    assert book["status"] == "verified"
    assert book["evidence"]["replayed"] is True
    timeline = client.get(f"/api/cases/{case['id']}/timeline").json()
    kinds = [e["kind"] for e in timeline["events"]]
    assert "tool_timeout" in kinds and "reconciled" in kinds
    statuses = [i["status"] for i in timeline["invocations"] if i["step_id"] == "book_repair"]
    assert statuses == ["timeout", "reconciled"]
    confirmed = [r for r in client.get("/api/demo-services/repair/requests").json()["requests"] if r["status"] == "confirmed"]
    assert len(confirmed) == 1
    assert case["status"] == "completed"


def test_transient_failure_retries_then_recovers_with_approval(client: TestClient) -> None:
    case = start_repair(client, check_funding="false")
    case = approve_all(client, case)  # book
    client.put("/api/demo/faults", json={"messaging_unavailable": True})
    case = approve_all(client, case)  # send -> fails twice
    send = step(case, "send_caregiver")
    assert send["status"] == "failed" and send["attempts"] == 2
    assert send["error"]["code"] == "service_unavailable"
    retry = step(case, "send_caregiver_r1")
    assert retry["status"] == "awaiting_approval"
    case = approve_all(client, case)
    assert step(case, "send_caregiver_r1")["status"] == "verified"
    assert case["status"] == "completed"
    messages = client.get("/api/demo-services/messaging/outbox").json()["messages"]
    assert [m["status"] for m in messages] == ["delivered_simulated"]


def test_rejecting_an_action_blocks_dependents_and_finishes_partially(client: TestClient) -> None:
    case = start_repair(client)
    book = next(a for a in case["pending_approvals"] if a["step_id"] == "book_repair")
    res = client.post(f"/api/approvals/{book['id']}/decision", json={"decision": "reject"})
    case = res.json()["case"]
    assert step(case, "book_repair")["status"] == "rejected"
    assert step(case, "add_to_calendar")["status"] == "blocked"
    assert step(case, "draft_caregiver")["status"] == "blocked"
    case = approve_all(client, case)  # remaining: funding inquiry
    assert case["status"] == "completed_partial"
    assert any("declined" in x for x in case["summary"]["not_done"])
    assert all(r["status"] == "draft" for r in client.get("/api/demo-services/repair/requests").json()["requests"])


def test_editing_an_approval_rebinds_it_to_the_new_inputs(client: TestClient) -> None:
    case = start_repair(client, check_funding="false", notify_caregiver="false")
    approval = case["pending_approvals"][0]
    options = approval["details"]["edit"]["options"]
    other = options[1]["value"]
    res = client.post(f"/api/approvals/{approval['id']}/edit", json={"edits": {"slot_id": other}})
    assert res.status_code == 200, res.text
    new_approval = res.json()["approval"]
    assert new_approval["id"] != approval["id"] and new_approval["inputs_hash"] != approval["inputs_hash"]
    # The old approval can no longer be used.
    stale = client.post(f"/api/approvals/{approval['id']}/decision", json={"decision": "approve"})
    assert stale.status_code == 409
    case = client.post(f"/api/approvals/{new_approval['id']}/decision", json={"decision": "approve"}).json()["case"]
    assert step(case, "book_repair")["output"]["slot"]["slot_id"] == other

    bad = start_repair(client)
    bad_approval = next(a for a in bad["pending_approvals"] if a["step_id"] == "book_repair")
    res = client.post(f"/api/approvals/{bad_approval['id']}/edit", json={"edits": {"slot_id": "slot_nope"}})
    assert res.status_code == 409


def test_pause_stops_execution_and_resume_continues(client: TestClient) -> None:
    case = start_repair(client)
    client.post("/api/system/pause")
    ids = [a["id"] for a in case["pending_approvals"]]
    case = client.post("/api/approvals/batch", json={"approval_ids": ids, "decision": "approve"}).json()["cases"][0]
    assert case["status"] == "paused"
    assert step(case, "book_repair")["status"] == "approved"  # approved, but nothing ran
    assert all(r["status"] == "draft" for r in client.get("/api/demo-services/repair/requests").json()["requests"])
    client.post("/api/system/resume")
    case = client.get(f"/api/cases/{case['id']}").json()
    assert step(case, "book_repair")["status"] == "verified"


def test_case_pause_resume_and_cancel(client: TestClient) -> None:
    case = start_repair(client)
    case = client.post(f"/api/cases/{case['id']}/pause").json()
    assert case["status"] == "paused"
    case = client.post(f"/api/cases/{case['id']}/resume").json()
    assert case["status"] == "waiting_approval"
    case = client.post(f"/api/cases/{case['id']}/cancel").json()
    assert case["status"] == "cancelled"
    assert client.get("/api/approvals").json() == []
    assert client.post(f"/api/cases/{case['id']}/resume").status_code == 409


def test_state_survives_restart_and_interrupted_step_is_reconciled(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Kill the coordinator after the calendar service committed an event but before the
    result was recorded. After restart the case is held, the step is reconciled with the
    calendar (not repeated), and Resume finishes the case."""
    original = TOOLS["calendar.add_event"]

    async def commit_then_hang(ctx, inp):  # type: ignore[no-untyped-def]
        await original.run(ctx, inp)
        await asyncio.Event().wait()

    monkeypatch.setitem(TOOLS, "calendar.add_event", replace(original, run=commit_then_hang))
    settings_kwargs = {"db_name": "restart.db"}
    with make_client(tmp_path, inline=False, **settings_kwargs) as c:
        case = start_repair_async(c)
        case_id = case["id"]
        ids = [a["id"] for a in case["pending_approvals"]]
        c.post("/api/approvals/batch", json={"approval_ids": ids, "decision": "approve"})
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            case = c.get(f"/api/cases/{case_id}").json()
            if step(case, "add_to_calendar")["status"] == "running":
                break
            time.sleep(0.05)
        assert step(case, "add_to_calendar")["status"] == "running"
        assert step(case, "book_repair")["status"] == "verified"
        engine = c.app.state.agency.engine  # type: ignore[attr-defined]
        events_before = len(engine.calendar.list_events())
    # The context exit is the "crash": the runner task is cancelled mid-step.
    monkeypatch.setitem(TOOLS, "calendar.add_event", original)

    with make_client(tmp_path, **settings_kwargs) as c2:
        tune(c2)
        case = c2.get(f"/api/cases/{case_id}").json()
        assert case["status"] == "interrupted"
        assert step(case, "book_repair")["status"] == "verified"
        assert step(case, "add_to_calendar")["status"] == "succeeded"
        timeline = c2.get(f"/api/cases/{case_id}/timeline").json()
        kinds = [e["kind"] for e in timeline["events"]]
        assert "interrupted_step" in kinds and "interrupted" in kinds
        statuses = [i["status"] for i in timeline["invocations"] if i["step_id"] == "add_to_calendar"]
        assert statuses == ["interrupted", "reconciled"]
        case = c2.post(f"/api/cases/{case_id}/resume").json()
        assert step(case, "add_to_calendar")["status"] == "verified"
        engine = c2.app.state.agency.engine  # type: ignore[attr-defined]
        assert len(engine.calendar.list_events()) == events_before
        assert len([r for r in engine.repair.list_requests() if r["status"] == "confirmed"]) == 1


def test_reschedule_workflow_asks_mid_workflow(client: TestClient) -> None:
    preview = client.post(
        "/api/goals/interpret", json={"goal_type": "reschedule_appointment", "selections": {"notify_caregiver": "true"}}
    ).json()
    case = client.post("/api/cases", json={"goal": preview["goal"]}).json()
    assert case["status"] == "waiting_input"
    ask = step(case, "ask_which")
    assert ask["status"] == "waiting_input"
    options = ask["question"]["options"]
    assert any("Neurology" in o["label"] for o in options)
    bad = client.post(f"/api/cases/{case['id']}/steps/ask_which/answer", json={"value": "ev_nope"})
    assert bad.status_code == 409
    case = client.post(f"/api/cases/{case['id']}/steps/ask_which/answer", json={"value": "ev_neuro"}).json()
    assert case["status"] == "waiting_approval"
    case = approve_all(client, case)
    case = approve_all(client, case)
    assert case["status"] == "completed"
    event = next(e for e in client.get("/api/demo-services/calendar/events").json()["events"] if e["event_id"] == "ev_neuro")
    assert event["status"] == "rescheduled" and len(event["history"]) == 1


def test_admin_request_workflow(client: TestClient) -> None:
    preview = client.post("/api/goals/interpret", json={"goal_type": "admin_request", "selections": {}}).json()
    assert not preview["ready"] and preview["questions"][0]["key"] == "form_id"
    preview = client.post(
        "/api/goals/interpret", json={"goal_type": "admin_request", "selections": {"form_id": "form_paratransit"}}
    ).json()
    case = client.post("/api/cases", json={"goal": preview["goal"]}).json()
    assert step(case, "ask_trips_per_week")["status"] == "waiting_input"
    case = client.post(f"/api/cases/{case['id']}/steps/ask_trips_per_week/answer", json={"value": "3-5"}).json()
    case = client.post(f"/api/cases/{case['id']}/steps/ask_needs_attendant/answer", json={"value": "no"}).json()
    assert case["status"] == "waiting_approval"
    case = approve_all(client, case)
    assert case["status"] == "completed"
    app = client.get("/api/demo-services/funding/cases").json()["cases"][0]
    assert app["kind"] == "application" and app["status"] == "received"
    assert app["payload"]["fields"]["trips_per_week"] == "3-5"


def test_message_followup_workflow_from_phrases(client: TestClient) -> None:
    preview = client.post("/api/goals/interpret", json={"phrases": ["Please call me"]}).json()
    assert preview["goal"]["goal_type"] == "message_followup"
    assert preview["questions"][0]["key"] == "contact_id"
    preview = client.post(
        "/api/goals/interpret", json={"phrases": ["Please call me"], "selections": {"contact_id": "c_jordan"}}
    ).json()
    assert preview["ready"]
    case = client.post("/api/cases", json={"goal": preview["goal"]}).json()
    case = approve_all(client, case)
    assert case["status"] == "completed"
    assert step(case, "follow_up")["status"] == "verified"


def test_phrases_map_to_repair_goal(client: TestClient) -> None:
    preview = client.post(
        "/api/goals/interpret", json={"phrases": ["My wheelchair needs repair", "It won't charge", "Tell Jordan"]}
    ).json()
    goal = preview["goal"]
    assert goal["goal_type"] == "equipment_repair"
    assert goal["entities"]["issue"] == "battery"
    assert goal["options"] == {"check_funding": False, "notify_caregiver": True}
    assert preview["ready"]
    unknown = client.post("/api/goals/interpret", json={"free_text": "order a pizza"}).json()
    assert unknown["goal"] is None and unknown["unsupported"]
