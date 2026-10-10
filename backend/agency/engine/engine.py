"""The workflow engine: runs a case's plan step by step.

Guarantees, in plain terms:

* Only tools in the registry run, and only those permitted for the case's goal.
* Every input is resolved from stored, verified outputs and validated against the tool's
  typed model before anything is called.
* A consequential action runs only with an approval whose fingerprint matches the exact
  inputs being executed. If anything changes, the user is asked again.
* Each step has one idempotency key. A repeated attempt (retry, restart, timeout) reuses it,
  and an uncertain attempt is reconciled with the service before anything is repeated.
* "Succeeded" (the tool said so) and "verified" (the service's own records agree) are
  separate states. Model-generated text never sets either.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

from pydantic import ValidationError

from ..db import Database
from ..models import (
    STEP_TRANSITIONS,
    TERMINAL_STEP_STATUSES,
    CaseStatus,
    StepDraft,
    StepStatus,
    ToolError,
    ToolResult,
    VerificationCheck,
    VerificationResult,
)
from ..planning.refs import RefError, lookup, rename_root, resolve
from ..services.calendar import DemoCalendar
from ..services.common import INTEGRATIONS, Faults
from ..services.funding import DemoFundingService
from ..services.messaging import DemoMessagingService
from ..services.repair import DemoRepairProvider
from ..tools.base import ActionSummary, ToolContext, ToolSpec, fail, when
from ..tools.catalog import ALLOWED_TOOLS_BY_GOAL, TOOLS
from .store import Store, inputs_hash

log = logging.getLogger("agency.engine")

INTEGRATION_NAMES = {i.key: i.name for i in INTEGRATIONS} | {"agency": "AGENCY"}
FINALIZER_TOOLS = {"case.verify_outcomes", "case.save_notes"}
MAX_RECOVERY_GENERATIONS = 2
BLOCKING_DEP_STATUSES = {
    StepStatus.FAILED,
    StepStatus.REJECTED,
    StepStatus.BLOCKED,
    StepStatus.CANCELLED,
    StepStatus.SKIPPED,
    StepStatus.SUPERSEDED,
}
NON_RECOVERABLE = {"not_permitted", "invalid_inputs", "missing_information", "verification_failed", "draft_changed"}


class EngineError(RuntimeError):
    """A request the engine refuses (shown to the user as-is)."""


def _format_item(template: str, item: dict[str, Any]) -> str:
    def sub(match: re.Match[str]) -> str:
        key, filt = match.group(1), match.group(2)
        value = item.get(key, "")
        if filt == "|when":
            return when(str(value)) if value else ""
        return str(value)

    return re.sub(r"\{(\w+)(\|when)?\}", sub, template)


class Engine:
    def __init__(self, db: Database, *, step_delay_ms: int = 0) -> None:
        self.db = db
        self.store = Store(db)
        self.faults = Faults(db)
        self.repair = DemoRepairProvider(db, self.faults)
        self.funding = DemoFundingService(db, self.faults)
        self.calendar = DemoCalendar(db, self.faults)
        self.messaging = DemoMessagingService(db, self.faults)
        self.step_delay_s = step_delay_ms / 1000
        self.backoff_scale = 1.0
        self.timeout_scale = 1.0
        self._locks: dict[str, asyncio.Lock] = {}

    # ---------------------------------------------------------------------------------
    # helpers
    # ---------------------------------------------------------------------------------
    def profile(self) -> dict[str, Any]:
        row = self.db.query_one("SELECT data FROM profile WHERE id = 1")
        from ..db import loads

        data: dict[str, Any] = loads(row["data"]) if row else {}
        return data

    def context(
        self, case_id: str = "", step: dict[str, Any] | None = None, outputs: dict[str, Any] | None = None
    ) -> ToolContext:
        return ToolContext(
            db=self.db,
            repair=self.repair,
            funding=self.funding,
            calendar=self.calendar,
            messaging=self.messaging,
            profile=self.profile(),
            case_id=case_id,
            step_id=step["id"] if step else "",
            idempotency_key=step["idempotency_key"] if step else "",
            step_outputs=outputs or {},
        )

    def automation_paused(self) -> bool:
        return bool(self.db.get_state("automation_paused", False))

    @staticmethod
    def outputs(steps: list[dict[str, Any]]) -> dict[str, Any]:
        return {s["id"]: s["output"] for s in steps if s["status"] == StepStatus.VERIFIED and s["output"] is not None}

    @staticmethod
    def _recovered(step_id: str, steps: list[dict[str, Any]]) -> bool:
        for s in steps:
            if s["recovery_of"] == step_id:
                if s["status"] == StepStatus.VERIFIED or (s["status"] == StepStatus.FAILED and Engine._recovered(s["id"], steps)):
                    return True
        return False

    def _generation(self, step: dict[str, Any], steps: list[dict[str, Any]]) -> tuple[int, str]:
        by_id = {s["id"]: s for s in steps}
        generation, current = 0, step
        while current["recovery_of"] and current["recovery_of"] in by_id:
            generation += 1
            current = by_id[current["recovery_of"]]
        return generation, current["id"]

    # ---------------------------------------------------------------------------------
    # main loop
    # ---------------------------------------------------------------------------------
    async def run_case(self, case_id: str) -> None:
        lock = self._locks.setdefault(case_id, asyncio.Lock())
        async with lock:
            await self._run(case_id)

    async def _run(self, case_id: str) -> None:
        while True:
            case = self.store.get_case(case_id)
            if case is None or case["status"] in {CaseStatus.COMPLETED, CaseStatus.COMPLETED_PARTIAL, CaseStatus.CANCELLED}:
                return
            if case["status"] == CaseStatus.INTERRUPTED:
                return
            if case["paused"] or self.automation_paused():
                if case["status"] != CaseStatus.PAUSED:
                    self.store.set_case(case_id, status=CaseStatus.PAUSED)
                    self.store.audit(case_id, "paused", "Paused. Nothing will happen until you resume.", actor="system")
                return
            steps = self.store.get_steps(case_id)
            if self._propagate_blocked(case, steps):
                steps = self.store.get_steps(case_id)
            step = self._next_ready(steps)
            if step is None:
                self._settle(case, steps)
                return
            if case["status"] != CaseStatus.RUNNING:
                self.store.set_case(case_id, status=CaseStatus.RUNNING)
            await self._advance(case, step, steps)
            if self.step_delay_s:
                await asyncio.sleep(self.step_delay_s)

    def _deps_done(self, step: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> bool:
        return all(by_id.get(d, {}).get("status") == StepStatus.VERIFIED for d in step["depends_on"])

    def _preconditions_met(self, step: dict[str, Any], steps: list[dict[str, Any]]) -> bool:
        for pre in step["preconditions"]:
            if pre.get("type") == "all_others_settled":
                for other in steps:
                    if other["id"] == step["id"]:
                        continue
                    if any(p.get("type") == "all_others_settled" for p in other["preconditions"]):
                        continue
                    if other["status"] not in TERMINAL_STEP_STATUSES:
                        return False
        return True

    def _next_ready(self, steps: list[dict[str, Any]]) -> dict[str, Any] | None:
        by_id = {s["id"]: s for s in steps}
        for step in steps:
            if step["status"] not in {StepStatus.PENDING, StepStatus.APPROVED, StepStatus.SUCCEEDED}:
                continue
            if self._deps_done(step, by_id) and self._preconditions_met(step, steps):
                return step
        return None

    def _propagate_blocked(self, case: dict[str, Any], steps: list[dict[str, Any]]) -> bool:
        by_id = {s["id"]: s for s in steps}
        changed = False
        progress = True
        while progress:
            progress = False
            for step in steps:
                if step["status"] not in {StepStatus.PENDING, StepStatus.AWAITING_APPROVAL, StepStatus.WAITING_INPUT}:
                    continue
                bad = [by_id[d] for d in step["depends_on"] if d in by_id and by_id[d]["status"] in BLOCKING_DEP_STATUSES]
                if not bad:
                    continue
                reason = f"Not done because “{bad[0]['title']}” didn't happen."
                if step["status"] == StepStatus.AWAITING_APPROVAL:
                    pending = self.store.latest_approval(case["id"], step["id"])
                    if pending and pending["status"] == "pending":
                        self.store.decide_approval(pending["id"], "withdrawn", "No longer needed")
                updated = self.store.update_step(
                    case["id"], step["id"], status=StepStatus.BLOCKED, error={"code": "dependency", "message": reason}
                )
                by_id[step["id"]] = updated
                step["status"] = updated["status"]
                self.store.audit(case["id"], "step_blocked", f"{step['title']}: {reason}", step_id=step["id"])
                changed = progress = True
        return changed

    def _settle(self, case: dict[str, Any], steps: list[dict[str, Any]]) -> None:
        statuses = {s["status"] for s in steps}
        if StepStatus.WAITING_INPUT in statuses:
            new = CaseStatus.WAITING_INPUT
        elif StepStatus.AWAITING_APPROVAL in statuses:
            new = CaseStatus.WAITING_APPROVAL
        elif all(s["status"] in TERMINAL_STEP_STATUSES for s in steps):
            clean = all(
                s["status"] in {StepStatus.VERIFIED, StepStatus.SKIPPED}
                or (s["status"] == StepStatus.FAILED and self._recovered(s["id"], steps))
                for s in steps
            )
            new = CaseStatus.COMPLETED if clean else CaseStatus.COMPLETED_PARTIAL
            if case["status"] != new:
                from ..db import utcnow

                self.store.set_case(case["id"], status=new, completed_at=utcnow())
                self.store.audit(
                    case["id"],
                    "case_completed",
                    "Case finished. Every completed action was verified."
                    if clean
                    else "Case finished, but some parts were not done. See the summary.",
                    actor="system",
                )
            return
        else:
            new = CaseStatus.NEEDS_ATTENTION
        if case["status"] != new:
            self.store.set_case(case["id"], status=new)
            if new == CaseStatus.NEEDS_ATTENTION:
                self.store.audit(
                    case["id"], "needs_attention", "I can't continue on my own. Please review this case.", actor="system"
                )

    # ---------------------------------------------------------------------------------
    # one step
    # ---------------------------------------------------------------------------------
    async def _advance(self, case: dict[str, Any], step: dict[str, Any], steps: list[dict[str, Any]]) -> None:
        outputs = self.outputs(steps)
        if step["kind"] == "ask":
            self._ask(case, step, outputs)
            return
        if step["tool"] in FINALIZER_TOOLS:
            await self._finalize(case, step, steps)
            return
        spec = TOOLS.get(step["tool"])
        if spec is None or step["tool"] not in ALLOWED_TOOLS_BY_GOAL.get(case["goal_type"], set()):
            self.store.audit(
                case["id"],
                "action_refused",
                f"Refused “{step['tool']}”: it is not on the list of permitted actions.",
                actor="system",
                step_id=step["id"],
            )
            self.store.update_step(
                case["id"],
                step["id"],
                status=StepStatus.FAILED,
                error={"code": "not_permitted", "message": "This action is not permitted."},
            )
            return

        if step["status"] == StepStatus.SUCCEEDED:
            # A restart happened between the action and its verification.
            done = [i for i in self.store.invocations(case["id"], step["id"]) if i["status"] in {"succeeded", "reconciled"}]
            if done:
                parsed = spec.input_model.model_validate(done[-1]["inputs"])
                await self._verify(case, step, spec, parsed, ToolResult(**done[-1]["result"]), done[-1]["id"], outputs)
                return

        try:
            resolved = resolve(step["inputs"], outputs)
        except RefError as exc:
            self._fail(case, step, ToolError(code="missing_information", message=f"Missing information: {exc}"))
            return
        try:
            parsed = spec.input_model.model_validate(resolved)
        except ValidationError as exc:
            first = exc.errors()[0]
            self._fail(
                case,
                step,
                ToolError(
                    code="invalid_inputs", message=f"Invalid input {'.'.join(str(x) for x in first['loc'])}: {first['msg']}"
                ),
            )
            return
        canonical = parsed.model_dump(mode="json")
        fingerprint = inputs_hash(canonical)

        if spec.consequential or step["approval"] == "required":
            approval = self.store.latest_approval(case["id"], step["id"])
            if approval is None or approval["status"] != "approved" or approval["inputs_hash"] != fingerprint:
                if approval and approval["status"] == "approved" and approval["inputs_hash"] != fingerprint:
                    self.store.audit(
                        case["id"],
                        "approval_stale",
                        "The details changed after you approved, so I need to ask again.",
                        step_id=step["id"],
                    )
                self._request_approval(case, step, spec, parsed, fingerprint, outputs)
                return

        await self._execute(case, step, spec, parsed, canonical, outputs)

    def _ask(self, case: dict[str, Any], step: dict[str, Any], outputs: dict[str, Any]) -> None:
        question = step["question"]
        if question is None:
            inputs = step["inputs"]
            try:
                items = lookup(str(inputs["options_from"]), outputs)
            except RefError as exc:
                self._fail(case, step, ToolError(code="missing_information", message=str(exc)))
                return
            value_field = inputs.get("value_field", "id")
            options = [
                {
                    "value": str(item.get(value_field)),
                    "label": _format_item(inputs.get("label_template", "{" + value_field + "}"), item)[:120],
                    "description": _format_item(inputs.get("description_template", ""), item)[:240],
                }
                for item in list(items)[:6]
                if isinstance(item, dict)
            ]
            question = {"key": step["id"], "prompt": inputs.get("prompt", step["title"]), "options": options}
        self.store.update_step(case["id"], step["id"], status=StepStatus.WAITING_INPUT, question=question)
        self.store.audit(case["id"], "question_asked", f"I need to know: {question['prompt']}", step_id=step["id"])

    def _request_approval(
        self, case: dict[str, Any], step: dict[str, Any], spec: ToolSpec, parsed: Any, fingerprint: str, outputs: dict[str, Any]
    ) -> None:
        ctx = self.context(case["id"], step, outputs)
        if spec.describe:
            summary = spec.describe(ctx, parsed)
        else:
            summary = ActionSummary(
                headline=step["title"],
                details=[(k.replace("_", " ").capitalize(), str(v)) for k, v in parsed.model_dump().items()],
                effect=step["description"],
                if_rejected="This step is not done.",
                reversible=spec.reversible or "Ask the provider",
            )
        details = summary.as_dict() | {
            "tool": spec.name,
            "integration": INTEGRATION_NAMES.get(spec.integration, spec.integration),
            "simulated": True,
            "step_title": step["title"],
            "recovery_context": step["recovery_context"],
        }
        previous = self.store.latest_approval(case["id"], step["id"])
        if previous and previous["status"] == "pending":
            self.store.decide_approval(previous["id"], "superseded", "Replaced by an updated request")
        self.store.create_approval(
            case_id=case["id"], step_id=step["id"], summary=summary.headline, details=details, hash_=fingerprint
        )
        if step["status"] != StepStatus.AWAITING_APPROVAL:
            self.store.update_step(case["id"], step["id"], status=StepStatus.AWAITING_APPROVAL)
        self.store.audit(case["id"], "approval_requested", f"Waiting for your approval: {summary.headline}", step_id=step["id"])

    async def _execute(
        self,
        case: dict[str, Any],
        step: dict[str, Any],
        spec: ToolSpec,
        parsed: Any,
        canonical: dict[str, Any],
        outputs: dict[str, Any],
    ) -> None:
        ctx = self.context(case["id"], step, outputs)
        service = INTEGRATION_NAMES.get(spec.integration, spec.integration)
        history = self.store.invocations(case["id"], step["id"])
        result: ToolResult | None = None
        inv_id: str | None = None

        # 1. Never repeat something that already succeeded.
        done = [i for i in history if i["status"] in {"succeeded", "reconciled"}]
        if done:
            result = ToolResult(**done[-1]["result"])
            inv_id = done[-1]["id"]
            self.store.audit(
                case["id"],
                "already_done",
                f"{step['title']}: this already went through earlier. Not repeating it.",
                step_id=step["id"],
            )
        # 2. An earlier attempt has an unknown outcome: ask the service before trying again.
        elif any(i["status"] in {"timeout", "interrupted", "started"} for i in history) and spec.lookup:
            found = spec.lookup(ctx, parsed)
            if found:
                inv_id = self._record_reconciled(case, step, canonical, found, attempt=step["attempts"])
                result = found
                self.store.audit(
                    case["id"],
                    "reconciled",
                    f"Checked with {service}: an earlier attempt did go through. Not repeating it.",
                    step_id=step["id"],
                )

        attempt = step["attempts"]
        max_attempts = int(step["retry"].get("max_attempts", 2))
        backoff_ms = int(step["retry"].get("backoff_ms", 400))
        while result is None:
            attempt += 1
            self.store.update_step(case["id"], step["id"], status=StepStatus.RUNNING, attempts=attempt)
            inv_id = self.store.start_invocation(
                case_id=case["id"],
                step_id=step["id"],
                tool=spec.name,
                inputs=canonical,
                key=step["idempotency_key"],
                attempt=attempt,
            )
            called = (
                f"{spec.title}."
                if spec.integration == "agency"
                else f"Contacting {service}: {spec.title[0].lower()}{spec.title[1:]}."
            )
            self.store.audit(
                case["id"],
                "tool_called",
                called,
                step_id=step["id"],
                data={"tool": spec.name, "attempt": attempt, "invocation": inv_id},
            )
            started = time.monotonic()
            timeout = max(0.05, step["timeout_s"] * self.timeout_scale)
            try:
                outcome = await asyncio.wait_for(spec.run(ctx, parsed), timeout=timeout)
                status = "succeeded" if outcome.ok else "failed"
            except TimeoutError:
                self.store.finish_invocation(
                    inv_id,
                    status="timeout",
                    result=None,
                    error={"code": "timeout", "message": f"No answer after {step['timeout_s']:.0f}s"},
                    duration_ms=int((time.monotonic() - started) * 1000),
                )
                self.store.audit(
                    case["id"],
                    "tool_timeout",
                    f"{service} didn't answer in time. Checking whether it went through before trying again.",
                    step_id=step["id"],
                )
                found = spec.lookup(ctx, parsed) if spec.lookup else None
                if found:
                    inv_id = self._record_reconciled(case, step, canonical, found, attempt=attempt)
                    self.store.audit(
                        case["id"],
                        "reconciled",
                        f"Checked with {service}: it did go through. I will not repeat it.",
                        step_id=step["id"],
                    )
                    result = found
                    break
                outcome = fail("timeout", f"{service} did not answer in time.", retryable=True)
                status = "timeout"
            except Exception as exc:  # a bug or an unexpected integration failure
                log.exception("tool %s crashed", spec.name)
                outcome = fail("tool_error", f"Unexpected error in {spec.title}: {type(exc).__name__}")
                status = "error"
            if status != "timeout":
                self.store.finish_invocation(
                    inv_id,
                    status=status,
                    result=outcome.model_dump(mode="json") if outcome.ok else None,
                    error=outcome.error.model_dump() if outcome.error else None,
                    duration_ms=int((time.monotonic() - started) * 1000),
                )
            if outcome.ok:
                result = outcome
                break
            assert outcome.error is not None
            if outcome.error.retryable and attempt < max_attempts:
                self.store.update_step(case["id"], step["id"], status=StepStatus.RETRYING, error=outcome.error.model_dump())
                self.store.audit(
                    case["id"],
                    "tool_retry",
                    f"{outcome.error.message} Trying again (attempt {attempt + 1} of {max_attempts}).",
                    step_id=step["id"],
                )
                await asyncio.sleep(backoff_ms * attempt / 1000 * self.backoff_scale)
                continue
            result = outcome
            break

        assert result is not None
        if not result.ok:
            assert result.error is not None
            self._fail(case, self.store.get_step(case["id"], step["id"]) or step, result.error, attempted=True)
            await self._plan_recovery(case, step["id"], result.error)
            return

        current = self.store.get_step(case["id"], step["id"])
        assert current is not None
        if current["status"] in {StepStatus.PENDING, StepStatus.APPROVED}:
            self.store.update_step(case["id"], step["id"], status=StepStatus.RUNNING)
        self.store.update_step(
            case["id"],
            step["id"],
            status=StepStatus.SUCCEEDED,
            output=result.data,
            evidence=result.evidence | {"replayed": result.replayed},
            error=None,
        )
        self.store.audit(
            case["id"],
            "tool_succeeded",
            result.message,
            step_id=step["id"],
            data={"evidence": result.evidence, "invocation": inv_id},
        )
        await self._verify(case, step, spec, parsed, result, inv_id, outputs)

    def _record_reconciled(
        self, case: dict[str, Any], step: dict[str, Any], canonical: dict[str, Any], found: ToolResult, *, attempt: int
    ) -> str:
        inv_id = self.store.start_invocation(
            case_id=case["id"],
            step_id=step["id"],
            tool=step["tool"],
            inputs=canonical,
            key=step["idempotency_key"],
            attempt=attempt,
        )
        self.store.finish_invocation(inv_id, status="reconciled", result=found.model_dump(mode="json"), error=None, duration_ms=0)
        return inv_id

    async def _verify(
        self,
        case: dict[str, Any],
        step: dict[str, Any],
        spec: ToolSpec,
        parsed: Any,
        result: ToolResult,
        inv_id: str | None,
        outputs: dict[str, Any],
    ) -> None:
        current = self.store.get_step(case["id"], step["id"])
        assert current is not None
        evidence = current["evidence"] or {}
        if spec.verify is None:
            self.store.update_step(
                case["id"],
                step["id"],
                status=StepStatus.VERIFIED,
                evidence=evidence | {"verification": "Read-only step: nothing was changed."},
            )
            return
        ctx = self.context(case["id"], step, outputs)
        try:
            verdict = spec.verify(ctx, parsed, result)
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("verification crashed")
            verdict = VerificationResult(passed=False, checks=[], summary=f"Could not check: {type(exc).__name__}")
        self.store.record_verification(case_id=case["id"], step_id=step["id"], invocation_id=inv_id, result=verdict)
        checks = [c.model_dump(mode="json") for c in verdict.checks]
        if verdict.passed:
            self.store.update_step(
                case["id"],
                step["id"],
                status=StepStatus.VERIFIED,
                evidence=evidence | {"verification": verdict.summary, "checks": checks},
            )
            self.store.audit(case["id"], "verified", verdict.summary, step_id=step["id"], data={"checks": checks})
        else:
            self.store.update_step(
                case["id"],
                step["id"],
                status=StepStatus.FAILED,
                evidence=evidence | {"verification": verdict.summary, "checks": checks},
                error={"code": "verification_failed", "message": verdict.summary},
            )
            self.store.audit(case["id"], "verification_failed", verdict.summary, step_id=step["id"], data={"checks": checks})

    def _fail(self, case: dict[str, Any], step: dict[str, Any], error: ToolError, *, attempted: bool = False) -> None:
        current = self.store.get_step(case["id"], step["id"]) or step
        status = StepStatus(current["status"])
        if status == StepStatus.RETRYING or status == StepStatus.RUNNING or status in {StepStatus.PENDING, StepStatus.APPROVED}:
            self.store.update_step(case["id"], step["id"], status=StepStatus.FAILED, error=error.model_dump())
        self.store.audit(
            case["id"],
            "step_failed",
            f"{step['title']} failed: {error.message}",
            step_id=step["id"],
            data={"code": error.code, "attempted": attempted},
        )

    # ---------------------------------------------------------------------------------
    # recovery
    # ---------------------------------------------------------------------------------
    async def _plan_recovery(self, case: dict[str, Any], step_id: str, error: ToolError) -> None:
        steps = self.store.get_steps(case["id"])
        failed = next(s for s in steps if s["id"] == step_id)
        generation, root_id = self._generation(failed, steps)
        if error.code in NON_RECOVERABLE or generation >= MAX_RECOVERY_GENERATIONS:
            self.store.audit(
                case["id"],
                "recovery_unavailable",
                "I can't fix this automatically, so I stopped this part of the plan. Anything that depended on it will not happen.",
                step_id=step_id,
            )
            return
        n = generation + 1
        spec = TOOLS[failed["tool"]]
        service = INTEGRATION_NAMES.get(spec.integration, spec.integration)
        last_inputs: dict[str, Any] = next((i["inputs"] for i in reversed(self.store.invocations(case["id"], step_id))), {})
        drafts: list[StepDraft] = []

        if failed["tool"] == "repair.submit_request" and error.code == "slot_unavailable":
            nothing_booked = self.repair.find_submission(failed["idempotency_key"]) is None
            slot = self.repair.get_slot(str(last_inputs.get("slot_id", ""))) or {}
            finder = next((s for s in steps if s["tool"] == "repair.find_slots" and not s["recovery_context"]), None)
            if finder is None:
                return
            find_id = f"{finder['id']}_r{n}"
            drafts.append(
                StepDraft(
                    id=find_id,
                    title="Look for another repair time",
                    description="The time you approved was taken. Ask the provider for the next open times before the deadline.",
                    tool="repair.find_slots",
                    inputs=finder["inputs"],
                    depends_on=list(finder["depends_on"]),
                )
            )
            drafts.append(
                StepDraft(
                    id=f"{root_id}_r{n}",
                    title="Book a different repair time",
                    description="Book the next open time instead, once you approve.",
                    tool="repair.submit_request",
                    inputs={"request_id": failed["inputs"]["request_id"], "slot_id": {"$ref": f"{find_id}.recommended.slot_id"}},
                    depends_on=[find_id] + [d for d in failed["depends_on"] if d != finder["id"]],
                    approval="required",
                    timeout_s=failed["timeout_s"],
                )
            )
            context = {
                "failed_step": step_id,
                "failed_title": failed["title"],
                "reason": f"The time you approved ({when(slot.get('starts_at'))}) was taken by someone else just before the booking went through.",
                "what_happened": "I checked with the provider: nothing was booked and nothing was charged."
                if nothing_booked
                else "The provider's records are unclear. Please check before booking again.",
                "verified_nothing_happened": nothing_booked,
            }
        else:
            lookup_note = ""
            if spec.lookup:
                ctx = self.context(case["id"], failed, self.outputs(steps))
                try:
                    parsed = spec.input_model.model_validate(last_inputs)
                    lookup_note = (
                        "I checked: it did not go through."
                        if spec.lookup(ctx, parsed) is None
                        else "The service shows it may have gone through. Please check."
                    )
                except ValidationError:
                    lookup_note = ""
            drafts.append(
                StepDraft(
                    id=f"{root_id}_r{n}",
                    title=f"Try again: {failed['title'][0].lower()}{failed['title'][1:]}",
                    description=f"Try this step again, once you approve. {service} reported a problem last time.",
                    tool=failed["tool"],
                    inputs=failed["inputs"],
                    depends_on=list(failed["depends_on"]),
                    approval="required",
                    optional=failed["optional"],
                    timeout_s=failed["timeout_s"],
                )
            )
            context = {
                "failed_step": step_id,
                "failed_title": failed["title"],
                "reason": f"{service}: {error.message} I tried {failed['attempts']} time{'s' if failed['attempts'] != 1 else ''}.",
                "what_happened": lookup_note or "Nothing was changed.",
                "verified_nothing_happened": lookup_note.startswith("I checked"),
            }

        replacement = drafts[-1].id
        existing_ids = {s["id"] for s in steps}
        if any(d.id in existing_ids for d in drafts):
            return
        insert_at = failed["position"] + 1
        self.store.shift_positions(case["id"], insert_at, len(drafts))
        version = case["plan_version"] + 1
        if len(drafts) > 1:
            self.store.insert_steps(
                case["id"],
                drafts[:-1],
                plan_version=version,
                start_position=insert_at,
                recovery_context={"part_of_recovery_for": step_id},
            )
        self.store.insert_steps(
            case["id"],
            drafts[-1:],
            plan_version=version,
            start_position=insert_at + len(drafts) - 1,
            recovery_of=step_id,
            recovery_context=context,
        )
        for other in steps:
            if step_id in other["depends_on"] and other["status"] not in TERMINAL_STEP_STATUSES:
                deps = [replacement if d == step_id else d for d in other["depends_on"]]
                self.store.update_step(
                    case["id"], other["id"], depends_on=deps, inputs=rename_root(other["inputs"], step_id, replacement)
                )
        self.store.set_case(case["id"], plan_version=version)
        self.store.audit(
            case["id"],
            "recovery_planned",
            f"{context['reason']} {context['what_happened']} I added: "
            + "; ".join(d.title for d in drafts)
            + ". I'll ask before doing anything that matters.",
            step_id=step_id,
            data={"new_steps": [d.id for d in drafts]},
        )

    # ---------------------------------------------------------------------------------
    # finalizers
    # ---------------------------------------------------------------------------------
    async def _finalize(self, case: dict[str, Any], step: dict[str, Any], steps: list[dict[str, Any]]) -> None:
        self.store.update_step(case["id"], step["id"], status=StepStatus.RUNNING, attempts=step["attempts"] + 1)
        inv_id = self.store.start_invocation(
            case_id=case["id"],
            step_id=step["id"],
            tool=step["tool"],
            inputs={},
            key=step["idempotency_key"],
            attempt=step["attempts"] + 1,
        )
        if step["tool"] == "case.verify_outcomes":
            data, message = self._verify_outcomes(case, steps)
        else:
            data, message = self._save_notes(case, steps)
        self.store.finish_invocation(inv_id, status="succeeded", result={"ok": True, "data": data}, error=None, duration_ms=0)
        self.store.update_step(
            case["id"], step["id"], status=StepStatus.SUCCEEDED, output=data, evidence={"integration": "AGENCY case store"}
        )
        self.store.update_step(case["id"], step["id"], status=StepStatus.VERIFIED)
        self.store.audit(case["id"], "tool_succeeded", message, step_id=step["id"])

    def _outcome_line(self, step: dict[str, Any]) -> str:
        out = step["output"] or {}
        tool = step["tool"]
        if tool == "repair.submit_request":
            return f"Repair booked for {when(out.get('starts_at'))} with {out.get('technician')} (ref {out.get('reference')})."
        if tool == "funding.submit":
            return f"Request received by the demo office (ref {out.get('reference')}). No decision has been made yet."
        if tool == "calendar.add_event":
            return f"On your calendar: {out.get('title')} at {when(out.get('starts_at'))}."
        if tool == "calendar.reschedule":
            return f"“{out.get('title')}” moved to {when(out.get('starts_at'))}."
        if tool == "messaging.send":
            return "Message recorded as delivered by the Demo Messaging Service (simulated; nobody was contacted)."
        return f"{step['title']}: done."

    def _verify_outcomes(self, case: dict[str, Any], steps: list[dict[str, Any]]) -> tuple[dict[str, Any], str]:
        outcomes: list[dict[str, Any]] = []
        pending: list[dict[str, Any]] = []
        outputs = self.outputs(steps)
        for s in steps:
            if s["tool"] in FINALIZER_TOOLS or s["kind"] == "ask":
                continue
            spec = TOOLS.get(s["tool"])
            if spec is None:
                continue
            if s["status"] == StepStatus.VERIFIED and spec.verify and (spec.consequential or s["tool"] == "calendar.add_event"):
                done = [i for i in self.store.invocations(case["id"], s["id"]) if i["status"] in {"succeeded", "reconciled"}]
                if not done:
                    continue
                parsed = spec.input_model.model_validate(done[-1]["inputs"])
                verdict = spec.verify(self.context(case["id"], s, outputs), parsed, ToolResult(**done[-1]["result"]))
                self.store.record_verification(case_id=case["id"], step_id=s["id"], invocation_id=done[-1]["id"], result=verdict)
                outcomes.append(
                    {
                        "step_id": s["id"],
                        "title": s["title"],
                        "line": self._outcome_line(s),
                        "verified": verdict.passed,
                        "checks": [c.model_dump(mode="json") for c in verdict.checks],
                        "reference": (s["output"] or {}).get("reference"),
                        "integration": INTEGRATION_NAMES.get(spec.integration),
                        "simulated": True,
                    }
                )
            elif s["status"] in {StepStatus.FAILED} and self._recovered(s["id"], steps):
                continue
            elif s["status"] in {
                StepStatus.FAILED,
                StepStatus.REJECTED,
                StepStatus.BLOCKED,
                StepStatus.SKIPPED,
                StepStatus.CANCELLED,
            }:
                reason = {
                    StepStatus.FAILED: "failed",
                    StepStatus.REJECTED: "you declined it",
                    StepStatus.BLOCKED: "it depended on something that didn't happen",
                    StepStatus.SKIPPED: "skipped",
                    StepStatus.CANCELLED: "cancelled",
                }[StepStatus(s["status"])]
                pending.append({"step_id": s["id"], "title": s["title"], "reason": reason})
        for s in steps:
            out = s["output"] or {}
            if s["tool"] == "funding.check_requirements" and s["status"] == StepStatus.VERIFIED:
                for missing in out.get("missing", []):
                    pending.append(
                        {"step_id": s["id"], "title": f"Still needed for funding: {missing['label']}", "reason": "follow-up"}
                    )
            if s["tool"] == "funding.submit" and s["status"] == StepStatus.VERIFIED:
                pending.append(
                    {
                        "step_id": s["id"],
                        "title": f"Decision on {out.get('reference')} is up to the demo office",
                        "reason": "waiting",
                    }
                )
        all_verified = all(o["verified"] for o in outcomes)
        message = (
            f"Re-checked {len(outcomes)} completed action{'s' if len(outcomes) != 1 else ''} against each service's records: "
            + ("all confirmed." if all_verified else "some could not be confirmed.")
        )
        return {"outcomes": outcomes, "pending": pending, "all_verified": all_verified}, message

    def _save_notes(self, case: dict[str, Any], steps: list[dict[str, Any]]) -> tuple[dict[str, Any], str]:
        verify_step = next((s for s in steps if s["tool"] == "case.verify_outcomes"), None)
        data = (verify_step or {}).get("output") or {"outcomes": [], "pending": []}
        follow_ups = [p["title"] for p in data["pending"] if p["reason"] in {"follow-up", "waiting"}]
        not_done = [f"{p['title']} ({p['reason']})" for p in data["pending"] if p["reason"] not in {"follow-up", "waiting"}]
        summary = {
            "done": [o["line"] for o in data["outcomes"] if o["verified"]],
            "unconfirmed": [o["line"] for o in data["outcomes"] if not o["verified"]],
            "not_done": not_done,
            "follow_ups": follow_ups,
            "simulated_note": "All actions used demonstration services. No real company, office or person was contacted.",
        }
        self.store.set_case(case["id"], summary=summary)
        return {"summary": summary, "follow_ups": follow_ups}, "Saved the case summary and follow-ups."

    # ---------------------------------------------------------------------------------
    # user decisions
    # ---------------------------------------------------------------------------------
    def answer(self, case_id: str, step_id: str, value: str) -> dict[str, Any]:
        step = self.store.get_step(case_id, step_id)
        if not step or step["status"] != StepStatus.WAITING_INPUT:
            raise EngineError("That question isn't waiting for an answer.")
        options = {o["value"]: o for o in (step["question"] or {}).get("options", [])}
        if value not in options:
            raise EngineError("Please choose one of the listed answers.")
        option = options[value]
        self.store.update_step(
            case_id,
            step_id,
            status=StepStatus.VERIFIED,
            output={"value": value, "label": option["label"]},
            evidence={"source": "your answer"},
        )
        self.store.audit(case_id, "answered", f"You answered: {option['label']}", actor="user", step_id=step_id)
        return self.store.get_step(case_id, step_id) or step

    def decide(self, approval_id: str, decision: str, note: str | None = None) -> dict[str, Any]:
        approval = self.store.get_approval(approval_id)
        if not approval:
            raise EngineError("Approval request not found.")
        if approval["status"] != "pending":
            raise EngineError(f"This request was already {approval['status']}.")
        step = self.store.get_step(approval["case_id"], approval["step_id"])
        if not step or step["status"] != StepStatus.AWAITING_APPROVAL:
            raise EngineError("This action is no longer waiting for approval.")
        if decision == "approve":
            self.store.decide_approval(approval_id, "approved", note)
            self.store.update_step(approval["case_id"], step["id"], status=StepStatus.APPROVED)
            self.store.audit(
                approval["case_id"], "approved", f"You approved: {approval['summary']}", actor="user", step_id=step["id"]
            )
        else:
            self.store.decide_approval(approval_id, "rejected", note)
            self.store.update_step(
                approval["case_id"],
                step["id"],
                status=StepStatus.REJECTED,
                error={"code": "rejected", "message": "You declined this action."},
            )
            self.store.audit(
                approval["case_id"],
                "rejected",
                f"You declined: {approval['summary']}. It will not happen.",
                actor="user",
                step_id=step["id"],
            )
        updated = self.store.get_approval(approval_id)
        assert updated is not None
        return updated

    def edit(self, approval_id: str, edits: dict[str, Any]) -> dict[str, Any]:
        approval = self.store.get_approval(approval_id)
        if not approval or approval["status"] != "pending":
            raise EngineError("Only a pending approval can be changed.")
        case = self.store.get_case(approval["case_id"])
        step = self.store.get_step(approval["case_id"], approval["step_id"])
        assert case and step
        spec = TOOLS[step["tool"]]
        if spec.apply_edit is None:
            raise EngineError("This action has nothing to change.")
        steps = self.store.get_steps(case["id"])
        outputs = self.outputs(steps)
        try:
            current = spec.input_model.model_validate(resolve(step["inputs"], outputs))
            new_inputs = spec.apply_edit(self.context(case["id"], step, outputs), current, edits)
            parsed = spec.input_model.model_validate(new_inputs)
        except (ValueError, RefError) as exc:
            raise EngineError(str(exc)) from exc
        self.store.update_step(case["id"], step["id"], inputs=parsed.model_dump(mode="json"))
        self.store.audit(
            case["id"],
            "edited",
            f"You changed the details of: {step['title']}",
            actor="user",
            step_id=step["id"],
            data={"fields": sorted(edits)},
        )
        fresh = self.store.get_step(case["id"], step["id"])
        assert fresh is not None
        self._request_approval(case, fresh, spec, parsed, inputs_hash(parsed.model_dump(mode="json")), outputs)
        latest = self.store.latest_approval(case["id"], step["id"])
        assert latest is not None
        return latest

    def skip(self, case_id: str, step_id: str) -> None:
        step = self.store.get_step(case_id, step_id)
        if not step:
            raise EngineError("Step not found.")
        if not step["optional"]:
            raise EngineError("This step is required for the goal. You can cancel the case instead.")
        if step["status"] not in {StepStatus.PENDING, StepStatus.WAITING_INPUT, StepStatus.AWAITING_APPROVAL}:
            raise EngineError("This step can no longer be skipped.")
        if step["status"] == StepStatus.AWAITING_APPROVAL:
            pending = self.store.latest_approval(case_id, step_id)
            if pending and pending["status"] == "pending":
                self.store.decide_approval(pending["id"], "withdrawn", "Step skipped")
            self.store.update_step(
                case_id, step_id, status=StepStatus.REJECTED, error={"code": "skipped", "message": "You skipped this step."}
            )
        else:
            self.store.update_step(case_id, step_id, status=StepStatus.SKIPPED)
        self.store.audit(case_id, "skipped", f"You skipped: {step['title']}", actor="user", step_id=step_id)

    def pause_case(self, case_id: str) -> None:
        self.store.set_case(case_id, paused=True, status=CaseStatus.PAUSED)
        self.store.audit(case_id, "paused", "You paused this case. Nothing will happen until you resume.", actor="user")

    def resume_case(self, case_id: str) -> None:
        case = self.store.get_case(case_id)
        if not case:
            raise EngineError("Case not found.")
        if case["status"] in {CaseStatus.COMPLETED, CaseStatus.COMPLETED_PARTIAL, CaseStatus.CANCELLED}:
            raise EngineError("This case is finished.")
        self.store.set_case(case_id, paused=False, status=CaseStatus.RUNNING)
        self.store.audit(
            case_id, "resumed", "Resumed. Picking up where we left off; finished steps will not be repeated.", actor="user"
        )

    def cancel_case(self, case_id: str) -> None:
        for step in self.store.get_steps(case_id):
            if step["status"] in TERMINAL_STEP_STATUSES or step["status"] == StepStatus.SUCCEEDED:
                continue
            if step["status"] == StepStatus.AWAITING_APPROVAL:
                pending = self.store.latest_approval(case_id, step["id"])
                if pending and pending["status"] == "pending":
                    self.store.decide_approval(pending["id"], "withdrawn", "Case cancelled")
            if StepStatus.CANCELLED in STEP_TRANSITIONS[StepStatus(step["status"])]:
                self.store.update_step(case_id, step["id"], status=StepStatus.CANCELLED)
        from ..db import utcnow

        self.store.set_case(case_id, status=CaseStatus.CANCELLED, completed_at=utcnow())
        self.store.audit(
            case_id,
            "cancelled",
            "You cancelled this case. Nothing else will happen. Completed actions stay as they are.",
            actor="user",
        )

    def set_automation_paused(self, paused: bool) -> list[str]:
        self.db.set_state("automation_paused", paused)
        self.store.audit(
            None,
            "automation_paused" if paused else "automation_resumed",
            "All automation stopped." if paused else "Automation resumed.",
            actor="user",
        )
        affected: list[str] = []
        if not paused:
            for case in self.store.list_cases():
                if case["status"] == CaseStatus.PAUSED and not case["paused"]:
                    self.store.set_case(case["id"], status=CaseStatus.RUNNING)
                    affected.append(case["id"])
        return affected

    # ---------------------------------------------------------------------------------
    # restart recovery
    # ---------------------------------------------------------------------------------
    def reconcile_on_startup(self) -> list[str]:
        """Find work that was in flight when the coordinator stopped, settle what can be known
        from the services, and hold those cases until the user presses Resume."""
        held: list[str] = []
        for case in self.store.list_cases():
            if case["status"] not in {CaseStatus.RUNNING, CaseStatus.PLANNING}:
                continue
            steps = self.store.get_steps(case["id"])
            outputs = self.outputs(steps)
            for step in steps:
                if step["status"] not in {StepStatus.RUNNING, StepStatus.RETRYING}:
                    continue
                self.store.mark_open_invocations(case["id"], step["id"], "interrupted")
                spec = TOOLS.get(step["tool"])
                history = self.store.invocations(case["id"], step["id"])
                found = None
                if spec and spec.lookup and history:
                    try:
                        parsed = spec.input_model.model_validate(history[-1]["inputs"])
                        found = spec.lookup(self.context(case["id"], step, outputs), parsed)
                    except ValidationError:
                        found = None
                if found:
                    self._record_reconciled(case, step, history[-1]["inputs"], found, attempt=step["attempts"])
                    self.store.update_step(
                        case["id"],
                        step["id"],
                        status=StepStatus.SUCCEEDED,
                        output=found.data,
                        evidence=found.evidence | {"replayed": True},
                    )
                    note = "it had gone through"
                else:
                    approved = self.store.latest_approval(case["id"], step["id"])
                    back = StepStatus.APPROVED if approved and approved["status"] == "approved" else StepStatus.PENDING
                    self.store.update_step(case["id"], step["id"], status=back)
                    note = "it had not gone through, so it is safe to try again"
                self.store.audit(
                    case["id"],
                    "interrupted_step",
                    f"“{step['title']}” was in progress when the coordinator stopped. I checked: {note}.",
                    actor="system",
                    step_id=step["id"],
                )
            self.store.set_case(case["id"], status=CaseStatus.INTERRUPTED)
            self.store.audit(
                case["id"],
                "interrupted",
                "The coordinator restarted while this case was running. Nothing will continue until you press Resume.",
                actor="system",
            )
            held.append(case["id"])
        return held

    # ---------------------------------------------------------------------------------
    # plain-language status
    # ---------------------------------------------------------------------------------
    def next_actions(self, case: dict[str, Any], steps: list[dict[str, Any]]) -> list[dict[str, str]]:
        actions: list[dict[str, str]] = []
        for s in steps:
            if s["status"] == StepStatus.WAITING_INPUT:
                actions.append(
                    {
                        "kind": "question",
                        "step_id": s["id"],
                        "text": f"Waiting for your answer: {(s['question'] or {}).get('prompt', s['title'])}",
                    }
                )
            elif s["status"] == StepStatus.AWAITING_APPROVAL:
                actions.append({"kind": "approval", "step_id": s["id"], "text": f"Waiting for your approval: {s['title']}"})
        if case["status"] in {CaseStatus.PAUSED, CaseStatus.INTERRUPTED}:
            actions.insert(0, {"kind": "paused", "step_id": "", "text": "Paused. Press Resume to continue."})
            return actions
        by_id = {s["id"]: s for s in steps}
        upcoming = [
            s
            for s in steps
            if s["status"] in {StepStatus.PENDING, StepStatus.APPROVED}
            and self._deps_done(s, by_id)
            and self._preconditions_met(s, steps)
        ]
        for s in upcoming[:2]:
            actions.append({"kind": "next", "step_id": s["id"], "text": f"Next I will: {s['title'][0].lower()}{s['title'][1:]}"})
        return actions


def summarize_checks(checks: list[VerificationCheck]) -> str:
    return ", ".join(f"{c.name}: {'yes' if c.passed else 'no'}" for c in checks)
