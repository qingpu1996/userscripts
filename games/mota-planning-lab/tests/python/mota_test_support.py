from __future__ import annotations

import copy
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from mota_lab.api import Settings
from mota_lab.knowledge import KnowledgeRegistry
from mota_lab.models import BlockLabel, ExpectedDelta, FloorModel


def make_block(
    *,
    x: int,
    y: int,
    block_id: str = "resourceA",
    cls: str = "items",
    trigger: Optional[str] = "getItem",
    numeric_id: int = 101,
    no_pass: bool = True,
    damage: Any = None,
    enemy: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "x": x,
        "y": y,
        "numeric_id": numeric_id,
        "id": block_id,
        "cls": cls,
        "trigger": trigger,
        "no_pass": no_pass,
        "damage": damage,
        "enemy": enemy,
    }


def make_enemy_block(
    *,
    x: int,
    y: int,
    damage: Any = 0,
    block_id: str = "enemyA",
) -> Dict[str, Any]:
    return make_block(
        x=x,
        y=y,
        block_id=block_id,
        cls="enemy48",
        trigger="battle",
        numeric_id=201,
        no_pass=True,
        damage=damage,
        enemy={
            "hp": 50,
            "attack": None,
            "defense": None,
            "gold": 5,
            "experience": 4,
            "special": [],
        },
    )


def make_observation(
    *,
    floor_id: str = "F1",
    floor_name: Optional[str] = "1F",
    floor_number: Optional[int] = 1,
    x: int = 0,
    y: int = 0,
    direction: str = "down",
    hp: int = 208,
    attack: int = 23,
    defense: int = 21,
    gold: int = 16,
    experience: int = 63,
    yellow: int = 4,
    blue: int = 1,
    red: int = 0,
    busy: bool = False,
    blocks: Optional[List[Dict[str, Any]]] = None,
    captured_at: int = 1234567890,
    width: int = 11,
    height: int = 11,
    session_id: str = "test-session",
    map_instance_id: Optional[str] = None,
    valid_cells: Optional[List[Dict[str, int]]] = None,
) -> Dict[str, Any]:
    return {
        "protocol": 2,
        "page": "/games/24/",
        "session_id": session_id,
        "floor_id": floor_id,
        "floor_name": floor_name,
        "floor_number": floor_number,
        "dimensions": {"width": width, "height": height},
        "topology": {
            "kind": "rectangle" if valid_cells is None else "valid_cells",
            **({} if valid_cells is None else {"valid_cells": copy.deepcopy(valid_cells)}),
            "source": "engine_current_map",
            "confidence": "confirmed",
        },
        "topology_fingerprint": "sha256:" + "1" * 64,
        "map_instance_id": map_instance_id or f"{floor_id}@" + "1" * 16,
        "hero": {
            "hp": hp,
            "attack": attack,
            "defense": defense,
            "gold": gold,
            "experience": experience,
            "loc": {"x": x, "y": y, "direction": direction},
        },
        "keys": {"yellow": yellow, "blue": blue, "red": red},
        "busy": busy,
        "blocks": copy.deepcopy(blocks or []),
        "captured_at": captured_at,
    }


def make_request(observation: Dict[str, Any], **overrides: Any) -> Dict[str, Any]:
    payload = {
        "source": "mota-planning-lab-userscript",
        "intent": "cycle",
        "completed_action_id": None,
        "observation": observation,
        "recovery": {
            "phase": "none",
            "pending_action_id": None,
            "pre_fingerprint": None,
            "current_fingerprint": None,
            "detail_code": None,
        },
        "session": {"mode": "new_game", "command": "confirm"},
    }
    payload.update(overrides)
    return payload


def make_settings(
    directory: Path,
    *,
    max_body_bytes: int = 256 * 1024,
    rate_limit_per_second: int = 50,
) -> Settings:
    settings = Settings.for_directory(
        directory,
        max_body_bytes=max_body_bytes,
        rate_limit_per_second=rate_limit_per_second,
    )
    # Tests explicitly use an isolated mutable fixture directory as the
    # coordinator's bundled-data source. Production never does this.
    fixture_settings = replace(settings, bundled_data_dir=settings.knowledge_dir)
    KnowledgeRegistry(
        fixture_settings.labels_path,
        fixture_settings.floors_path,
        bundled_labels_path=settings.bundled_data_dir / "block-labels.json",
        bundled_floors_path=settings.bundled_data_dir / "floor-models.json",
    )
    return fixture_settings


def registry(settings: Settings) -> KnowledgeRegistry:
    return KnowledgeRegistry(
        settings.labels_path,
        settings.floors_path,
        bundled_labels_path=settings.bundled_data_dir / "block-labels.json",
        bundled_floors_path=settings.bundled_data_dir / "floor-models.json",
    )


def mark_floor(settings: Settings, floor_id: str = "F1", name: str = "1F") -> None:
    registry(settings).apply_floor_model(
        FloorModel(floor_id=floor_id, known=True, name=name, source="human", version=1)
    )


def label_block(
    settings: Settings,
    block: Dict[str, Any],
    *,
    category: str,
    passable: bool = False,
    boundary: bool = True,
    fast_path: bool = False,
    supported: bool = True,
    expected_delta: Optional[Dict[str, Any]] = None,
) -> None:
    registry(settings).apply_block_label(
        BlockLabel(
            id=block["id"],
            cls=block["cls"],
            trigger=block.get("trigger"),
            category=category,
            passable=passable,
            boundary=boundary,
            fast_path=fast_path,
            supported=supported,
            expected_delta=None
            if expected_delta is None
            else ExpectedDelta.model_validate(expected_delta),
            source="human",
            version=1,
        )
    )
