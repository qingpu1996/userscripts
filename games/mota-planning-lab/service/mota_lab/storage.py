"""SQLite observation store and transactional action ledger."""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any, Dict, Optional

from .models import Observation
from .state import canonical_json, observation_fingerprint, observation_payload


class LedgerError(RuntimeError):
    code = "LEDGER_ERROR"


class UnknownAction(LedgerError):
    code = "UNKNOWN_ACTION_ID"


class ActionConflict(LedgerError):
    code = "ACTION_STATE_CONFLICT"


@dataclass(frozen=True)
class ActionRecord:
    action_id: str
    pre_fingerprint: str
    response: Dict[str, Any]
    status: str
    post_fingerprint: Optional[str]
    replacement_action_id: Optional[str]


class Store:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(str(self.path), check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._lock = RLock()
        with self._connection:
            self._connection.execute("PRAGMA foreign_keys=ON")
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=FULL")
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS observations (
                    fingerprint TEXT PRIMARY KEY,
                    floor_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL,
                    seen_count INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS actions (
                    action_id TEXT PRIMARY KEY,
                    pre_fingerprint TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('issued','completed','mismatch','superseded')),
                    post_fingerprint TEXT,
                    replacement_action_id TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY(pre_fingerprint) REFERENCES observations(fingerprint)
                );
                CREATE INDEX IF NOT EXISTS actions_pre_idx ON actions(pre_fingerprint, status);
                CREATE TABLE IF NOT EXISTS decisions (
                    decision_key TEXT PRIMARY KEY,
                    observation_fingerprint TEXT NOT NULL,
                    knowledge_fingerprint TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    action_id TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(observation_fingerprint) REFERENCES observations(fingerprint)
                );
                CREATE TABLE IF NOT EXISTS action_id_sequence (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    next_value INTEGER NOT NULL CHECK(next_value >= 1)
                );
                INSERT OR IGNORE INTO action_id_sequence(singleton, next_value) VALUES (1, 1);
                """
            )

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def record_observation(self, observation: Observation) -> str:
        fingerprint = observation_fingerprint(observation)
        payload_json = canonical_json(observation_payload(observation))
        now = int(time.time() * 1000)
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO observations(
                    fingerprint, floor_id, payload_json, created_at, last_seen_at, seen_count
                ) VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(fingerprint) DO UPDATE SET
                    last_seen_at=excluded.last_seen_at,
                    seen_count=observations.seen_count + 1
                """,
                (fingerprint, observation.floor_id, payload_json, now, now),
            )
        return fingerprint

    def get_observation(self, fingerprint: str) -> Optional[Observation]:
        with self._lock:
            row = self._connection.execute(
                "SELECT payload_json FROM observations WHERE fingerprint=?", (fingerprint,)
            ).fetchone()
        if row is None:
            return None
        return Observation.model_validate(json.loads(row["payload_json"]))

    def observation_count(self) -> int:
        with self._lock:
            row = self._connection.execute("SELECT COUNT(*) AS count FROM observations").fetchone()
        return int(row["count"])

    def observation_seen_count(self, fingerprint: str) -> int:
        with self._lock:
            row = self._connection.execute(
                "SELECT seen_count FROM observations WHERE fingerprint=?", (fingerprint,)
            ).fetchone()
        return 0 if row is None else int(row["seen_count"])

    @staticmethod
    def _action_from_row(row: sqlite3.Row) -> ActionRecord:
        return ActionRecord(
            action_id=row["action_id"],
            pre_fingerprint=row["pre_fingerprint"],
            response=json.loads(row["response_json"]),
            status=row["status"],
            post_fingerprint=row["post_fingerprint"],
            replacement_action_id=row["replacement_action_id"],
        )

    def get_action(self, action_id: str) -> Optional[ActionRecord]:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM actions WHERE action_id=?", (action_id,)
            ).fetchone()
        return None if row is None else self._action_from_row(row)

    def issued_action_for_prestate(self, fingerprint: str) -> Optional[ActionRecord]:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT * FROM actions
                WHERE pre_fingerprint=? AND status='issued'
                ORDER BY created_at DESC, action_id DESC LIMIT 1
                """,
                (fingerprint,),
            ).fetchone()
        return None if row is None else self._action_from_row(row)

    def get_decision(self, decision_key: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._connection.execute(
                "SELECT response_json FROM decisions WHERE decision_key=?", (decision_key,)
            ).fetchone()
        return None if row is None else json.loads(row["response_json"])

    def reserve_action_id(self) -> str:
        """Reserve a never-reused action id from the persistent SQLite sequence.

        Gaps are intentional: a process may reserve an id and fail before an
        action is committed, but the id is still never handed out again.  The
        ledger collision check also makes this safe for databases created by
        older deterministic-id versions.
        """

        maximum = (1 << 63) - 2
        with self._lock:
            cursor = self._connection.cursor()
            try:
                cursor.execute("BEGIN IMMEDIATE")
                row = cursor.execute(
                    "SELECT next_value FROM action_id_sequence WHERE singleton=1"
                ).fetchone()
                if row is None:
                    raise LedgerError("action id sequence is missing")
                candidate = int(row["next_value"])
                action_id = None
                while candidate <= maximum:
                    proposed = f"AUTO-{candidate:016X}"
                    collision = cursor.execute(
                        "SELECT 1 FROM actions WHERE action_id=?", (proposed,)
                    ).fetchone()
                    candidate += 1
                    if collision is None:
                        action_id = proposed
                        break
                if action_id is None:
                    raise LedgerError("action id sequence is exhausted")
                cursor.execute(
                    "UPDATE action_id_sequence SET next_value=? WHERE singleton=1",
                    (candidate,),
                )
                self._connection.commit()
                return action_id
            except Exception:
                self._connection.rollback()
                raise
            finally:
                cursor.close()

    @staticmethod
    def _latest_action_row(cursor: sqlite3.Cursor, row: sqlite3.Row) -> sqlite3.Row:
        seen = set()
        current = row
        while current["status"] == "superseded":
            action_id = current["action_id"]
            replacement_action_id = current["replacement_action_id"]
            if action_id in seen or replacement_action_id is None:
                raise ActionConflict("invalid replacement action chain")
            seen.add(action_id)
            current = cursor.execute(
                "SELECT * FROM actions WHERE action_id=?", (replacement_action_id,)
            ).fetchone()
            if current is None:
                raise ActionConflict("replacement action is missing")
        return current

    def save_decision(
        self,
        *,
        decision_key: str,
        observation_fingerprint: str,
        knowledge_fingerprint: str,
        response: Dict[str, Any],
        supersedes_action_id: Optional[str] = None,
        replace_completed_decision: bool = False,
    ) -> Dict[str, Any]:
        response_json = canonical_json(response)
        action_id = response.get("action_id") if response.get("status") == "execute" else None
        now = int(time.time() * 1000)
        with self._lock:
            cursor = self._connection.cursor()
            try:
                cursor.execute("BEGIN IMMEDIATE")
                existing = cursor.execute(
                    "SELECT response_json, action_id FROM decisions WHERE decision_key=?",
                    (decision_key,),
                ).fetchone()
                replace_existing = False
                if existing is not None:
                    existing_response = json.loads(existing["response_json"])
                    if replace_completed_decision and existing_response.get("status") == "execute":
                        existing_action = cursor.execute(
                            "SELECT * FROM actions WHERE action_id=?",
                            (existing["action_id"],),
                        ).fetchone()
                        if existing_action is None:
                            raise ActionConflict("cached action is missing")
                        latest = self._latest_action_row(cursor, existing_action)
                        if latest["status"] == "completed":
                            replace_existing = True
                        else:
                            self._connection.commit()
                            return json.loads(latest["response_json"])
                    else:
                        self._connection.commit()
                        return existing_response

                if action_id is not None:
                    if supersedes_action_id is None:
                        issued = cursor.execute(
                            """
                            SELECT response_json FROM actions
                            WHERE pre_fingerprint=? AND status='issued'
                            ORDER BY created_at DESC, action_id DESC LIMIT 1
                            """,
                            (observation_fingerprint,),
                        ).fetchone()
                        if issued is not None:
                            self._connection.commit()
                            return json.loads(issued["response_json"])
                    action_row = cursor.execute(
                        "SELECT response_json FROM actions WHERE action_id=?", (action_id,)
                    ).fetchone()
                    if action_row is not None and action_row["response_json"] != response_json:
                        raise ActionConflict("action id already exists with different response")
                    if action_row is None:
                        cursor.execute(
                            """
                            INSERT INTO actions(
                                action_id, pre_fingerprint, response_json, status,
                                post_fingerprint, replacement_action_id, created_at, updated_at
                            ) VALUES (?, ?, ?, 'issued', NULL, NULL, ?, ?)
                            """,
                            (action_id, observation_fingerprint, response_json, now, now),
                        )

                if supersedes_action_id is not None:
                    old = cursor.execute(
                        "SELECT * FROM actions WHERE action_id=?", (supersedes_action_id,)
                    ).fetchone()
                    if old is None:
                        raise UnknownAction(supersedes_action_id)
                    if old["pre_fingerprint"] != observation_fingerprint:
                        raise ActionConflict("replacement prestate differs from superseded action")
                    if old["status"] == "superseded":
                        if old["replacement_action_id"] != action_id:
                            raise ActionConflict("action already superseded by a different replacement")
                    elif old["status"] != "issued":
                        raise ActionConflict(f"cannot supersede action in status {old['status']}")
                    else:
                        cursor.execute(
                            """
                            UPDATE actions
                            SET status='superseded', replacement_action_id=?, updated_at=?
                            WHERE action_id=?
                            """,
                            (action_id, now, supersedes_action_id),
                        )

                if replace_existing:
                    cursor.execute(
                        """
                        UPDATE decisions
                        SET observation_fingerprint=?, knowledge_fingerprint=?,
                            response_json=?, action_id=?, created_at=?
                        WHERE decision_key=?
                        """,
                        (
                            observation_fingerprint,
                            knowledge_fingerprint,
                            response_json,
                            action_id,
                            now,
                            decision_key,
                        ),
                    )
                else:
                    cursor.execute(
                        """
                        INSERT INTO decisions(
                            decision_key, observation_fingerprint, knowledge_fingerprint,
                            response_json, action_id, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            decision_key,
                            observation_fingerprint,
                            knowledge_fingerprint,
                            response_json,
                            action_id,
                            now,
                        ),
                    )
                self._connection.commit()
                return response
            except Exception:
                self._connection.rollback()
                raise
            finally:
                cursor.close()

    def confirm_action(self, action_id: str, post_fingerprint: str) -> ActionRecord:
        now = int(time.time() * 1000)
        with self._lock:
            cursor = self._connection.cursor()
            try:
                cursor.execute("BEGIN IMMEDIATE")
                row = cursor.execute(
                    "SELECT * FROM actions WHERE action_id=?", (action_id,)
                ).fetchone()
                if row is None:
                    raise UnknownAction(action_id)
                if row["status"] == "completed":
                    if row["post_fingerprint"] != post_fingerprint:
                        raise ActionConflict("completed action reported with a different poststate")
                elif row["status"] != "issued":
                    raise ActionConflict(f"cannot complete action in status {row['status']}")
                else:
                    cursor.execute(
                        """
                        UPDATE actions
                        SET status='completed', post_fingerprint=?, updated_at=?
                        WHERE action_id=?
                        """,
                        (post_fingerprint, now, action_id),
                    )
                self._connection.commit()
                refreshed = cursor.execute(
                    "SELECT * FROM actions WHERE action_id=?", (action_id,)
                ).fetchone()
                return self._action_from_row(refreshed)
            except Exception:
                self._connection.rollback()
                raise
            finally:
                cursor.close()

    def mark_mismatch(self, action_id: str, post_fingerprint: str) -> None:
        now = int(time.time() * 1000)
        with self._lock, self._connection:
            row = self._connection.execute(
                "SELECT status, post_fingerprint FROM actions WHERE action_id=?", (action_id,)
            ).fetchone()
            if row is None:
                raise UnknownAction(action_id)
            if row["status"] == "mismatch" and row["post_fingerprint"] == post_fingerprint:
                return
            if row["status"] != "issued":
                raise ActionConflict(f"cannot mark action in status {row['status']} as mismatch")
            self._connection.execute(
                """
                UPDATE actions SET status='mismatch', post_fingerprint=?, updated_at=?
                WHERE action_id=?
                """,
                (post_fingerprint, now, action_id),
            )
