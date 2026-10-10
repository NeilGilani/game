"""SQLite persistence with forward-only, versioned migrations.

One connection per process, guarded by a re-entrant lock. The workload is a single
user's cases on a MacBook or a Raspberry Pi, so this is deliberately simple: WAL mode
keeps reads cheap and every write is a short transaction.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MIGRATIONS: list[tuple[int, str, str]] = [
    (
        1,
        "core workflow tables",
        """
        CREATE TABLE system_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data TEXT NOT NULL
        );
        CREATE TABLE preferences (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE cases (
            id TEXT PRIMARY KEY,
            goal_type TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            goal TEXT NOT NULL,
            plan_version INTEGER NOT NULL DEFAULT 1,
            reasoning TEXT NOT NULL,
            paused INTEGER NOT NULL DEFAULT 0,
            summary TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
        );
        CREATE TABLE steps (
            case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            position INTEGER NOT NULL,
            plan_version INTEGER NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            tool TEXT NOT NULL,
            inputs TEXT NOT NULL,
            depends_on TEXT NOT NULL,
            preconditions TEXT NOT NULL,
            approval TEXT NOT NULL,
            optional INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            expected_output TEXT NOT NULL,
            verification TEXT NOT NULL,
            retry TEXT NOT NULL,
            timeout_s REAL NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            question TEXT,
            output TEXT,
            error TEXT,
            evidence TEXT,
            idempotency_key TEXT NOT NULL,
            recovery_of TEXT,
            recovery_context TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (case_id, id)
        );
        CREATE TABLE invocations (
            id TEXT PRIMARY KEY,
            case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
            step_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            inputs TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            status TEXT NOT NULL,
            result TEXT,
            error TEXT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            duration_ms INTEGER
        );
        CREATE INDEX idx_invocations_case ON invocations(case_id, step_id);
        CREATE TABLE approvals (
            id TEXT PRIMARY KEY,
            case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
            step_id TEXT NOT NULL,
            status TEXT NOT NULL,
            summary TEXT NOT NULL,
            details TEXT NOT NULL,
            inputs_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            decided_at TEXT,
            decision_note TEXT
        );
        CREATE INDEX idx_approvals_case ON approvals(case_id, status);
        CREATE TABLE audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            case_id TEXT,
            step_id TEXT,
            ts TEXT NOT NULL,
            kind TEXT NOT NULL,
            actor TEXT NOT NULL,
            message TEXT NOT NULL,
            data TEXT NOT NULL
        );
        CREATE INDEX idx_audit_case ON audit_events(case_id, id);
        CREATE TABLE verifications (
            id TEXT PRIMARY KEY,
            case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
            step_id TEXT NOT NULL,
            invocation_id TEXT,
            passed INTEGER NOT NULL,
            checks TEXT NOT NULL,
            ts TEXT NOT NULL
        );
        """,
    ),
    (
        2,
        "demo integration services (each owns its own tables)",
        """
        CREATE TABLE svc_repair_slots (
            id TEXT PRIMARY KEY,
            technician TEXT NOT NULL,
            starts_at TEXT NOT NULL,
            ends_at TEXT NOT NULL,
            visit_type TEXT NOT NULL,
            status TEXT NOT NULL,
            booked_request_id TEXT,
            note TEXT
        );
        CREATE TABLE svc_repair_requests (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            device TEXT NOT NULL,
            issue TEXT NOT NULL,
            slot_id TEXT,
            estimate_cents INTEGER NOT NULL,
            reference TEXT,
            created_at TEXT NOT NULL,
            confirmed_at TEXT
        );
        CREATE TABLE svc_repair_submissions (
            idempotency_key TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            slot_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE svc_funding_programs (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL
        );
        CREATE TABLE svc_funding_cases (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            program_id TEXT,
            form_id TEXT,
            payload TEXT NOT NULL,
            reference TEXT,
            decision TEXT,
            created_at TEXT NOT NULL,
            submitted_at TEXT
        );
        CREATE TABLE svc_funding_submissions (
            idempotency_key TEXT PRIMARY KEY,
            case_ref TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE svc_calendar_events (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT UNIQUE,
            title TEXT NOT NULL,
            starts_at TEXT NOT NULL,
            ends_at TEXT NOT NULL,
            location TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            notes TEXT NOT NULL,
            history TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE svc_calendar_openings (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            starts_at TEXT NOT NULL,
            ends_at TEXT NOT NULL,
            status TEXT NOT NULL
        );
        CREATE TABLE svc_calendar_ops (
            idempotency_key TEXT PRIMARY KEY,
            event_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE svc_contacts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT NOT NULL,
            channel TEXT NOT NULL
        );
        CREATE TABLE svc_messages (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            contact_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            sent_at TEXT
        );
        CREATE TABLE svc_message_sends (
            idempotency_key TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """,
    ),
]


def utcnow() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def loads(value: str | None) -> Any:
    if value is None:
        return None
    return json.loads(value)


class Database:
    def __init__(self, path: Path | str) -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._depth = 0
        with self._lock:
            self._conn.execute("PRAGMA foreign_keys = ON")
            if self.path != ":memory:":
                self._conn.execute("PRAGMA journal_mode = WAL")
            self._conn.execute("PRAGMA synchronous = NORMAL")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- migrations ---------------------------------------------------------------------
    def migrate(self) -> int:
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
            )
            applied = {row["version"] for row in self._conn.execute("SELECT version FROM schema_migrations")}
            for version, name, sql in MIGRATIONS:
                if version in applied:
                    continue
                self._conn.execute("BEGIN")
                try:
                    for statement in sql.split(";"):
                        if statement.strip():
                            self._conn.execute(statement)
                    self._conn.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (version, name, utcnow()),
                    )
                    self._conn.execute("COMMIT")
                except Exception:
                    self._conn.execute("ROLLBACK")
                    raise
            return self.schema_version()

    def schema_version(self) -> int:
        row = self.query_one("SELECT MAX(version) AS v FROM schema_migrations")
        return int(row["v"]) if row and row["v"] is not None else 0

    # -- access -------------------------------------------------------------------------
    @contextmanager
    def transaction(self) -> Iterator[None]:
        with self._lock:
            outermost = self._depth == 0
            if outermost:
                self._conn.execute("BEGIN IMMEDIATE")
            self._depth += 1
            try:
                yield
            except Exception:
                self._depth -= 1
                if outermost:
                    self._conn.execute("ROLLBACK")
                raise
            else:
                self._depth -= 1
                if outermost:
                    self._conn.execute("COMMIT")

    def execute(self, sql: str, params: tuple[Any, ...] | list[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    def query(self, sql: str, params: tuple[Any, ...] | list[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return list(self._conn.execute(sql, params).fetchall())

    def query_one(self, sql: str, params: tuple[Any, ...] | list[Any] = ()) -> sqlite3.Row | None:
        with self._lock:
            row: sqlite3.Row | None = self._conn.execute(sql, params).fetchone()
            return row

    # -- small key/value store for system flags -----------------------------------------
    def get_state(self, key: str, default: Any = None) -> Any:
        row = self.query_one("SELECT value FROM system_state WHERE key = ?", (key,))
        return loads(row["value"]) if row else default

    def set_state(self, key: str, value: Any) -> None:
        self.execute(
            "INSERT INTO system_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, dumps(value)),
        )
