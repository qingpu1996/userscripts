"""Post-action expected-delta validation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping

from .models import ExpectedDelta, Observation


@dataclass(frozen=True)
class DeltaValidation:
    matches: bool
    differences: List[Dict[str, Any]]
    actual: Dict[str, Any]


def _block_identity(block: object) -> tuple:
    return (
        getattr(block, "id"),
        getattr(block, "cls"),
        getattr(block, "trigger"),
    )


def _matches_block_ref(block: object, reference: Mapping[str, Any]) -> bool:
    if getattr(block, "id") != reference["id"]:
        return False
    for field in ("cls", "trigger", "numeric_id"):
        if field in reference and reference[field] is not None:
            if getattr(block, field) != reference[field]:
                return False
    return True


def validate_expected_delta(
    pre: Observation,
    post: Observation,
    expected: ExpectedDelta,
    *,
    action_kind: str,
) -> DeltaValidation:
    declared = expected.model_dump(mode="json", exclude_unset=True)
    differences: List[Dict[str, Any]] = []
    actual: Dict[str, Any] = {}

    for field in ("hp", "attack", "defense", "gold", "experience"):
        before = getattr(pre.hero, field)
        after = getattr(post.hero, field)
        delta = after - before
        actual[field] = delta
        expected_value = declared.get(field, 0)
        if expected_value is not None and delta != expected_value:
            differences.append({"field": field, "expected": expected_value, "actual": delta})

    expected_keys = declared.get("keys") or {}
    actual_keys: Dict[str, int] = {}
    for color in ("yellow", "blue", "red"):
        delta = getattr(post.keys, color) - getattr(pre.keys, color)
        actual_keys[color] = delta
        expected_value = expected_keys.get(color, 0)
        if expected_value is not None and delta != expected_value:
            differences.append(
                {"field": f"keys.{color}", "expected": expected_value, "actual": delta}
            )
    actual["keys"] = actual_keys

    actual_position = {"x": post.hero.loc.x, "y": post.hero.loc.y}
    actual["position"] = actual_position
    if "position" in declared and declared["position"] is not None:
        expected_position = declared["position"]
        if actual_position != expected_position:
            differences.append(
                {"field": "position", "expected": expected_position, "actual": actual_position}
            )

    actual["floor_id"] = post.floor_id
    actual["map_instance_id"] = post.map_instance_id
    map_changed = post.map_instance_id != pre.map_instance_id
    if "map_instance_id" not in declared:
        if "floor_id" not in declared and map_changed:
            differences.append(
                {"field": "map_instance_id", "expected": pre.map_instance_id, "actual": post.map_instance_id}
            )
    elif declared["map_instance_id"] is None:
        if action_kind not in {"MOVE_TO_STAIR", "SCAN_OPAQUE_EXIT", "SCAN_VERIFIED_TRANSITION"} or not map_changed:
            differences.append(
                {
                    "field": "map_instance_id",
                    "expected": "a different map instance for a transition action",
                    "actual": post.map_instance_id,
                }
            )
    elif post.map_instance_id != declared["map_instance_id"]:
        differences.append(
            {
                "field": "map_instance_id",
                "expected": declared["map_instance_id"],
                "actual": post.map_instance_id,
            }
        )

    if "floor_id" not in declared:
        if not map_changed and post.floor_id != pre.floor_id:
            differences.append(
                {"field": "floor_id", "expected": pre.floor_id, "actual": post.floor_id}
            )
    elif declared["floor_id"] is None:
        if action_kind not in {"MOVE_TO_STAIR", "SCAN_OPAQUE_EXIT", "SCAN_VERIFIED_TRANSITION"} or not map_changed:
            differences.append(
                {
                    "field": "floor_id",
                    "expected": "a different map instance for a transition action",
                    "actual": post.map_instance_id,
                }
            )
    elif post.floor_id != declared["floor_id"]:
        differences.append(
            {"field": "floor_id", "expected": declared["floor_id"], "actual": post.floor_id}
        )

    if not map_changed:
        pre_blocks = {(block.x, block.y): block for block in pre.blocks}
        post_blocks = {(block.x, block.y): block for block in post.blocks}
        changed_coordinates = {
            coordinate
            for coordinate in set(pre_blocks) | set(post_blocks)
            if pre_blocks.get(coordinate) != post_blocks.get(coordinate)
        }
        expected_removed = declared.get("removed_blocks") or []
        expected_added = declared.get("added_blocks") or []
        removed_coordinates = {(item["x"], item["y"]) for item in expected_removed}
        added_coordinates = {(item["x"], item["y"]) for item in expected_added}
        allowed_coordinates = {
            (item["x"], item["y"]) for item in expected_removed + expected_added
        }
        actual["changed_block_coordinates"] = [
            {"x": coordinate[0], "y": coordinate[1]}
            for coordinate in sorted(changed_coordinates, key=lambda item: (item[1], item[0]))
        ]
        for item in expected_removed:
            coordinate = (item["x"], item["y"])
            before = pre_blocks.get(coordinate)
            after = post_blocks.get(coordinate)
            if before is None or not _matches_block_ref(before, item):
                differences.append(
                    {"field": "removed_blocks", "expected": item, "actual": "missing-pre-block"}
                )
            elif after is not None and _block_identity(after) == _block_identity(before):
                differences.append(
                    {"field": "removed_blocks", "expected": item, "actual": "still-present"}
                )
            elif after is not None and coordinate not in added_coordinates:
                differences.append(
                    {
                        "field": "removed_blocks",
                        "expected": item,
                        "actual": "replaced-without-declared-addition",
                    }
                )
        for item in expected_added:
            coordinate = (item["x"], item["y"])
            before = pre_blocks.get(coordinate)
            after = post_blocks.get(coordinate)
            if after is None or not _matches_block_ref(after, item):
                differences.append(
                    {"field": "added_blocks", "expected": item, "actual": "not-present"}
                )
            elif before is not None and coordinate not in removed_coordinates:
                differences.append(
                    {
                        "field": "added_blocks",
                        "expected": item,
                        "actual": "replaced-without-declared-removal",
                    }
                )
        unexpected = changed_coordinates - allowed_coordinates
        if unexpected:
            differences.append(
                {
                    "field": "blocks",
                    "expected": "only declared coordinates may change",
                    "actual": [
                        {"x": coordinate[0], "y": coordinate[1]}
                        for coordinate in sorted(unexpected, key=lambda item: (item[1], item[0]))
                    ],
                }
            )
    else:
        # Blocks belong to map-instance snapshots.  Their coordinate sets are
        # intentionally incomparable across a transition.
        actual["changed_block_coordinates"] = []
    return DeltaValidation(matches=not differences, differences=differences, actual=actual)
