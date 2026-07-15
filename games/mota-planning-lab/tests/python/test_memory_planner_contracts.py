from __future__ import annotations

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from mota_lab.__main__ import _parser, main as cli_main
from mota_lab.api import CycleCoordinator
from mota_lab.models import BlockLabel, CycleRequest, Observation
from mota_lab.planner import Planner
from mota_lab.state import historical_map_fact_payload, observation_fingerprint

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


class MemoryPlannerWorldTests(unittest.TestCase):
    """Current equivalents of the non-persistence contracts from test_runtime_v2.py."""

    @staticmethod
    def complete_scan(*map_ids: str, current: str) -> dict:
        return {
            "phase": "complete",
            "anchor_map_instance_id": map_ids[0],
            "current_map_instance_id": current,
            "scanned_map_instance_ids": list(map_ids),
            "pending_exits": [],
            "traversed_transitions": [],
            "reason": "synthetic complete scan",
        }

    @staticmethod
    def label(block: dict, category: str, expected_delta: dict | None = None) -> BlockLabel:
        return BlockLabel(
            id=block["id"],
            cls=block["cls"],
            trigger=block["trigger"],
            category=category,
            passable=False,
            boundary=True,
            fast_path=False,
            expected_delta=expected_delta,
        )

    def test_world_search_follows_verified_transition_to_remote_frontier(self) -> None:
        stair = make_block(
            x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor"
        )
        resource = make_block(
            x=1, y=0, block_id="remotePotion", cls="items", trigger="getItem"
        )
        current = Observation.model_validate(
            make_observation(
                width=2, height=1, blocks=[stair], map_instance_id="A", floor_id="A"
            )
        )
        remote = Observation.model_validate(
            make_observation(
                width=2, height=1, blocks=[resource], map_instance_id="B", floor_id="B"
            )
        )
        stair_label = self.label(stair, "stair")
        resource_label = self.label(resource, "resource", {"attack": 10})
        labels = {
            stair_label.identity: stair_label,
            resource_label.identity: resource_label,
        }
        context = {
            "map_facts": [map_fact(current), map_fact(remote)],
            "transitions": [
                {
                    "from_map_instance_id": "A",
                    "to_map_instance_id": "B",
                    "from_x": 1,
                    "from_y": 0,
                    "to_x": 0,
                    "to_y": 0,
                }
            ],
        }

        result, exhausted = Planner(planning_budget=32)._world_search(
            current, labels, context
        )
        response = Planner(planning_budget=32).plan(
            current,
            labels,
            action_id_factory=lambda: "AUTO-0000000000000001",
            registry_entries=[],
            world_context=context,
            scan_state=self.complete_scan("A", "B", current="A"),
        )

        self.assertFalse(exhausted)
        self.assertIsNotNone(result)
        self.assertEqual(result.first.boundary.block.id, "upFloor")
        self.assertEqual(result.target.boundary.block.id, "remotePotion")
        self.assertEqual(result.target_map_instance_id, "B")
        self.assertEqual(response.status, "execute")
        self.assertEqual(response.action_kind, "MOVE_TO_STAIR")
        self.assertEqual(response.expected_delta.map_instance_id, "B")
        self.assertIn("remotePotion", response.reason)

    def test_verified_transition_cycle_without_progress_is_idle(self) -> None:
        portal_a = make_block(
            x=1, y=0, block_id="portalA", cls="terrains", trigger="changeFloor"
        )
        portal_b = make_block(
            x=1, y=0, block_id="portalB", cls="terrains", trigger="changeFloor"
        )
        first = Observation.model_validate(
            make_observation(
                width=2, height=1, map_instance_id="A", floor_id="A", blocks=[portal_a]
            )
        )
        second = Observation.model_validate(
            make_observation(
                width=2, height=1, map_instance_id="B", floor_id="B", blocks=[portal_b]
            )
        )
        labels = {}
        for block in (portal_a, portal_b):
            label = self.label(block, "stair")
            labels[label.identity] = label
        context = {
            "map_facts": [map_fact(first), map_fact(second)],
            "transitions": [
                {
                    "from_map_instance_id": "A",
                    "to_map_instance_id": "B",
                    "from_x": 1,
                    "from_y": 0,
                    "to_x": 0,
                    "to_y": 0,
                },
                {
                    "from_map_instance_id": "B",
                    "to_map_instance_id": "A",
                    "from_x": 1,
                    "from_y": 0,
                    "to_x": 0,
                    "to_y": 0,
                },
            ],
        }

        result, exhausted = Planner(planning_budget=32)._world_search(
            first, labels, context
        )
        response = Planner(planning_budget=32).plan(
            first,
            labels,
            action_id_factory=lambda: "AUTO-0000000000000002",
            registry_entries=[],
            world_context=context,
            scan_state=self.complete_scan("A", "B", current="A"),
        )

        self.assertFalse(exhausted)
        self.assertIsNone(result)
        self.assertEqual(response.status, "idle")
        self.assertNotIn("action_id", response.model_dump(mode="json", exclude_unset=True))

    def test_world_planning_budget_exhausts_without_action(self) -> None:
        blocks = [
            make_block(x=1, y=0, block_id="a"),
            make_block(x=0, y=1, block_id="b"),
        ]
        observation = Observation.model_validate(
            make_observation(width=2, height=2, blocks=blocks)
        )
        labels = {}
        for block in blocks:
            label = self.label(block, "resource", {"hp": 1})
            labels[label.identity] = label

        response = Planner(planning_budget=1).plan(
            observation,
            labels,
            action_id_factory=lambda: "AUTO-0000000000000003",
            registry_entries=[],
            world_context={"transitions": [], "frontiers": []},
        )

        self.assertEqual(response.status, "pause")
        self.assertEqual(response.pause_kind.value, "PLANNING_BUDGET_EXHAUSTED")
        self.assertNotIn("action_id", response.model_dump(mode="json", exclude_unset=True))

    def test_unfightable_enemy_is_not_crossed_in_world_search(self) -> None:
        stair = make_block(
            x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor"
        )
        enemy = make_enemy_block(x=1, y=0, damage=5, block_id="blockedEnemy")
        enemy["enemy"]["defense"] = 10
        behind = make_block(x=2, y=0, block_id="behindEnemy")
        current = Observation.model_validate(
            make_observation(
                width=2,
                height=1,
                blocks=[stair],
                map_instance_id="A",
                floor_id="A",
                attack=10,
            )
        )
        remote = Observation.model_validate(
            make_observation(
                width=3,
                height=1,
                blocks=[enemy, behind],
                map_instance_id="B",
                floor_id="B",
                attack=10,
            )
        )
        labels = {}
        for block, category, delta in (
            (stair, "stair", None),
            (enemy, "enemy", None),
            (behind, "resource", {"attack": 10}),
        ):
            label = self.label(block, category, delta)
            labels[label.identity] = label

        result, exhausted = Planner(planning_budget=32)._world_search(
            current,
            labels,
            {
                "map_facts": [map_fact(current), map_fact(remote)],
                "transitions": [
                    {
                        "from_map_instance_id": "A",
                        "to_map_instance_id": "B",
                        "from_x": 1,
                        "from_y": 0,
                        "to_x": 0,
                        "to_y": 0,
                    }
                ],
            },
        )

        self.assertFalse(exhausted)
        self.assertIsNone(result)

    def test_takeover_scan_uses_exit_without_consuming_other_boundaries(self) -> None:
        stair = make_block(
            x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor"
        )
        resource = make_block(
            x=0, y=1, block_id="hugeAttack", cls="items", trigger="getItem"
        )
        door = make_block(
            x=2, y=1, block_id="yellowDoor", cls="terrains", trigger="openDoor"
        )
        observation = Observation.model_validate(
            make_observation(
                width=3,
                height=2,
                blocks=[stair, resource, door],
                map_instance_id="A",
            )
        )
        labels = {}
        for block, category, delta in (
            (stair, "stair", None),
            (resource, "resource", {"attack": 999}),
            (door, "door", {"keys": {"yellow": -1}}),
        ):
            label = self.label(block, category, delta)
            labels[label.identity] = label
        scan_state = {
            "phase": "discover",
            "anchor_map_instance_id": "A",
            "current_map_instance_id": "A",
            "scanned_map_instance_ids": ["A"],
            "pending_exits": [],
            "traversed_transitions": [],
            "reason": "initial takeover scan",
        }

        response = Planner().plan(
            observation,
            labels,
            action_id_factory=lambda: "AUTO-0000000000000004",
            registry_entries=[],
            world_context={"map_facts": [map_fact(observation)], "transitions": []},
            scan_state=scan_state,
        )

        self.assertEqual(response.status, "execute")
        self.assertEqual(response.action_kind, "SCAN_OPAQUE_EXIT")
        self.assertEqual((response.operations[-1].x, response.operations[-1].y), (1, 0))
        self.assertEqual(response.expected_delta.map_instance_id, None)


class MemoryCoordinatorRecoveryTests(unittest.TestCase):
    """Same-process ledger, reconnect, ACK and delta contracts after persistence removal."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.settings = make_settings(
            Path(self.temporary.name), rate_limit_per_second=0
        )
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
        return coordinator.cycle(
            CycleRequest.model_validate(make_request(self.pre))
        )

    def completion_request(self, action_id: str, *, hp: int) -> CycleRequest:
        post = make_observation(
            blocks=[], x=3, y=0, hp=hp, captured_at=1234567999
        )
        return CycleRequest.model_validate(
            make_request(
                post,
                completed_action_id=action_id,
                recovery={
                    "phase": "completed",
                    "pending_action_id": action_id,
                    "pre_fingerprint": observation_fingerprint(
                        Observation.model_validate(self.pre)
                    ),
                    "current_fingerprint": observation_fingerprint(
                        Observation.model_validate(post)
                    ),
                    "detail_code": None,
                },
            )
        )

    def test_completed_action_is_acknowledged_and_idempotent_in_memory(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            action = self.issue(coordinator)
            completion = self.completion_request(action["action_id"], hp=408)
            response = coordinator.cycle(completion)

            self.assertEqual(response["status"], "idle")
            self.assertEqual(response["acknowledged_action_id"], action["action_id"])
            self.assertEqual(
                coordinator.store.get_action(action["action_id"]).status, "completed"
            )
            self.assertEqual(coordinator.cycle(completion), response)
        finally:
            coordinator.store.close()

    def test_expected_delta_mismatch_never_issues_followup(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            action = self.issue(coordinator)
            response = coordinator.cycle(
                self.completion_request(action["action_id"], hp=407)
            )

            self.assertEqual(response["status"], "pause")
            self.assertEqual(response["pause_kind"], "EXPECTED_DELTA_MISMATCH")
            self.assertNotIn("action_id", response)
            self.assertEqual(
                coordinator.store.get_action(action["action_id"]).status, "mismatch"
            )
        finally:
            coordinator.store.close()

    def test_reconnect_only_never_creates_decision_or_new_action(self) -> None:
        coordinator = CycleCoordinator(self.settings)
        try:
            reconnect = CycleRequest.model_validate(
                make_request(self.pre, intent="reconnect_only")
            )
            first = coordinator.cycle(reconnect)
            second = coordinator.cycle(reconnect)
            self.assertEqual(first["status"], "idle")
            self.assertEqual(second, first)
            self.assertEqual(
                coordinator.store._connection.execute(
                    "SELECT COUNT(*) FROM actions"
                ).fetchone()[0],
                0,
            )
            self.assertEqual(
                coordinator.store._connection.execute(
                    "SELECT COUNT(*) FROM decisions"
                ).fetchone()[0],
                0,
            )

            action = self.issue(coordinator)
            fingerprint = observation_fingerprint(
                Observation.model_validate(self.pre)
            )
            unresolved = CycleRequest.model_validate(
                make_request(
                    self.pre,
                    intent="reconnect_only",
                    recovery={
                        "phase": "not_executed",
                        "pending_action_id": action["action_id"],
                        "pre_fingerprint": fingerprint,
                        "current_fingerprint": fingerprint,
                        "detail_code": None,
                    },
                )
            )
            paused = coordinator.cycle(unresolved)
            repeated = coordinator.cycle(unresolved)
            self.assertEqual(paused["status"], "pause")
            self.assertEqual(paused["detail_code"], "RECONNECT_UNRESOLVED_ACTION")
            self.assertEqual(
                paused["details"]["ledger_action_id"], action["action_id"]
            )
            self.assertEqual(repeated, paused)
            self.assertEqual(
                coordinator.store._connection.execute(
                    "SELECT COUNT(*) FROM actions"
                ).fetchone()[0],
                1,
            )
        finally:
            coordinator.store.close()


class LoopbackCliContractTests(unittest.TestCase):
    """Current serve boundary; no filesystem runtime recovery is exercised here."""

    def test_serve_rejects_non_loopback_host(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli_main(["serve", "--host", "0.0.0.0"])

    def test_serve_default_port_contract_remains_18724(self) -> None:
        self.assertEqual(_parser().parse_args(["serve"]).port, 18724)

    def test_serve_rejects_out_of_range_port(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli_main(["serve", "--port", "0"])


if __name__ == "__main__":
    unittest.main()
