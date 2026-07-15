from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from mota_lab.api import CycleCoordinator, create_app
from mota_lab.engine_model import (
    UnsupportedItemEffect, derive_engine_authority, interpret_item_effect,
)
from mota_lab.models import Observation
from mota_test_support import make_block, make_observation, make_request, make_settings


def engine_model(blocks: list[dict], *, inventory: dict | None = None) -> dict:
    floor_blocks = [{
        "x": item["x"], "y": item["y"], "numeric_id": item["numeric_id"],
        "id": item["id"], "cls": item["cls"], "trigger": item["trigger"],
        "no_pass": item["no_pass"], "disabled": False,
    } for item in blocks]
    definitions = []
    for item in blocks:
        door = {"keys": {"yellowKey": 1}} if item["trigger"] == "openDoor" else None
        definitions.append({
            "numeric_id": item["numeric_id"], "id": item["id"], "cls": item["cls"],
            "trigger": item["trigger"], "no_pass": item["no_pass"], "door_info": door,
        })
    return {
        "protocol": 1, "catalog_hash": "sha256:" + "a" * 64,
        "model_hash": "sha256:" + "b" * 64,
        "floors": [{
            "floor_id": "MT2", "title": "第 2 层", "width": 13, "height": 13,
            "topology": {"kind": "rectangle"},
            "map": [[0] * 13 for _ in range(13)], "blocks": floor_blocks,
            "change_floor": [], "ratio": 2,
        }],
        "blocks": definitions,
        "items": [
            {"id": "yellowKey", "cls": "tools", "name": "黄钥匙", "text": None,
             "item_effect": None, "item_effect_tip": None, "use_item_event": None,
             "complex": False},
            {"id": "redGem", "cls": "items", "name": "红宝石", "text": None,
             "item_effect": "core.status.hero.atk+=core.values.redGem*floor.ratio",
             "item_effect_tip": None, "use_item_event": None, "complex": False},
        ],
        "enemies": [], "values": {"redGem": 3},
        "inventory": {
            "classes": inventory or {"tools": {"yellowKey": 1, "blueKey": 1}},
            "key_slots": {"yellow": "yellowKey", "blue": "blueKey", "red": "redKey"},
        },
    }


def mt2_observation(blocks: list[dict]) -> dict:
    observation = make_observation(
        floor_id="MT2", floor_name="第 2 层", floor_number=2, width=13, height=13,
        x=1, y=2, hp=860, attack=10, defense=10, gold=4, experience=4,
        yellow=1, blue=1, red=0, blocks=blocks, session_id="mt2-functional",
    )
    observation["engine_model"] = engine_model(blocks)
    return observation


class ItemEffectTests(unittest.TestCase):
    def test_restricted_arithmetic_inventory_and_rejection(self) -> None:
        observation = Observation.model_validate(mt2_observation([]))
        delta = interpret_item_effect(
            "core.status.hero.hp+=100*floor.ratio;core.status.hero.atk*=2;"
            "core.addItem('yellowKey',2)", observation, 2,
        ).model_dump(mode="json", exclude_unset=True)
        self.assertEqual(delta, {"hp": 200, "attack": 10, "keys": {"yellow": 2}})
        inventory_delta = interpret_item_effect(
            "core.addItem('book',1)", observation, 1,
        ).model_dump(mode="json", exclude_unset=True)
        self.assertEqual(inventory_delta, {"inventory": {"book": 1}})
        with self.assertRaises(UnsupportedItemEffect):
            interpret_item_effect("core.insertAction([{type:'choices'}])", observation, 1)


class FunctionalCycleTests(unittest.TestCase):
    def test_engine_authority_cache_reuses_model_hash_and_invalidates_on_change(self) -> None:
        observation = Observation.model_validate(mt2_observation([]))
        changed_payload = mt2_observation([])
        changed_payload["engine_model"]["model_hash"] = "sha256:" + "c" * 64
        changed = Observation.model_validate(changed_payload)
        with tempfile.TemporaryDirectory() as directory:
            coordinator = CycleCoordinator(make_settings(Path(directory)))
            with patch(
                "mota_lab.api.derive_engine_authority", wraps=derive_engine_authority
            ) as derive:
                first = coordinator._derive_engine_authority(observation)
                second = coordinator._derive_engine_authority(observation)
                third = coordinator._derive_engine_authority(changed)
        self.assertIs(first, second)
        self.assertIsNot(first, third)
        self.assertEqual(derive.call_count, 2)

    def test_empty_knowledge_mt2_uses_engine_model_and_returns_safe_decision(self) -> None:
        yellow_key = make_block(
            x=2, y=2, block_id="yellowKey", cls="items", trigger="getItem",
            numeric_id=31, no_pass=True,
        )
        red_gem = make_block(
            x=4, y=2, block_id="redGem", cls="items", trigger="getItem",
            numeric_id=32, no_pass=True,
        )
        yellow_door = make_block(
            x=3, y=2, block_id="yellowDoor", cls="terrains", trigger="openDoor",
            numeric_id=21, no_pass=True,
        )
        observation = mt2_observation([yellow_key, red_gem, yellow_door])
        with tempfile.TemporaryDirectory() as directory:
            settings = make_settings(Path(directory), max_body_bytes=2 * 1024 * 1024,
                                     rate_limit_per_second=0)
            with TestClient(create_app(settings)) as client:
                response = client.post(
                    "/cycle", json=make_request(observation), headers={"X-Mota-Lab": "1"},
                )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertNotEqual(body.get("detail_code"), "FLOOR_MODEL_MISSING")
        self.assertNotEqual(body.get("detail_code"), "UNKNOWN_BLOCK")
        self.assertIn(body["status"], {"execute", "idle"})
        if body["status"] == "execute":
            self.assertIn(body["action_kind"], {"MOVE_TO_RESOURCE", "OPEN_DOOR"})
            self.assertRegex(body["action_id"], r"^AUTO-[A-F0-9]{16}$")


if __name__ == "__main__":
    unittest.main()
