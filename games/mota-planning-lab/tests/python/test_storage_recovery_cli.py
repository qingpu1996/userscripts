from __future__ import annotations

import contextlib
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path

from mota_lab.__main__ import main as cli_main
from mota_lab.api import CycleCoordinator, ServiceError
from mota_lab.labels import list_pauses
from mota_lab.models import BlockLabel, CycleRequest, Observation
from mota_lab.state import observation_fingerprint

from mota_test_support import (
    label_block,
    make_block,
    make_observation,
    make_request,
    make_settings,
    mark_floor,
    registry,
)


class StorageAndRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = make_settings(self.root, rate_limit_per_second=0)
        self.resource = make_block(x=3, y=0, block_id="potion")
        mark_floor(self.settings)
        label_block(
            self.settings,
            self.resource,
            category="resource",
            expected_delta={"hp": 200},
        )
        self.pre = make_observation(blocks=[self.resource])

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def issue(self, coordinator: CycleCoordinator) -> dict:
        return coordinator.cycle(CycleRequest.model_validate(make_request(self.pre)))

    def test_observation_store_deduplicates_timestamp_only_changes(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            self.issue(coordinator)
            changed_time = copy.deepcopy(self.pre)
            changed_time["captured_at"] += 1000
            coordinator.cycle(CycleRequest.model_validate(make_request(changed_time)))
            fingerprint = observation_fingerprint(Observation.model_validate(self.pre))
            self.assertEqual(coordinator.store.observation_count(), 1)
            self.assertEqual(coordinator.store.observation_seen_count(fingerprint), 2)
        finally:
            coordinator.store.close()

    def test_response_loss_retry_and_service_restart_return_same_action(self) -> None:
        first_coordinator = CycleCoordinator(self.settings)
        first = self.issue(first_coordinator)
        first_coordinator.store.close()

        second_coordinator = CycleCoordinator(self.settings)
        try:
            second = self.issue(second_coordinator)
            self.assertEqual(first, second)
            self.assertEqual(second_coordinator.store.get_action(first["action_id"]).status, "issued")
        finally:
            second_coordinator.store.close()

    def test_session_wide_unresolved_action_blocks_new_fingerprint_and_replays_same_id(self) -> None:
        first_coordinator = CycleCoordinator(self.settings)
        first = self.issue(first_coordinator)
        first_fp = observation_fingerprint(Observation.model_validate(self.pre))
        changed = copy.deepcopy(self.pre)
        changed["hero"]["loc"]["x"] = 1
        changed_fp = observation_fingerprint(Observation.model_validate(changed))
        ambiguous = make_request(changed)
        ambiguous["session"] = {"mode": "resume_existing_ledger", "command": "observe"}
        ambiguous["recovery"] = {
            "phase": "none",
            "pending_action_id": None,
            "pre_fingerprint": None,
            "current_fingerprint": changed_fp,
            "detail_code": None,
        }
        response = first_coordinator.cycle(CycleRequest.model_validate(ambiguous))
        self.assertEqual(response["status"], "pause")
        self.assertEqual(response["detail_code"], "RECOVERY_JOURNAL_LEDGER_MISMATCH")
        self.assertEqual(first_coordinator.store.unresolved_action_count(self.pre["session_id"]), 1)
        first_coordinator.store.close()

        restarted = CycleCoordinator(self.settings)
        try:
            retry = make_request(self.pre)
            retry["session"] = {"mode": "resume_existing_ledger", "command": "observe"}
            retry["recovery"] = {
                "phase": "not_executed",
                "pending_action_id": first["action_id"],
                "pre_fingerprint": first_fp,
                "current_fingerprint": first_fp,
                "detail_code": None,
            }
            replayed = restarted.cycle(CycleRequest.model_validate(retry))
            self.assertEqual(replayed, first)
            self.assertEqual(restarted.store.unresolved_action_count(self.pre["session_id"]), 1)
            self.assertEqual(
                restarted.store._connection.execute("SELECT COUNT(*) FROM actions").fetchone()[0],
                1,
            )
        finally:
            restarted.store.close()

    def test_action_id_sequence_skips_collision_and_never_reuses_reserved_gap(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        first = self.issue(coordinator)
        with coordinator.store._connection:
            coordinator.store._connection.execute(
                "UPDATE action_id_sequence SET next_value=1 WHERE singleton=1"
            )
        reserved_gap = coordinator.store.reserve_action_id()
        self.assertNotEqual(reserved_gap, first["action_id"])
        coordinator.store.close()

        restarted = CycleCoordinator(self.settings)
        try:
            after_restart = restarted.store.reserve_action_id()
            self.assertNotIn(after_restart, {first["action_id"], reserved_gap})
            self.assertRegex(after_restart, r"^AUTO-[A-F0-9]{16}$")
        finally:
            restarted.store.close()

    def test_completed_roundtrip_reissues_unique_persistent_action_ids(self) -> None:
        stair = make_block(
            x=1,
            y=0,
            block_id="upFloor",
            cls="terrains",
            trigger="changeFloor",
        )
        settings = make_settings(self.root / "roundtrip", rate_limit_per_second=0)
        mark_floor(settings, "F1", "1F")
        label_block(settings, stair, category="stair")
        pre = make_observation(blocks=[stair])
        pre_fp = observation_fingerprint(Observation.model_validate(pre))
        post = make_observation(
            floor_id="F2",
            floor_name="2F",
            floor_number=2,
            x=5,
            y=5,
            blocks=[],
        )
        post_fp = observation_fingerprint(Observation.model_validate(post))

        def ledger_counts(coordinator: CycleCoordinator) -> tuple[int, int]:
            action_row = coordinator.store._connection.execute(
                "SELECT COUNT(*) AS count FROM actions"
            ).fetchone()
            decision_row = coordinator.store._connection.execute(
                "SELECT COUNT(*) AS count FROM decisions WHERE observation_fingerprint=?",
                (pre_fp,),
            ).fetchone()
            return int(action_row["count"]), int(decision_row["count"])

        def complete(coordinator: CycleCoordinator, action_id: str) -> None:
            completion = make_request(
                post,
                completed_action_id=action_id,
                recovery={
                    "phase": "completed",
                    "pending_action_id": action_id,
                    "pre_fingerprint": pre_fp,
                    "current_fingerprint": post_fp,
                    "detail_code": None,
                },
            )
            coordinator.cycle(CycleRequest.model_validate(completion))
            self.assertEqual(coordinator.store.get_action(action_id).status, "completed")

        first_coordinator = CycleCoordinator(settings)
        first = first_coordinator.cycle(CycleRequest.model_validate(make_request(pre)))
        self.assertRegex(first["action_id"], r"^AUTO-[A-F0-9]{16}$")
        self.assertEqual(
            first_coordinator.cycle(CycleRequest.model_validate(make_request(pre))),
            first,
        )
        self.assertEqual(ledger_counts(first_coordinator), (1, 1))
        complete(first_coordinator, first["action_id"])

        second = first_coordinator.cycle(CycleRequest.model_validate(make_request(pre)))
        self.assertNotEqual(second["action_id"], first["action_id"])
        self.assertEqual(
            first_coordinator.cycle(CycleRequest.model_validate(make_request(pre))),
            second,
        )
        self.assertEqual(ledger_counts(first_coordinator), (2, 1))
        first_coordinator.store.close()

        restarted = CycleCoordinator(settings)
        try:
            self.assertEqual(
                restarted.cycle(CycleRequest.model_validate(make_request(pre))),
                second,
            )
            self.assertEqual(ledger_counts(restarted), (2, 1))
            complete(restarted, second["action_id"])
            third = restarted.cycle(CycleRequest.model_validate(make_request(pre)))
            self.assertNotIn(third["action_id"], {first["action_id"], second["action_id"]})
            self.assertEqual(ledger_counts(restarted), (3, 1))
        finally:
            restarted.store.close()

    def test_triggerless_knowledge_label_persists_explicit_null_and_reloads(self) -> None:
        settings = make_settings(self.root / "triggerless", rate_limit_per_second=0)
        wall = make_block(
            x=1,
            y=0,
            block_id="wall",
            cls="terrains",
            trigger=None,
            no_pass=True,
        )
        label_block(
            settings,
            wall,
            category="wall",
            passable=False,
            boundary=False,
            fast_path=False,
        )
        raw = json.loads(settings.labels_path.read_text(encoding="utf-8"))
        self.assertIn("trigger", raw["labels"][0])
        self.assertIsNone(raw["labels"][0]["trigger"])
        reloaded = registry(settings).label_for(
            Observation.model_validate(make_observation(blocks=[wall])).blocks[0]
        )
        self.assertIsNotNone(reloaded)
        self.assertEqual(
            reloaded,
            BlockLabel.model_validate(raw["labels"][0]),
        )

    def test_completed_action_is_validated_and_confirmed_idempotently(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            action = self.issue(coordinator)
            post = make_observation(blocks=[], x=3, y=0, hp=408, captured_at=1234567999)
            post_fp = observation_fingerprint(Observation.model_validate(post))
            completion = make_request(
                post,
                completed_action_id=action["action_id"],
                recovery={
                    "phase": "completed",
                    "pending_action_id": action["action_id"],
                    "pre_fingerprint": observation_fingerprint(Observation.model_validate(self.pre)),
                    "current_fingerprint": post_fp,
                    "detail_code": None,
                },
            )
            response = coordinator.cycle(CycleRequest.model_validate(completion))
            self.assertEqual(response["status"], "idle")
            record = coordinator.store.get_action(action["action_id"])
            self.assertEqual(record.status, "completed")
            repeated = coordinator.cycle(CycleRequest.model_validate(completion))
            self.assertEqual(repeated, response)
        finally:
            coordinator.store.close()

    def test_expected_delta_mismatch_never_issues_a_followup(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            action = self.issue(coordinator)
            bad_post = make_observation(blocks=[], x=3, y=0, hp=407)
            completion = make_request(
                bad_post,
                completed_action_id=action["action_id"],
                recovery={
                    "phase": "completed",
                    "pending_action_id": action["action_id"],
                    "pre_fingerprint": observation_fingerprint(Observation.model_validate(self.pre)),
                    "current_fingerprint": observation_fingerprint(Observation.model_validate(bad_post)),
                    "detail_code": None,
                },
            )
            response = coordinator.cycle(CycleRequest.model_validate(completion))
            self.assertEqual(response["status"], "pause")
            self.assertEqual(response["pause_kind"], "EXPECTED_DELTA_MISMATCH")
            self.assertNotIn("action_id", response)
            self.assertEqual(coordinator.store.get_action(action["action_id"]).status, "mismatch")
        finally:
            coordinator.store.close()

    def test_not_executed_recovery_replays_same_id_and_is_restart_idempotent(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        first = self.issue(coordinator)
        pre_fp = observation_fingerprint(Observation.model_validate(self.pre))
        recovery_request = make_request(
            self.pre,
            recovery={
                "phase": "not_executed",
                "pending_action_id": first["action_id"],
                "pre_fingerprint": pre_fp,
                "current_fingerprint": pre_fp,
                "detail_code": "REQUEST_RESPONSE_LOST",
            },
        )
        replacement = coordinator.cycle(CycleRequest.model_validate(recovery_request))
        self.assertEqual(replacement, first)
        self.assertEqual(coordinator.store.get_action(first["action_id"]).status, "issued")
        coordinator.store.close()

        restarted = CycleCoordinator(self.settings)
        try:
            repeated = restarted.cycle(CycleRequest.model_validate(recovery_request))
            self.assertEqual(repeated, replacement)
            self.assertEqual(restarted.store.get_action(first["action_id"]).status, "issued")
            normal_retry = self.issue(restarted)
            self.assertEqual(normal_retry["action_id"], first["action_id"])
        finally:
            restarted.store.close()

    def test_not_executed_retries_never_create_a_replacement_chain(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            first = self.issue(coordinator)
            pre_fp = observation_fingerprint(Observation.model_validate(self.pre))

            def resign(action_id: str) -> dict:
                payload = make_request(
                    self.pre,
                    recovery={
                        "phase": "not_executed",
                        "pending_action_id": action_id,
                        "pre_fingerprint": pre_fp,
                        "current_fingerprint": pre_fp,
                        "detail_code": "REQUEST_RESPONSE_LOST",
                    },
                )
                return coordinator.cycle(CycleRequest.model_validate(payload))

            second = resign(first["action_id"])
            third = resign(second["action_id"])
            self.assertEqual(second, first)
            self.assertEqual(third, first)
            self.assertEqual(self.issue(coordinator), first)
            self.assertEqual(resign(first["action_id"]), first)
            self.assertEqual(
                coordinator.store._connection.execute("SELECT COUNT(*) FROM actions").fetchone()[0],
                1,
            )
            self.assertEqual(coordinator.store.get_action(first["action_id"]).status, "issued")
        finally:
            coordinator.store.close()

    def test_pending_recovery_does_not_replay_action(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            first = self.issue(coordinator)
            pre_fp = observation_fingerprint(Observation.model_validate(self.pre))
            request = make_request(
                self.pre,
                recovery={
                    "phase": "pending",
                    "pending_action_id": first["action_id"],
                    "pre_fingerprint": pre_fp,
                    "current_fingerprint": pre_fp,
                    "detail_code": None,
                },
            )
            response = coordinator.cycle(CycleRequest.model_validate(request))
            self.assertEqual(response["status"], "idle")
            self.assertNotIn("action_id", response)
        finally:
            coordinator.store.close()

    def test_busy_metadata_cannot_replay_cached_execute(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            self.issue(coordinator)
            busy = copy.deepcopy(self.pre)
            busy["busy"] = True
            response = coordinator.cycle(CycleRequest.model_validate(make_request(busy)))
            self.assertEqual(response["status"], "pause")
            self.assertEqual(response["pause_kind"], "UNSUPPORTED_INTERACTION")
            self.assertNotIn("action_id", response)
        finally:
            coordinator.store.close()

    def test_none_recovery_fingerprint_is_checked_when_present(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            request = make_request(
                self.pre,
                recovery={
                    "phase": "none",
                    "pending_action_id": None,
                    "pre_fingerprint": None,
                    "current_fingerprint": "sha256:" + "0" * 64,
                    "detail_code": None,
                },
            )
            with self.assertRaises(ServiceError) as raised:
                coordinator.cycle(CycleRequest.model_validate(request))
            self.assertEqual(raised.exception.code, "ACTION_STATE_CONFLICT")
        finally:
            coordinator.store.close()

    def test_unknown_completed_action_is_protocol_error_not_pause_kind(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            request = make_request(self.pre, completed_action_id="AUTO-0000000000000000")
            with self.assertRaises(ServiceError) as raised:
                coordinator.cycle(CycleRequest.model_validate(request))
            self.assertEqual(raised.exception.code, "UNKNOWN_ACTION_ID")
        finally:
            coordinator.store.close()

    def test_jsonl_log_contains_only_minimal_summary(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            self.issue(coordinator)
        finally:
            coordinator.store.close()
        records = [json.loads(line) for line in self.settings.log_path.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(records)
        allowed = {
            "timestamp",
            "event",
            "observation_fingerprint",
            "floor_id",
            "position",
            "status",
            "action_id",
            "supersedes_action_id",
            "pause_kind",
            "detail_code",
            "reason",
        }
        self.assertTrue(all(set(record) <= allowed for record in records))
        raw = self.settings.log_path.read_text(encoding="utf-8")
        self.assertNotIn('"blocks"', raw)
        self.assertNotIn('"keys"', raw)


class LabelCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = make_settings(self.root, rate_limit_per_second=0)
        self.block = make_block(x=1, y=0)
        coordinator = CycleCoordinator(self.settings)
        try:
            coordinator.cycle(
                CycleRequest.model_validate(make_request(make_observation(blocks=[self.block])))
            )
        finally:
            coordinator.store.close()
        self.pause_path = Path(list_pauses(self.settings)[0]["path"])

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_cli(self, *arguments: str) -> tuple[int, object]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli_main(
                [
                    "--state-dir",
                    str(self.settings.state_dir),
                    "--knowledge-dir",
                    str(self.settings.knowledge_dir),
                    *arguments,
                ]
            )
        return code, json.loads(output.getvalue())

    def run_cli_failure(self, *arguments: str) -> tuple[int, str]:
        output = io.StringIO()
        errors = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = cli_main(
                [
                    "--state-dir",
                    str(self.settings.state_dir),
                    "--knowledge-dir",
                    str(self.settings.knowledge_dir),
                    *arguments,
                ]
            )
        self.assertEqual(output.getvalue(), "")
        return code, errors.getvalue()

    def test_cli_lists_and_applies_floor_and_block_labels(self) -> None:
        code, rows = self.run_cli("labels", "list")
        self.assertEqual(code, 0)
        self.assertEqual(rows[0]["pause_kind"], "UNKNOWN_FLOOR")

        code, floor = self.run_cli(
            "labels", "apply-floor", "--pause", str(self.pause_path)
        )
        self.assertEqual(code, 0)
        self.assertEqual(floor["floor_id"], "F1")

        code, label = self.run_cli(
            "labels",
            "apply-block",
            "--pause",
            str(self.pause_path),
            "--x",
            "1",
            "--y",
            "0",
            "--category",
            "resource",
            "--blocked",
            "--boundary",
            "--no-fast-path",
            "--expected-delta",
            '{"hp":10}',
        )
        self.assertEqual(code, 0)
        self.assertEqual(label["expected_delta"]["hp"], 10)
        saved = registry(self.settings).label_for(
            Observation.model_validate(make_observation(blocks=[self.block])).blocks[0]
        )
        self.assertIsNotNone(saved)

        code, updated = self.run_cli(
            "labels",
            "apply-block",
            "--pause",
            str(self.pause_path),
            "--x",
            "1",
            "--y",
            "0",
            "--category",
            "resource",
            "--passable",
            "--non-boundary",
            "--fast-path",
            "--expected-delta",
            '{"hp":10}',
        )
        self.assertEqual(code, 0)
        self.assertEqual(updated["version"], 2)

    def test_cli_can_generate_evidence_from_request(self) -> None:
        request_path = self.root / "request.json"
        request_path.write_text(
            json.dumps(make_request(make_observation()), ensure_ascii=False), encoding="utf-8"
        )
        code, payload = self.run_cli(
            "labels",
            "evidence",
            "--request",
            str(request_path),
            "--pause-kind",
            "UNKNOWN_FLOOR",
            "--detail-code",
            "FLOOR_MODEL_MISSING",
            "--reason",
            "synthetic evidence",
        )
        self.assertEqual(code, 0)
        self.assertTrue(Path(payload["evidence_path"]).exists())

    def test_cli_triggerless_wall_label_survives_process_style_reload(self) -> None:
        request_path = self.root / "triggerless-request.json"
        wall = make_block(
            x=2,
            y=0,
            block_id="plainWall",
            cls="terrains",
            trigger=None,
            no_pass=True,
        )
        request_path.write_text(
            json.dumps(make_request(make_observation(blocks=[wall])), ensure_ascii=False),
            encoding="utf-8",
        )
        code, evidence = self.run_cli(
            "labels",
            "evidence",
            "--request",
            str(request_path),
            "--pause-kind",
            "NEW_OBJECT_OR_MECHANISM",
            "--detail-code",
            "UNKNOWN_BLOCK",
            "--reason",
            "synthetic triggerless wall",
        )
        self.assertEqual(code, 0)
        code, label = self.run_cli(
            "labels",
            "apply-block",
            "--pause",
            evidence["evidence_path"],
            "--x",
            "2",
            "--y",
            "0",
            "--category",
            "wall",
            "--blocked",
            "--non-boundary",
            "--no-fast-path",
        )
        self.assertEqual(code, 0)
        self.assertIn("trigger", label)
        self.assertIsNone(label["trigger"])
        raw = json.loads(self.settings.labels_path.read_text(encoding="utf-8"))
        persisted = next(item for item in raw["labels"] if item["id"] == "plainWall")
        self.assertIn("trigger", persisted)
        self.assertIsNone(persisted["trigger"])

        code, shown = self.run_cli("labels", "show")
        self.assertEqual(code, 0)
        reloaded = next(item for item in shown["labels"] if item["id"] == "plainWall")
        self.assertEqual(reloaded, label)

    def test_cli_rejects_boundary_without_verifiable_non_position_postcondition(self) -> None:
        code, error = self.run_cli_failure(
            "labels",
            "apply-block",
            "--pause",
            str(self.pause_path),
            "--x",
            "1",
            "--y",
            "0",
            "--category",
            "other",
            "--blocked",
            "--boundary",
            "--no-fast-path",
            "--supported",
            "--expected-delta",
            "{}",
        )
        self.assertEqual(code, 2)
        self.assertIn("postcondition", error)

    def test_serve_rejects_non_loopback_host(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli_main(["serve", "--host", "0.0.0.0"])


if __name__ == "__main__":
    unittest.main()
