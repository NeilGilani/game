"""Plan validation. Every plan, from the built-in templates or from a cloud model, passes
through here before it is stored. Problems are collected and reported, never silently fixed,
except for safety normalisations (which only ever make a plan stricter) and finalizers."""

from __future__ import annotations

from typing import Any

from pydantic import TypeAdapter, ValidationError

from ..models import PlanDraft, StepDraft
from ..tools.catalog import ALLOWED_TOOLS_BY_GOAL, ASK_TOOL, TOOLS
from .refs import ref_paths
from .templates import FINALIZERS

ASK_INPUT_KEYS = {"prompt", "options_from", "value_field", "label_template", "description_template"}
ASK_OUTPUT_KEYS = {"value", "label"}
MAX_STEPS = 24


class PlanValidationError(ValueError):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


def _ancestors(step_id: str, by_id: dict[str, StepDraft]) -> set[str]:
    seen: set[str] = set()
    stack = list(by_id[step_id].depends_on)
    while stack:
        current = stack.pop()
        if current in seen or current not in by_id:
            continue
        seen.add(current)
        stack.extend(by_id[current].depends_on)
    return seen


def _check_ref(path: str, step: StepDraft, by_id: dict[str, StepDraft], ancestors: set[str], problems: list[str]) -> None:
    root, _, rest = path.partition(".")
    if root not in by_id:
        problems.append(f"step '{step.id}' refers to unknown step '{root}'")
        return
    if root not in ancestors:
        problems.append(f"step '{step.id}' uses '{root}' without depending on it")
        return
    first = rest.split(".")[0] if rest else ""
    source = by_id[root]
    allowed = ASK_OUTPUT_KEYS if source.tool == ASK_TOOL else set(TOOLS[source.tool].output_keys)
    if first not in allowed:
        problems.append(f"step '{step.id}' refers to '{path}', but '{root}' does not produce '{first}'")


def validate_plan(draft: PlanDraft, goal_type: str) -> tuple[PlanDraft, list[str]]:
    """Return a normalised copy of the plan and notes about any normalisation.

    Raises PlanValidationError listing every problem found.
    """
    problems: list[str] = []
    notes: list[str] = []
    steps = [s.model_copy(deep=True) for s in draft.steps if s.tool not in {"case.verify_outcomes", "case.save_notes"}]
    if len(steps) + len(FINALIZERS) > MAX_STEPS:
        problems.append(f"plan has too many steps (max {MAX_STEPS})")

    allowed_tools = ALLOWED_TOOLS_BY_GOAL.get(goal_type, set())
    by_id: dict[str, StepDraft] = {}
    for index, step in enumerate(steps):
        if step.id in by_id or step.id in {f.id for f in FINALIZERS}:
            problems.append(f"duplicate step id '{step.id}'")
            continue
        for dep in step.depends_on:
            if dep not in by_id:
                problems.append(f"step '{step.id}' depends on '{dep}', which is not an earlier step")
        by_id[step.id] = step
        if step.tool != ASK_TOOL and step.tool not in TOOLS:
            problems.append(f"step '{step.id}' uses unknown tool '{step.tool}'")
            continue
        if step.tool not in allowed_tools:
            problems.append(f"tool '{step.tool}' is not permitted for this kind of goal")
            continue
        ancestors = _ancestors(step.id, by_id)
        for path in ref_paths(step.inputs):
            _check_ref(path, step, by_id, ancestors, problems)

        if step.tool == ASK_TOOL:
            if step.question is None and "options_from" not in step.inputs:
                problems.append(f"question step '{step.id}' has no options")
            extra = set(step.inputs) - ASK_INPUT_KEYS
            if extra:
                problems.append(f"question step '{step.id}' has unexpected inputs {sorted(extra)}")
            continue

        spec = TOOLS[step.tool]
        fields = spec.input_model.model_fields
        extra = set(step.inputs) - set(fields)
        if extra:
            problems.append(f"step '{step.id}' passes unknown inputs {sorted(extra)} to {step.tool}")
        for name, field in fields.items():
            if name not in step.inputs:
                if field.is_required():
                    problems.append(f"step '{step.id}' is missing required input '{name}'")
                continue
            value = step.inputs[name]
            if ref_paths(value):
                continue  # checked above; the resolved value is validated at run time
            try:
                TypeAdapter(field.annotation or object).validate_python(value)
            except ValidationError as exc:
                problems.append(f"step '{step.id}' input '{name}' is invalid: {exc.errors()[0]['msg']}")

        if spec.consequential and step.approval != "required":
            step.approval = "required"
            notes.append(f"'{step.title}' changes something outside AGENCY, so it will always ask for approval.")
        step.timeout_s = min(step.timeout_s, spec.timeout_s) if spec.timeout_s else step.timeout_s
        if index == 0 and step.depends_on:
            problems.append("the first step cannot depend on anything")

    if problems:
        raise PlanValidationError(problems)

    final = steps + [f.model_copy(deep=True) for f in FINALIZERS]
    return PlanDraft(steps=final, rationale=draft.rationale), notes


def tool_catalog_for(goal_type: str) -> list[dict[str, Any]]:
    allowed = ALLOWED_TOOLS_BY_GOAL.get(goal_type, set())
    return [TOOLS[name].catalog_entry() for name in sorted(allowed) if name in TOOLS]
