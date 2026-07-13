from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from mota_lab.api import CycleCoordinator
from mota_lab.combat import UnknownDamage, combat_outcome
from mota_lab.deltas import validate_expected_delta
from mota_lab.guards import compare_guard, guard_from_observation
from mota_lab.models import BlockLabel, CycleRequest, ExpectedDelta, Observation
from mota_lab.search import SearchCandidate, dominates, limited_depth_search
from mota_lab.state import CurrentFloorGraph, canonical_json, fingerprint_payload, observation_fingerprint
from mota_lab.valuation import ResourceState, apply_delta, value_delta

from mota_test_support import (
    label_block,
    make_block,
    make_enemy_block,
    make_observation,
    make_request,
    make_settings,
    mark_floor,
)


class GraphAndModelTests(unittest.TestCase):
    def test_graph_respects_known_wall_and_finds_reachable_boundary(self) -> None:
        walls = [make_block(x=1, y=y, block_id="wall", cls="terrains", trigger=None) for y in range(11)]
        resource = make_block(x=0, y=3)
        observation = Observation.model_validate(make_observation(blocks=walls + [resource]))
        wall_label = BlockLabel(
            id="wall",
            cls="terrains",
            trigger=None,
            category="wall",
            passable=False,
            boundary=False,
            fast_path=False,
            supported=True,
            source="human",
            version=1,
        )
        resource_label = BlockLabel(
            id=resource["id"],
            cls=resource["cls"],
            trigger=resource["trigger"],
            category="resource",
            passable=False,
            boundary=True,
            fast_path=False,
            supported=True,
            expected_delta=ExpectedDelta(hp=10),
            source="human",
            version=1,
        )
        labels = {wall_label.identity: wall_label, resource_label.identity: resource_label}
        graph = CurrentFloorGraph(observation, labels)
        self.assertNotIn((2, 0), graph.reachable().coordinates)
        boundaries = graph.reachable_boundaries()
        self.assertEqual([(item.block.x, item.block.y) for item in boundaries], [(0, 3)])

    def test_observation_fingerprint_ignores_capture_time_and_block_order(self) -> None:
        first = make_block(x=2, y=1, block_id="a")
        second = make_block(x=1, y=1, block_id="b")
        left = Observation.model_validate(make_observation(blocks=[first, second], captured_at=1))
        right = Observation.model_validate(make_observation(blocks=[second, first], captured_at=999))
        self.assertEqual(observation_fingerprint(left), observation_fingerprint(right))

    def test_fingerprint_projection_fixed_vector_matches_browser_contract(self) -> None:
        raw = make_observation(blocks=[])
        observation = Observation.model_validate(raw)
        self.assertEqual(
            set(fingerprint_payload(observation)),
            {"session_id", "map_instance_id", "floor_id", "dimensions", "topology", "topology_fingerprint", "hero", "keys", "blocks"},
        )
        self.assertTrue(observation_fingerprint(observation).startswith("sha256:"))

        changed_metadata = make_observation(
            floor_name="synthetic display name",
            floor_number=999,
            busy=True,
            captured_at=999999,
        )
        self.assertEqual(
            observation_fingerprint(observation),
            observation_fingerprint(Observation.model_validate(changed_metadata)),
        )

    def test_combat_uses_observed_damage_and_enemy_rewards(self) -> None:
        block = Observation.model_validate(
            make_observation(blocks=[make_enemy_block(x=1, y=0, damage=24)])
        ).blocks[0]
        outcome = combat_outcome(block)
        self.assertEqual((outcome.hp_delta, outcome.gold_delta, outcome.experience_delta), (-24, 5, 4))

    def test_unknown_and_negative_damage_rejected(self) -> None:
        for damage in (None, "???", -1):
            block = Observation.model_validate(
                make_observation(blocks=[make_enemy_block(x=1, y=0, damage=damage)])
            ).blocks[0]
            with self.subTest(damage=damage), self.assertRaises(UnknownDamage):
                combat_outcome(block)

    def test_resource_transition_and_valuation(self) -> None:
        state = ResourceState(100, 10, 10, 0, 0, 1, 0, 0)
        changed = apply_delta(state, {"hp": 200, "keys": {"yellow": -1}})
        self.assertIsNotNone(changed)
        self.assertEqual((changed.hp, changed.yellow), (300, 0))
        self.assertGreater(value_delta({"attack": 1}), value_delta({"gold": 10}))
        self.assertIsNone(apply_delta(state, {"hp": -100}))

    def test_guard_is_exact_for_panel_keys_floor_and_location(self) -> None:
        observation = Observation.model_validate(make_observation())
        guard = guard_from_observation(observation)
        self.assertEqual(compare_guard(guard, observation), [])
        changed = Observation.model_validate(make_observation(gold=17, yellow=3, x=1))
        fields = {difference["field"] for difference in compare_guard(guard, changed)}
        self.assertEqual(fields, {"gold", "keys.yellow", "position.x"})

    def test_dominance_and_finite_search_pruning(self) -> None:
        weak = ResourceState(100, 10, 10, 0, 0, 0, 0, 0)
        strong = ResourceState(101, 10, 10, 0, 0, 0, 0, 0)
        self.assertTrue(dominates(strong, weak))
        candidates = [
            SearchCandidate("a", {"hp": 10}, 1),
            SearchCandidate("b", {"gold": 2}, 1),
            SearchCandidate("c", {"experience": 2}, 1),
        ]
        result = limited_depth_search(weak, candidates, max_depth=3)
        self.assertIsNotNone(result)
        self.assertGreater(result.explored_nodes, 3)
        self.assertGreater(result.pruned_nodes, 0)


class PlannerCycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temporary.name), rate_limit_per_second=0)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def cycle(self, observation: dict, **request_overrides: object) -> dict:
        coordinator = CycleCoordinator(self.settings)
        try:
            request = CycleRequest.model_validate(
                make_request(observation, **request_overrides)
            )
            return coordinator.cycle(request)
        finally:
            coordinator.store.close()

    def test_unknown_floor_then_unknown_block_pause(self) -> None:
        block = make_block(x=2, y=0)
        observation = make_observation(blocks=[block])
        first = self.cycle(observation)
        self.assertEqual(first["pause_kind"], "UNKNOWN_FLOOR")
        mark_floor(self.settings)
        second = self.cycle(observation)
        self.assertEqual(second["pause_kind"], "NEW_OBJECT_OR_MECHANISM")
        self.assertEqual(second["details"]["blocks"][0]["id"], block["id"])

    def test_known_resource_emits_guard_delta_reason_registry_and_safe_corridor(self) -> None:
        resource = make_block(x=3, y=0, block_id="redPotion")
        observation = make_observation(blocks=[resource])
        mark_floor(self.settings)
        label_block(
            self.settings,
            resource,
            category="resource",
            expected_delta={"hp": 200},
        )
        response = self.cycle(observation)
        self.assertEqual(response["status"], "execute")
        self.assertEqual(response["action_kind"], "MOVE_TO_RESOURCE")
        self.assertEqual(response["guard"]["hp"], 208)
        self.assertEqual(response["expected_delta"]["hp"], 200)
        self.assertEqual(response["expected_delta"]["removed_blocks"][0]["id"], "redPotion")
        self.assertIn("世界图 frontier 搜索", response["reason"])
        self.assertEqual(response["registry_entries"][0]["category"], "resource")
        self.assertFalse(response["registry_entries"][0]["fast_path"])
        self.assertEqual(response["operations"], [
            {"type": "grid", "x": 2, "y": 0},
            {"type": "grid", "x": 3, "y": 0},
        ])

    def test_adjacent_boundary_is_one_operation(self) -> None:
        resource = make_block(x=1, y=0)
        observation = make_observation(blocks=[resource])
        mark_floor(self.settings)
        label_block(self.settings, resource, category="resource", expected_delta={"hp": 1})
        response = self.cycle(observation)
        self.assertEqual(len(response["operations"]), 1)
        self.assertEqual(response["operations"][0]["x"], 1)

    def test_known_door_includes_key_delta(self) -> None:
        door = make_block(x=1, y=0, block_id="yellowDoor", cls="terrains", trigger="openDoor")
        mark_floor(self.settings)
        label_block(
            self.settings,
            door,
            category="door",
            expected_delta={"keys": {"yellow": -1}},
        )
        response = self.cycle(make_observation(blocks=[door]))
        self.assertEqual(response["action_kind"], "OPEN_DOOR")
        self.assertEqual(response["expected_delta"]["keys"]["yellow"], -1)

    def test_zero_damage_enemy_is_automatic_but_unknown_damage_pauses(self) -> None:
        enemy = make_enemy_block(x=1, y=0, damage=0)
        mark_floor(self.settings)
        label_block(self.settings, enemy, category="enemy")
        automatic = self.cycle(make_observation(blocks=[enemy]))
        self.assertEqual(automatic["status"], "execute")
        self.assertEqual(automatic["expected_delta"]["hp"], 0)
        self.assertEqual(automatic["expected_delta"]["gold"], 5)

        other_settings = make_settings(Path(self.temporary.name) / "unknown", rate_limit_per_second=0)
        self.settings = other_settings
        unknown = make_enemy_block(x=1, y=0, damage=None)
        mark_floor(self.settings)
        label_block(self.settings, unknown, category="enemy")
        paused = self.cycle(make_observation(blocks=[unknown]))
        self.assertEqual(paused["pause_kind"], "UNKNOWN_DAMAGE")

    def test_unsupported_registered_interaction_pauses(self) -> None:
        npc = make_block(x=1, y=0, block_id="npcA", cls="npcs", trigger="action")
        mark_floor(self.settings)
        label_block(
            self.settings,
            npc,
            category="npc",
            supported=False,
            expected_delta={},
        )
        response = self.cycle(make_observation(blocks=[npc]))
        self.assertEqual(response["pause_kind"], "UNSUPPORTED_INTERACTION")

    def test_legacy_other_boundary_without_postcondition_pauses_instead_of_executes(self) -> None:
        boundary = make_block(
            x=1,
            y=0,
            block_id="legacyBoundary",
            cls="terrains",
            trigger=None,
        )
        mark_floor(self.settings)
        self.settings.labels_path.write_text(
            json.dumps(
                {
                    "protocol": 1,
                    "labels": [
                        {
                            "id": boundary["id"],
                            "cls": boundary["cls"],
                            "trigger": boundary["trigger"],
                            "category": "other",
                            "passable": False,
                            "boundary": True,
                            "fast_path": False,
                            "supported": True,
                            "expected_delta": {},
                            "source": "human",
                            "version": 1,
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        response = self.cycle(make_observation(blocks=[boundary]))
        self.assertEqual(response["status"], "pause")
        self.assertEqual(response["pause_kind"], "NEW_OBJECT_OR_MECHANISM")
        self.assertEqual(response["detail_code"], "INCOMPLETE_LABEL")
        self.assertNotIn("action_id", response)

    def test_stair_null_floor_requires_a_real_floor_change(self) -> None:
        stair = make_block(x=1, y=0, block_id="upFloor", cls="terrains", trigger="changeFloor")
        mark_floor(self.settings)
        label_block(self.settings, stair, category="stair")
        pre = make_observation(blocks=[stair])
        action = self.cycle(pre)
        self.assertEqual(action["action_kind"], "SCAN_OPAQUE_EXIT")
        self.assertEqual(action["expected_delta"]["map_instance_id"], None)

        pre_model = Observation.model_validate(pre)
        unchanged = Observation.model_validate(make_observation(blocks=[stair], x=1, y=0))
        changed = Observation.model_validate(
            make_observation(floor_id="F2", floor_name="2F", floor_number=2, x=5, y=5, blocks=[])
        )
        expected = ExpectedDelta.model_validate(action["expected_delta"])
        self.assertFalse(
            validate_expected_delta(pre_model, unchanged, expected, action_kind="SCAN_OPAQUE_EXIT").matches
        )
        self.assertTrue(
            validate_expected_delta(pre_model, changed, expected, action_kind="SCAN_OPAQUE_EXIT").matches
        )

    def test_minimal_block_ref_matches_and_unlisted_resource_delta_fails(self) -> None:
        block = make_block(x=1, y=0)
        pre = Observation.model_validate(make_observation(blocks=[block]))
        post = Observation.model_validate(make_observation(blocks=[], x=1, y=0, hp=218))
        expected = ExpectedDelta.model_validate(
            {"hp": 10, "removed_blocks": [{"x": 1, "y": 0, "id": block["id"]}]}
        )
        self.assertTrue(
            validate_expected_delta(pre, post, expected, action_kind="MOVE_TO_RESOURCE").matches
        )
        wrong = Observation.model_validate(make_observation(blocks=[], x=1, y=0, hp=219))
        self.assertFalse(
            validate_expected_delta(pre, wrong, expected, action_kind="MOVE_TO_RESOURCE").matches
        )


if __name__ == "__main__":
    unittest.main()
