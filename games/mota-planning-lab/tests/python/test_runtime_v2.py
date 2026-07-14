from __future__ import annotations

import copy
import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from unittest import mock
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import ValidationError

from mota_lab.api import CycleCoordinator, create_app
from mota_lab.guards import guard_from_observation
from mota_lab.models import CycleRequest, ExpectedDelta, Observation
from mota_lab.models import BlockLabel
from mota_lab.planner import Planner
from mota_lab.state import (
    CurrentFloorGraph,
    historical_map_fact_payload,
    observation_fingerprint,
)
from mota_lab.deltas import validate_expected_delta
from mota_lab.storage import (
    ActionConflict,
    SchemaMigrationRequired,
    Store,
    V2_EXTENSION_TABLE_COLUMNS,
    V2_TABLE_COLUMNS,
)

from mota_test_support import (
    label_block,
    make_block,
    make_enemy_block,
    make_observation,
    make_request,
    make_settings,
    mark_floor,
)


def map_fact(observation: Observation) -> dict:
    return historical_map_fact_payload(
        observation, observation_fingerprint(observation)
    )


class ProtocolV2TopologyTests(unittest.TestCase):
    @staticmethod
    def _database_file_snapshot(path: Path) -> dict[str, tuple[bool, int | None, str | None]]:
        result = {}
        for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
            if candidate.exists():
                result[candidate.name] = (
                    True,
                    candidate.stat().st_mtime_ns,
                    hashlib.sha256(candidate.read_bytes()).hexdigest(),
                )
            else:
                result[candidate.name] = (False, None, None)
        return result

    def test_dynamic_rectangles_11_13_and_7_by_19(self) -> None:
        for width, height, x, y in ((11, 11, 10, 10), (13, 13, 12, 12), (7, 19, 6, 18)):
            with self.subTest(size=(width, height)):
                parsed = Observation.model_validate(
                    make_observation(width=width, height=height, x=x, y=y)
                )
                self.assertEqual((parsed.dimensions.width, parsed.dimensions.height), (width, height))

    def test_cross_field_coordinate_and_area_limits(self) -> None:
        with self.assertRaises(ValidationError):
            Observation.model_validate(make_observation(width=7, height=19, x=7))
        with self.assertRaises(ValidationError):
            Observation.model_validate(make_observation(width=256, height=256, blocks=[make_block(x=255, y=255)] * 8193))

    def test_valid_cells_hole_is_not_traversable(self) -> None:
        cells = [{"x": x, "y": y} for y in range(3) for x in range(3) if (x, y) != (1, 1)]
        observation = Observation.model_validate(
            make_observation(width=3, height=3, valid_cells=cells, x=0, y=1)
        )
        graph = CurrentFloorGraph(observation, {})
        self.assertNotIn((1, 1), graph.reachable().coordinates)
        self.assertIn((2, 1), graph.reachable().coordinates)

    def test_v1_fails_closed(self) -> None:
        payload = make_observation()
        payload["protocol"] = 1
        with self.assertRaises(ValidationError):
            Observation.model_validate(payload)

    def test_same_floor_can_have_multiple_instances_and_topology_revisions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "world.sqlite3")
            try:
                first = Observation.model_validate(make_observation(map_instance_id="F1-main"))
                second_raw = make_observation(map_instance_id="F1-side")
                second_raw["topology_fingerprint"] = "sha256:" + "2" * 64
                second = Observation.model_validate(second_raw)
                third = Observation.model_validate(
                    make_observation(floor_id="F1-side-engine-id", floor_number=1, map_instance_id="F1-side-engine")
                )
                store.ensure_session(first.session_id, "new_game", None, confirm=True)
                for item in (first, second, third):
                    fp = store.record_observation(item)
                    store.record_world_snapshot(item, fp)
                rows = store.map_instances_for_session(first.session_id)
                self.assertEqual({row["map_instance_id"] for row in rows}, {"F1-main", "F1-side", "F1-side-engine"})
                self.assertEqual({row["floor_number"] for row in rows}, {1})
                revisited = Observation.model_validate(make_observation(
                    map_instance_id="F1-main", hp=1, yellow=0,
                    blocks=[make_block(x=1, y=0, block_id="revisitBlock")],
                    captured_at=first.captured_at + 100,
                ))
                revisited_fp = store.record_observation(revisited)
                store.record_world_snapshot(revisited, revisited_fp)
                facts = store.latest_map_facts(first.session_id)
                main_fact = next(
                    fact for fact in facts if fact["map_instance_id"] == "F1-main"
                )
                self.assertNotIn("hero", main_fact)
                self.assertNotIn("keys", main_fact)
                self.assertNotIn("busy", main_fact)
                self.assertEqual(main_fact["snapshot_fingerprint"], revisited_fp)
                self.assertEqual([block["id"] for block in main_fact["blocks"]], ["revisitBlock"])
                version = store._connection.execute("PRAGMA user_version").fetchone()[0]
                self.assertEqual(version, 2)
                illegal_raw = make_observation(map_instance_id="F1-main")
                illegal_raw["topology_fingerprint"] = "sha256:" + "9" * 64
                illegal = Observation.model_validate(illegal_raw)
                with self.assertRaises(ActionConflict):
                    store.ingest_observation(illegal, "new_game", None, confirm=True)
            finally:
                store.close()

    def test_legacy_and_future_sqlite_fail_closed_before_any_schema_write(self) -> None:
        builders = {
            "legacy-v0": (
                0,
                "CREATE TABLE observations(fingerprint TEXT PRIMARY KEY, payload_json TEXT);"
                "INSERT INTO observations VALUES('old','{}');",
            ),
            **{
                f"legacy-full-v{version}": (
                version,
                "CREATE TABLE observations(fingerprint TEXT PRIMARY KEY, floor_id TEXT, payload_json TEXT, created_at INTEGER, last_seen_at INTEGER, seen_count INTEGER);"
                "CREATE TABLE actions(action_id TEXT PRIMARY KEY, pre_fingerprint TEXT, response_json TEXT, status TEXT, post_fingerprint TEXT, replacement_action_id TEXT, created_at INTEGER, updated_at INTEGER);"
                "CREATE TABLE decisions(decision_key TEXT PRIMARY KEY, observation_fingerprint TEXT, knowledge_fingerprint TEXT, response_json TEXT, action_id TEXT, created_at INTEGER);"
                "CREATE TABLE action_id_sequence(singleton INTEGER PRIMARY KEY, next_value INTEGER);"
                "INSERT INTO observations VALUES('old','F1','{}',1,1,1);"
                "INSERT INTO action_id_sequence VALUES(1,9);",
                ) for version in (0, 1)
            },
            "future": (3, "CREATE TABLE future_state(value TEXT); INSERT INTO future_state VALUES('keep');"),
            "unknown-v2": (2, "CREATE TABLE surprising(value TEXT); INSERT INTO surprising VALUES('keep');"),
        }
        with tempfile.TemporaryDirectory() as directory:
            for name, (version, script) in builders.items():
                with self.subTest(name=name):
                    path = Path(directory) / f"{name}.sqlite3"
                    connection = sqlite3.connect(path)
                    connection.executescript(script)
                    connection.execute(f"PRAGMA user_version={version}")
                    connection.commit()
                    before_bytes = path.read_bytes()
                    before_schema = connection.execute(
                        "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
                    ).fetchall()
                    connection.close()
                    with self.assertRaises(SchemaMigrationRequired):
                        Store(path)
                    self.assertEqual(path.read_bytes(), before_bytes)
                    check = sqlite3.connect(path)
                    self.assertEqual(check.execute("PRAGMA user_version").fetchone()[0], version)
                    self.assertEqual(
                        check.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").fetchall(),
                        before_schema,
                    )
                    check.close()

    def test_empty_database_initializes_v2_and_normal_v2_restarts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.sqlite3"
            path.touch()
            first = Store(path)
            self.assertEqual(first.schema_diagnostics()["classification"], "v2")
            first._connection.execute(
                "INSERT INTO observations VALUES('probe','F','{}',1,1,1)"
            )
            with self.assertRaises(sqlite3.IntegrityError):
                first._connection.execute(
                    "INSERT INTO actions VALUES('bad','probe','{}','INVALID',NULL,NULL,1,1)"
                )
            first._connection.rollback()
            first.close()
            second = Store(path)
            self.assertEqual(second._connection.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertIsNone(second.get_scan_state("missing"))
            active_path = second.path
            second.close()

            partial_path = Path(directory) / "partial-v2.sqlite3"
            partial_path.write_bytes(active_path.read_bytes())
            compatibility = sqlite3.connect(partial_path)
            compatibility.execute("DROP TABLE scan_audit")
            compatibility.execute("DROP TABLE takeover_scans")
            compatibility.commit()
            before_mode = compatibility.execute("PRAGMA journal_mode").fetchone()[0]
            compatibility.close()
            before_bytes = partial_path.read_bytes()
            with self.assertRaises(SchemaMigrationRequired):
                Store(partial_path)
            self.assertEqual(partial_path.read_bytes(), before_bytes)
            check = sqlite3.connect(partial_path)
            self.assertEqual(check.execute("PRAGMA journal_mode").fetchone()[0], before_mode)
            check.close()

    def test_wal_schema_classification_uses_private_consistent_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "active.sqlite3"
            active = Store(path)
            try:
                active._connection.execute(
                    "INSERT INTO observations VALUES('wal-probe','F','{}',1,1,1)"
                )
                active._connection.commit()
                self.assertTrue(Path(f"{active.path}-wal").exists())
                self.assertTrue(Path(f"{active.path}-shm").exists())
                reopened = Store(path)
                try:
                    self.assertEqual(reopened.schema_diagnostics()["classification"], "v2")
                    self.assertEqual(
                        reopened._connection.execute(
                            "SELECT COUNT(*) FROM observations WHERE fingerprint='wal-probe'"
                        ).fetchone()[0],
                        1,
                    )
                finally:
                    reopened.close()

                authoritative_path = reopened.path
                invalid = sqlite3.connect(authoritative_path)
                invalid.execute("CREATE TABLE illegal_wal_extra(value TEXT)")
                invalid.execute("INSERT INTO illegal_wal_extra VALUES('keep')")
                invalid.commit()
                known_pragmas = (
                    invalid.execute("PRAGMA user_version").fetchone()[0],
                    invalid.execute("PRAGMA journal_mode").fetchone()[0],
                )
                before = self._database_file_snapshot(authoritative_path)
                with self.assertRaises(SchemaMigrationRequired):
                    Store(path)
                self.assertEqual(self._database_file_snapshot(authoritative_path), before)
                self.assertEqual(known_pragmas, (2, "wal"))

                wal_without_shm = root / "wal-without-shm.sqlite3"
                wal_without_shm.write_bytes(authoritative_path.read_bytes())
                Path(f"{wal_without_shm}-wal").write_bytes(Path(f"{authoritative_path}-wal").read_bytes())
                incomplete_before = self._database_file_snapshot(wal_without_shm)
                with self.assertRaises(SchemaMigrationRequired):
                    Store(wal_without_shm)
                self.assertEqual(self._database_file_snapshot(wal_without_shm), incomplete_before)

                truncated = root / "truncated.sqlite3"
                truncated.write_bytes(authoritative_path.read_bytes())
                Path(f"{truncated}-wal").write_bytes(Path(f"{authoritative_path}-wal").read_bytes()[:64])
                Path(f"{truncated}-shm").write_bytes(Path(f"{authoritative_path}-shm").read_bytes()[:64])
                truncated_before = self._database_file_snapshot(truncated)
                with self.assertRaises(SchemaMigrationRequired):
                    Store(truncated)
                self.assertEqual(self._database_file_snapshot(truncated), truncated_before)
                invalid.close()
            finally:
                active.close()

    def test_unstable_snapshot_capture_fails_closed_without_opening_original(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.sqlite3"
            created = Store(path)
            created.close()
            before = self._database_file_snapshot(path)
            with mock.patch.object(
                Store,
                "_capture_private_snapshot",
                side_effect=SchemaMigrationRequired("database files changed during snapshot"),
                create=True,
            ) as capture:
                with self.assertRaises(SchemaMigrationRequired):
                    Store(path)
                capture.assert_called_once()
            self.assertEqual(self._database_file_snapshot(path), before)

            classify = Store._classify_schema_before_write

            def mutate_original_after_private_probe(store):
                result = classify(store)
                store._source_path.write_bytes(store._source_path.read_bytes())
                return result

            with mock.patch.object(
                Store,
                "_classify_schema_before_write",
                mutate_original_after_private_probe,
            ):
                with self.assertRaises(SchemaMigrationRequired):
                    Store(path)
            self.assertFalse(Path(f"{path}-wal").exists())
            self.assertFalse(Path(f"{path}-shm").exists())

    def test_classified_inode_swap_to_future_schema_is_never_opened_or_written(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "state.sqlite3"
            created = Store(path)
            manifest_path = created._manifest_path
            created.close()
            manifest_before = manifest_path.read_bytes()
            future = root / "future.sqlite3"
            connection = sqlite3.connect(future)
            connection.execute("CREATE TABLE future_state(value TEXT)")
            connection.execute("INSERT INTO future_state VALUES('preserve')")
            connection.execute("PRAGMA user_version=99")
            connection.commit()
            connection.close()
            future_snapshot = self._database_file_snapshot(future)
            swapped = False
            publish = Store._publish_manifest

            def swap_during_generation_publication(store, generation_name, import_identity):
                nonlocal swapped
                if not swapped:
                    os.replace(future, path)
                    swapped = True
                return publish(store, generation_name, import_identity)

            with mock.patch.object(Store, "_publish_manifest", swap_during_generation_publication):
                with self.assertRaises(SchemaMigrationRequired):
                    Store(path)
            self.assertTrue(swapped)
            self.assertEqual(manifest_path.read_bytes(), manifest_before)
            self.assertEqual(self._database_file_snapshot(path), {
                name.replace("future.sqlite3", "state.sqlite3"): value
                for name, value in future_snapshot.items()
            })
            check = sqlite3.connect(path)
            self.assertEqual(check.execute("PRAGMA user_version").fetchone()[0], 99)
            self.assertEqual(check.execute("SELECT value FROM future_state").fetchone()[0], "preserve")
            check.close()

    def test_import_swap_immediately_before_generation_connect_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "state.sqlite3"
            initial = Store(path)
            manifest_path = initial._manifest_path
            initial.close()
            manifest_before = manifest_path.read_bytes()
            future = root / "future.sqlite3"
            connection = sqlite3.connect(future)
            connection.execute("CREATE TABLE future_state(value TEXT)")
            connection.execute("INSERT INTO future_state VALUES('preserve')")
            connection.execute("PRAGMA user_version=99")
            connection.commit()
            connection.close()
            future_before = self._database_file_snapshot(future)
            real_connect = sqlite3.connect
            swapped = False

            def swap_at_generation_connect(database, *args, **kwargs):
                nonlocal swapped
                candidate = Path(str(database))
                if candidate.name == "ledger.sqlite3" and candidate.parent.name.startswith("gen-") \
                        and not swapped:
                    os.replace(future, path)
                    swapped = True
                return real_connect(database, *args, **kwargs)

            with mock.patch("mota_lab.storage.sqlite3.connect", swap_at_generation_connect):
                with self.assertRaises(SchemaMigrationRequired):
                    Store(path)
            self.assertTrue(swapped)
            self.assertEqual(manifest_path.read_bytes(), manifest_before)
            self.assertEqual(self._database_file_snapshot(path), {
                name.replace("future.sqlite3", "state.sqlite3"): value
                for name, value in future_before.items()
            })
            check = sqlite3.connect(path)
            self.assertEqual(check.execute("PRAGMA user_version").fetchone()[0], 99)
            self.assertEqual(check.execute("SELECT value FROM future_state").fetchone()[0], "preserve")
            check.close()

    def test_generation_manifest_restart_and_crash_candidate_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.sqlite3"
            first = Store(path)
            first._connection.execute(
                "INSERT INTO observations VALUES('persist','F','{}',1,1,1)"
            )
            first._connection.commit()
            generation_root = first._generation_root
            manifest_path = first._manifest_path
            first.close()
            self.assertTrue(manifest_path.is_file())
            crash_candidate = generation_root / ".candidate-crash-residual"
            crash_candidate.mkdir()
            (crash_candidate / "partial").write_bytes(b"partial")

            second = Store(path)
            try:
                self.assertEqual(
                    second._connection.execute(
                        "SELECT COUNT(*) FROM observations WHERE fingerprint='persist'"
                    ).fetchone()[0],
                    1,
                )
                self.assertFalse(crash_candidate.exists())
            finally:
                second.close()

            manifest_before = manifest_path.read_bytes()
            manifest_path.write_text("{", encoding="utf-8")
            malformed = manifest_path.read_bytes()
            with self.assertRaises(SchemaMigrationRequired):
                Store(path)
            self.assertEqual(manifest_path.read_bytes(), malformed)
            manifest_path.write_bytes(manifest_before)

    def test_generation_inode_swap_at_connect_is_rejected_before_ddl(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "state.sqlite3"
            initial = Store(path)
            manifest_path = initial._manifest_path
            initial.close()
            manifest_before = manifest_path.read_bytes()
            future = root / "future.sqlite3"
            connection = sqlite3.connect(future)
            connection.execute("CREATE TABLE future_state(value TEXT)")
            connection.execute("INSERT INTO future_state VALUES('preserve')")
            connection.execute("PRAGMA user_version=99")
            connection.commit()
            connection.close()
            future_before = self._database_file_snapshot(future)
            real_connect = sqlite3.connect
            swapped_target: Path | None = None

            def swap_generation_at_connect(database, *args, **kwargs):
                nonlocal swapped_target
                candidate = Path(str(database))
                if candidate.name == "ledger.sqlite3" and candidate.parent.name.startswith("gen-") \
                        and swapped_target is None:
                    os.replace(future, candidate)
                    swapped_target = candidate
                return real_connect(database, *args, **kwargs)

            with mock.patch("mota_lab.storage.sqlite3.connect", swap_generation_at_connect):
                with self.assertRaises(SchemaMigrationRequired):
                    Store(path)
            self.assertIsNotNone(swapped_target)
            self.assertEqual(manifest_path.read_bytes(), manifest_before)
            self.assertEqual(self._database_file_snapshot(swapped_target), {
                name.replace("future.sqlite3", "ledger.sqlite3"): value
                for name, value in future_before.items()
            })
            check = sqlite3.connect(swapped_target)
            self.assertEqual(check.execute("PRAGMA user_version").fetchone()[0], 99)
            self.assertEqual(check.execute("SELECT value FROM future_state").fetchone()[0], "preserve")
            check.close()

    def test_private_snapshot_cleanup_and_unknown_sidecar_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "state.sqlite3"
            created = Store(path)
            active_path = created.path
            created.close()
            sidecar = Path(f"{active_path}-journal")
            sidecar.write_bytes(b"untrusted-live-journal")
            before = self._database_file_snapshot(active_path)
            sidecar_before = (sidecar.stat().st_mtime_ns, sidecar.read_bytes())
            snapshot_root = root / "private-snapshots"
            snapshot_root.mkdir()
            real_temporary_directory = tempfile.TemporaryDirectory
            created_snapshots: list[Path] = []

            def temporary_directory(*args, **kwargs):
                kwargs["dir"] = snapshot_root
                context = real_temporary_directory(*args, **kwargs)
                created_snapshots.append(Path(context.name))
                return context

            with mock.patch(
                "mota_lab.storage.tempfile.TemporaryDirectory",
                side_effect=temporary_directory,
            ):
                with self.assertRaises(SchemaMigrationRequired):
                    Store(path)
            self.assertEqual(self._database_file_snapshot(active_path), before)
            self.assertEqual((sidecar.stat().st_mtime_ns, sidecar.read_bytes()), sidecar_before)
            self.assertEqual(created_snapshots, [])

            sidecar.unlink()
            invalid = sqlite3.connect(active_path)
            invalid.execute("CREATE TABLE invalid_after_sidecar(value TEXT)")
            invalid.commit()
            invalid.close()
            invalid_before = self._database_file_snapshot(active_path)
            with mock.patch(
                "mota_lab.storage.tempfile.TemporaryDirectory",
                side_effect=temporary_directory,
            ):
                with self.assertRaises(SchemaMigrationRequired):
                    Store(path)
            self.assertEqual(self._database_file_snapshot(active_path), invalid_before)
            self.assertTrue(created_snapshots)
            self.assertTrue(all(not item.exists() for item in created_snapshots))
            self.assertEqual(list(snapshot_root.iterdir()), [])

    def test_counterfeit_v2_schema_contracts_fail_before_any_write(self) -> None:
        table_names = sorted(set(V2_TABLE_COLUMNS) | set(V2_EXTENSION_TABLE_COLUMNS))

        def all_text_schema() -> str:
            statements = []
            for table in table_names:
                columns = sorted(({**V2_TABLE_COLUMNS, **V2_EXTENSION_TABLE_COLUMNS})[table])
                statements.append(
                    f'CREATE TABLE "{table}" ('
                    + ",".join(f'"{column}" TEXT' for column in columns)
                    + ");"
                )
            return "".join(statements)

        with tempfile.TemporaryDirectory() as directory:
            valid_path = Path(directory) / "valid.sqlite3"
            valid = Store(valid_path)
            valid_source = valid.path
            valid.close()
            source = sqlite3.connect(valid_source)
            table_sql = {
                row[0]: row[1]
                for row in source.execute(
                    "SELECT name,sql FROM sqlite_master "
                    "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            index_sql = {
                row[0]: row[1]
                for row in source.execute(
                    "SELECT name,sql FROM sqlite_master "
                    "WHERE type='index' AND sql IS NOT NULL"
                )
            }
            source.close()

            def build(name: str, mutate_table=None, omitted_index: str | None = None) -> Path:
                target = Path(directory) / f"{name}.sqlite3"
                connection = sqlite3.connect(target)
                for table in sorted(table_sql):
                    sql = table_sql[table]
                    if mutate_table is not None:
                        sql = mutate_table(table, sql)
                    connection.execute(sql)
                for index in sorted(index_sql):
                    if index != omitted_index:
                        connection.execute(index_sql[index])
                connection.execute("INSERT INTO action_id_sequence VALUES(1,1)")
                connection.execute("PRAGMA user_version=2")
                connection.commit()
                connection.close()
                return target

            cases = {
                "same-columns-all-text": None,
                "missing-primary-key": build(
                    "missing-pk",
                    lambda table, sql: sql.replace("fingerprint TEXT PRIMARY KEY", "fingerprint TEXT")
                    if table == "observations" else sql,
                ),
                "missing-explicit-index": build("missing-index", omitted_index="actions_pre_idx"),
                "missing-check": build(
                    "missing-check",
                    lambda table, sql: sql.replace(
                        " CHECK(status IN ('issued','completed','mismatch','superseded'))", ""
                    ) if table == "actions" else sql,
                ),
                "missing-foreign-key": build(
                    "missing-fk",
                    lambda table, sql: sql.replace(
                        ",\n                    FOREIGN KEY(pre_fingerprint) REFERENCES observations(fingerprint)",
                        "",
                    ) if table == "actions" else sql,
                ),
                "missing-unique": build(
                    "missing-unique",
                    lambda table, sql: sql.replace("action_id TEXT NOT NULL UNIQUE", "action_id TEXT NOT NULL")
                    if table == "transitions" else sql,
                ),
                "wrong-default": build(
                    "wrong-default",
                    lambda table, sql: sql.replace("DEFAULT 0", "DEFAULT 1")
                    if table == "transitions" else sql,
                ),
                "wrong-not-null": build(
                    "wrong-not-null",
                    lambda table, sql: sql.replace("floor_id TEXT NOT NULL", "floor_id TEXT")
                    if table == "observations" else sql,
                ),
                "wrong-type": build(
                    "wrong-type",
                    lambda table, sql: sql.replace("created_at INTEGER NOT NULL", "created_at TEXT NOT NULL")
                    if table == "observations" else sql,
                ),
            }
            fake_path = Path(directory) / "same-columns-all-text.sqlite3"
            connection = sqlite3.connect(fake_path)
            connection.executescript(all_text_schema())
            connection.execute("PRAGMA user_version=2")
            connection.commit()
            connection.close()
            cases["same-columns-all-text"] = fake_path

            for name, candidate in cases.items():
                with self.subTest(name=name):
                    before_bytes = candidate.read_bytes()
                    before = sqlite3.connect(candidate)
                    before_schema = before.execute(
                        "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
                    ).fetchall()
                    before_mode = before.execute("PRAGMA journal_mode").fetchone()[0]
                    before.close()
                    with self.assertRaises(SchemaMigrationRequired):
                        Store(candidate)
                    self.assertEqual(candidate.read_bytes(), before_bytes)
                    after = sqlite3.connect(candidate)
                    self.assertEqual(after.execute("PRAGMA user_version").fetchone()[0], 2)
                    self.assertEqual(after.execute("PRAGMA journal_mode").fetchone()[0], before_mode)
                    self.assertEqual(
                        after.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").fetchall(),
                        before_schema,
                    )
                    after.close()

    def test_counterfeit_check_comments_and_generated_columns_fail_without_touching_db(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "base.sqlite3"
            base_store = Store(base)
            base_source = base_store.path
            base_store.close()
            cases = {}

            commented = Path(directory) / "commented-check.sqlite3"
            commented.write_bytes(base_source.read_bytes())
            connection = sqlite3.connect(commented)
            action_sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='actions'"
            ).fetchone()[0]
            required = "CHECK(status IN ('issued','completed','mismatch','superseded'))"
            self.assertIn(required, action_sql)
            connection.execute("PRAGMA writable_schema=ON")
            connection.execute(
                "UPDATE sqlite_master SET sql=? WHERE type='table' AND name='actions'",
                (action_sql.replace(required, f"/*{required}*/"),),
            )
            connection.execute("PRAGMA writable_schema=OFF")
            connection.commit()
            connection.close()
            cases["commented-check"] = commented

            generated = Path(directory) / "generated-column.sqlite3"
            generated.write_bytes(base_source.read_bytes())
            connection = sqlite3.connect(generated)
            connection.execute(
                "ALTER TABLE observations ADD COLUMN hidden_probe TEXT "
                "GENERATED ALWAYS AS (floor_id) VIRTUAL"
            )
            connection.commit()
            connection.close()
            cases["generated-column"] = generated

            for name, path in cases.items():
                with self.subTest(name=name):
                    before_bytes = path.read_bytes()
                    before_sidecars = {
                        suffix: (path.parent / f"{path.name}{suffix}").read_bytes()
                        for suffix in ("-wal", "-shm", "-journal")
                        if (path.parent / f"{path.name}{suffix}").exists()
                    }
                    check = sqlite3.connect(path)
                    before_version = check.execute("PRAGMA user_version").fetchone()[0]
                    before_mode = check.execute("PRAGMA journal_mode").fetchone()[0]
                    before_schema = check.execute(
                        "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
                    ).fetchall()
                    check.close()
                    with self.assertRaises(SchemaMigrationRequired):
                        Store(path)
                    self.assertEqual(path.read_bytes(), before_bytes)
                    self.assertEqual({
                        suffix: (path.parent / f"{path.name}{suffix}").read_bytes()
                        for suffix in ("-wal", "-shm", "-journal")
                        if (path.parent / f"{path.name}{suffix}").exists()
                    }, before_sidecars)
                    check = sqlite3.connect(path)
                    self.assertEqual(check.execute("PRAGMA user_version").fetchone()[0], before_version)
                    self.assertEqual(check.execute("PRAGMA journal_mode").fetchone()[0], before_mode)
                    self.assertEqual(check.execute(
                        "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
                    ).fetchall(), before_schema)
                    check.close()

    def test_map_instance_transition_delta_is_identical_for_same_or_different_floor_id(self) -> None:
        stair = make_block(x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor")
        pre = Observation.model_validate(make_observation(
            floor_id="F1", map_instance_id="A", blocks=[stair], width=3, height=2,
        ))
        for floor_id, map_instance_id in (("F1", "B"), ("F2", "C")):
            with self.subTest(target=(floor_id, map_instance_id)):
                post = Observation.model_validate(make_observation(
                    floor_id=floor_id, map_instance_id=map_instance_id,
                    x=2, y=1, width=3, height=2,
                    blocks=[make_block(x=0, y=1, block_id="remote")],
                ))
                unknown = validate_expected_delta(
                    pre, post, ExpectedDelta(map_instance_id=None), action_kind="SCAN_OPAQUE_EXIT"
                )
                self.assertTrue(unknown.matches, unknown.differences)
                self.assertEqual(unknown.actual["changed_block_coordinates"], [])
                exact = validate_expected_delta(
                    pre, post, ExpectedDelta(map_instance_id=map_instance_id),
                    action_kind="SCAN_VERIFIED_TRANSITION",
                )
                self.assertTrue(exact.matches, exact.differences)
        unchanged = validate_expected_delta(
            pre, pre, ExpectedDelta(map_instance_id=None), action_kind="SCAN_OPAQUE_EXIT"
        )
        self.assertFalse(unchanged.matches)


class SessionWorldAndCorsTests(unittest.TestCase):
    @staticmethod
    def _complete_scan(*map_ids: str, current: str) -> dict:
        return {
            "phase": "complete",
            "anchor_map_instance_id": map_ids[0],
            "current_map_instance_id": current,
            "scanned_map_instance_ids": list(map_ids),
            "pending_exits": [],
            "traversed_transitions": [],
            "reason": "synthetic complete scan",
        }

    def test_verified_stairs_without_remote_progress_are_idle_not_a_round_trip(self) -> None:
        portal_a = make_block(
            x=1, y=0, block_id="portalA", cls="terrains", trigger="changeFloor"
        )
        portal_b = make_block(
            x=1, y=0, block_id="portalB", cls="terrains", trigger="changeFloor"
        )
        a = Observation.model_validate(make_observation(
            width=2, height=1, x=0, y=0, map_instance_id="A", floor_id="A",
            blocks=[portal_a],
        ))
        b = Observation.model_validate(make_observation(
            width=2, height=1, x=0, y=0, map_instance_id="B", floor_id="B",
            blocks=[portal_b],
        ))
        labels = {}
        for portal in (portal_a, portal_b):
            label = BlockLabel(
                id=portal["id"], cls=portal["cls"], trigger=portal["trigger"],
                category="stair", passable=False, boundary=True, fast_path=False,
            )
            labels[label.identity] = label
        context = {
            "map_facts": [map_fact(a), map_fact(b)],
            "transitions": [
                {"from_map_instance_id": "A", "to_map_instance_id": "B",
                 "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0},
                {"from_map_instance_id": "B", "to_map_instance_id": "A",
                 "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0},
            ],
        }

        result, exhausted = Planner(planning_budget=32)._world_search(a, labels, context)
        response = Planner(planning_budget=32).plan(
            a, labels, action_id_factory=lambda: "AUTO-0000000000000005",
            registry_entries=[], world_context=context,
            scan_state=self._complete_scan("A", "B", current="A"),
        )

        self.assertFalse(exhausted)
        self.assertIsNone(result)
        self.assertEqual(response.status, "idle")
        self.assertNotIn("action_id", response.model_dump(mode="json", exclude_unset=True))

    def test_direct_red_door_beats_verified_return_stair(self) -> None:
        down = make_block(
            x=1, y=0, block_id="downFloor", cls="terrains", trigger="changeFloor"
        )
        red_door = make_block(
            x=2, y=1, block_id="redDoor", cls="terrains", trigger="openDoor"
        )
        up = make_block(
            x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor"
        )
        mt1 = Observation.model_validate(make_observation(
            width=3, height=2, x=1, y=1, red=1, map_instance_id="MT1", floor_id="MT1",
            blocks=[down, red_door],
        ))
        mt0 = Observation.model_validate(make_observation(
            width=2, height=1, x=0, y=0, red=1, map_instance_id="MT0", floor_id="MT0",
            blocks=[up],
        ))
        labels = {}
        for stair in (down, up):
            label = BlockLabel(
                id=stair["id"], cls=stair["cls"], trigger=stair["trigger"],
                category="stair", passable=False, boundary=True, fast_path=False,
            )
            labels[label.identity] = label
        door_label = BlockLabel(
            id=red_door["id"], cls=red_door["cls"], trigger=red_door["trigger"],
            category="door", passable=False, boundary=True, fast_path=False,
            expected_delta={"keys": {"red": -1}},
        )
        labels[door_label.identity] = door_label
        context = {
            "map_facts": [map_fact(mt0), map_fact(mt1)],
            "transitions": [
                {"from_map_instance_id": "MT1", "to_map_instance_id": "MT0",
                 "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0},
                {"from_map_instance_id": "MT0", "to_map_instance_id": "MT1",
                 "from_x": 1, "from_y": 0, "to_x": 1, "to_y": 1},
            ],
        }

        response = Planner(planning_budget=32).plan(
            mt1, labels, action_id_factory=lambda: "AUTO-0000000000000005",
            registry_entries=[], world_context=context,
            scan_state=self._complete_scan("MT0", "MT1", current="MT1"),
        )

        self.assertEqual(response.status, "execute")
        self.assertEqual(response.action_kind, "OPEN_DOOR")
        self.assertEqual((response.operations[-1].x, response.operations[-1].y), (2, 1))

    def test_verified_stair_is_only_first_step_toward_named_remote_frontier(self) -> None:
        stair = make_block(
            x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor"
        )
        remote = make_block(
            x=1, y=0, block_id="remotePotion", cls="items", trigger="getItem"
        )
        a = Observation.model_validate(make_observation(
            width=2, height=1, map_instance_id="A", floor_id="A", blocks=[stair]
        ))
        b = Observation.model_validate(make_observation(
            width=2, height=1, map_instance_id="B", floor_id="B", blocks=[remote]
        ))
        stair_label = BlockLabel(
            id=stair["id"], cls=stair["cls"], trigger=stair["trigger"],
            category="stair", passable=False, boundary=True, fast_path=False,
        )
        resource_label = BlockLabel(
            id=remote["id"], cls=remote["cls"], trigger=remote["trigger"],
            category="resource", passable=False, boundary=True, fast_path=False,
            expected_delta={"attack": 10},
        )
        context = {
            "map_facts": [map_fact(a), map_fact(b)],
            "transitions": [{
                "from_map_instance_id": "A", "to_map_instance_id": "B",
                "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0,
            }],
        }

        response = Planner(planning_budget=32).plan(
            a, {stair_label.identity: stair_label, resource_label.identity: resource_label},
            action_id_factory=lambda: "AUTO-0000000000000004", registry_entries=[],
            world_context=context,
            scan_state=self._complete_scan("A", "B", current="A"),
        )

        self.assertEqual(response.status, "execute")
        self.assertEqual(response.action_kind, "MOVE_TO_STAIR")
        self.assertEqual(response.expected_delta.map_instance_id, "B")
        self.assertEqual(response.expected_delta.floor_id, "B")
        self.assertIn("remotePotion", response.reason)
        self.assertIn("B", response.reason)

    def test_verified_exit_is_not_rediscovered_after_opaque_scan_completion(self) -> None:
        stair = make_block(
            x=1, y=0, block_id="portal", cls="terrains", trigger="changeFloor"
        )
        a = Observation.model_validate(make_observation(
            width=2, height=1, map_instance_id="A", floor_id="A", blocks=[stair]
        ))
        b = Observation.model_validate(make_observation(
            width=2, height=1, map_instance_id="B", floor_id="B", blocks=[]
        ))
        label = BlockLabel(
            id=stair["id"], cls=stair["cls"], trigger=stair["trigger"],
            category="stair", passable=False, boundary=True, fast_path=False,
        )
        initial_scan = {
            "phase": "discover", "anchor_map_instance_id": "A",
            "current_map_instance_id": "A", "scanned_map_instance_ids": ["A"],
            "pending_exits": [], "traversed_transitions": [], "reason": "initial",
        }
        planner = Planner()
        opaque = planner.plan(
            a, {label.identity: label},
            action_id_factory=lambda: "AUTO-0000000000000003", registry_entries=[],
            world_context={"map_facts": [map_fact(a)], "transitions": []},
            scan_state=initial_scan,
        )
        self.assertEqual(opaque.action_kind, "SCAN_OPAQUE_EXIT")

        established = planner.refresh_scan_state(
            a, {label.identity: label},
            {
                "map_facts": [map_fact(a), map_fact(b)],
                "transitions": [{
                    "from_map_instance_id": "A", "to_map_instance_id": "B",
                    "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0,
                }],
            },
            {
                **initial_scan, "phase": "sweep", "scanned_map_instance_ids": ["A", "B"],
                "traversed_transitions": [{
                    "from_map_instance_id": "A", "from_x": 1, "from_y": 0,
                    "to_map_instance_id": "B", "to_x": 0, "to_y": 0,
                }],
            },
        )
        self.assertEqual(established["phase"], "complete")
        self.assertEqual(established["pending_exits"], [])

    def test_auto3_auto4_auto5_sequence_targets_red_door_instead_of_ping_pong(self) -> None:
        down = make_block(
            x=1, y=0, block_id="downFloor", cls="terrains", trigger="changeFloor"
        )
        up = make_block(
            x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor"
        )
        red_door = make_block(
            x=2, y=1, block_id="redDoor", cls="terrains", trigger="openDoor"
        )
        mt1 = Observation.model_validate(make_observation(
            width=3, height=2, x=1, y=1, red=1,
            map_instance_id="MT1", floor_id="MT1", blocks=[down, red_door],
        ))
        mt0 = Observation.model_validate(make_observation(
            width=2, height=1, x=0, y=0, red=1,
            map_instance_id="MT0", floor_id="MT0", blocks=[up],
        ))
        labels = {}
        for stair in (down, up):
            label = BlockLabel(
                id=stair["id"], cls=stair["cls"], trigger=stair["trigger"],
                category="stair", passable=False, boundary=True, fast_path=False,
            )
            labels[label.identity] = label
        door_label = BlockLabel(
            id=red_door["id"], cls=red_door["cls"], trigger=red_door["trigger"],
            category="door", passable=False, boundary=True, fast_path=False,
            expected_delta={"keys": {"red": -1}},
        )
        labels[door_label.identity] = door_label
        planner = Planner(planning_budget=32)
        auto3 = planner.plan(
            mt1, labels, action_id_factory=lambda: "AUTO-0000000000000003",
            registry_entries=[],
            world_context={"map_facts": [map_fact(mt1)], "transitions": []},
            scan_state={
                "phase": "sweep", "anchor_map_instance_id": "MT0",
                "current_map_instance_id": "MT1", "scanned_map_instance_ids": ["MT1"],
                "pending_exits": [], "traversed_transitions": [], "reason": "scan",
            },
        )
        self.assertEqual(auto3.action_kind, "SCAN_OPAQUE_EXIT")
        self.assertEqual(auto3.operations[-1].x, 1)
        self.assertEqual(auto3.operations[-1].y, 0)

        context = {
            "map_facts": [map_fact(mt0), map_fact(mt1)],
            "transitions": [
                {"from_map_instance_id": "MT1", "to_map_instance_id": "MT0",
                 "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0},
                {"from_map_instance_id": "MT0", "to_map_instance_id": "MT1",
                 "from_x": 1, "from_y": 0, "to_x": 1, "to_y": 1},
            ],
        }
        completed_scan = planner.refresh_scan_state(
            mt0, labels, context,
            {
                "phase": "sweep", "anchor_map_instance_id": "MT0",
                "current_map_instance_id": "MT0",
                "scanned_map_instance_ids": ["MT0", "MT1"],
                "pending_exits": [],
                "traversed_transitions": [{
                    "from_map_instance_id": "MT1", "from_x": 1, "from_y": 0,
                    "to_map_instance_id": "MT0", "to_x": 0, "to_y": 0,
                }],
                "reason": "AUTO-3 completed",
            },
        )
        self.assertEqual(completed_scan["phase"], "complete")

        auto4 = planner.plan(
            mt0, labels, action_id_factory=lambda: "AUTO-0000000000000004",
            registry_entries=[], world_context=context, scan_state=completed_scan,
        )
        self.assertEqual(auto4.action_kind, "MOVE_TO_STAIR")
        self.assertIn("redDoor", auto4.reason)

        auto5 = planner.plan(
            mt1, labels, action_id_factory=lambda: "AUTO-0000000000000005",
            registry_entries=[], world_context=context,
            scan_state={**completed_scan, "current_map_instance_id": "MT1"},
        )
        self.assertEqual(auto5.action_kind, "OPEN_DOOR")
        self.assertEqual((auto5.operations[-1].x, auto5.operations[-1].y), (2, 1))

    def test_completed_opaque_transition_restart_keeps_verified_identity_and_zero_replay(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            settings = make_settings(Path(directory), rate_limit_per_second=0)
            stair = make_block(
                x=1, y=0, block_id="portal", cls="terrains", trigger="changeFloor"
            )
            for floor_id in ("A", "B"):
                mark_floor(settings, floor_id=floor_id, name=floor_id)
            label_block(settings, stair, category="stair")
            pre = make_observation(
                floor_id="A", map_instance_id="A", width=2, height=1,
                x=0, y=0, blocks=[stair], session_id="restart-transition",
            )
            post = make_observation(
                floor_id="B", map_instance_id="B", width=2, height=1,
                x=0, y=0, blocks=[], session_id="restart-transition",
                captured_at=1234567891,
            )
            coordinator = CycleCoordinator(settings)
            try:
                issued = coordinator.cycle(CycleRequest.model_validate(make_request(pre)))
                self.assertEqual(issued["action_kind"], "SCAN_OPAQUE_EXIT")
                completed = make_request(
                    post,
                    completed_action_id=issued["action_id"],
                    recovery={
                        "phase": "completed",
                        "pending_action_id": issued["action_id"],
                        "pre_fingerprint": observation_fingerprint(
                            Observation.model_validate(pre)
                        ),
                        "current_fingerprint": observation_fingerprint(
                            Observation.model_validate(post)
                        ),
                        "detail_code": None,
                    },
                )
                ack = coordinator.cycle(CycleRequest.model_validate(completed))
                self.assertEqual(ack["acknowledged_action_id"], issued["action_id"])
            finally:
                coordinator.store.close()

            restarted = CycleCoordinator(settings)
            try:
                repeated = restarted.cycle(CycleRequest.model_validate(completed))
                self.assertEqual(repeated["acknowledged_action_id"], issued["action_id"])
                next_request = make_request(post)
                next_request["session"] = {
                    "mode": "resume_existing_ledger", "command": "observe"
                }
                settled = restarted.cycle(CycleRequest.model_validate(next_request))
                self.assertEqual(settled["status"], "idle")
                self.assertEqual(settled["scan_state"]["phase"], "complete")
                self.assertEqual(
                    restarted.store._connection.execute(
                        "SELECT COUNT(*) FROM actions"
                    ).fetchone()[0],
                    1,
                )
                self.assertEqual(len(restarted.store.transitions_for_session("restart-transition")), 1)
            finally:
                restarted.store.close()

    def test_coordinator_scan_action_is_idempotent_and_same_floor_completion_builds_edge(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            settings = make_settings(Path(directory), rate_limit_per_second=0)
            stair = make_block(x=1, y=0, block_id="portal", cls="terrains", trigger="changeFloor")
            resource = make_block(x=0, y=1, block_id="hugeAttack", cls="items", trigger="getItem")
            mark_floor(settings, floor_id="same")
            label_block(settings, stair, category="stair")
            label_block(settings, resource, category="resource", expected_delta={"attack": 999})
            coordinator = CycleCoordinator(settings)
            try:
                pre = make_observation(
                    floor_id="same", map_instance_id="A", width=2, height=2,
                    blocks=[stair, resource], session_id="scan-session",
                )
                request = CycleRequest.model_validate(make_request(pre))
                first = coordinator.cycle(request)
                second = coordinator.cycle(request)
                self.assertEqual(first["action_kind"], "SCAN_OPAQUE_EXIT")
                self.assertEqual(second["action_id"], first["action_id"])
                self.assertEqual(first["operations"][-1], {"type": "grid", "x": 1, "y": 0})
                self.assertEqual(first["scan_state"]["phase"], "discover")

                post = make_observation(
                    floor_id="same", map_instance_id="B", width=2, height=2,
                    x=0, y=0, blocks=[], session_id="scan-session", captured_at=1234567891,
                )
                completed_raw = make_request(post, completed_action_id=first["action_id"])
                completed = coordinator.cycle(CycleRequest.model_validate(completed_raw))
                self.assertNotEqual(completed.get("detail_code"), "RESOURCE_DELTA_MISMATCH")
                edges = coordinator.store.transitions_for_session("scan-session")
                self.assertEqual(len(edges), 1)
                self.assertEqual((edges[0]["from_map_instance_id"], edges[0]["to_map_instance_id"]), ("A", "B"))
                scan = coordinator.store.get_scan_state("scan-session")
                self.assertEqual(set(scan["scanned_map_instance_ids"]), {"A", "B"})
            finally:
                coordinator.store.close()

    def test_change_map_completion_ack_precedes_live_unfightable_enemy_planning(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            settings = make_settings(Path(directory), rate_limit_per_second=0)
            stair = make_block(x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor")
            mark_floor(settings, floor_id="MT0")
            label_block(settings, stair, category="stair")
            coordinator = CycleCoordinator(settings)
            try:
                pre = make_observation(
                    floor_id="MT0", floor_number=0, map_instance_id="MT0-map",
                    width=2, height=1, x=0, y=0, blocks=[stair], session_id="live-enemy-session",
                    attack=10, hp=1000, yellow=0, blue=1, red=1,
                )
                issued = coordinator.cycle(CycleRequest.model_validate(make_request(pre)))
                self.assertEqual(issued["status"], "execute")
                self.assertEqual(issued["action_kind"], "SCAN_OPAQUE_EXIT")

                unfightable = make_enemy_block(
                    x=0, y=0, damage=None, block_id="blackSlime",
                )
                unfightable["enemy"].update({
                    "hp": 200, "attack": 35, "defense": 10,
                    "gold": 5, "experience": 5, "special": [],
                })
                post = make_observation(
                    floor_id="MT1", floor_number=1, map_instance_id="MT1-map",
                    width=2, height=1, x=1, y=0, blocks=[unfightable],
                    session_id="live-enemy-session", captured_at=1234567891,
                    attack=10, hp=1000, yellow=0, blue=1, red=1,
                )
                post_fp = observation_fingerprint(Observation.model_validate(post))
                completed = make_request(
                    post,
                    completed_action_id=issued["action_id"],
                    recovery={
                        "phase": "completed",
                        "pending_action_id": issued["action_id"],
                        "pre_fingerprint": observation_fingerprint(Observation.model_validate(pre)),
                        "current_fingerprint": post_fp,
                        "detail_code": None,
                    },
                )
                acknowledged = coordinator.cycle(CycleRequest.model_validate(completed))
                self.assertEqual(acknowledged["status"], "pause")
                self.assertEqual(acknowledged["acknowledged_action_id"], issued["action_id"])
                self.assertEqual(coordinator.store.get_action(issued["action_id"]).status, "completed")
                events = [
                    json.loads(line)["event"]
                    for line in settings.log_path.read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
                self.assertIn("action_completed", events)
                self.assertEqual(
                    coordinator.cycle(CycleRequest.model_validate(completed)), acknowledged,
                )
            finally:
                coordinator.store.close()

            restarted = CycleCoordinator(settings)
            try:
                repeated = restarted.cycle(CycleRequest.model_validate(completed))
                self.assertEqual(repeated["status"], "pause")
                self.assertEqual(repeated["acknowledged_action_id"], issued["action_id"])
                self.assertEqual(
                    restarted.store._connection.execute(
                        "SELECT COUNT(*) FROM actions",
                    ).fetchone()[0],
                    1,
                )
                self.assertEqual(restarted.store.unresolved_action_count("live-enemy-session"), 0)
            finally:
                restarted.store.close()

    def test_frontier_scan_and_boundary_removal_recompute(self) -> None:
        boundary = make_block(x=1, y=0, block_id="door")
        label = BlockLabel(
            id="door", cls="items", trigger="getItem", category="door",
            passable=False, boundary=True, fast_path=False,
            expected_delta={"keys": {"yellow": -1}},
        )
        pre = Observation.model_validate(make_observation(width=3, height=1, blocks=[boundary]))
        post = Observation.model_validate(make_observation(width=3, height=1, blocks=[]))
        self.assertNotIn((2, 0), CurrentFloorGraph(pre, {label.identity: label}).reachable().coordinates)
        self.assertIn((2, 0), CurrentFloorGraph(post, {label.identity: label}).reachable().coordinates)
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "world.sqlite3")
            try:
                store.ensure_session(pre.session_id, "new_game", None, confirm=True)
                pre_fp = store.record_observation(pre)
                store.record_world_snapshot(pre, pre_fp)
                store.sync_frontiers(pre, pre_fp, {(1, 0)})
                self.assertEqual(len(store.frontiers_for_session(pre.session_id)), 1)
                post_fp = store.record_observation(post)
                store.record_world_snapshot(post, post_fp)
                store.sync_frontiers(post, post_fp, set())
                self.assertEqual(store.frontiers_for_session(pre.session_id), [])
            finally:
                store.close()

    def test_new_game_requires_explicit_confirmation_then_resume(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            settings = make_settings(Path(directory), rate_limit_per_second=0)
            coordinator = CycleCoordinator(settings)
            try:
                raw = make_request(make_observation())
                raw["session"]["command"] = "observe"
                first = coordinator.cycle(CycleRequest.model_validate(raw))
                self.assertEqual(first["pause_kind"], "SESSION_CONFIRMATION_REQUIRED")
                raw["session"]["command"] = "confirm"
                confirmed = coordinator.cycle(CycleRequest.model_validate(raw))
                self.assertNotEqual(confirmed.get("pause_kind"), "SESSION_CONFIRMATION_REQUIRED")
                raw["session"] = {"mode": "resume_existing_ledger", "command": "observe"}
                resumed = coordinator.cycle(CycleRequest.model_validate(raw))
                self.assertNotEqual(resumed.get("pause_kind"), "SESSION_CONFIRMATION_REQUIRED")
            finally:
                coordinator.store.close()

    def test_handoff_guard_must_match_before_confirmation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            coordinator = CycleCoordinator(make_settings(Path(directory), rate_limit_per_second=0))
            try:
                observation = Observation.model_validate(make_observation(session_id="handoff"))
                guard = guard_from_observation(observation).model_dump(mode="json")
                guard["hp"] += 1
                raw = make_request(observation.model_dump(mode="json", exclude_none=True))
                raw["session"] = {
                    "mode": "handoff_expected_guard",
                    "command": "confirm",
                    "expected_guard": guard,
                }
                response = coordinator.cycle(CycleRequest.model_validate(raw))
                self.assertEqual(response["detail_code"], "HANDOFF_BASELINE_MISMATCH")
                self.assertIsNone(coordinator.store.session_status("handoff"))
                raw["session"]["expected_guard"]["hp"] -= 1
                accepted = coordinator.cycle(CycleRequest.model_validate(raw))
                self.assertNotEqual(accepted.get("detail_code"), "SESSION_NOT_CONFIRMED")
                self.assertEqual(coordinator.store.session_status("handoff"), "confirmed")
            finally:
                coordinator.store.close()

    def test_world_planning_budget_exhausts_without_action(self) -> None:
        blocks = [make_block(x=1, y=0, block_id="a"), make_block(x=0, y=1, block_id="b")]
        observation = Observation.model_validate(make_observation(width=2, height=2, blocks=blocks))
        labels = {}
        for block in blocks:
            label = BlockLabel(
                id=block["id"], cls=block["cls"], trigger=block["trigger"],
                category="resource", passable=False, boundary=True, fast_path=False,
                expected_delta={"hp": 1},
            )
            labels[label.identity] = label
        response = Planner(planning_budget=1).plan(
            observation,
            labels,
            action_id_factory=lambda: "AUTO-0000000000000001",
            registry_entries=[],
            world_context={"transitions": [], "frontiers": []},
        )
        self.assertEqual(response.status, "pause")
        self.assertEqual(response.pause_kind.value, "PLANNING_BUDGET_EXHAUSTED")

    def test_incomplete_cross_map_edge_stays_opaque(self) -> None:
        stair = make_block(x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor")
        observation = Observation.model_validate(make_observation(width=2, height=1, blocks=[stair], map_instance_id="A"))
        label = BlockLabel(
            id=stair["id"], cls=stair["cls"], trigger=stair["trigger"],
            category="stair", passable=False, boundary=True, fast_path=False,
        )
        response = Planner().plan(
            observation, {label.identity: label},
            action_id_factory=lambda: "AUTO-0000000000000001",
            registry_entries=[],
            world_context={"transitions": [{
                "from_map_instance_id": "A", "to_map_instance_id": "B",
                "from_x": 1, "from_y": 0,
            }]},
        )
        self.assertEqual(response.status, "execute")
        self.assertNotIn("已验证的跨图返回边", response.reason)
        self.assertIsNone(response.expected_delta.map_instance_id)

    def test_world_search_simulates_transition_then_remote_boundary(self) -> None:
        stair = make_block(x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor")
        resource = make_block(x=1, y=0, block_id="remotePotion", cls="items", trigger="getItem")
        first = Observation.model_validate(make_observation(
            width=2, height=1, blocks=[stair], map_instance_id="A", floor_id="A"
        ))
        second = Observation.model_validate(make_observation(
            width=2, height=1, blocks=[resource], map_instance_id="B", floor_id="B"
        ))
        stair_label = BlockLabel(
            id=stair["id"], cls=stair["cls"], trigger=stair["trigger"],
            category="stair", passable=False, boundary=True, fast_path=False,
        )
        resource_label = BlockLabel(
            id=resource["id"], cls=resource["cls"], trigger=resource["trigger"],
            category="resource", passable=False, boundary=True, fast_path=False,
            expected_delta={"attack": 10},
        )
        planner = Planner(planning_budget=32)
        result, exhausted = planner._world_search(
            first,
            {stair_label.identity: stair_label, resource_label.identity: resource_label},
            {
                "map_facts": [map_fact(first), map_fact(second)],
                "transitions": [{
                    "from_map_instance_id": "A", "to_map_instance_id": "B",
                    "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0,
                }],
            },
        )
        self.assertFalse(exhausted)
        self.assertIsNotNone(result)
        self.assertEqual(result.first.boundary.block.id, "upFloor")
        self.assertEqual(result.target.boundary.block.id, "remotePotion")
        self.assertEqual(result.target_map_instance_id, "B")
        self.assertGreaterEqual(result.path_length, 2)
        self.assertEqual(result.score, 309.5)

        stale_result, _ = planner._world_search(
            first,
            {stair_label.identity: stair_label, resource_label.identity: resource_label},
            {
                "map_facts": [map_fact(first), map_fact(second)],
                "map_instances": [
                    {
                        "map_instance_id": "A", "floor_id": "A",
                        "topology_fingerprint": first.topology_fingerprint,
                        "dimensions_json": json.dumps({"height": 1, "width": 2}, sort_keys=True, separators=(",", ":")),
                    },
                    {
                        "map_instance_id": "B", "floor_id": "stale-wrong-floor",
                        "topology_fingerprint": second.topology_fingerprint,
                        "dimensions_json": json.dumps({"height": 1, "width": 2}, sort_keys=True, separators=(",", ":")),
                    },
                ],
                "transitions": [{
                    "from_map_instance_id": "A", "to_map_instance_id": "B",
                    "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0,
                }],
            },
        )
        self.assertIsNotNone(stale_result)
        self.assertEqual(stale_result.path_length, 1)
        self.assertLess(stale_result.score, 300)

    def test_world_search_uses_only_live_resources_not_historical_map_state(self) -> None:
        stair = make_block(
            x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor"
        )
        door = make_block(
            x=1, y=0, block_id="yellowDoor", cls="terrains", trigger="openDoor"
        )
        resource = make_block(
            x=2, y=0, block_id="remoteAttack", cls="items", trigger="getItem"
        )
        current = Observation.model_validate(make_observation(
            width=2, height=1, blocks=[stair], map_instance_id="A", floor_id="A",
            yellow=0, hp=20,
        ))
        historical_remote = Observation.model_validate(make_observation(
            width=3, height=1, blocks=[door, resource], map_instance_id="B", floor_id="B",
            yellow=99, hp=9999,
        ))
        stair_label = BlockLabel(
            id=stair["id"], cls=stair["cls"], trigger=stair["trigger"],
            category="stair", passable=False, boundary=True, fast_path=False,
        )
        door_label = BlockLabel(
            id=door["id"], cls=door["cls"], trigger=door["trigger"],
            category="door", passable=False, boundary=True, fast_path=False,
            expected_delta={"keys": {"yellow": -1}},
        )
        resource_label = BlockLabel(
            id=resource["id"], cls=resource["cls"], trigger=resource["trigger"],
            category="resource", passable=False, boundary=True, fast_path=False,
            expected_delta={"attack": 10},
        )
        result, exhausted = Planner(planning_budget=32)._world_search(
            current,
            {stair_label.identity: stair_label, door_label.identity: door_label,
             resource_label.identity: resource_label},
            {
                "map_facts": [map_fact(current), map_fact(historical_remote)],
                "transitions": [{
                    "from_map_instance_id": "A", "to_map_instance_id": "B",
                    "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0,
                }],
            },
        )
        self.assertFalse(exhausted)
        self.assertIsNone(result)

        with_key = Observation.model_validate(make_observation(
            width=2, height=1, blocks=[stair], map_instance_id="A", floor_id="A",
            yellow=1, hp=20,
        ))
        unlocked, _ = Planner(planning_budget=32)._world_search(
            with_key,
            {stair_label.identity: stair_label, door_label.identity: door_label,
             resource_label.identity: resource_label},
            {
                "map_facts": [map_fact(with_key), map_fact(historical_remote)],
                "transitions": [{
                    "from_map_instance_id": "A", "to_map_instance_id": "B",
                    "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0,
                }],
            },
        )
        self.assertIsNotNone(unlocked)
        self.assertGreaterEqual(unlocked.path_length, 3)

    def test_known_unfightable_enemy_is_never_crossed_by_scan_or_world_search(self) -> None:
        exit_stair = make_block(
            x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor"
        )
        enemy = make_enemy_block(x=1, y=0, damage=5, block_id="blockedEnemy")
        enemy["enemy"]["defense"] = 10
        remote_resource = make_block(x=2, y=0, block_id="behindEnemy")
        current = Observation.model_validate(make_observation(
            width=2, height=1, blocks=[exit_stair], map_instance_id="A", floor_id="A",
            attack=10,
        ))
        remote = Observation.model_validate(make_observation(
            width=3, height=1, blocks=[enemy, remote_resource],
            map_instance_id="B", floor_id="B", attack=10,
        ))
        stair_label = BlockLabel(
            id=exit_stair["id"], cls=exit_stair["cls"], trigger=exit_stair["trigger"],
            category="stair", passable=False, boundary=True, fast_path=False,
        )
        enemy_label = BlockLabel(
            id=enemy["id"], cls=enemy["cls"], trigger=enemy["trigger"],
            category="enemy", passable=False, boundary=True, fast_path=False,
        )
        resource_label = BlockLabel(
            id=remote_resource["id"], cls=remote_resource["cls"],
            trigger=remote_resource["trigger"], category="resource",
            passable=False, boundary=True, fast_path=False,
            expected_delta={"attack": 10},
        )
        labels = {
            stair_label.identity: stair_label,
            enemy_label.identity: enemy_label,
            resource_label.identity: resource_label,
        }
        planner = Planner(planning_budget=32)
        result, exhausted = planner._world_search(
            current,
            labels,
            {
                "map_facts": [map_fact(current), map_fact(remote)],
                "transitions": [{
                    "from_map_instance_id": "A", "to_map_instance_id": "B",
                    "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0,
                }],
            },
        )
        self.assertFalse(exhausted)
        self.assertIsNone(result)

        blocked_stair = make_block(
            x=2, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor"
        )
        scan_enemy = make_enemy_block(x=1, y=0, damage=None, block_id="blockedEnemy")
        scan_enemy["enemy"]["defense"] = 10
        scan_observation = Observation.model_validate(make_observation(
            width=3, height=1, blocks=[scan_enemy, blocked_stair],
            map_instance_id="B", floor_id="B", attack=10,
        ))
        scan_response = planner.plan(
            scan_observation,
            labels,
            action_id_factory=lambda: "AUTO-0000000000000001",
            registry_entries=[],
            world_context={"map_facts": [map_fact(scan_observation)], "transitions": [], "frontiers": []},
            scan_state={
                "phase": "discover",
                "anchor_map_instance_id": "B",
                "current_map_instance_id": "B",
                "scanned_map_instance_ids": ["B"],
                "pending_exits": [],
                "traversed_transitions": [],
                "reason": "synthetic scan",
            },
        )
        self.assertEqual(scan_response.status, "idle")
        self.assertNotIn("action_id", scan_response.model_dump(mode="json", exclude_unset=True))

    def test_world_search_never_reuses_live_enemy_fact_after_same_map_resource(self) -> None:
        gem = make_block(x=1, y=0, block_id="redGem")
        enemy = make_enemy_block(x=2, y=0, damage=0, block_id="staleEnemy")
        enemy["enemy"].update({"defense": 10, "gold": 20_000, "experience": 0})
        observation = Observation.model_validate(make_observation(
            width=3, height=1, x=0, y=0, attack=10,
            map_instance_id="A", floor_id="A", blocks=[gem, enemy],
        ))
        gem_label = BlockLabel(
            id=gem["id"], cls=gem["cls"], trigger=gem["trigger"],
            category="resource", passable=False, boundary=True, fast_path=False,
            expected_delta={"attack": 10},
        )
        enemy_label = BlockLabel(
            id=enemy["id"], cls=enemy["cls"], trigger=enemy["trigger"],
            category="enemy", passable=False, boundary=True, fast_path=False,
        )

        result, exhausted = Planner(planning_budget=32)._world_search(
            observation,
            {gem_label.identity: gem_label, enemy_label.identity: enemy_label},
            {"map_facts": [map_fact(observation)], "transitions": []},
        )

        self.assertFalse(exhausted)
        self.assertIsNotNone(result)
        self.assertEqual(result.first.boundary.block.id, "redGem")
        self.assertEqual(result.path_length, 1)
        self.assertEqual(result.score, 309.5)

    def test_world_search_never_reuses_live_enemy_fact_after_non_attack_resource(self) -> None:
        potion = make_block(x=1, y=0, block_id="redPotion")
        enemy = make_enemy_block(x=2, y=0, damage=0, block_id="staleEnemy")
        enemy["enemy"].update({"defense": 1, "gold": 20_000, "experience": 0})
        observation = Observation.model_validate(make_observation(
            width=3, height=1, x=0, y=0, attack=10,
            map_instance_id="A", floor_id="A", blocks=[potion, enemy],
        ))
        potion_label = BlockLabel(
            id=potion["id"], cls=potion["cls"], trigger=potion["trigger"],
            category="resource", passable=False, boundary=True, fast_path=False,
            expected_delta={"hp": 200},
        )
        enemy_label = BlockLabel(
            id=enemy["id"], cls=enemy["cls"], trigger=enemy["trigger"],
            category="enemy", passable=False, boundary=True, fast_path=False,
        )

        result, _ = Planner(planning_budget=32)._world_search(
            observation,
            {potion_label.identity: potion_label, enemy_label.identity: enemy_label},
            {"map_facts": [map_fact(observation)], "transitions": []},
        )

        self.assertIsNotNone(result)
        self.assertEqual(result.first.boundary.block.id, "redPotion")
        self.assertEqual(result.path_length, 1)
        self.assertEqual(result.score, 209.5)

    def test_world_search_never_reuses_live_enemy_fact_after_return_to_same_map(self) -> None:
        portal_a = make_block(
            x=1, y=0, block_id="portalA", cls="terrains", trigger="changeFloor"
        )
        enemy = make_enemy_block(x=3, y=0, damage=0, block_id="staleEnemy")
        enemy["enemy"].update({"defense": 1, "gold": 20_000, "experience": 0})
        portal_b = make_block(
            x=1, y=0, block_id="portalB", cls="terrains", trigger="changeFloor"
        )
        current = Observation.model_validate(make_observation(
            width=4, height=1, x=0, y=0, map_instance_id="A", floor_id="A",
            blocks=[portal_a, enemy],
        ))
        remote = Observation.model_validate(make_observation(
            width=2, height=1, x=0, y=0, map_instance_id="B", floor_id="B",
            blocks=[portal_b],
        ))
        labels = {}
        for portal in (portal_a, portal_b):
            label = BlockLabel(
                id=portal["id"], cls=portal["cls"], trigger=portal["trigger"],
                category="stair", passable=False, boundary=True, fast_path=False,
            )
            labels[label.identity] = label
        enemy_label = BlockLabel(
            id=enemy["id"], cls=enemy["cls"], trigger=enemy["trigger"],
            category="enemy", passable=False, boundary=True, fast_path=False,
        )
        labels[enemy_label.identity] = enemy_label

        result, exhausted = Planner(planning_budget=32)._world_search(
            current,
            labels,
            {
                "map_facts": [map_fact(current), map_fact(remote)],
                "transitions": [
                    {
                        "from_map_instance_id": "A", "to_map_instance_id": "B",
                        "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0,
                    },
                    {
                        "from_map_instance_id": "B", "to_map_instance_id": "A",
                        "from_x": 1, "from_y": 0, "to_x": 2, "to_y": 0,
                    },
                ],
            },
        )

        self.assertFalse(exhausted)
        self.assertIsNone(result)

    def test_world_search_live_root_enemy_is_a_terminal_atomic_candidate(self) -> None:
        enemy = make_enemy_block(x=1, y=0, damage=10, block_id="liveEnemy")
        enemy["enemy"].update({"defense": 1, "gold": 5, "experience": 4})
        observation = Observation.model_validate(make_observation(
            width=2, height=1, x=0, y=0, map_instance_id="A", floor_id="A",
            blocks=[enemy],
        ))
        label = BlockLabel(
            id=enemy["id"], cls=enemy["cls"], trigger=enemy["trigger"],
            category="enemy", passable=False, boundary=True, fast_path=False,
        )

        result, exhausted = Planner(planning_budget=32)._world_search(
            observation, {label.identity: label},
            {"map_facts": [map_fact(observation)], "transitions": []},
        )

        self.assertFalse(exhausted)
        self.assertIsNotNone(result)
        self.assertEqual(result.first.boundary.block.id, "liveEnemy")
        self.assertEqual(result.path_length, 1)

    def test_unknown_exit_is_opaque_and_never_scores_resource_behind_it(self) -> None:
        stair = make_block(x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor")
        resource = make_block(x=2, y=0, block_id="behindStair", cls="items", trigger="getItem")
        observation = Observation.model_validate(make_observation(
            width=3, height=1, blocks=[stair, resource], map_instance_id="A",
        ))
        stair_label = BlockLabel(
            id=stair["id"], cls=stair["cls"], trigger=stair["trigger"],
            category="stair", passable=False, boundary=True, fast_path=False,
        )
        resource_label = BlockLabel(
            id=resource["id"], cls=resource["cls"], trigger=resource["trigger"],
            category="resource", passable=False, boundary=True, fast_path=False,
            expected_delta={"attack": 10},
        )
        result, exhausted = Planner(planning_budget=32)._world_search(
            observation,
            {stair_label.identity: stair_label, resource_label.identity: resource_label},
            {"map_facts": [map_fact(observation)], "transitions": []},
        )
        self.assertFalse(exhausted)
        self.assertIsNotNone(result)
        self.assertEqual(result.first.boundary.block.id, "upFloor")
        self.assertEqual(result.path_length, 1)
        self.assertLess(result.score, 300)

    def test_takeover_scan_prioritizes_safe_exit_and_never_consumes_resource_or_blocker(self) -> None:
        stair = make_block(x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor")
        resource = make_block(x=0, y=1, block_id="hugeAttack", cls="items", trigger="getItem")
        door = make_block(x=2, y=1, block_id="yellowDoor", cls="terrains", trigger="openDoor")
        npc = make_block(x=2, y=0, block_id="optionalNpc", cls="npcs", trigger="action")
        observation = Observation.model_validate(make_observation(
            width=3, height=2, blocks=[stair, resource, door, npc], map_instance_id="A",
        ))
        labels = {}
        for block, category, delta in (
            (stair, "stair", None),
            (resource, "resource", {"attack": 999}),
            (door, "door", {"keys": {"yellow": -1}}),
        ):
            label = BlockLabel(
                id=block["id"], cls=block["cls"], trigger=block["trigger"],
                category=category, passable=False, boundary=True, fast_path=False,
                expected_delta=delta,
            )
            labels[label.identity] = label
        npc_label = BlockLabel(
            id=npc["id"], cls=npc["cls"], trigger=npc["trigger"],
            category="npc", passable=False, boundary=True, fast_path=False,
            supported=False,
        )
        labels[npc_label.identity] = npc_label
        scan_state = {
            "phase": "discover", "anchor_map_instance_id": "A",
            "current_map_instance_id": "A", "scanned_map_instance_ids": ["A"],
            "pending_exits": [], "traversed_transitions": [],
            "reason": "initial takeover scan",
        }
        response = Planner().plan(
            observation, labels,
            action_id_factory=lambda: "AUTO-0000000000000001",
            registry_entries=[],
            world_context={"map_facts": [map_fact(observation)], "transitions": []},
            scan_state=scan_state,
        )
        self.assertEqual(response.status, "execute")
        self.assertEqual(response.action_kind, "SCAN_OPAQUE_EXIT")
        self.assertEqual((response.operations[-1].x, response.operations[-1].y), (1, 0))
        self.assertEqual(response.expected_delta.map_instance_id, None)
        self.assertEqual(response.scan_state.phase, "discover")
        self.assertIn("scan", response.reason.lower())

        no_exit = Observation.model_validate(make_observation(
            width=3, height=2, blocks=[resource, door, npc], map_instance_id="A",
        ))
        completed = Planner().plan(
            no_exit, labels,
            action_id_factory=lambda: "AUTO-0000000000000002",
            registry_entries=[],
            world_context={"map_facts": [map_fact(no_exit)], "transitions": []},
            scan_state=scan_state,
        )
        self.assertEqual(completed.status, "idle")
        self.assertEqual(completed.scan_state.phase, "complete")
        self.assertNotIn("action_id", completed.model_dump(mode="json", exclude_unset=True))

    def test_scan_uses_display_floor_only_as_lowest_target_hint(self) -> None:
        left = make_block(x=1, y=0, block_id="portal", cls="terrains", trigger="changeFloor")
        right = make_block(x=0, y=1, block_id="portal", cls="terrains", trigger="changeFloor")
        a = Observation.model_validate(make_observation(
            width=2, height=2, blocks=[left, right], map_instance_id="A", floor_number=10,
        ))
        b = Observation.model_validate(make_observation(
            width=2, height=2, map_instance_id="B", floor_id="same", floor_number=5,
        ))
        c = Observation.model_validate(make_observation(
            width=2, height=2, map_instance_id="C", floor_id="same", floor_number=2,
        ))
        label = BlockLabel(
            id="portal", cls="terrains", trigger="changeFloor", category="stair",
            passable=False, boundary=True, fast_path=False,
        )
        response = Planner().plan(
            a, {label.identity: label},
            action_id_factory=lambda: "AUTO-0000000000000001",
            registry_entries=[],
            world_context={
                "map_facts": [map_fact(item) for item in (a, b, c)],
                "transitions": [
                    {"from_map_instance_id": "A", "to_map_instance_id": "B", "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0},
                    {"from_map_instance_id": "A", "to_map_instance_id": "C", "from_x": 0, "from_y": 1, "to_x": 0, "to_y": 0},
                ],
            },
            scan_state={
                "phase": "discover", "anchor_map_instance_id": "A",
                "current_map_instance_id": "A", "scanned_map_instance_ids": ["A", "B", "C"],
                "pending_exits": [], "traversed_transitions": [], "reason": "scan",
            },
        )
        self.assertEqual(response.status, "idle")
        self.assertEqual(response.scan_state.phase, "complete")
        self.assertNotIn("action_id", response.model_dump(mode="json", exclude_unset=True))

    def test_ordinary_verified_transition_binds_exact_target_and_ambiguous_exit_pauses(self) -> None:
        stair = make_block(x=1, y=0, block_id="portal", cls="terrains", trigger="changeFloor")
        a = Observation.model_validate(make_observation(
            width=2, height=1, blocks=[stair], map_instance_id="A", floor_id="same",
        ))
        b = Observation.model_validate(make_observation(
            width=2, height=1, map_instance_id="B", floor_id="same", x=0, y=0,
        ))
        c = Observation.model_validate(make_observation(
            width=2, height=1, map_instance_id="C", floor_id="other", x=0, y=0,
        ))
        label = BlockLabel(
            id="portal", cls="terrains", trigger="changeFloor", category="stair",
            passable=False, boundary=True, fast_path=False,
        )
        scan = {
            "phase": "complete", "anchor_map_instance_id": "A",
            "current_map_instance_id": "A", "scanned_map_instance_ids": ["A", "B", "C"],
            "pending_exits": [], "traversed_transitions": [], "reason": "complete",
        }
        context = {
            "map_facts": [map_fact(item) for item in (a, b, c)],
            "transitions": [{
                "from_map_instance_id": "A", "to_map_instance_id": "B",
                "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0,
            }],
        }
        exact = Planner().plan(
            a, {label.identity: label},
            action_id_factory=lambda: "AUTO-0000000000000001", registry_entries=[],
            world_context=context, scan_state=scan,
        )
        self.assertEqual(exact.status, "idle")
        self.assertNotIn("action_id", exact.model_dump(mode="json", exclude_unset=True))

        ambiguous_context = copy.deepcopy(context)
        ambiguous_context["transitions"].append({
            "from_map_instance_id": "A", "to_map_instance_id": "C",
            "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0,
        })
        ambiguous = Planner().plan(
            a, {label.identity: label},
            action_id_factory=lambda: "AUTO-0000000000000002", registry_entries=[],
            world_context=ambiguous_context, scan_state=scan,
        )
        self.assertEqual(ambiguous.status, "pause")
        self.assertEqual(ambiguous.detail_code, "TRANSITION_TARGET_AMBIGUOUS")

        scan_ambiguous = copy.deepcopy(scan)
        scan_ambiguous.update({
            "phase": "discover", "pending_exits": [], "reason": "scan",
        })
        ambiguous_during_scan = Planner().plan(
            a, {label.identity: label},
            action_id_factory=lambda: "AUTO-0000000000000003", registry_entries=[],
            world_context=ambiguous_context, scan_state=scan_ambiguous,
        )
        self.assertEqual(ambiguous_during_scan.status, "pause")
        self.assertEqual(
            ambiguous_during_scan.detail_code, "TRANSITION_TARGET_AMBIGUOUS",
        )

    def test_one_way_scan_pauses_unreachable_pending_and_reverse_edge_repositions(self) -> None:
        a_exit = make_block(x=1, y=0, block_id="portal", cls="terrains", trigger="changeFloor")
        a_other = make_block(x=0, y=1, block_id="portal", cls="terrains", trigger="changeFloor")
        b_exit = make_block(x=1, y=0, block_id="portal", cls="terrains", trigger="changeFloor")
        a = Observation.model_validate(make_observation(
            width=2, height=2, map_instance_id="A", blocks=[a_exit, a_other],
        ))
        b = Observation.model_validate(make_observation(
            width=2, height=2, map_instance_id="B", blocks=[],
        ))
        b_with_return = Observation.model_validate(make_observation(
            width=2, height=2, map_instance_id="B", blocks=[b_exit], captured_at=1234567891,
        ))
        label = BlockLabel(
            id="portal", cls="terrains", trigger="changeFloor", category="stair",
            passable=False, boundary=True, fast_path=False,
        )
        traversed = [{
            "from_map_instance_id": "A", "from_x": 1, "from_y": 0,
            "to_map_instance_id": "B", "to_x": 0, "to_y": 0,
        }]
        state = {
            "phase": "sweep", "anchor_map_instance_id": "A",
            "current_map_instance_id": "B", "scanned_map_instance_ids": ["A", "B"],
            "pending_exits": [], "traversed_transitions": traversed, "reason": "scan",
        }
        base_context = {
            "map_facts": [map_fact(a), map_fact(b)],
            "transitions": [{
                "from_map_instance_id": "A", "to_map_instance_id": "B",
                "from_x": 1, "from_y": 0, "to_x": 0, "to_y": 0,
            }],
        }
        paused = Planner().plan(
            b, {label.identity: label},
            action_id_factory=lambda: "AUTO-0000000000000001", registry_entries=[],
            world_context=base_context, scan_state=state,
        )
        self.assertEqual(paused.status, "idle")
        self.assertEqual(paused.scan_state.phase, "paused")

        reversible_context = copy.deepcopy(base_context)
        reversible_context["map_facts"] = [map_fact(a), map_fact(b_with_return)]
        reversible_context["transitions"].append({
            "from_map_instance_id": "B", "to_map_instance_id": "A",
            "from_x": 1, "from_y": 0, "to_x": 1, "to_y": 0,
        })
        returning = Planner().plan(
            b_with_return, {label.identity: label},
            action_id_factory=lambda: "AUTO-0000000000000002", registry_entries=[],
            world_context=reversible_context, scan_state=state,
        )
        self.assertEqual(returning.status, "execute")
        self.assertEqual(returning.action_kind, "SCAN_VERIFIED_TRANSITION")
        self.assertEqual(returning.expected_delta.map_instance_id, "A")

    def test_scan_transition_and_audit_survive_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "world.sqlite3"
            store = Store(path)
            stair = make_block(x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor")
            pre = Observation.model_validate(make_observation(
                width=2, height=1, map_instance_id="A", floor_id="same", blocks=[stair],
            ))
            post = Observation.model_validate(make_observation(
                width=2, height=1, map_instance_id="B", floor_id="same", x=0, y=0,
                captured_at=1234567891,
            ))
            pre_fp, _ = store.ingest_observation(pre, "new_game", None, confirm=True)
            label = BlockLabel(
                id=stair["id"], cls=stair["cls"], trigger=stair["trigger"],
                category="stair", passable=False, boundary=True, fast_path=False,
            )
            response = Planner().plan(
                pre, {label.identity: label},
                action_id_factory=lambda: "AUTO-0000000000000001",
                registry_entries=[],
                world_context={"map_facts": [map_fact(pre)], "transitions": []},
                scan_state=store.get_scan_state(pre.session_id),
            )
            wire = response.model_dump(mode="json", exclude_unset=True)
            store.save_decision(
                decision_key="scan-action", observation_fingerprint=pre_fp,
                knowledge_fingerprint="knowledge", response=wire,
            )
            post_fp = store.record_observation(post)
            store.record_world_snapshot(post, post_fp)
            store.confirm_action_and_transition(response.action_id, post_fp, pre, post)
            store.close()

            reopened = Store(path)
            scan = reopened.get_scan_state(pre.session_id)
            self.assertEqual(scan["phase"], "sweep")
            self.assertEqual(scan["current_map_instance_id"], "B")
            self.assertEqual(set(scan["scanned_map_instance_ids"]), {"A", "B"})
            self.assertEqual(len(scan["traversed_transitions"]), 1)
            audit = reopened.scan_audit_for_session(pre.session_id)
            self.assertEqual([item["event"] for item in audit], ["scan_started", "transition_observed"])
            reopened.close()

    def test_transition_is_created_only_from_pre_post_completion_and_deduplicates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "world.sqlite3")
            try:
                pre = Observation.model_validate(make_observation(map_instance_id="A"))
                post = Observation.model_validate(make_observation(map_instance_id="B", x=2, y=3))
                store.ensure_session(pre.session_id, "new_game", None, confirm=True)
                for item in (pre, post):
                    fp = store.record_observation(item)
                    store.record_world_snapshot(item, fp)
                store.record_transition("AUTO-0000000000000001", pre, post)
                store.record_transition("AUTO-0000000000000001", pre, post)
                self.assertEqual(len(store.transitions_for_session(pre.session_id)), 1)
                store.record_transition("AUTO-0000000000000002", post, pre)
                rows = store.transitions_for_session(pre.session_id)
                self.assertEqual(len(rows), 2)
                self.assertTrue(all(row["reversible"] for row in rows))

                # The same map pair can have unrelated portals.  Only the exact
                # endpoint inverse may become reversible.
                a2 = Observation.model_validate(make_observation(
                    map_instance_id="A", x=5, y=5, captured_at=1234567891,
                ))
                b2 = Observation.model_validate(make_observation(
                    map_instance_id="B", x=7, y=7, captured_at=1234567891,
                ))
                store.record_transition("AUTO-0000000000000003", a2, b2)
                rows = store.transitions_for_session(pre.session_id)
                edge = next(row for row in rows if row["action_id"] == "AUTO-0000000000000003")
                self.assertFalse(edge["reversible"])
                store.close()
                reopened = Store(Path(directory) / "world.sqlite3")
                rows = reopened.transitions_for_session(pre.session_id)
                self.assertEqual(sum(bool(row["reversible"]) for row in rows), 2)
                reopened.close()
                store = None
            finally:
                if store is not None:
                    store.close()

    def test_cors_is_default_deny_and_exact_when_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            settings = make_settings(Path(directory), rate_limit_per_second=0)
            headers = {
                "Origin": "https://h5mota.com",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-mota-lab",
            }
            with TestClient(create_app(settings)) as client:
                denied = client.options("/cycle", headers=headers)
                self.assertNotIn("access-control-allow-origin", denied.headers)
            with TestClient(create_app(replace(settings, direct_mount_origin="https://h5mota.com"))) as client:
                allowed = client.options("/cycle", headers=headers)
                self.assertEqual(allowed.headers["access-control-allow-origin"], "https://h5mota.com")
                self.assertNotEqual(allowed.headers.get("access-control-allow-origin"), "*")

    def test_reconnect_only_never_issues_decision_or_action_and_preserves_unresolved_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            settings = make_settings(Path(directory), rate_limit_per_second=0)
            resource = make_block(x=1, y=0, block_id="potion")
            mark_floor(settings)
            label_block(settings, resource, category="resource", expected_delta={"hp": 10})
            observation = make_observation(blocks=[resource])
            coordinator = CycleCoordinator(settings)
            try:
                reconnect = make_request(observation, intent="reconnect_only")
                first = coordinator.cycle(CycleRequest.model_validate(reconnect))
                second = coordinator.cycle(CycleRequest.model_validate(reconnect))
                self.assertEqual(first["status"], "idle")
                self.assertEqual(second, first)
                self.assertEqual(
                    coordinator.store._connection.execute("SELECT COUNT(*) FROM actions").fetchone()[0], 0
                )
                self.assertEqual(
                    coordinator.store._connection.execute("SELECT COUNT(*) FROM decisions").fetchone()[0], 0
                )

                issued = coordinator.cycle(CycleRequest.model_validate(make_request(observation)))
                self.assertEqual(issued["status"], "execute")
                fingerprint = observation_fingerprint(Observation.model_validate(observation))
                pending_reconnect = make_request(
                    observation,
                    intent="reconnect_only",
                    recovery={
                        "phase": "not_executed",
                        "pending_action_id": issued["action_id"],
                        "pre_fingerprint": fingerprint,
                        "current_fingerprint": fingerprint,
                        "detail_code": None,
                    },
                )
                paused = coordinator.cycle(CycleRequest.model_validate(pending_reconnect))
                repeated = coordinator.cycle(CycleRequest.model_validate(pending_reconnect))
                self.assertEqual(paused["status"], "pause")
                self.assertEqual(paused["detail_code"], "RECONNECT_UNRESOLVED_ACTION")
                self.assertEqual(paused["details"]["ledger_action_id"], issued["action_id"])
                self.assertEqual(repeated["details"]["ledger_action_id"], issued["action_id"])
                self.assertEqual(
                    coordinator.store._connection.execute("SELECT COUNT(*) FROM actions").fetchone()[0], 1
                )
                self.assertEqual(
                    coordinator.store._connection.execute("SELECT COUNT(*) FROM decisions").fetchone()[0], 1
                )
            finally:
                coordinator.store.close()


if __name__ == "__main__":
    unittest.main()
