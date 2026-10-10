"""The memory tree's behaviour: recording, suggesting, explaining, and the person's controls."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..db import Database
from .clock import Clock, SystemClock
from .crypto import AesGcmCipher, Cipher, EncryptionUnavailable, KeychainKeyStore, NullCipher
from .learning import (
    DAYPART_HOUR,
    Context,
    EventRecord,
    Occasion,
    Params,
    daypart,
    describe,
    occasions,
    rank,
    usual_of,
)
from .models import (
    POSITIVE_OUTCOMES,
    SECRET_KEY,
    GrantRequest,
    MemorySettings,
    NodePatch,
    OnboardingAnswer,
    PrefillRequest,
    SelectionEventIn,
    looks_like_card_number,
)
from .store import ENCRYPTION_KEY, SETTINGS_KEY, MemoryStore, NodeRow, iso

Summarizer = Callable[[list[str]], Awaitable[list[str]]]

# Attribute names that identify an entity in a path: {"restaurant": "Thai Basil"} makes the
# "Thai Basil" node an entity of type restaurant.
ENTITY_KEYS = frozenset(
    {"restaurant", "store", "shop", "place", "person", "contact", "product", "document", "pharmacy", "app", "site", "doctor"}
)
# Words that make a new node sensitive (health, money, relationships). Conservative and editable:
# the person can turn the flag on or off for anything.
SENSITIVE_WORDS = re.compile(
    r"\b(health|medical|medicine|medication|meds|prescription|pharmacy|pharmacist|doctor|gp|clinic|hospital|nurse|"
    r"therapy|therapist|symptom|pain|diagnosis|bank|banking|money|bill|bills|payment|budget|insurance|benefits|tax|"
    r"taxes|loan|debt|salary|relationship|partner|dating|divorce|private)\b",
    re.IGNORECASE,
)
PHRASE_SURFACES = frozenset({"talk", "keyboard"})
MASK = "Private"


class MemoryServiceError(Exception):
    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _hash_facts(facts: list[str]) -> str:
    return hashlib.sha256(json.dumps(facts, ensure_ascii=False).encode()).hexdigest()


class MemoryService:
    def __init__(
        self,
        db: Database,
        clock: Clock | None = None,
        *,
        summarizer: Summarizer | None = None,
        keystore: KeychainKeyStore | None = None,
    ) -> None:
        self.db = db
        self.clock = clock or SystemClock()
        self.summarizer = summarizer
        self.keystore = keystore or KeychainKeyStore()
        self.store = MemoryStore(db)
        self._locked: str | None = None
        if db.get_state(ENCRYPTION_KEY) == "keychain":
            try:
                self.store.cipher = self._keychain_cipher(create=False)
            except EncryptionUnavailable as exc:
                self._locked = str(exc)

    # -- settings and time --------------------------------------------------------------
    def settings(self) -> MemorySettings:
        raw = self.db.get_state(SETTINGS_KEY) or {}
        return MemorySettings.model_validate(raw)

    def save_settings(self, settings: MemorySettings) -> MemorySettings:
        if settings.timezone:
            try:
                ZoneInfo(settings.timezone)
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise MemoryServiceError("That time zone isn't recognised.", 422) from exc
        self.db.set_state(SETTINGS_KEY, settings.model_dump())
        return settings

    def params(self, settings: MemorySettings | None = None) -> Params:
        s = settings or self.settings()
        return Params(half_life_days=s.half_life_days, usual_window=s.usual_window, usual_min=s.usual_min)

    def tz(self, settings: MemorySettings | None = None) -> tzinfo:
        s = settings or self.settings()
        if s.timezone:
            try:
                return ZoneInfo(s.timezone)
            except (ZoneInfoNotFoundError, ValueError):
                pass
        local = datetime.now().astimezone().tzinfo
        return local or UTC

    def now(self, settings: MemorySettings | None = None) -> datetime:
        return self.clock.now().astimezone(self.tz(settings))

    def _stamp(self) -> str:
        return iso(self.clock.now().astimezone(UTC))

    def _check_unlocked(self) -> None:
        if self._locked:
            raise MemoryServiceError(f"The memory is locked: {self._locked}", 503)

    # -- encryption ---------------------------------------------------------------------
    def _keychain_cipher(self, *, create: bool) -> Cipher:
        key = self.keystore.load_or_create() if create else self.keystore.load()
        if key is None:
            raise EncryptionUnavailable("The memory key wasn't found in the keychain.")
        return AesGcmCipher(key)

    def encryption_status(self) -> dict[str, Any]:
        return {
            "enabled": self.store.cipher.enabled,
            "keyStore": "macOS keychain" if self.db.get_state(ENCRYPTION_KEY) == "keychain" else None,
            "available": KeychainKeyStore.supported(),
            "locked": self._locked,
        }

    def set_encryption(self, enabled: bool) -> dict[str, Any]:
        self._check_unlocked()
        if enabled == self.store.cipher.enabled:
            return self.encryption_status()
        try:
            new: Cipher = self._keychain_cipher(create=True) if enabled else NullCipher(self.store._salt())
        except EncryptionUnavailable as exc:
            raise MemoryServiceError(str(exc), 409) from exc
        self.store.reencrypt(new)
        self.db.set_state(ENCRYPTION_KEY, "keychain" if enabled else "off")
        return self.encryption_status()

    # -- nodes helpers ------------------------------------------------------------------
    def _nodes(self) -> dict[str, NodeRow]:
        return {n.id: n for n in self.store.all_nodes()}

    @staticmethod
    def _ancestry(node_id: str, nodes: dict[str, NodeRow]) -> list[NodeRow]:
        chain: list[NodeRow] = []
        current = nodes.get(node_id)
        while current is not None:
            chain.append(current)
            current = nodes.get(current.parent_id) if current.parent_id else None
        return list(reversed(chain))

    def _effective(self, node_id: str, nodes: dict[str, NodeRow]) -> tuple[bool, bool]:
        """(hidden, sensitive) including what the node inherits from its ancestors."""
        chain = self._ancestry(node_id, nodes)
        return any(n.hidden for n in chain), any(n.sensitive for n in chain)

    def resolve(self, path: list[str]) -> NodeRow | None:
        parent: str | None = None
        node: NodeRow | None = None
        for label in path:
            node = self.store.find_child(parent, label)
            if node is None:
                return None
            parent = node.id
        return node

    def _ensure_path(self, path: list[str], surface: str, attributes: dict[str, str]) -> list[NodeRow]:
        stamp = self._stamp()
        parent: str | None = None
        chain: list[NodeRow] = []
        entity_of = {v.casefold(): k for k, v in attributes.items() if k.casefold() in ENTITY_KEYS}
        for depth, label in enumerate(path):
            leaf = depth == len(path) - 1
            node = self.store.find_child(parent, label)
            if node is None:
                if depth == 0:
                    kind = "area"
                elif label.casefold() in entity_of:
                    kind = "entity"
                elif leaf:
                    kind = "phrase" if surface in PHRASE_SURFACES else "choice"
                elif depth == 1:
                    kind = "routine"
                else:
                    kind = "task"
                attrs: dict[str, str] = {}
                if kind == "entity":
                    attrs["type"] = entity_of[label.casefold()]
                if leaf:
                    attrs.update(attributes)
                sensitive = bool(SENSITIVE_WORDS.search(label)) or (leaf and attributes.get("sensitive") == "true")
                node = self.store.create_node(parent, label, kind, depth, attrs, sensitive, stamp)
            elif leaf and attributes:
                merged = {**node.attributes, **attributes}
                if merged != node.attributes:
                    node = self.store.update_node(node, stamp, attributes=merged)
            chain.append(node)
            parent = node.id
        return chain

    @staticmethod
    def _drop_secrets(attributes: dict[str, str]) -> tuple[dict[str, str], list[str]]:
        kept: dict[str, str] = {}
        dropped: list[str] = []
        for key, value in attributes.items():
            if SECRET_KEY.search(key) or looks_like_card_number(value):
                dropped.append(key)
            else:
                kept[key] = value
        return kept, dropped

    def _parse_at(self, raw: str | None) -> datetime:
        now = self.clock.now()
        if raw is None:
            return now
        try:
            at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError as exc:
            raise MemoryServiceError("The time of the selection isn't a valid date.", 422) from exc
        if at.tzinfo is None:
            at = at.replace(tzinfo=UTC)
        if at > now + timedelta(minutes=5):
            raise MemoryServiceError("A selection can't be in the future.", 422)
        return at

    # -- recording ----------------------------------------------------------------------
    def record(self, event: SelectionEventIn) -> dict[str, Any]:
        self._check_unlocked()
        settings = self.settings()
        if settings.learning_paused:
            return {"stored": False, "reason": "Learning is paused. Nothing was saved."}
        attributes, dropped = self._drop_secrets(event.attributes)
        at = self._parse_at(event.at)
        local = at.astimezone(self.tz(settings))
        with self.db.transaction():
            chain = self._ensure_path(event.path, event.surface, attributes)
            self.store.add_event(
                [n.id for n in chain],
                event.surface,
                event.outcome,
                "event",
                at.astimezone(UTC),
                local.weekday(),
                local.hour,
                attributes,
            )
        return {"stored": True, "nodeId": chain[-1].id, "dropped": dropped}

    def onboard(self, answers: list[OnboardingAnswer]) -> dict[str, Any]:
        """Cold start: what the person told AGENCY during setup, weighed like one past choice."""
        self._check_unlocked()
        settings = self.settings()
        now = self.now(settings)
        ids: list[str] = []
        with self.db.transaction():
            for a in answers:
                attributes, _ = self._drop_secrets(a.attributes)
                chain = self._ensure_path(a.path, a.surface, attributes)
                weekday = a.weekday if a.weekday is not None else now.weekday()
                hour = DAYPART_HOUR[a.daypart] if a.daypart else now.hour
                self.store.add_event(
                    [n.id for n in chain], a.surface, "chosen", "onboarding", now.astimezone(UTC), weekday, hour, attributes
                )
                ids.append(chain[-1].id)
        return {"stored": len(ids), "nodeIds": ids}

    # -- learning -----------------------------------------------------------------------
    def _occasions(self, params: Params, now: datetime) -> list[Occasion]:
        tz = now.tzinfo
        records = [
            EventRecord(e.node_id, e.path_ids, e.surface, e.outcome, e.source, e.at.astimezone(tz), e.weekday, e.hour)
            for e in self.store.events(since=(now - params.horizon).astimezone(UTC))
        ]
        return occasions(records)

    def _visible(self, node_id: str, nodes: dict[str, NodeRow], settings: MemorySettings) -> bool:
        if node_id not in nodes:
            return False
        hidden, sensitive = self._effective(node_id, nodes)
        return not hidden and not (sensitive and settings.private_mode)

    def _suggestion(
        self, node: NodeRow, nodes: dict[str, NodeRow], score: float, reason: str, surface: str | None
    ) -> dict[str, Any]:
        chain = self._ancestry(node.id, nodes)
        path = [n.label for n in chain]
        out: dict[str, Any] = {"nodeId": node.id, "path": path, "label": node.label, "score": score, "reason": reason}
        if surface not in PHRASE_SURFACES and node.kind != "phrase" and len(chain) > 1:
            selections: dict[str, str] = {}
            for n in chain:
                if n.kind == "entity" and "type" in n.attributes:
                    selections[n.attributes["type"]] = n.label
            selections.update({k: v for k, v in node.attributes.items() if k != "sensitive"})
            selections.setdefault("choice", node.label)
            out["task"] = {"goal": " › ".join(path), "selections": selections}
        return out

    def suggestions(self, surface: str, limit: int = 6, prefix: str | None = None) -> list[dict[str, Any]]:
        self._check_unlocked()
        settings = self.settings()
        params = self.params(settings)
        now = self.now(settings)
        nodes = self._nodes()
        occs = self._occasions(params, now)
        # Home offers things to do; single keyboard words belong on the keyboard only.
        on_surface = [o for o in occs if o.surface == surface or (surface == "home" and o.surface != "keyboard")]
        candidates = {o.node_id for o in on_surface if self._visible(o.node_id, nodes, settings)}
        if prefix:
            p = prefix.casefold().strip()
            candidates = {
                n
                for n in candidates
                if nodes[n].label.casefold().startswith(p) or any(w.startswith(p) for w in nodes[n].label.casefold().split())
            }
        ranked = rank(on_surface, candidates, now, params, sequence_occasions=occs)
        labels = {n.id: n.label for n in nodes.values()}
        ranked.sort(key=lambda r: not nodes[r.node_id].pinned)  # stable: pinned first, otherwise by score
        out: list[dict[str, Any]] = []
        for r in ranked[: max(1, min(limit, 24))]:
            node = nodes[r.node_id]
            out.append(self._suggestion(node, nodes, r.score, describe(r.facts, now, labels, pinned=node.pinned), surface))
        return out

    def usual(self, path: list[str]) -> dict[str, Any] | None:
        self._check_unlocked()
        settings = self.settings()
        params = self.params(settings)
        now = self.now(settings)
        root = self.resolve(path)
        if root is None:
            return None
        nodes = self._nodes()
        subtree = set(self.store.subtree_ids(root.id))
        items = [(o, o.node_id) for o in self._occasions(params, now) if o.node_id in subtree]
        found = usual_of(items, Context.of(now), params)
        if found is None:
            return None
        node_id, fact = found
        if not self._visible(node_id, nodes, settings):
            return None
        reason = f"You chose this {fact.phrase()}."
        surface = next((o.surface for o, k in reversed(items) if k == node_id), None)
        return self._suggestion(nodes[node_id], nodes, round(fact.count / fact.window, 4), reason, surface)

    def prefill(self, req: PrefillRequest) -> dict[str, Any] | None:
        """Pre-select an answer to the agent's question only when the person's choice is settled."""
        self._check_unlocked()
        settings = self.settings()
        params = self.params(settings)
        now = self.now(settings)
        root = self.resolve(req.path)
        if root is None:
            return None
        nodes = self._nodes()
        hidden, sensitive = self._effective(root.id, nodes)
        if hidden or (sensitive and settings.private_mode):
            return None
        options = {o.id: {o.id.casefold(), " ".join(o.label.casefold().split())} for o in req.question.options}
        items: list[tuple[Occasion, str]] = []
        for rec, attrs in self.store.event_attributes(self.store.subtree_ids(root.id), since=now - params.horizon):
            if rec.outcome not in POSITIVE_OUTCOMES or rec.source != "event":
                continue
            values = {" ".join(v.casefold().split()) for v in attrs.values()}
            values |= {nodes[i].original_label.casefold() for i in rec.path_ids if i in nodes}
            values |= {nodes[i].label.casefold() for i in rec.path_ids if i in nodes}
            match = [oid for oid, names in options.items() if names & values]
            if len(match) != 1:
                continue
            local = rec.at.astimezone(now.tzinfo)
            occ = Occasion(
                rec.node_id, rec.path_ids, rec.surface, local, Context(rec.weekday, daypart(rec.hour)), "positive", False
            )
            items.append((occ, match[0]))
        found = usual_of(items, Context.of(now), params)
        if found is None:
            return None
        option_id, fact = found
        label = next(o.label for o in req.question.options if o.id == option_id)
        return {
            "questionId": req.question.id,
            "optionId": option_id,
            "score": round(fact.count / fact.window, 4),
            "reason": f"You chose {label} {fact.phrase()}.",
        }

    # -- the person's view and controls -------------------------------------------------
    def tree(self, *, reveal: bool = False) -> list[dict[str, Any]]:
        self._check_unlocked()
        settings = self.settings()
        nodes = self._nodes()
        out: list[dict[str, Any]] = []
        for node in nodes.values():
            item = node.contract()
            hidden, sensitive = self._effective(node.id, nodes)
            item["effectiveSensitive"] = sensitive
            item["effectiveHidden"] = hidden
            if sensitive and settings.private_mode and not reveal:
                item["label"] = MASK
                item["attributes"] = {}
                item["masked"] = True
            out.append(item)
        return out

    def node_detail(self, node_id: str, *, reveal: bool = False) -> dict[str, Any]:
        self._check_unlocked()
        settings = self.settings()
        params = self.params(settings)
        now = self.now(settings)
        nodes = self._nodes()
        node = nodes.get(node_id)
        if node is None:
            raise MemoryServiceError("AGENCY doesn't know that (it may have been forgotten).", 404)
        hidden, sensitive = self._effective(node_id, nodes)
        masked = sensitive and settings.private_mode and not reveal
        subtree = set(self.store.subtree_ids(node_id))
        every = self._occasions(params, now)
        occs = [o for o in every if subtree & set(o.path_ids)]
        chosen = [o for o in occs if o.kind == "positive" and not o.onboarding]
        own = [o for o in occs if o.node_id == node_id]
        ranked = rank(own, [node_id], now, params, sequence_occasions=every) if own else []
        labels = {n.id: n.label for n in nodes.values()}
        reason = describe(ranked[0].facts, now, labels, pinned=node.pinned) if ranked else None
        if reason is None and chosen:
            reason = f"Things here were chosen {len(chosen)} time{'s' if len(chosen) != 1 else ''}."
        usual = None
        path = [n.label for n in self._ancestry(node_id, nodes)]
        if node.kind in {"area", "routine", "task", "entity"}:
            usual = self.usual([n.original_label for n in self._ancestry(node_id, nodes)])
        item = node.contract()
        item.update(
            {
                "path": path,
                "effectiveSensitive": sensitive,
                "effectiveHidden": hidden,
                "children": sum(1 for n in nodes.values() if n.parent_id == node_id),
                "timesChosen": len(chosen),
                "lastChosenAt": iso(chosen[-1].at) if chosen else None,
                "fromSetup": any(o.onboarding for o in occs),
                "reason": reason,
                "usual": usual,
            }
        )
        if masked:
            item.update({"label": MASK, "attributes": {}, "path": [MASK], "reason": None, "usual": None, "masked": True})
        return item

    def patch(self, node_id: str, body: NodePatch) -> dict[str, Any]:
        self._check_unlocked()
        node = self.store.get_node(node_id)
        if node is None:
            raise MemoryServiceError("AGENCY doesn't know that (it may have been forgotten).", 404)
        fields = body.model_dump(exclude_none=True)
        if "label" in fields:
            fields["label"] = " ".join(str(fields["label"]).split())
            if not fields["label"]:
                raise MemoryServiceError("A name can't be empty.", 422)
        updated = self.store.update_node(node, self._stamp(), **fields)
        return updated.contract()

    def forget(self, node_id: str) -> dict[str, Any]:
        self._check_unlocked()
        nodes = self._nodes()
        if node_id not in nodes:
            raise MemoryServiceError("AGENCY doesn't know that (it may have been forgotten).", 404)
        ancestors = [n.id for n in reversed(self._ancestry(node_id, nodes)[:-1])]
        removed = self.store.delete_subtree(node_id)
        self.store.prune_empty(ancestors)
        return {"forgotten": removed}

    def forget_all(self, confirm: bool) -> dict[str, Any]:
        if not confirm:
            raise MemoryServiceError("Forgetting everything needs a confirmation.", 422)
        before = self.store.counts()
        self.store.forget_all()
        return {"forgotten": before}

    def export(self) -> dict[str, Any]:
        self._check_unlocked()
        nodes = self._nodes()
        events = self.store.raw_events()
        for e in events:
            e["path"] = [nodes[i].label for i in e["pathIds"] if i in nodes]
        return {
            "format": "agency-memory-export",
            "version": 1,
            "exportedAt": self._stamp(),
            "settings": self.settings().model_dump(by_alias=True),
            "encryption": self.encryption_status(),
            "nodes": [n.contract() for n in nodes.values()],
            "events": events,
            "notes": self.store.notes(),
            "caregiverAccess": self.store.grants(),
            "accessLog": self.store.access_log(500),
        }

    def overview(self) -> dict[str, Any]:
        self._check_unlocked()
        settings = self.settings()
        return {
            "counts": self.store.counts(),
            "settings": settings.model_dump(by_alias=True),
            "encryption": self.encryption_status(),
            "grants": [g for g in self.store.grants() if g["revokedAt"] is None and g["expiresAt"] > self._stamp()],
            "recentAccess": self.store.access_log(10),
        }

    # -- opt-in summaries ---------------------------------------------------------------
    def summary_facts(self) -> list[str]:
        """Exactly what a summary request would send: no sensitive or hidden items, no event details."""
        settings = self.settings()
        params = self.params(settings)
        now = self.now(settings)
        nodes = self._nodes()
        counts: dict[str, list[Occasion]] = {}
        for o in self._occasions(params, now):
            if o.kind == "positive" and not o.onboarding:
                counts.setdefault(o.node_id, []).append(o)
        facts: list[str] = []
        for node_id, occs in sorted(counts.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            hidden, sensitive = self._effective(node_id, nodes)
            if hidden or sensitive or node_id not in nodes or len(occs) < 2:
                continue
            path = " > ".join(n.label for n in self._ancestry(node_id, nodes))
            days = sorted({o.context.weekday for o in occs})
            parts = sorted({o.context.daypart for o in occs})
            when = ", ".join(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d] for d in days)
            facts.append(f"{path}: chosen {len(occs)} times (days: {when}; times of day: {', '.join(parts)})")
            if len(facts) >= 40:
                break
        return facts

    def summary_preview(self, model: str | None) -> dict[str, Any]:
        self._check_unlocked()
        facts = self.summary_facts()
        return {
            "enabled": self.settings().summaries_enabled,
            "available": self.summarizer is not None,
            "destination": f"Anthropic API ({model})" if model else "Anthropic API (not configured)",
            "facts": facts,
            "factsHash": _hash_facts(facts),
            "excluded": "Sensitive and hidden items, and everything chosen fewer than twice, are never sent.",
        }

    async def summarize(self, facts_hash: str) -> list[dict[str, Any]]:
        self._check_unlocked()
        if not self.settings().summaries_enabled:
            raise MemoryServiceError("Summaries are off. Turn them on in memory settings first.")
        if self.summarizer is None:
            raise MemoryServiceError("No cloud model is configured, so nothing was sent.")
        facts = self.summary_facts()
        if _hash_facts(facts) != facts_hash:
            raise MemoryServiceError("What would be sent has changed. Please look at it again before sending.")
        if not facts:
            raise MemoryServiceError("There isn't enough yet to summarise.")
        lines = await self.summarizer(facts)
        stamp = self._stamp()
        return [self.store.add_note(line[:400], facts_hash, stamp) for line in lines[:8] if line.strip()]

    # -- caregiver access ---------------------------------------------------------------
    def grant(self, req: GrantRequest) -> dict[str, Any]:
        if not req.confirm:
            raise MemoryServiceError("Caregiver access needs the person's confirmation.", 422)
        expires = iso((self.clock.now() + timedelta(days=req.days)).astimezone(UTC))
        grant, token = self.store.add_grant(" ".join(req.caregiver.split()), req.scope, expires, self._stamp())
        # The token is shown once, to hand to the caregiver; only its hash is stored.
        return {**grant, "token": token}

    def revoke(self, grant_id: str) -> dict[str, Any]:
        if not self.store.revoke_grant(grant_id, self._stamp()):
            raise MemoryServiceError("That access was already ended or doesn't exist.", 404)
        grant = self.store.grant(grant_id)
        assert grant is not None
        return grant

    def caregiver_view(self, token: str) -> dict[str, Any]:
        self._check_unlocked()
        grant = self.store.grant_by_token(token) if token else None
        stamp = self._stamp()
        if grant is None or grant["revokedAt"] is not None or grant["expiresAt"] <= stamp:
            raise MemoryServiceError("This caregiver access isn't valid. Ask the person to share it again.", 403)
        nodes = self._nodes()
        visible = []
        for node in nodes.values():
            hidden, sensitive = self._effective(node.id, nodes)
            if hidden or (sensitive and grant["scope"] != "everything"):
                continue
            visible.append(node.contract())
        self.store.log_access(grant["id"], grant["caregiver"], f"Looked at {len(visible)} items", stamp)
        return {"caregiver": grant["caregiver"], "scope": grant["scope"], "expiresAt": grant["expiresAt"], "nodes": visible}
