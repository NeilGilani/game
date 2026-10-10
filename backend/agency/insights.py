"""Measured workflow totals for the live demo; never inferred from model claims."""

from typing import Any

from .db import Database, loads, utcnow
from .tools.catalog import TOOLS


def workflow_insights(db: Database) -> dict[str, Any]:
    # One snapshot: a presenter must not see half of a committed workflow update.
    with db.transaction():
        cases = db.query("SELECT status, reasoning FROM cases")
        steps = db.query("SELECT tool, status, recovery_of FROM steps")
        decisions = db.query_one("SELECT COUNT(*) AS n FROM approvals WHERE status = 'approved'")
        calls = db.query_one("SELECT COUNT(*) AS n FROM invocations")
        checks = db.query_one("SELECT COUNT(*) AS n FROM verifications WHERE passed = 1")
    verified = [s for s in steps if s["status"] == "verified"]
    return {
        "server_time": utcnow(),
        "cases_completed": sum(c["status"] == "completed" for c in cases),
        "steps_verified": len(verified),
        "actions_verified": sum(bool(TOOLS.get(s["tool"]) and not TOOLS[s["tool"]].read_only) for s in verified),
        "approved_decisions": decisions["n"] if decisions else 0,
        "recovery_steps_verified": sum(bool(s["recovery_of"]) for s in verified),
        "cloud_plans": sum(loads(c["reasoning"]).get("mode") == "cloud" for c in cases),
        "tool_calls": calls["n"] if calls else 0,
        "verification_passes": checks["n"] if checks else 0,
    }
