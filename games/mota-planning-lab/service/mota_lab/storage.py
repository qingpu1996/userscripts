"""SQLite observation store and transactional action ledger."""

from __future__ import annotations

import json
import hashlib
import os
import secrets
import shutil
import sqlite3
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any, Dict, Iterator, Mapping, Optional

from .models import Guard, Observation, SessionMode
from .state import (
    canonical_json,
    historical_map_fact_payload,
    observation_fingerprint,
    observation_payload,
)


class LedgerError(RuntimeError):
    code = "LEDGER_ERROR"


class UnknownAction(LedgerError):
    code = "UNKNOWN_ACTION_ID"


class ActionConflict(LedgerError):
    code = "ACTION_STATE_CONFLICT"


class SchemaMigrationRequired(LedgerError):
    code = "STATE_SCHEMA_MIGRATION_REQUIRED"


V2_TABLE_COLUMNS = {
    "observations": {"fingerprint", "floor_id", "payload_json", "created_at", "last_seen_at", "seen_count"},
    "actions": {"action_id", "pre_fingerprint", "response_json", "status", "post_fingerprint", "replacement_action_id", "created_at", "updated_at"},
    "decisions": {"decision_key", "observation_fingerprint", "knowledge_fingerprint", "response_json", "action_id", "created_at"},
    "action_id_sequence": {"singleton", "next_value"},
    "sessions": {"session_id", "mode", "status", "expected_guard_json", "created_at", "updated_at"},
    "map_instances": {"session_id", "map_instance_id", "floor_id", "floor_number", "topology_fingerprint", "dimensions_json", "topology_json", "first_seen_at", "last_seen_at"},
    "map_snapshots": {"fingerprint", "session_id", "map_instance_id", "payload_json", "captured_at"},
    "transitions": {"session_id", "action_id", "from_map_instance_id", "to_map_instance_id", "from_x", "from_y", "to_x", "to_y", "reversible", "observed_at"},
    "frontiers": {"session_id", "map_instance_id", "x", "y", "block_id", "state", "last_snapshot_fingerprint", "updated_at"},
}

V2_EXTENSION_TABLE_COLUMNS = {
    "takeover_scans": {"session_id", "phase", "anchor_map_instance_id", "current_map_instance_id", "scanned_json", "pending_json", "traversed_json", "reason", "updated_at"},
    "scan_audit": {"sequence", "session_id", "action_id", "phase", "event", "details_json", "created_at"},
}

# SQLite's declared schema is part of the recovery ledger contract.  Names
# alone are insufficient: a counterfeit database with TEXT everywhere would
# otherwise be accepted and then mutated by WAL/DDL setup.  Values mirror
# PRAGMA table_info output as (name, declared_type, not_null, default, pk_order).
V2_TABLE_CONTRACTS = {
    "observations": (
        ("fingerprint", "TEXT", 0, None, 1), ("floor_id", "TEXT", 1, None, 0),
        ("payload_json", "TEXT", 1, None, 0), ("created_at", "INTEGER", 1, None, 0),
        ("last_seen_at", "INTEGER", 1, None, 0), ("seen_count", "INTEGER", 1, None, 0),
    ),
    "actions": (
        ("action_id", "TEXT", 0, None, 1), ("pre_fingerprint", "TEXT", 1, None, 0),
        ("response_json", "TEXT", 1, None, 0), ("status", "TEXT", 1, None, 0),
        ("post_fingerprint", "TEXT", 0, None, 0),
        ("replacement_action_id", "TEXT", 0, None, 0),
        ("created_at", "INTEGER", 1, None, 0), ("updated_at", "INTEGER", 1, None, 0),
    ),
    "decisions": (
        ("decision_key", "TEXT", 0, None, 1),
        ("observation_fingerprint", "TEXT", 1, None, 0),
        ("knowledge_fingerprint", "TEXT", 1, None, 0),
        ("response_json", "TEXT", 1, None, 0), ("action_id", "TEXT", 0, None, 0),
        ("created_at", "INTEGER", 1, None, 0),
    ),
    "action_id_sequence": (
        ("singleton", "INTEGER", 0, None, 1), ("next_value", "INTEGER", 1, None, 0),
    ),
    "sessions": (
        ("session_id", "TEXT", 0, None, 1), ("mode", "TEXT", 1, None, 0),
        ("status", "TEXT", 1, None, 0), ("expected_guard_json", "TEXT", 0, None, 0),
        ("created_at", "INTEGER", 1, None, 0), ("updated_at", "INTEGER", 1, None, 0),
    ),
    "map_instances": (
        ("session_id", "TEXT", 1, None, 1), ("map_instance_id", "TEXT", 1, None, 2),
        ("floor_id", "TEXT", 1, None, 0), ("floor_number", "INTEGER", 0, None, 0),
        ("topology_fingerprint", "TEXT", 1, None, 0),
        ("dimensions_json", "TEXT", 1, None, 0), ("topology_json", "TEXT", 1, None, 0),
        ("first_seen_at", "INTEGER", 1, None, 0), ("last_seen_at", "INTEGER", 1, None, 0),
    ),
    "map_snapshots": (
        ("fingerprint", "TEXT", 0, None, 1), ("session_id", "TEXT", 1, None, 0),
        ("map_instance_id", "TEXT", 1, None, 0), ("payload_json", "TEXT", 1, None, 0),
        ("captured_at", "INTEGER", 1, None, 0),
    ),
    "transitions": (
        ("session_id", "TEXT", 1, None, 1), ("action_id", "TEXT", 1, None, 2),
        ("from_map_instance_id", "TEXT", 1, None, 0),
        ("to_map_instance_id", "TEXT", 1, None, 0),
        ("from_x", "INTEGER", 1, None, 0), ("from_y", "INTEGER", 1, None, 0),
        ("to_x", "INTEGER", 1, None, 0), ("to_y", "INTEGER", 1, None, 0),
        ("reversible", "INTEGER", 1, "0", 0), ("observed_at", "INTEGER", 1, None, 0),
    ),
    "frontiers": (
        ("session_id", "TEXT", 1, None, 1), ("map_instance_id", "TEXT", 1, None, 2),
        ("x", "INTEGER", 1, None, 3), ("y", "INTEGER", 1, None, 4),
        ("block_id", "TEXT", 1, None, 0), ("state", "TEXT", 1, None, 0),
        ("last_snapshot_fingerprint", "TEXT", 1, None, 0),
        ("updated_at", "INTEGER", 1, None, 0),
    ),
    "takeover_scans": (
        ("session_id", "TEXT", 0, None, 1), ("phase", "TEXT", 1, None, 0),
        ("anchor_map_instance_id", "TEXT", 1, None, 0),
        ("current_map_instance_id", "TEXT", 1, None, 0),
        ("scanned_json", "TEXT", 1, None, 0), ("pending_json", "TEXT", 1, None, 0),
        ("traversed_json", "TEXT", 1, None, 0), ("reason", "TEXT", 1, None, 0),
        ("updated_at", "INTEGER", 1, None, 0),
    ),
    "scan_audit": (
        ("sequence", "INTEGER", 0, None, 1), ("session_id", "TEXT", 1, None, 0),
        ("action_id", "TEXT", 0, None, 0), ("phase", "TEXT", 1, None, 0),
        ("event", "TEXT", 1, None, 0), ("details_json", "TEXT", 1, None, 0),
        ("created_at", "INTEGER", 1, None, 0),
    ),
}

V2_FOREIGN_KEY_CONTRACTS = {
    "actions": {(0, 0, "observations", "pre_fingerprint", "fingerprint", "NO ACTION", "NO ACTION", "NONE")},
    "decisions": {(0, 0, "observations", "observation_fingerprint", "fingerprint", "NO ACTION", "NO ACTION", "NONE")},
    "map_instances": {(0, 0, "sessions", "session_id", "session_id", "NO ACTION", "NO ACTION", "NONE")},
    "map_snapshots": {
        (0, 0, "map_instances", "session_id", "session_id", "NO ACTION", "NO ACTION", "NONE"),
        (0, 1, "map_instances", "map_instance_id", "map_instance_id", "NO ACTION", "NO ACTION", "NONE"),
    },
    "takeover_scans": {(0, 0, "sessions", "session_id", "session_id", "NO ACTION", "NO ACTION", "NONE")},
    "scan_audit": {(0, 0, "sessions", "session_id", "session_id", "NO ACTION", "NO ACTION", "NONE")},
}

V2_EXPLICIT_INDEX_CONTRACTS = {
    "actions_pre_idx": ("actions", 0, "c", ("pre_fingerprint", "status")),
    "map_instances_floor_idx": (
        "map_instances", 0, "c", ("session_id", "floor_id", "topology_fingerprint")
    ),
    "scan_audit_session_idx": ("scan_audit", 0, "c", ("session_id", "sequence")),
}

V2_INDEX_SIGNATURES = {
    "observations": {(1, "pk", 0, ("fingerprint",))},
    "actions": {
        (1, "pk", 0, ("action_id",)),
        (0, "c", 0, ("pre_fingerprint", "status")),
    },
    "decisions": {(1, "pk", 0, ("decision_key",))},
    "action_id_sequence": set(),
    "sessions": {(1, "pk", 0, ("session_id",))},
    "map_instances": {
        (1, "pk", 0, ("session_id", "map_instance_id")),
        (0, "c", 0, ("session_id", "floor_id", "topology_fingerprint")),
    },
    "map_snapshots": {(1, "pk", 0, ("fingerprint",))},
    "transitions": {
        (1, "pk", 0, ("session_id", "action_id")),
        (1, "u", 0, ("action_id",)),
    },
    "frontiers": {(1, "pk", 0, ("session_id", "map_instance_id", "x", "y"))},
    "takeover_scans": {(1, "pk", 0, ("session_id",))},
    "scan_audit": {(0, "c", 0, ("session_id", "sequence"))},
}

@dataclass(frozen=True)
class ActionRecord:
    action_id: str
    pre_fingerprint: str
    response: Dict[str, Any]
    status: str
    post_fingerprint: Optional[str]
    replacement_action_id: Optional[str]


class Store:
    def __init__(self, path: Optional[Path] = None) -> None:
        self._lock = RLock()
        self._memory_only = path is None
        if self._memory_only:
            self.import_path = None
            self.path = None
            self._connection = sqlite3.connect(":memory:", check_same_thread=False)
            self._connection.row_factory = sqlite3.Row
            self._schema_classification = "v2-memory-only"
        else:
            self._initialize_persistent(Path(path))
        with self._connection:
            self._connection.execute("PRAGMA foreign_keys=ON")
            if not self._memory_only:
                self._connection.execute("PRAGMA journal_mode=WAL")
                self._connection.execute("PRAGMA synchronous=FULL")
            self._connection.executescript(
                self._schema_sql()
            )
        if not self._memory_only:
            self._schema_classification = "v2"
            self._cleanup_abandoned_candidates()

    @staticmethod
    def _schema_sql() -> str:
        return """
                CREATE TABLE IF NOT EXISTS observations (
                    fingerprint TEXT PRIMARY KEY, floor_id TEXT NOT NULL, payload_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, seen_count INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS actions (
                    action_id TEXT PRIMARY KEY, pre_fingerprint TEXT NOT NULL, response_json TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('issued','completed','mismatch','superseded')),
                    post_fingerprint TEXT, replacement_action_id TEXT, created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL, FOREIGN KEY(pre_fingerprint) REFERENCES observations(fingerprint));
                CREATE INDEX IF NOT EXISTS actions_pre_idx ON actions(pre_fingerprint, status);
                CREATE TABLE IF NOT EXISTS decisions (
                    decision_key TEXT PRIMARY KEY, observation_fingerprint TEXT NOT NULL,
                    knowledge_fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, action_id TEXT,
                    created_at INTEGER NOT NULL, FOREIGN KEY(observation_fingerprint) REFERENCES observations(fingerprint));
                CREATE TABLE IF NOT EXISTS action_id_sequence (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1), next_value INTEGER NOT NULL CHECK(next_value >= 1));
                INSERT OR IGNORE INTO action_id_sequence(singleton, next_value) VALUES (1, 1);
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL,
                    expected_guard_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS map_instances (
                    session_id TEXT NOT NULL, map_instance_id TEXT NOT NULL, floor_id TEXT NOT NULL,
                    floor_number INTEGER, topology_fingerprint TEXT NOT NULL, dimensions_json TEXT NOT NULL,
                    topology_json TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id, map_instance_id));
                CREATE INDEX IF NOT EXISTS map_instances_floor_idx ON map_instances(session_id, floor_id, topology_fingerprint);
                CREATE TABLE IF NOT EXISTS map_snapshots (
                    fingerprint TEXT PRIMARY KEY, session_id TEXT NOT NULL, map_instance_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL, captured_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS transitions (
                    session_id TEXT NOT NULL, action_id TEXT NOT NULL UNIQUE, from_map_instance_id TEXT NOT NULL,
                    to_map_instance_id TEXT NOT NULL, from_x INTEGER NOT NULL, from_y INTEGER NOT NULL,
                    to_x INTEGER NOT NULL, to_y INTEGER NOT NULL, reversible INTEGER NOT NULL DEFAULT 0,
                    observed_at INTEGER NOT NULL, PRIMARY KEY(session_id, action_id));
                CREATE TABLE IF NOT EXISTS frontiers (
                    session_id TEXT NOT NULL, map_instance_id TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
                    block_id TEXT NOT NULL, state TEXT NOT NULL, last_snapshot_fingerprint TEXT NOT NULL,
                    updated_at INTEGER NOT NULL, PRIMARY KEY(session_id, map_instance_id, x, y));
                CREATE TABLE IF NOT EXISTS takeover_scans (
                    session_id TEXT PRIMARY KEY, phase TEXT NOT NULL, anchor_map_instance_id TEXT NOT NULL,
                    current_map_instance_id TEXT NOT NULL, scanned_json TEXT NOT NULL, pending_json TEXT NOT NULL,
                    traversed_json TEXT NOT NULL, reason TEXT NOT NULL, updated_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS scan_audit (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, action_id TEXT,
                    phase TEXT NOT NULL, event TEXT NOT NULL, details_json TEXT NOT NULL, created_at INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS scan_audit_session_idx ON scan_audit(session_id, sequence);
                PRAGMA user_version=2;
                """

    def _initialize_persistent(self, path: Path) -> None:
        self.import_path = Path(path)
        self.import_path.parent.mkdir(parents=True, exist_ok=True)
        self._generation_root = self.import_path.parent / f".{self.import_path.name}.generations"
        self._manifest_path = self.import_path.parent / f".{self.import_path.name}.manifest.json"
        self._generation_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._source_path, manifest = self._authoritative_source()
        if manifest is not None:
            self._assert_import_identity(manifest["import_identity"])
        main_exists = self._source_path.exists()
        wal_exists = Path(f"{self._source_path}-wal").exists()
        shm_exists = Path(f"{self._source_path}-shm").exists()
        if not main_exists:
            if wal_exists or shm_exists:
                raise SchemaMigrationRequired("state database sidecar exists without its main file")
            self._schema_classification = "empty"
        elif not self._source_path.is_file():
            raise SchemaMigrationRequired("state database path is not a regular file")
        elif self._source_path.stat().st_size == 0:
            if wal_exists or shm_exists:
                raise SchemaMigrationRequired("empty state database has unexpected WAL sidecars")
            self._schema_classification = "empty"
        self.path = self._prepare_generation(manifest)
        # Only the private, schema-classified generation is ever opened for
        # normal SQLite operation.  The caller-supplied pathname is an immutable
        # import witness after first publication and is never reopened here.
        self._connection = sqlite3.connect(str(self.path), check_same_thread=False)
        try:
            self._assert_import_identity(self._active_import_identity)
            if self._identity_payload(self.path) != self._active_generation_identity:
                raise SchemaMigrationRequired(
                    "published generation identity changed before SQLite operation"
                )
        except Exception:
            self._connection.close()
            self._rollback_manifest_after_connect_failure()
            raise
        self._connection.row_factory = sqlite3.Row
        """Legacy persistent schema retained only for offline migration tooling.
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
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    mode TEXT NOT NULL CHECK(mode IN ('new_game','handoff_expected_guard','resume_existing_ledger')),
                    status TEXT NOT NULL CHECK(status IN ('pending','confirmed')),
                    expected_guard_json TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS map_instances (
                    session_id TEXT NOT NULL,
                    map_instance_id TEXT NOT NULL,
                    floor_id TEXT NOT NULL,
                    floor_number INTEGER,
                    topology_fingerprint TEXT NOT NULL,
                    dimensions_json TEXT NOT NULL,
                    topology_json TEXT NOT NULL,
                    first_seen_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id, map_instance_id),
                    FOREIGN KEY(session_id) REFERENCES sessions(session_id)
                );
                CREATE INDEX IF NOT EXISTS map_instances_floor_idx
                    ON map_instances(session_id, floor_id, topology_fingerprint);
                CREATE TABLE IF NOT EXISTS map_snapshots (
                    fingerprint TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    map_instance_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    captured_at INTEGER NOT NULL,
                    FOREIGN KEY(session_id, map_instance_id)
                      REFERENCES map_instances(session_id, map_instance_id)
                );
                CREATE TABLE IF NOT EXISTS transitions (
                    session_id TEXT NOT NULL,
                    action_id TEXT NOT NULL UNIQUE,
                    from_map_instance_id TEXT NOT NULL,
                    to_map_instance_id TEXT NOT NULL,
                    from_x INTEGER NOT NULL,
                    from_y INTEGER NOT NULL,
                    to_x INTEGER NOT NULL,
                    to_y INTEGER NOT NULL,
                    reversible INTEGER NOT NULL DEFAULT 0,
                    observed_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id, action_id)
                );
                CREATE TABLE IF NOT EXISTS frontiers (
                    session_id TEXT NOT NULL,
                    map_instance_id TEXT NOT NULL,
                    x INTEGER NOT NULL,
                    y INTEGER NOT NULL,
                    block_id TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('open','resolved')),
                    last_snapshot_fingerprint TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id, map_instance_id, x, y)
                );
                CREATE TABLE IF NOT EXISTS takeover_scans (
                    session_id TEXT PRIMARY KEY,
                    phase TEXT NOT NULL CHECK(phase IN ('anchor','discover','sweep','complete','paused')),
                    anchor_map_instance_id TEXT NOT NULL,
                    current_map_instance_id TEXT NOT NULL,
                    scanned_json TEXT NOT NULL,
                    pending_json TEXT NOT NULL,
                    traversed_json TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(session_id)
                );
                CREATE TABLE IF NOT EXISTS scan_audit (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    action_id TEXT,
                    phase TEXT NOT NULL,
                    event TEXT NOT NULL,
                    details_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(session_id)
                );
                CREATE INDEX IF NOT EXISTS scan_audit_session_idx
                    ON scan_audit(session_id, sequence);
                PRAGMA user_version=2;
                """

    @staticmethod
    def _identity_payload(path: Path) -> Dict[str, Any]:
        if not path.exists():
            return {"kind": "absent"}
        if not path.is_file():
            return {"kind": "not_file"}
        stat = path.stat()
        payload = path.read_bytes()
        return {
            "kind": "file",
            "device": stat.st_dev,
            "inode": stat.st_ino,
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
            "ctime_ns": stat.st_ctime_ns,
            "sha256": hashlib.sha256(payload).hexdigest(),
        }

    def _import_identity(self) -> Dict[str, Any]:
        result = {"main": self._identity_payload(self.import_path)}
        for suffix in ("-wal", "-shm"):
            result[suffix[1:]] = self._identity_payload(Path(f"{self.import_path}{suffix}"))
        return result

    def _assert_import_identity(self, expected: Mapping[str, Any]) -> None:
        if self._import_identity() != dict(expected):
            raise SchemaMigrationRequired(
                "state database import witness changed after generation publication"
            )

    def _authoritative_source(self) -> tuple[Path, Optional[Dict[str, Any]]]:
        if not self._manifest_path.exists():
            return self.import_path, None
        try:
            raw = json.loads(self._manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SchemaMigrationRequired("state generation manifest is unreadable") from exc
        if not isinstance(raw, dict) or set(raw) != {
            "protocol", "generation", "database", "import_identity", "published_at"
        } or raw.get("protocol") != 2:
            raise SchemaMigrationRequired("state generation manifest is invalid")
        generation = raw.get("generation")
        database = raw.get("database")
        if not isinstance(generation, str) or not generation.startswith("gen-") \
                or any(part in generation for part in ("/", "\\", "..")) \
                or database != "ledger.sqlite3" \
                or not isinstance(raw.get("import_identity"), dict):
            raise SchemaMigrationRequired("state generation manifest path is invalid")
        source = self._generation_root / generation / database
        if not source.is_file():
            raise SchemaMigrationRequired("published state generation is missing")
        return source, raw

    def _publish_manifest(
        self,
        generation_name: str,
        import_identity: Mapping[str, Any],
    ) -> None:
        payload = {
            "protocol": 2,
            "generation": generation_name,
            "database": "ledger.sqlite3",
            "import_identity": dict(import_identity),
            "published_at": int(time.time() * 1000),
        }
        temporary = self._manifest_path.with_name(
            f".{self._manifest_path.name}.tmp-{secrets.token_hex(8)}"
        )
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self._manifest_path)
            self._fsync_directory(self._manifest_path.parent)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _fsync_directory(directory: Path) -> None:
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _prepare_generation(self, previous_manifest: Optional[Dict[str, Any]]) -> Path:
        import_identity = self._import_identity() if previous_manifest is None \
            else dict(previous_manifest["import_identity"])
        self._active_import_identity = import_identity
        candidate_name = f".candidate-{secrets.token_hex(16)}"
        candidate_directory = self._generation_root / candidate_name
        candidate_directory.mkdir(mode=0o700)
        candidate_main = candidate_directory / "ledger.sqlite3"
        old_manifest = self._manifest_path.read_bytes() if self._manifest_path.exists() else None
        self._previous_manifest_bytes = old_manifest
        final_directory: Optional[Path] = None
        published = False
        try:
            if self._source_path.exists() and self._source_path.stat().st_size > 0:
                with self._capture_private_snapshot() as snapshot_path:
                    for suffix in ("", "-wal", "-shm"):
                        source = Path(f"{snapshot_path}{suffix}")
                        if source.exists():
                            shutil.copyfile(source, Path(f"{candidate_main}{suffix}"))
                    snapshot = sqlite3.connect(str(candidate_main), check_same_thread=False)
                    snapshot.row_factory = sqlite3.Row
                    self._connection = snapshot
                    try:
                        self._schema_classification = self._classify_schema_before_write()
                    finally:
                        snapshot.close()
                        self.__dict__.pop("_connection", None)
            else:
                candidate_main.touch(mode=0o600)
                self._schema_classification = "empty"

            # No source pathname is opened after this point.  A source swap can
            # only cause rejection; it can never redirect SQLite to that inode.
            if previous_manifest is None:
                self._assert_import_identity(import_identity)
            else:
                self._assert_import_identity(previous_manifest["import_identity"])
                if self._identity_payload(self._source_path) != self._captured_main_identity:
                    raise SchemaMigrationRequired("published generation changed after classification")

            generation_name = f"gen-{secrets.token_hex(16)}"
            final_directory = self._generation_root / generation_name
            os.replace(candidate_directory, final_directory)
            self._fsync_directory(self._generation_root)
            self._publish_manifest(generation_name, import_identity)
            published = True
            self._published_generation_directory = final_directory
            # Detect swaps injected during publication.  Even if this check
            # fails, the replacement was never opened and remains untouched.
            self._assert_import_identity(import_identity)
            active_main = final_directory / "ledger.sqlite3"
            self._active_generation_identity = self._identity_payload(active_main)
            return active_main
        except sqlite3.DatabaseError as exc:
            raise SchemaMigrationRequired(
                "state database is not a recognized SQLite schema"
            ) from exc
        except Exception:
            if published:
                if old_manifest is None:
                    self._manifest_path.unlink(missing_ok=True)
                else:
                    rollback = self._manifest_path.with_name(
                        f".{self._manifest_path.name}.rollback-{secrets.token_hex(8)}"
                    )
                    rollback.write_bytes(old_manifest)
                    os.replace(rollback, self._manifest_path)
                published = False
            raise
        finally:
            self.__dict__.pop("_connection", None)
            if candidate_directory.exists():
                shutil.rmtree(candidate_directory, ignore_errors=True)
            if final_directory is not None and final_directory.exists() and not published:
                shutil.rmtree(final_directory, ignore_errors=True)

    def _cleanup_abandoned_candidates(self) -> None:
        for item in self._generation_root.iterdir():
            if item.is_dir() and item.name.startswith(".candidate-"):
                shutil.rmtree(item, ignore_errors=True)

    def _rollback_manifest_after_connect_failure(self) -> None:
        """Restore the prior authority pointer without deleting swap evidence."""
        old_manifest = getattr(self, "_previous_manifest_bytes", None)
        if old_manifest is None:
            self._manifest_path.unlink(missing_ok=True)
        else:
            rollback = self._manifest_path.with_name(
                f".{self._manifest_path.name}.connect-rollback-{secrets.token_hex(8)}"
            )
            rollback.write_bytes(old_manifest)
            os.replace(rollback, self._manifest_path)
        self._fsync_directory(self._manifest_path.parent)

    @staticmethod
    def _file_signature(path: Path) -> tuple[int, int, int, int, int]:
        stat = path.stat()
        return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)

    @contextmanager
    def _capture_private_snapshot(self) -> Iterator[Path]:
        """Capture main/WAL/SHM without ever opening the original database.

        SQLite read-only connections may still update a shared-memory file.
        Classification therefore operates only on a bounded, double-read
        snapshot whose file identities, metadata and content hashes were stable
        throughout capture.  An incomplete WAL pair or any other live SQLite
        sidecar is ambiguous and fails closed.
        """

        main = self._source_path
        wal = Path(f"{self._source_path}-wal")
        shm = Path(f"{self._source_path}-shm")
        prefix = f"{self._source_path.name}-"
        captured: Optional[Dict[Path, bytes]] = None
        captured_signatures: Optional[Dict[Path, tuple[int, int, int, int, int]]] = None
        captured_siblings: tuple[str, ...] = ()
        for _attempt in range(3):
            siblings_before = tuple(sorted(
                item.name for item in main.parent.iterdir()
                if item.name.startswith(prefix)
            ))
            extras = tuple(name for name in siblings_before if name not in {wal.name, shm.name})
            if extras:
                raise SchemaMigrationRequired(
                    "state database has unsupported live sidecars: " + ", ".join(extras)
                )
            if wal.exists() != shm.exists():
                raise SchemaMigrationRequired("state database WAL/SHM sidecar set is incomplete")
            paths = (main, wal, shm) if wal.exists() else (main,)
            try:
                before = {item: self._file_signature(item) for item in paths}
                first = {item: item.read_bytes() for item in paths}
                middle = {item: self._file_signature(item) for item in paths}
                second = {item: item.read_bytes() for item in paths}
                after = {item: self._file_signature(item) for item in paths}
            except (FileNotFoundError, OSError):
                continue
            siblings_after = tuple(sorted(
                item.name for item in main.parent.iterdir()
                if item.name.startswith(prefix)
            ))
            first_hashes = {item: hashlib.sha256(value).digest() for item, value in first.items()}
            second_hashes = {item: hashlib.sha256(value).digest() for item, value in second.items()}
            if (siblings_before == siblings_after and before == middle == after
                    and first_hashes == second_hashes):
                captured = first
                captured_signatures = before
                captured_siblings = siblings_before
                break
        if captured is None:
            raise SchemaMigrationRequired("state database files changed during private snapshot")
        if wal in captured:
            wal_payload = captured[wal]
            shm_payload = captured[shm]
            if len(wal_payload) < 32:
                raise SchemaMigrationRequired("state database WAL header is truncated")
            magic = int.from_bytes(wal_payload[0:4], "big")
            page_size = int.from_bytes(wal_payload[8:12], "big")
            if page_size == 1:
                page_size = 65536
            frame_size = 24 + page_size
            if (magic not in {0x377F0682, 0x377F0683}
                    or page_size < 512 or page_size > 65536
                    or page_size & (page_size - 1)
                    or (len(wal_payload) - 32) % frame_size != 0):
                raise SchemaMigrationRequired("state database WAL framing is invalid or truncated")
            if len(shm_payload) < 32768 or len(shm_payload) % 32768 != 0:
                raise SchemaMigrationRequired("state database SHM sidecar is invalid or truncated")

        with tempfile.TemporaryDirectory(prefix="mota-lab-schema-snapshot-") as directory:
            snapshot_main = Path(directory) / main.name
            for source, payload in captured.items():
                destination = snapshot_main if source == main \
                    else Path(f"{snapshot_main}{source.name[len(main.name):]}")
                destination.write_bytes(payload)
            yield snapshot_main
            try:
                verify_before = {
                    item: self._file_signature(item) for item in captured
                }
                verify_payloads = {item: item.read_bytes() for item in captured}
                verify_after = {
                    item: self._file_signature(item) for item in captured
                }
                verify_siblings = tuple(sorted(
                    item.name for item in main.parent.iterdir()
                    if item.name.startswith(prefix)
                ))
            except (FileNotFoundError, OSError) as exc:
                raise SchemaMigrationRequired(
                    "state database changed while classifying its private snapshot"
                ) from exc
            verify_hashes = {
                item: hashlib.sha256(value).digest()
                for item, value in verify_payloads.items()
            }
            captured_hashes = {
                item: hashlib.sha256(value).digest()
                for item, value in captured.items()
            }
            if (verify_before != captured_signatures or verify_after != captured_signatures
                    or verify_hashes != captured_hashes
                    or verify_siblings != captured_siblings):
                raise SchemaMigrationRequired(
                    "state database changed while classifying its private snapshot"
                )
            main_signature = captured_signatures[main]
            self._captured_main_identity = {
                "kind": "file",
                "device": main_signature[0],
                "inode": main_signature[1],
                "size": main_signature[2],
                "mtime_ns": main_signature[3],
                "ctime_ns": main_signature[4],
                "sha256": hashlib.sha256(captured[main]).hexdigest(),
            }

    def _classify_schema_before_write(self) -> str:
        """Classify without DDL or write-affecting pragmas.

        A legacy or unknown database is evidence, not a cache.  It must remain
        byte-for-byte untouched until the user selects a new state root or an
        audited migration tool is provided.
        """

        version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
        rows = self._connection.execute(
            "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
        ).fetchall()
        objects = {(str(row["type"]), str(row["name"])) for row in rows}
        tables = {name for kind, name in objects if kind == "table"}
        non_table_objects = {(kind, name) for kind, name in objects if kind not in {"table", "index"}}
        if version > 2:
            raise SchemaMigrationRequired(f"state database user_version {version} is newer than protocol 2")
        if version in {0, 1}:
            if version == 0 and not objects:
                return "empty"
            raise SchemaMigrationRequired(
                f"legacy/non-empty state database user_version {version}; use a new state root"
            )
        if version != 2:
            raise SchemaMigrationRequired(f"unsupported state database user_version {version}")
        if non_table_objects:
            raise SchemaMigrationRequired("protocol 2 state database contains unknown schema objects")
        required = set(V2_TABLE_CONTRACTS)
        if tables != required:
            raise SchemaMigrationRequired("protocol 2 state database table set is incomplete or unknown")
        for table, expected in V2_TABLE_CONTRACTS.items():
            extended_columns = self._connection.execute(
                f'PRAGMA table_xinfo("{table}")'
            ).fetchall()
            if len(extended_columns) != len(expected) or any(
                int(row["hidden"]) != 0 for row in extended_columns
            ):
                raise SchemaMigrationRequired(
                    f"protocol 2 table {table} contains hidden/generated or extra columns"
                )
            columns = tuple(
                (
                    str(row["name"]), str(row["type"]).upper(), int(row["notnull"]),
                    None if row["dflt_value"] is None else str(row["dflt_value"]), int(row["pk"]),
                )
                for row in self._connection.execute(f'PRAGMA table_info("{table}")').fetchall()
            )
            if columns != expected:
                raise SchemaMigrationRequired(f"protocol 2 table {table} violates the column contract")

            foreign_keys = {
                (
                    int(row["id"]), int(row["seq"]), str(row["table"]), str(row["from"]),
                    str(row["to"]), str(row["on_update"]), str(row["on_delete"]), str(row["match"]),
                )
                for row in self._connection.execute(f'PRAGMA foreign_key_list("{table}")').fetchall()
            }
            if foreign_keys != V2_FOREIGN_KEY_CONTRACTS.get(table, set()):
                raise SchemaMigrationRequired(f"protocol 2 table {table} violates the foreign-key contract")

            index_signatures = set()
            for index_row in self._connection.execute(f'PRAGMA index_list("{table}")').fetchall():
                index_columns = tuple(
                    str(column["name"])
                    for column in self._connection.execute(
                        f'PRAGMA index_info("{str(index_row["name"])}")'
                    ).fetchall()
                )
                index_signatures.add((
                    int(index_row["unique"]), str(index_row["origin"]),
                    int(index_row["partial"]), index_columns,
                ))
            if index_signatures != V2_INDEX_SIGNATURES[table]:
                raise SchemaMigrationRequired(
                    f"protocol 2 table {table} violates its PK/UNIQUE/index contract"
                )

        explicit_indexes = {
            str(row["name"]): str(row["tbl_name"])
            for row in self._connection.execute(
                "SELECT name,tbl_name FROM sqlite_master "
                "WHERE type='index' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
        if set(explicit_indexes) != set(V2_EXPLICIT_INDEX_CONTRACTS):
            raise SchemaMigrationRequired("protocol 2 explicit index set is incomplete or unknown")
        for index_name, (table, unique, origin, expected_columns) in V2_EXPLICIT_INDEX_CONTRACTS.items():
            if explicit_indexes[index_name] != table:
                raise SchemaMigrationRequired(f"protocol 2 index {index_name} belongs to the wrong table")
            listed = {
                str(row["name"]): (int(row["unique"]), str(row["origin"]), int(row["partial"]))
                for row in self._connection.execute(f'PRAGMA index_list("{table}")').fetchall()
            }
            if listed.get(index_name) != (unique, origin, 0):
                raise SchemaMigrationRequired(f"protocol 2 index {index_name} violates its index contract")
            index_columns = tuple(
                str(row["name"])
                for row in self._connection.execute(f'PRAGMA index_info("{index_name}")').fetchall()
            )
            if index_columns != expected_columns:
                raise SchemaMigrationRequired(f"protocol 2 index {index_name} has wrong columns")

        transition_unique = []
        for row in self._connection.execute('PRAGMA index_list("transitions")').fetchall():
            if str(row["origin"]) != "u" or int(row["unique"]) != 1 or int(row["partial"]) != 0:
                continue
            transition_unique.append(tuple(
                str(column["name"])
                for column in self._connection.execute(
                    f'PRAGMA index_info("{str(row["name"])}")'
                ).fetchall()
            ))
        if transition_unique != [("action_id",)]:
            raise SchemaMigrationRequired("protocol 2 transitions.action_id UNIQUE contract is missing")

        sequence_rows = self._connection.execute(
            "SELECT singleton,next_value FROM action_id_sequence"
        ).fetchall()
        if len(sequence_rows) != 1 or int(sequence_rows[0]["singleton"]) != 1 \
                or int(sequence_rows[0]["next_value"]) < 1:
            raise SchemaMigrationRequired("protocol 2 action id sequence invariant is invalid")
        self._probe_schema_constraints_read_only()
        return "v2"

    def _probe_schema_constraints_read_only(self) -> None:
        """Probe behavior only in a private in-memory backup, never in the state DB."""
        probe = sqlite3.connect(":memory:")
        try:
            self._connection.backup(probe)
            probe.execute("PRAGMA foreign_keys=ON")
            probe.execute(
                "INSERT INTO observations VALUES('__probe_obs__','F','{}',1,1,1)"
            )
            probe.execute(
                "INSERT INTO sessions VALUES('__probe_session__','new_game','confirmed',NULL,1,1)"
            )

            def must_reject(sql: str, parameters: tuple[Any, ...]) -> None:
                probe.execute("SAVEPOINT schema_contract_probe")
                try:
                    probe.execute(sql, parameters)
                except sqlite3.IntegrityError:
                    probe.execute("ROLLBACK TO schema_contract_probe")
                    probe.execute("RELEASE schema_contract_probe")
                    return
                except sqlite3.DatabaseError as exc:
                    probe.execute("ROLLBACK TO schema_contract_probe")
                    probe.execute("RELEASE schema_contract_probe")
                    raise SchemaMigrationRequired("protocol 2 constraint probe failed") from exc
                probe.execute("ROLLBACK TO schema_contract_probe")
                probe.execute("RELEASE schema_contract_probe")
                raise SchemaMigrationRequired("protocol 2 CHECK constraint is missing or too broad")

            must_reject(
                "INSERT INTO actions VALUES(?,?,?,?,?,?,?,?)",
                ("__probe_action__", "__probe_obs__", "{}", "INVALID", None, None, 1, 1),
            )
            must_reject("INSERT INTO action_id_sequence VALUES(?,?)", (2, 1))
            must_reject("UPDATE action_id_sequence SET next_value=? WHERE singleton=1", (0,))
            must_reject(
                "INSERT INTO sessions VALUES(?,?,?,?,?,?)",
                ("__bad_mode__", "invalid", "confirmed", None, 1, 1),
            )
            must_reject(
                "INSERT INTO sessions VALUES(?,?,?,?,?,?)",
                ("__bad_status__", "new_game", "invalid", None, 1, 1),
            )
            must_reject(
                "INSERT INTO frontiers VALUES(?,?,?,?,?,?,?,?)",
                ("__probe_session__", "M", 0, 0, "x", "invalid", "fp", 1),
            )
            must_reject(
                "INSERT INTO takeover_scans VALUES(?,?,?,?,?,?,?,?,?)",
                ("__probe_session__", "invalid", "M", "M", "[]", "[]", "[]", "x", 1),
            )

            if probe.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'"
            ).fetchone() is None:
                raise SchemaMigrationRequired("protocol 2 scan_audit AUTOINCREMENT contract is missing")
            probe.execute(
                "INSERT INTO scan_audit(session_id,action_id,phase,event,details_json,created_at) "
                "VALUES('__probe_session__',NULL,'anchor','probe','{}',1)"
            )
            first = int(probe.execute("SELECT max(sequence) FROM scan_audit").fetchone()[0])
            probe.execute("DELETE FROM scan_audit WHERE sequence=?", (first,))
            probe.execute(
                "INSERT INTO scan_audit(session_id,action_id,phase,event,details_json,created_at) "
                "VALUES('__probe_session__',NULL,'anchor','probe2','{}',2)"
            )
            second = int(probe.execute("SELECT max(sequence) FROM scan_audit").fetchone()[0])
            if second <= first:
                raise SchemaMigrationRequired("protocol 2 scan_audit AUTOINCREMENT behavior is missing")
        finally:
            probe.close()

    def schema_diagnostics(self) -> Dict[str, Any]:
        with self._lock:
            version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
            tables = [
                str(row[0])
                for row in self._connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                ).fetchall()
            ]
        return {"classification": "v2", "user_version": version, "tables": tables}

    def ensure_session(
        self,
        session_id: str,
        mode: SessionMode,
        expected_guard: Optional[Guard],
        *,
        confirm: bool,
    ) -> str:
        now = int(time.time() * 1000)
        expected_json = None if expected_guard is None else canonical_json(expected_guard.model_dump(mode="json"))
        with self._lock, self._connection:
            row = self._connection.execute(
                "SELECT mode, status, expected_guard_json FROM sessions WHERE session_id=?",
                (session_id,),
            ).fetchone()
            if row is None:
                if mode == "resume_existing_ledger":
                    raise ActionConflict("resume_existing_ledger requires an existing session")
                status = "confirmed" if confirm else "pending"
                self._connection.execute(
                    "INSERT INTO sessions VALUES (?,?,?,?,?,?)",
                    (session_id, mode, status, expected_json, now, now),
                )
                return status
            if mode == "resume_existing_ledger":
                return str(row["status"])
            if row["mode"] != mode or row["expected_guard_json"] != expected_json:
                raise ActionConflict("session mode or expected guard changed")
            if confirm and row["status"] != "confirmed":
                self._connection.execute(
                    "UPDATE sessions SET status='confirmed', updated_at=? WHERE session_id=?",
                    (now, session_id),
                )
                return "confirmed"
            return str(row["status"])

    def session_status(self, session_id: str) -> Optional[str]:
        with self._lock:
            row = self._connection.execute(
                "SELECT status FROM sessions WHERE session_id=?", (session_id,)
            ).fetchone()
        return None if row is None else str(row["status"])

    @staticmethod
    def _scan_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "phase": str(row["phase"]),
            "anchor_map_instance_id": str(row["anchor_map_instance_id"]),
            "current_map_instance_id": str(row["current_map_instance_id"]),
            "scanned_map_instance_ids": json.loads(row["scanned_json"]),
            "pending_exits": json.loads(row["pending_json"]),
            "traversed_transitions": json.loads(row["traversed_json"]),
            "reason": str(row["reason"]),
            "updated_at": int(row["updated_at"]),
        }

    def get_scan_state(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM takeover_scans WHERE session_id=?", (session_id,)
            ).fetchone()
        return None if row is None else self._scan_from_row(row)

    @staticmethod
    def _ensure_scan_with_cursor(
        cursor: sqlite3.Cursor, observation: Observation, now: int
    ) -> None:
        row = cursor.execute(
            "SELECT scanned_json FROM takeover_scans WHERE session_id=?",
            (observation.session_id,),
        ).fetchone()
        if row is None:
            scanned = [observation.map_instance_id]
            cursor.execute(
                """INSERT INTO takeover_scans(
                   session_id,phase,anchor_map_instance_id,current_map_instance_id,
                   scanned_json,pending_json,traversed_json,reason,updated_at)
                   VALUES (?,'anchor',?,?,?,'[]','[]',?,?)""",
                (
                    observation.session_id,
                    observation.map_instance_id,
                    observation.map_instance_id,
                    canonical_json(scanned),
                    "takeover scan anchored at the first confirmed runtime map",
                    now,
                ),
            )
            cursor.execute(
                """INSERT INTO scan_audit(session_id,action_id,phase,event,details_json,created_at)
                   VALUES (?,NULL,'anchor','scan_started',?,?)""",
                (
                    observation.session_id,
                    canonical_json({
                        "map_instance_id": observation.map_instance_id,
                        "floor_number_hint": observation.floor_number,
                    }),
                    now,
                ),
            )
            return
        scanned = list(json.loads(row["scanned_json"]))
        if observation.map_instance_id not in scanned:
            scanned.append(observation.map_instance_id)
        cursor.execute(
            """UPDATE takeover_scans SET current_map_instance_id=?,scanned_json=?,updated_at=?
               WHERE session_id=?""",
            (
                observation.map_instance_id,
                canonical_json(sorted(set(scanned))),
                now,
                observation.session_id,
            ),
        )

    def save_scan_state(
        self,
        session_id: str,
        state: Mapping[str, Any],
        *,
        event: str,
        action_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        now = int(time.time() * 1000)
        scanned = sorted(set(str(item) for item in state["scanned_map_instance_ids"]))
        pending = list(state.get("pending_exits", []))
        traversed = list(state.get("traversed_transitions", []))
        reason = str(state["reason"])
        with self._lock:
            cursor = self._connection.cursor()
            try:
                cursor.execute("BEGIN IMMEDIATE")
                existing = cursor.execute(
                    "SELECT 1 FROM takeover_scans WHERE session_id=?", (session_id,)
                ).fetchone()
                if existing is None:
                    raise ActionConflict("takeover scan is not initialized")
                cursor.execute(
                    """UPDATE takeover_scans SET phase=?,anchor_map_instance_id=?,
                       current_map_instance_id=?,scanned_json=?,pending_json=?,traversed_json=?,
                       reason=?,updated_at=? WHERE session_id=?""",
                    (
                        state["phase"], state["anchor_map_instance_id"],
                        state["current_map_instance_id"], canonical_json(scanned),
                        canonical_json(pending), canonical_json(traversed), reason, now, session_id,
                    ),
                )
                cursor.execute(
                    """INSERT INTO scan_audit(session_id,action_id,phase,event,details_json,created_at)
                       VALUES (?,?,?,?,?,?)""",
                    (
                        session_id, action_id, state["phase"], event,
                        canonical_json({"pending": len(pending), "reason": reason}), now,
                    ),
                )
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
            finally:
                cursor.close()
        result = self.get_scan_state(session_id)
        if result is None:
            raise ActionConflict("takeover scan disappeared")
        return result

    def scan_audit_for_session(self, session_id: str) -> list[Dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM scan_audit WHERE session_id=? ORDER BY sequence", (session_id,)
            ).fetchall()
        return [dict(row) for row in rows]

    def record_world_snapshot(self, observation: Observation, fingerprint: str) -> None:
        now = int(time.time() * 1000)
        with self._lock, self._connection:
            existing = self._connection.execute(
                """SELECT floor_id,topology_fingerprint,dimensions_json FROM map_instances
                   WHERE session_id=? AND map_instance_id=?""",
                (observation.session_id, observation.map_instance_id),
            ).fetchone()
            dimensions_json = canonical_json(observation.dimensions.model_dump(mode="json"))
            if existing is not None and (
                existing["floor_id"] != observation.floor_id
                or existing["topology_fingerprint"] != observation.topology_fingerprint
                or existing["dimensions_json"] != dimensions_json
            ):
                raise ActionConflict(
                    "map_instance_id is immutable; topology revision requires a new instance id"
                )
            self._connection.execute(
                """
                INSERT INTO map_instances(
                    session_id,map_instance_id,floor_id,floor_number,topology_fingerprint,
                    dimensions_json,topology_json,first_seen_at,last_seen_at
                ) VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(session_id,map_instance_id) DO UPDATE SET
                    last_seen_at=excluded.last_seen_at,
                    floor_id=excluded.floor_id,
                    topology_fingerprint=excluded.topology_fingerprint,
                    dimensions_json=excluded.dimensions_json,
                    topology_json=excluded.topology_json
                """,
                (
                    observation.session_id, observation.map_instance_id, observation.floor_id,
                    observation.floor_number, observation.topology_fingerprint,
                    dimensions_json,
                    canonical_json(observation.topology.model_dump(mode="json", exclude_unset=True)),
                    now, now,
                ),
            )
            self._connection.execute(
                "INSERT OR IGNORE INTO map_snapshots VALUES (?,?,?,?,?)",
                (fingerprint, observation.session_id, observation.map_instance_id,
                 canonical_json(observation_payload(observation)), observation.captured_at),
            )

    def record_transition(self, action_id: str, pre: Observation, post: Observation) -> None:
        if pre.session_id != post.session_id:
            raise ActionConflict("completed action cannot cross sessions")
        if pre.map_instance_id == post.map_instance_id:
            return
        now = int(time.time() * 1000)
        with self._lock, self._connection:
            existing = self._connection.execute(
                "SELECT * FROM transitions WHERE session_id=? AND action_id=?",
                (pre.session_id, action_id),
            ).fetchone()
            endpoints = (
                pre.map_instance_id, post.map_instance_id,
                pre.hero.loc.x, pre.hero.loc.y, post.hero.loc.x, post.hero.loc.y,
            )
            if existing is not None:
                recorded = (
                    existing["from_map_instance_id"], existing["to_map_instance_id"],
                    existing["from_x"], existing["from_y"], existing["to_x"], existing["to_y"],
                )
                if recorded != endpoints:
                    raise ActionConflict("transition action id is already bound to other endpoints")
                return
            reverse = self._connection.execute(
                """SELECT action_id FROM transitions WHERE session_id=?
                   AND from_map_instance_id=? AND to_map_instance_id=?
                   AND from_x=? AND from_y=? AND to_x=? AND to_y=? LIMIT 1""",
                (
                    pre.session_id, post.map_instance_id, pre.map_instance_id,
                    post.hero.loc.x, post.hero.loc.y, pre.hero.loc.x, pre.hero.loc.y,
                ),
            ).fetchone()
            self._connection.execute(
                """INSERT OR IGNORE INTO transitions(
                    session_id,action_id,from_map_instance_id,to_map_instance_id,
                    from_x,from_y,to_x,to_y,reversible,observed_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (pre.session_id, action_id, pre.map_instance_id, post.map_instance_id,
                 pre.hero.loc.x, pre.hero.loc.y, post.hero.loc.x, post.hero.loc.y,
                 1 if reverse else 0, now),
            )
            if reverse:
                self._connection.execute(
                    "UPDATE transitions SET reversible=1 WHERE session_id=? AND action_id=?",
                    (pre.session_id, reverse["action_id"]),
                )

    def transitions_for_session(self, session_id: str) -> list[Dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM transitions WHERE session_id=? ORDER BY observed_at, action_id",
                (session_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def sync_frontiers(
        self,
        observation: Observation,
        snapshot_fingerprint: str,
        frontier_coordinates: set[tuple[int, int]],
    ) -> None:
        now = int(time.time() * 1000)
        blocks = {(block.x, block.y): block for block in observation.blocks}
        with self._lock, self._connection:
            self._connection.execute(
                """UPDATE frontiers SET state='resolved',updated_at=? WHERE
                   session_id=? AND map_instance_id=? AND state='open'""",
                (now, observation.session_id, observation.map_instance_id),
            )
            for coordinate in sorted(frontier_coordinates):
                block = blocks[coordinate]
                self._connection.execute(
                    """INSERT INTO frontiers(session_id,map_instance_id,x,y,block_id,state,
                       last_snapshot_fingerprint,updated_at) VALUES (?,?,?,?,?,'open',?,?)
                       ON CONFLICT(session_id,map_instance_id,x,y) DO UPDATE SET
                       block_id=excluded.block_id,state='open',
                       last_snapshot_fingerprint=excluded.last_snapshot_fingerprint,
                       updated_at=excluded.updated_at""",
                    (observation.session_id, observation.map_instance_id, block.x, block.y,
                     block.id, snapshot_fingerprint, now),
                )

    def frontiers_for_session(self, session_id: str, *, state: str = "open") -> list[Dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM frontiers WHERE session_id=? AND state=? ORDER BY map_instance_id,y,x",
                (session_id, state),
            ).fetchall()
        return [dict(row) for row in rows]

    def map_instances_for_session(self, session_id: str) -> list[Dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM map_instances WHERE session_id=? ORDER BY first_seen_at,map_instance_id",
                (session_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def latest_map_facts(self, session_id: str) -> list[Dict[str, Any]]:
        """Return latest revisioned map facts without historical hero/resources."""
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT fingerprint,map_instance_id,payload_json FROM map_snapshots
                WHERE session_id=? ORDER BY captured_at DESC,rowid DESC
                """,
                (session_id,),
            ).fetchall()
        latest: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            if row["map_instance_id"] in latest:
                continue
            observation = Observation.model_validate(json.loads(row["payload_json"]))
            latest[row["map_instance_id"]] = historical_map_fact_payload(
                observation, str(row["fingerprint"])
            )
        return list(latest.values())

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def ingest_observation(
        self,
        observation: Observation,
        mode: SessionMode,
        expected_guard: Optional[Guard],
        *,
        confirm: bool,
    ) -> tuple[str, str]:
        """Atomically establish the session and persist observation/world state."""
        fingerprint = observation_fingerprint(observation)
        payload_json = canonical_json(observation_payload(observation))
        expected_json = None if expected_guard is None else canonical_json(expected_guard.model_dump(mode="json"))
        dimensions_json = canonical_json(observation.dimensions.model_dump(mode="json"))
        topology_json = canonical_json(observation.topology.model_dump(mode="json", exclude_unset=True))
        now = int(time.time() * 1000)
        with self._lock:
            cursor = self._connection.cursor()
            try:
                cursor.execute("BEGIN IMMEDIATE")
                session = cursor.execute(
                    "SELECT mode,status,expected_guard_json FROM sessions WHERE session_id=?",
                    (observation.session_id,),
                ).fetchone()
                if session is None:
                    if mode == "resume_existing_ledger":
                        raise ActionConflict("resume_existing_ledger requires an existing session")
                    status = "confirmed" if confirm else "pending"
                    cursor.execute(
                        "INSERT INTO sessions VALUES (?,?,?,?,?,?)",
                        (observation.session_id, mode, status, expected_json, now, now),
                    )
                elif mode == "resume_existing_ledger":
                    status = str(session["status"])
                else:
                    if session["mode"] != mode or session["expected_guard_json"] != expected_json:
                        raise ActionConflict("session mode or expected guard changed")
                    status = "confirmed" if confirm else str(session["status"])
                    if confirm and session["status"] != "confirmed":
                        cursor.execute(
                            "UPDATE sessions SET status='confirmed',updated_at=? WHERE session_id=?",
                            (now, observation.session_id),
                        )
                cursor.execute(
                    """INSERT INTO observations(fingerprint,floor_id,payload_json,created_at,last_seen_at,seen_count)
                       VALUES (?,?,?,?,?,1) ON CONFLICT(fingerprint) DO UPDATE SET
                       last_seen_at=excluded.last_seen_at,seen_count=observations.seen_count+1""",
                    (fingerprint, observation.floor_id, payload_json, now, now),
                )
                instance = cursor.execute(
                    """SELECT floor_id,topology_fingerprint,dimensions_json FROM map_instances
                       WHERE session_id=? AND map_instance_id=?""",
                    (observation.session_id, observation.map_instance_id),
                ).fetchone()
                if instance is not None and (
                    instance["floor_id"] != observation.floor_id
                    or instance["topology_fingerprint"] != observation.topology_fingerprint
                    or instance["dimensions_json"] != dimensions_json
                ):
                    raise ActionConflict(
                        "map_instance_id is immutable; topology revision requires a new instance id"
                    )
                cursor.execute(
                    """INSERT INTO map_instances(
                       session_id,map_instance_id,floor_id,floor_number,topology_fingerprint,
                       dimensions_json,topology_json,first_seen_at,last_seen_at)
                       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,map_instance_id)
                       DO UPDATE SET last_seen_at=excluded.last_seen_at""",
                    (observation.session_id, observation.map_instance_id, observation.floor_id,
                     observation.floor_number, observation.topology_fingerprint, dimensions_json,
                     topology_json, now, now),
                )
                cursor.execute(
                    "INSERT OR IGNORE INTO map_snapshots VALUES (?,?,?,?,?)",
                    (fingerprint, observation.session_id, observation.map_instance_id,
                     payload_json, observation.captured_at),
                )
                if status == "confirmed":
                    self._ensure_scan_with_cursor(cursor, observation, now)
                self._connection.commit()
                return fingerprint, status
            except Exception:
                self._connection.rollback()
                raise
            finally:
                cursor.close()

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

    @staticmethod
    def _issued_rows_for_session(cursor: sqlite3.Cursor, session_id: str) -> list[sqlite3.Row]:
        return cursor.execute(
            """
            SELECT DISTINCT actions.* FROM actions
            JOIN map_snapshots ON map_snapshots.fingerprint=actions.pre_fingerprint
            WHERE map_snapshots.session_id=? AND actions.status='issued'
            ORDER BY actions.created_at,actions.action_id
            """,
            (session_id,),
        ).fetchall()

    def issued_action_for_session(self, session_id: str) -> Optional[ActionRecord]:
        with self._lock:
            rows = self._issued_rows_for_session(self._connection.cursor(), session_id)
        if len(rows) > 1:
            raise ActionConflict("session has multiple unresolved issued actions")
        return None if not rows else self._action_from_row(rows[0])

    def unresolved_action_count(self, session_id: str) -> int:
        with self._lock:
            rows = self._issued_rows_for_session(self._connection.cursor(), session_id)
        return len(rows)

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
                    session_row = cursor.execute(
                        "SELECT session_id FROM map_snapshots WHERE fingerprint=?",
                        (observation_fingerprint,),
                    ).fetchone()
                    if session_row is None:
                        raise ActionConflict("action prestate is not linked to a session snapshot")
                    session_issued = self._issued_rows_for_session(
                        cursor, str(session_row["session_id"])
                    )
                    if len(session_issued) > 1:
                        raise ActionConflict("session already has multiple unresolved issued actions")
                    if session_issued:
                        unresolved_id = str(session_issued[0]["action_id"])
                        if action_id == unresolved_id:
                            if session_issued[0]["response_json"] != response_json:
                                raise ActionConflict("issued action id has conflicting response bytes")
                        elif supersedes_action_id != unresolved_id:
                            raise ActionConflict(
                                "session already has an unresolved issued action"
                            )
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

    def confirm_action_and_transition(
        self,
        action_id: str,
        post_fingerprint: str,
        pre: Observation,
        post: Observation,
    ) -> ActionRecord:
        if pre.session_id != post.session_id:
            raise ActionConflict("completed action cannot cross sessions")
        now = int(time.time() * 1000)
        with self._lock:
            cursor = self._connection.cursor()
            try:
                cursor.execute("BEGIN IMMEDIATE")
                row = cursor.execute("SELECT * FROM actions WHERE action_id=?", (action_id,)).fetchone()
                if row is None:
                    raise UnknownAction(action_id)
                if row["status"] == "completed":
                    if row["post_fingerprint"] != post_fingerprint:
                        raise ActionConflict("completed action reported with a different poststate")
                elif row["status"] != "issued":
                    raise ActionConflict(f"cannot complete action in status {row['status']}")
                else:
                    cursor.execute(
                        "UPDATE actions SET status='completed',post_fingerprint=?,updated_at=? WHERE action_id=?",
                        (post_fingerprint, now, action_id),
                    )
                if pre.map_instance_id != post.map_instance_id:
                    response = json.loads(row["response_json"])
                    operations = response.get("operations") or []
                    exit_x = pre.hero.loc.x if not operations else int(operations[-1]["x"])
                    exit_y = pre.hero.loc.y if not operations else int(operations[-1]["y"])
                    reverse = cursor.execute(
                        """SELECT action_id FROM transitions WHERE session_id=? AND
                           from_map_instance_id=? AND to_map_instance_id=? AND
                           from_x=? AND from_y=? AND to_x=? AND to_y=? LIMIT 1""",
                        (
                            pre.session_id, post.map_instance_id, pre.map_instance_id,
                            post.hero.loc.x, post.hero.loc.y, exit_x, exit_y,
                        ),
                    ).fetchone()
                    cursor.execute(
                        """INSERT OR IGNORE INTO transitions(
                           session_id,action_id,from_map_instance_id,to_map_instance_id,
                           from_x,from_y,to_x,to_y,reversible,observed_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (pre.session_id, action_id, pre.map_instance_id, post.map_instance_id,
                         exit_x, exit_y, post.hero.loc.x, post.hero.loc.y,
                         1 if reverse else 0, now),
                    )
                    if reverse:
                        cursor.execute(
                            "UPDATE transitions SET reversible=1 WHERE session_id=? AND action_id=?",
                            (pre.session_id, reverse["action_id"]),
                        )
                    if str(response.get("action_kind", "")).startswith("SCAN_"):
                        scan = cursor.execute(
                            "SELECT * FROM takeover_scans WHERE session_id=?", (pre.session_id,)
                        ).fetchone()
                        if scan is None:
                            raise ActionConflict("scan action completed without takeover scan state")
                        scanned = set(json.loads(scan["scanned_json"]))
                        scanned.add(post.map_instance_id)
                        traversed = list(json.loads(scan["traversed_json"]))
                        edge = {
                            "from_map_instance_id": pre.map_instance_id,
                            "from_x": exit_x,
                            "from_y": exit_y,
                            "to_map_instance_id": post.map_instance_id,
                            "to_x": post.hero.loc.x,
                            "to_y": post.hero.loc.y,
                        }
                        if edge not in traversed:
                            traversed.append(edge)
                        pending = [
                            item for item in json.loads(scan["pending_json"])
                            if not (
                                item.get("from_map_instance_id") == pre.map_instance_id
                                and item.get("from_x") == exit_x
                                and item.get("from_y") == exit_y
                            )
                        ]
                        reason = (
                            f"scan traversed {pre.map_instance_id}@{exit_x},{exit_y} "
                            f"to {post.map_instance_id}@{post.hero.loc.x},{post.hero.loc.y}"
                        )
                        cursor.execute(
                            """UPDATE takeover_scans SET phase='sweep',current_map_instance_id=?,
                               scanned_json=?,pending_json=?,traversed_json=?,reason=?,updated_at=?
                               WHERE session_id=?""",
                            (
                                post.map_instance_id, canonical_json(sorted(scanned)),
                                canonical_json(pending), canonical_json(traversed), reason,
                                now, pre.session_id,
                            ),
                        )
                        cursor.execute(
                            """INSERT INTO scan_audit(
                               session_id,action_id,phase,event,details_json,created_at)
                               VALUES (?,?,'sweep','transition_observed',?,?)""",
                            (pre.session_id, action_id, canonical_json(edge), now),
                        )
                self._connection.commit()
                refreshed = cursor.execute("SELECT * FROM actions WHERE action_id=?", (action_id,)).fetchone()
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
