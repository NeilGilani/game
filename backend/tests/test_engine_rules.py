"""Safety rules: plan validation, permissions, approvals, state transitions, idempotency."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agency.db import MIGRATIONS, Database
from agency.models import Goal, InvalidTransition, PlanDraft, StepDraft, StepStatus, check_transition
from agency.planning.planner import build_goal
from agency.planning.templates import baseline_plan
from agency.planning.validate import PlanValidationError, validate_plan
from agency.services.common import Faults
from agency.services.repair import DemoRepairProvider
from agency.services.seed import DEMO_PROFILE, seed_demo_data
from conftest import start_repair, step

PROFILE = DEMO_PROFILE | {"demo_deadline": "2026-10-16"}


def repair_goal(**selections: str) -> Goal:
    goal, _, _ = build_goal("equipment_repair", {"issue": "battery", **selections}, PROFILE)
    return goal


def test_every_builtin_plan_validates() -> None:
    goals = [
        repair_goal(),
        repair_goal(check_funding="false", notify_caregiver="false"),
        build_goal("equipment_repair", {}, PROFILE)[0],
        build_goal("reschedule_appointment", {}, PROFILE)[0],
        build_goal("reschedule_appointment", {"event_id": "ev_neuro", "notify_caregiver": "true"}, PROFILE)[0],
        build_goal("admin_request", {"form_id": "form_placard"}, PROFILE)[0],
        build_goal("message_followup", {"contact_id": "c_jordan", "template": "need_help"}, PROFILE)[0],
    ]
    for goal in goals:
        plan, _ = validate_plan(baseline_plan(goal), goal.goal_type)
        assert plan.steps[-2].id == "verify_all" and plan.steps[-1].id == "save_notes"


def test_validator_rejects_unknown_and_unpermitted_tools() -> None:
    plan = PlanDraft(steps=[StepDraft(id="hack", title="Run a command", description="rm -rf", tool="shell.exec")])
    with pytest.raises(PlanValidationError) as exc:
        validate_plan(plan, "equipment_repair")
    assert "unknown tool 'shell.exec'" in str(exc.value)

    plan = PlanDraft(
        steps=[
            StepDraft(
                id="move",
                title="Move appt",
                description="xyz",
                tool="calendar.reschedule",
                inputs={"event_id": "ev_neuro", "opening_id": "open_01"},
            )
        ]
    )
    with pytest.raises(PlanValidationError) as exc:
        validate_plan(plan, "equipment_repair")
    assert "not permitted" in str(exc.value)


def test_validator_rejects_bad_inputs_refs_and_dependencies() -> None:
    plan = PlanDraft(
        steps=[
            StepDraft(id="find", title="Find slots", description="xyz", tool="repair.find_slots", inputs={"issue": "explosion"}),
            StepDraft(
                id="prep",
                title="Prepare",
                description="xyz",
                tool="repair.prepare_request",
                inputs={"issue": "battery", "slot_id": {"$ref": "find.recommended.slot_id"}, "device_serial": "X", "bogus": 1},
            ),
            StepDraft(
                id="book",
                title="Book",
                description="xyz",
                tool="repair.submit_request",
                inputs={"request_id": {"$ref": "prep.nonexistent"}, "slot_id": "slot_01"},
                depends_on=["prep", "later"],
            ),
        ]
    )
    with pytest.raises(PlanValidationError) as exc:
        validate_plan(plan, "equipment_repair")
    problems = " | ".join(exc.value.problems)
    assert "input 'issue' is invalid" in problems
    assert "without depending on it" in problems
    assert "unknown inputs ['bogus']" in problems
    assert "does not produce 'nonexistent'" in problems
    assert "not an earlier step" in problems


def test_validator_forces_approval_on_consequential_tools() -> None:
    plan = PlanDraft(
        steps=[
            StepDraft(
                id="draft",
                title="Draft",
                description="xyz",
                tool="messaging.prepare_message",
                inputs={"contact_id": "c_jordan", "template": "please_call"},
            ),
            StepDraft(
                id="send",
                title="Send it now",
                description="xyz",
                tool="messaging.send",
                approval="none",
                inputs={"message_id": {"$ref": "draft.message_id"}, "body_digest": {"$ref": "draft.body_digest"}},
                depends_on=["draft"],
            ),
        ]
    )
    validated, notes = validate_plan(plan, "message_followup")
    assert next(s for s in validated.steps if s.id == "send").approval == "required"
    assert notes


def test_step_state_machine_rejects_illegal_transitions() -> None:
    check_transition(StepStatus.PENDING, StepStatus.AWAITING_APPROVAL)
    check_transition(StepStatus.SUCCEEDED, StepStatus.VERIFIED)
    with pytest.raises(InvalidTransition):
        check_transition(StepStatus.PENDING, StepStatus.VERIFIED)  # can't verify something never attempted
    with pytest.raises(InvalidTransition):
        check_transition(StepStatus.AWAITING_APPROVAL, StepStatus.RUNNING)  # can't run without approval
    with pytest.raises(InvalidTransition):
        check_transition(StepStatus.VERIFIED, StepStatus.RUNNING)  # never redo verified work


def test_goal_model_validates_input() -> None:
    with pytest.raises(ValueError):
        Goal(goal_type="equipment_repair", outcome="ok outcome", deadline="next friday")
    with pytest.raises(ValueError):
        Goal(goal_type="launch_rocket", outcome="ok outcome")  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        Goal(goal_type="equipment_repair", outcome="ok outcome", unexpected="x")  # type: ignore[call-arg]


def test_consequential_tool_never_runs_without_matching_approval(client: TestClient) -> None:
    case = start_repair(client)
    engine = client.app.state.agency.engine  # type: ignore[attr-defined]
    # Force the step to "approved" without an approval record: the engine must ask instead of booking.
    engine.db.execute("UPDATE steps SET status = 'approved' WHERE case_id = ? AND id = 'book_repair'", (case["id"],))
    engine.db.execute("UPDATE approvals SET status = 'withdrawn' WHERE case_id = ? AND step_id = 'book_repair'", (case["id"],))
    engine.db.execute("UPDATE cases SET status = 'running' WHERE id = ?", (case["id"],))
    case = client.post(f"/api/cases/{case['id']}/resume").json()
    assert step(case, "book_repair")["status"] == "awaiting_approval"
    assert all(r["status"] == "draft" for r in engine.repair.list_requests())

    # An approval for different inputs doesn't count either.
    approval = next(a for a in case["pending_approvals"] if a["step_id"] == "book_repair")
    engine.db.execute("UPDATE approvals SET status = 'approved', inputs_hash = 'tampered' WHERE id = ?", (approval["id"],))
    engine.db.execute("UPDATE steps SET status = 'approved' WHERE case_id = ? AND id = 'book_repair'", (case["id"],))
    case = client.post(f"/api/cases/{case['id']}/resume").json()
    assert step(case, "book_repair")["status"] == "awaiting_approval"
    kinds = [e["kind"] for e in client.get(f"/api/cases/{case['id']}/timeline").json()["events"]]
    assert "approval_stale" in kinds
    assert all(r["status"] == "draft" for r in engine.repair.list_requests())


def test_executor_refuses_tool_not_permitted_for_goal(client: TestClient) -> None:
    case = start_repair(client)
    engine = client.app.state.agency.engine  # type: ignore[attr-defined]
    engine.db.execute(
        "UPDATE steps SET tool = 'calendar.reschedule', status = 'pending' WHERE case_id = ? AND id = 'add_to_calendar'",
        (case["id"],),
    )
    case = client.post(
        "/api/approvals/batch", json={"approval_ids": [a["id"] for a in case["pending_approvals"]], "decision": "approve"}
    ).json()["cases"][0]
    assert step(case, "add_to_calendar")["status"] == "failed"
    assert step(case, "add_to_calendar")["error"]["code"] == "not_permitted"
    kinds = [e["kind"] for e in client.get(f"/api/cases/{case['id']}/timeline").json()["events"]]
    assert "action_refused" in kinds


def test_invalid_resolved_inputs_fail_the_step(client: TestClient) -> None:
    case = start_repair(client, check_funding="false", notify_caregiver="false")
    engine = client.app.state.agency.engine  # type: ignore[attr-defined]
    engine.db.execute(
        'UPDATE steps SET inputs = \'{"title": "x", "starts_at": 5, "ends_at": "y"}\' WHERE case_id = ? AND id = \'add_to_calendar\'',
        (case["id"],),
    )
    case = client.post(
        "/api/approvals/batch", json={"approval_ids": [a["id"] for a in case["pending_approvals"]], "decision": "approve"}
    ).json()["cases"][0]
    cal = step(case, "add_to_calendar")
    assert cal["status"] == "failed" and cal["error"]["code"] == "invalid_inputs"
    assert case["status"] == "completed_partial"


def test_failed_verification_is_reported_not_hidden(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    case = start_repair(client, check_funding="false", notify_caregiver="false")
    engine = client.app.state.agency.engine  # type: ignore[attr-defined]
    real_get = engine.repair.get_request

    def lying_provider(request_id: str):  # type: ignore[no-untyped-def]
        record = real_get(request_id)
        return record | {"status": "draft"} if record else record

    monkeypatch.setattr(engine.repair, "get_request", lying_provider)
    case = client.post(
        "/api/approvals/batch", json={"approval_ids": [a["id"] for a in case["pending_approvals"]], "decision": "approve"}
    ).json()["cases"][0]
    book = step(case, "book_repair")
    assert book["status"] == "failed" and book["error"]["code"] == "verification_failed"
    assert any(not c["passed"] for c in book["evidence"]["checks"])
    assert step(case, "add_to_calendar")["status"] == "blocked"
    assert case["status"] == "completed_partial"


def test_demo_services_are_idempotent(tmp_path) -> None:  # type: ignore[no-untyped-def]
    db = Database(tmp_path / "svc.db")
    db.migrate()
    seed_demo_data(db)
    repair = DemoRepairProvider(db, Faults(db))
    draft1, replayed1 = repair.create_draft(idempotency_key="k1", device={}, issue="battery", slot_id="slot_01")
    draft2, replayed2 = repair.create_draft(idempotency_key="k1", device={}, issue="battery", slot_id="slot_01")
    assert draft1["request_id"] == draft2["request_id"] and not replayed1 and replayed2
    first = repair.submit(idempotency_key="s1", request_id=draft1["request_id"], slot_id="slot_01")
    again = repair.submit(idempotency_key="s1", request_id=draft1["request_id"], slot_id="slot_01")
    assert again["replayed"] and again["request"]["reference"] == first["request"]["reference"]
    assert len([s for s in repair.list_slots() if s["booked_request_id"] == draft1["request_id"]]) == 1


def test_migrations_are_versioned_and_repeatable(tmp_path) -> None:  # type: ignore[no-untyped-def]
    db = Database(tmp_path / "m.db")
    latest = MIGRATIONS[-1][0]
    assert db.migrate() == latest
    assert db.migrate() == latest
    names = [r["name"] for r in db.query("SELECT name FROM schema_migrations ORDER BY version")]
    assert len(names) == len(MIGRATIONS)
