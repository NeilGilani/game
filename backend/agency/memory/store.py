"""SQLite storage for the memory tree (tables from migration 5 in ``agency/db.py``).

Text (labels, attributes, notes) passes through a :class:`~.crypto.Cipher`, so the same code
stores plaintext or AES-GCM ciphertext. Nodes are found by a keyed blind index of
(parent, label), never by comparing plaintext in SQL.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..db import Database, dumps, loads
from .crypto import Cipher, NullCipher, blind_index
from .learning import EventRecord

SALT_KEY = "memory.index_salt"
SETTINGS_KEY = "memory.settings"
ENCRYPTION_KEY = "memory.encryption"


def iso(when: datetime) -> str:
    return when.isoformat(timespec="milliseconds")


@dataclass
class NodeRow:
    id: str
    parent_id: str | None
    kind: str
    label: str
    original_label: str
    attributes: dict[str, str]
    pinned: bool
    hidden: bool
    sensitive: bool
    depth: int
    created_at: str
    updated_at: str

    def contract(self) -> dict[str, Any]:
        """The ``MemoryNode`` shape from os/contracts/src/memory.ts."""
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "parentId": self.parent_id,
            "attributes": dict(self.attributes),
            "pinned": self.pinned,
            "hidden": self.hidden,
            "sensitive": self.sensitive,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class MemoryStore:
    def __init__(self, db: Database, cipher: Cipher | None = None) -> None:
        self.db = db
        self.cipher: Cipher = cipher or NullCipher(self._salt())

    def _salt(self) -> bytes:
        salt = self.db.get_state(SALT_KEY)
        if not salt:
            salt = secrets.token_hex(32)
            self.db.set_state(SALT_KEY, salt)
        return bytes.fromhex(str(salt))

    # -- text ---------------------------------------------------------------------------
    def _enc(self, text: str) -> str:
        return self.cipher.encrypt(text)

    def _dec(self, stored: str) -> str:
        return self.cipher.decrypt(stored)

    def _enc_json(self, value: Any) -> str:
        return self.cipher.encrypt(dumps(value))

    def _dec_json(self, stored: str) -> Any:
        return loads(self.cipher.decrypt(stored))

    def index(self, parent_id: str | None, label: str) -> str:
        return blind_index(self.cipher.index_key(), parent_id, label)

    # -- nodes --------------------------------------------------------------------------
    def _node(self, row: Any) -> NodeRow:
        return NodeRow(
            id=row["id"],
            parent_id=row["parent_id"],
            kind=row["kind"],
            label=self._dec(row["label"]),
            original_label=self._dec(row["original_label"]),
            attributes=self._dec_json(row["attributes"]) or {},
            pinned=bool(row["pinned"]),
            hidden=bool(row["hidden"]),
            sensitive=bool(row["sensitive"]),
            depth=int(row["depth"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def find_child(self, parent_id: str | None, label: str) -> NodeRow | None:
        row = self.db.query_one(
            "SELECT * FROM memory_nodes WHERE COALESCE(parent_id, '') = ? AND label_index = ?",
            (parent_id or "", self.index(parent_id, label)),
        )
        return self._node(row) if row else None

    def create_node(
        self,
        parent_id: str | None,
        label: str,
        kind: str,
        depth: int,
        attributes: dict[str, str],
        sensitive: bool,
        now: str,
    ) -> NodeRow:
        node_id = "m_" + secrets.token_hex(8)
        self.db.execute(
            "INSERT INTO memory_nodes(id, parent_id, label_index, kind, label, original_label, attributes, pinned, hidden,"
            " sensitive, depth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)",
            (
                node_id,
                parent_id,
                self.index(parent_id, label),
                kind,
                self._enc(label),
                self._enc(label),
                self._enc_json(attributes),
                int(sensitive),
                depth,
                now,
                now,
            ),
        )
        node = self.get_node(node_id)
        assert node is not None
        return node

    def update_node(self, node: NodeRow, now: str, **fields: Any) -> NodeRow:
        cols: list[str] = []
        params: list[Any] = []
        for key, value in fields.items():
            if key == "label":
                cols.append("label = ?")
                params.append(self._enc(str(value)))
            elif key == "attributes":
                cols.append("attributes = ?")
                params.append(self._enc_json(value))
            elif key in {"pinned", "hidden", "sensitive"}:
                cols.append(f"{key} = ?")
                params.append(int(bool(value)))
            elif key == "kind":
                cols.append("kind = ?")
                params.append(str(value))
            else:  # pragma: no cover - programming error
                raise KeyError(key)
        if not cols:
            return node
        cols.append("updated_at = ?")
        params.extend([now, node.id])
        self.db.execute(f"UPDATE memory_nodes SET {', '.join(cols)} WHERE id = ?", params)  # noqa: S608 - fixed columns
        updated = self.get_node(node.id)
        assert updated is not None
        return updated

    def get_node(self, node_id: str) -> NodeRow | None:
        row = self.db.query_one("SELECT * FROM memory_nodes WHERE id = ?", (node_id,))
        return self._node(row) if row else None

    def all_nodes(self) -> list[NodeRow]:
        return [self._node(r) for r in self.db.query("SELECT * FROM memory_nodes ORDER BY depth, created_at, id")]

    def subtree_ids(self, node_id: str) -> list[str]:
        rows = self.db.query(
            "WITH RECURSIVE sub(id) AS (SELECT id FROM memory_nodes WHERE id = ? "
            "UNION ALL SELECT n.id FROM memory_nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub",
            (node_id,),
        )
        return [r["id"] for r in rows]

    def delete_subtree(self, node_id: str) -> int:
        """Delete a node, its descendants, and every event that passed through any of them."""
        ids = self.subtree_ids(node_id)
        if not ids:
            return 0
        marks = ",".join("?" for _ in ids)
        with self.db.transaction():
            self.db.execute(
                f"DELETE FROM memory_events WHERE id IN (SELECT event_id FROM memory_event_nodes WHERE node_id IN ({marks}))",  # noqa: S608
                ids,
            )
            self.db.execute("DELETE FROM memory_nodes WHERE id = ?", (node_id,))
        return len(ids)

    def prune_empty(self, node_ids: list[str]) -> None:
        """Remove ancestors left with no children and no events of their own (after a forget)."""
        for nid in node_ids:
            has_child = self.db.query_one("SELECT 1 FROM memory_nodes WHERE parent_id = ? LIMIT 1", (nid,))
            has_event = self.db.query_one("SELECT 1 FROM memory_event_nodes WHERE node_id = ? LIMIT 1", (nid,))
            if has_child or has_event:
                return
            self.db.execute("DELETE FROM memory_nodes WHERE id = ?", (nid,))

    # -- events -------------------------------------------------------------------------
    def add_event(
        self,
        path_ids: list[str],
        surface: str,
        outcome: str,
        source: str,
        at: datetime,
        weekday: int,
        hour: int,
        attributes: dict[str, str],
    ) -> int:
        cur = self.db.execute(
            "INSERT INTO memory_events(node_id, path_ids, surface, outcome, source, at, weekday, hour, attributes)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (path_ids[-1], dumps(path_ids), surface, outcome, source, iso(at), weekday, hour, self._enc_json(attributes)),
        )
        event_id = int(cur.lastrowid or 0)
        for nid in dict.fromkeys(path_ids):
            self.db.execute("INSERT INTO memory_event_nodes(event_id, node_id) VALUES (?, ?)", (event_id, nid))
        return event_id

    def events(self, since: datetime | None = None, node_ids: list[str] | None = None) -> list[EventRecord]:
        sql = "SELECT e.* FROM memory_events e"
        params: list[Any] = []
        where: list[str] = []
        if node_ids is not None:
            if not node_ids:
                return []
            marks = ",".join("?" for _ in node_ids)
            where.append(f"e.id IN (SELECT event_id FROM memory_event_nodes WHERE node_id IN ({marks}))")  # noqa: S608
            params.extend(node_ids)
        if since is not None:
            where.append("e.at >= ?")
            params.append(iso(since))
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY e.at, e.id"
        return [
            EventRecord(
                node_id=r["node_id"],
                path_ids=tuple(loads(r["path_ids"])),
                surface=r["surface"],
                outcome=r["outcome"],
                source=r["source"],
                at=datetime.fromisoformat(r["at"]),
                weekday=int(r["weekday"]),
                hour=int(r["hour"]),
            )
            for r in self.db.query(sql, params)
        ]

    def event_attributes(self, node_ids: list[str], since: datetime | None = None) -> list[tuple[EventRecord, dict[str, str]]]:
        """Events through any of ``node_ids`` with their (decrypted) details."""
        if not node_ids:
            return []
        marks = ",".join("?" for _ in node_ids)
        sql = (
            f"SELECT e.* FROM memory_events e WHERE e.id IN (SELECT event_id FROM memory_event_nodes WHERE node_id IN ({marks}))"  # noqa: S608
        )
        params: list[Any] = list(node_ids)
        if since is not None:
            sql += " AND e.at >= ?"
            params.append(iso(since))
        sql += " ORDER BY e.at, e.id"
        out: list[tuple[EventRecord, dict[str, str]]] = []
        for r in self.db.query(sql, params):
            rec = EventRecord(
                node_id=r["node_id"],
                path_ids=tuple(loads(r["path_ids"])),
                surface=r["surface"],
                outcome=r["outcome"],
                source=r["source"],
                at=datetime.fromisoformat(r["at"]),
                weekday=int(r["weekday"]),
                hour=int(r["hour"]),
            )
            out.append((rec, self._dec_json(r["attributes"]) or {}))
        return out

    def raw_events(self) -> list[dict[str, Any]]:
        return [
            {
                "id": r["id"],
                "nodeId": r["node_id"],
                "pathIds": loads(r["path_ids"]),
                "surface": r["surface"],
                "outcome": r["outcome"],
                "source": r["source"],
                "at": r["at"],
                "attributes": self._dec_json(r["attributes"]) or {},
            }
            for r in self.db.query("SELECT * FROM memory_events ORDER BY at, id")
        ]

    def counts(self) -> dict[str, int]:
        nodes = self.db.query_one("SELECT COUNT(*) AS n FROM memory_nodes")
        events = self.db.query_one("SELECT COUNT(*) AS n FROM memory_events")
        notes = self.db.query_one("SELECT COUNT(*) AS n FROM memory_notes")
        return {
            "nodes": int(nodes["n"]) if nodes else 0,
            "events": int(events["n"]) if events else 0,
            "notes": int(notes["n"]) if notes else 0,
        }

    # -- notes --------------------------------------------------------------------------
    def add_note(self, text: str, facts_hash: str, now: str) -> dict[str, Any]:
        note_id = "note_" + secrets.token_hex(6)
        self.db.execute(
            "INSERT INTO memory_notes(id, text, facts_hash, created_at) VALUES (?, ?, ?, ?)",
            (note_id, self._enc(text), facts_hash, now),
        )
        return {"id": note_id, "text": text, "createdAt": now}

    def notes(self) -> list[dict[str, Any]]:
        return [
            {"id": r["id"], "text": self._dec(r["text"]), "createdAt": r["created_at"]}
            for r in self.db.query("SELECT * FROM memory_notes ORDER BY created_at, id")
        ]

    def delete_note(self, note_id: str) -> bool:
        cur = self.db.execute("DELETE FROM memory_notes WHERE id = ?", (note_id,))
        return cur.rowcount > 0

    # -- caregiver grants ---------------------------------------------------------------
    @staticmethod
    def token_hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def add_grant(self, caregiver: str, scope: str, expires_at: str, now: str) -> tuple[dict[str, Any], str]:
        token = secrets.token_urlsafe(24)
        grant_id = "grant_" + secrets.token_hex(6)
        self.db.execute(
            "INSERT INTO memory_grants(id, caregiver, scope, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            (grant_id, caregiver, scope, self.token_hash(token), now, expires_at),
        )
        grant = self.grant(grant_id)
        assert grant is not None
        return grant, token

    def _grant(self, r: Any) -> dict[str, Any]:
        return {
            "id": r["id"],
            "caregiver": r["caregiver"],
            "scope": r["scope"],
            "createdAt": r["created_at"],
            "expiresAt": r["expires_at"],
            "revokedAt": r["revoked_at"],
        }

    def grant(self, grant_id: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM memory_grants WHERE id = ?", (grant_id,))
        return self._grant(r) if r else None

    def grant_by_token(self, token: str) -> dict[str, Any] | None:
        r = self.db.query_one("SELECT * FROM memory_grants WHERE token_hash = ?", (self.token_hash(token),))
        return self._grant(r) if r else None

    def grants(self) -> list[dict[str, Any]]:
        return [self._grant(r) for r in self.db.query("SELECT * FROM memory_grants ORDER BY created_at, id")]

    def revoke_grant(self, grant_id: str, now: str) -> bool:
        cur = self.db.execute("UPDATE memory_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", (now, grant_id))
        return cur.rowcount > 0

    def log_access(self, grant_id: str, caregiver: str, what: str, now: str) -> None:
        self.db.execute(
            "INSERT INTO memory_access_log(grant_id, caregiver, at, what) VALUES (?, ?, ?, ?)", (grant_id, caregiver, now, what)
        )

    def access_log(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM memory_access_log ORDER BY id DESC LIMIT ?", (limit,))
        return [{"caregiver": r["caregiver"], "at": r["at"], "what": r["what"]} for r in rows]

    # -- whole memory -------------------------------------------------------------------
    def forget_all(self) -> None:
        with self.db.transaction():
            for table in ("memory_event_nodes", "memory_events", "memory_nodes", "memory_notes", "memory_access_log"):
                self.db.execute(f"DELETE FROM {table}")  # noqa: S608 - fixed table names
            # Caregiver access ends with the memory it gave access to.
            self.db.execute("DELETE FROM memory_grants")

    def reencrypt(self, new: Cipher) -> None:
        """Rewrite every stored text field with ``new`` (turning encryption on or off)."""
        nodes = self.all_nodes()
        events = self.db.query("SELECT id, attributes FROM memory_events")
        notes = self.db.query("SELECT id, text FROM memory_notes")
        old = self.cipher
        with self.db.transaction():
            for n in nodes:
                self.db.execute(
                    "UPDATE memory_nodes SET label_index = ?, label = ?, original_label = ?, attributes = ? WHERE id = ?",
                    (
                        blind_index(new.index_key(), n.parent_id, n.original_label),
                        new.encrypt(n.label),
                        new.encrypt(n.original_label),
                        new.encrypt(dumps(n.attributes)),
                        n.id,
                    ),
                )
            for e in events:
                self.db.execute(
                    "UPDATE memory_events SET attributes = ? WHERE id = ?",
                    (new.encrypt(old.decrypt(e["attributes"])), e["id"]),
                )
            for t in notes:
                self.db.execute("UPDATE memory_notes SET text = ? WHERE id = ?", (new.encrypt(old.decrypt(t["text"])), t["id"]))
        self.cipher = new
