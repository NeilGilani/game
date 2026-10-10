from fastapi.testclient import TestClient
from test_workflow import approve_all

from conftest import make_client, start_repair


def test_empty_insights_are_zero_not_demo_claims(client: TestClient) -> None:
    response = client.get("/api/insights")
    assert response.status_code == 200
    data = response.json()
    assert data.pop("server_time").endswith("Z")
    assert all(value == 0 for value in data.values())


def test_drafts_do_not_count_as_verified_actions(client: TestClient) -> None:
    case = start_repair(client)
    insights = client.get("/api/insights").json()
    assert insights["cases_completed"] == 0
    assert insights["approved_decisions"] == 0
    assert insights["cloud_plans"] == 0
    assert insights["steps_verified"] == sum(s["status"] == "verified" for s in case["steps"])
    assert not any(s["tool"] == "repair.submit_request" and s["status"] == "verified" for s in case["steps"])


def test_insights_match_service_verified_completed_case(client: TestClient) -> None:
    case = approve_all(client, approve_all(client, start_repair(client)))
    timeline = client.get(f"/api/cases/{case['id']}/timeline").json()
    data = client.get("/api/insights").json()
    assert data["cases_completed"] == 1
    assert data["steps_verified"] == len(case["steps"])
    assert data["actions_verified"] == sum(not s["read_only"] for s in case["steps"])
    assert data["approved_decisions"] == sum(a["status"] == "approved" for a in timeline["approvals"])
    assert data["tool_calls"] == len(timeline["invocations"])
    assert data["verification_passes"] == sum(v["passed"] for v in timeline["verifications"])
    assert data["recovery_steps_verified"] == 0


def test_recovery_only_counted_after_verified_not_when_proposed(client: TestClient) -> None:
    case = start_repair(client)
    client.put("/api/demo/faults", json={"repair_slot_taken": True})
    case = approve_all(client, case)
    before = client.get("/api/insights").json()
    assert any(s["status"] == "failed" for s in case["steps"])
    expected = sum(bool(s["recovery_of"]) and s["status"] == "verified" for s in case["steps"])
    assert before["recovery_steps_verified"] == expected
    assert not any(s["tool"] == "repair.submit_request" and s["status"] == "verified" for s in case["steps"])
    case = approve_all(client, case)
    after = client.get("/api/insights").json()
    assert after["recovery_steps_verified"] > before["recovery_steps_verified"]
    assert after["steps_verified"] == sum(s["status"] == "verified" for s in case["steps"])


def test_insights_respect_coordinator_authentication(tmp_path) -> None:  # type: ignore[no-untyped-def]
    with make_client(tmp_path, token="test-access") as client:
        assert client.get("/api/insights").status_code == 401
        assert client.get("/api/insights", headers={"X-Agency-Token": "test-access"}).status_code == 200
