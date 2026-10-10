"""References between plan steps.

A step's inputs may point at the verified output of an earlier step instead of a literal:

    {"$ref": "find_slots.recommended.slot_id"}
    {"$fmt": "Wheelchair repair ({0})", "args": ["book_repair.reference"]}

References are resolved by the executor at run time, from stored outputs only, so a step
always acts on what an earlier step actually returned.
"""

from __future__ import annotations

from typing import Any


class RefError(ValueError):
    pass


def is_ref(value: Any) -> bool:
    return isinstance(value, dict) and ("$ref" in value or "$fmt" in value)


def ref_paths(value: Any) -> list[str]:
    """All reference paths used anywhere inside an input value."""
    if isinstance(value, dict):
        if "$ref" in value:
            return [str(value["$ref"])]
        if "$fmt" in value:
            return [str(a) for a in value.get("args", [])]
        out: list[str] = []
        for v in value.values():
            out.extend(ref_paths(v))
        return out
    if isinstance(value, list):
        out = []
        for v in value:
            out.extend(ref_paths(v))
        return out
    return []


def lookup(path: str, outputs: dict[str, Any]) -> Any:
    parts = path.split(".")
    if not parts or parts[0] not in outputs:
        raise RefError(f"'{parts[0] if parts else path}' has no result yet")
    current: Any = outputs[parts[0]]
    for part in parts[1:]:
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            raise RefError(f"'{path}' could not be found in the earlier result")
    if current is None:
        raise RefError(f"'{path}' is empty")
    return current


def resolve(value: Any, outputs: dict[str, Any]) -> Any:
    if isinstance(value, dict):
        if "$ref" in value:
            return lookup(str(value["$ref"]), outputs)
        if "$fmt" in value:
            args = [lookup(str(a), outputs) for a in value.get("args", [])]
            return str(value["$fmt"]).format(*args)
        return {k: resolve(v, outputs) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, outputs) for v in value]
    return value


def rename_root(value: Any, old: str, new: str) -> Any:
    """Point references at a replacement step (used when a recovery step takes over)."""

    def swap(path: str) -> str:
        head, _, rest = path.partition(".")
        return f"{new}.{rest}" if head == old and rest else (new if head == old else path)

    if isinstance(value, dict):
        if "$ref" in value:
            return {**value, "$ref": swap(str(value["$ref"]))}
        if "$fmt" in value:
            return {**value, "args": [swap(str(a)) for a in value.get("args", [])]}
        return {k: rename_root(v, old, new) for k, v in value.items()}
    if isinstance(value, list):
        return [rename_root(v, old, new) for v in value]
    return value
