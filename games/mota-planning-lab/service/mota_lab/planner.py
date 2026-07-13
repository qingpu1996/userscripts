"""Current-observation planner producing one atomic grid boundary action."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List, Mapping, Optional

from .combat import UnknownDamage, combat_outcome
from .guards import guard_from_observation
from .models import (
    BlockLabel,
    BlockRef,
    ExecuteResponse,
    ExpectedDelta,
    GridOperation,
    IdleResponse,
    Observation,
    PauseKind,
    PauseResponse,
    RegistryEntry,
    block_label_execution_error,
    expected_delta_has_verifiable_non_position_postcondition,
)
from .search import SearchCandidate, limited_depth_search
from .state import Boundary, CurrentFloorGraph
from .valuation import ResourceState


@dataclass(frozen=True)
class PlannedBoundary:
    boundary: Boundary
    expected_delta: ExpectedDelta
    search_candidate: SearchCandidate


ACTION_KINDS = {
    "door": "OPEN_DOOR",
    "resource": "MOVE_TO_RESOURCE",
    "enemy": "MOVE_TO_ENEMY",
    "stair": "MOVE_TO_STAIR",
    "npc": "INTERACT_WITH_NPC",
    "mechanism": "INTERACT_WITH_MECHANISM",
    "other": "MOVE_TO_BOUNDARY",
}

PROGRESS_BONUS = {
    "door": 30.0,
    "resource": 10.0,
    "enemy": 5.0,
    "stair": 100.0,
    "npc": 20.0,
    "mechanism": 20.0,
    "other": 0.0,
}

CATEGORY_NAMES = {
    "door": "已知门",
    "resource": "已知资源",
    "enemy": "当前可见怪物",
    "stair": "已知楼梯",
    "npc": "已登记 NPC",
    "mechanism": "已登记机关",
    "other": "已登记边界",
}


class Planner:
    def __init__(self, *, search_depth: int = 3) -> None:
        self.search_depth = search_depth

    @staticmethod
    def _pause(
        kind: PauseKind,
        detail_code: str,
        reason: str,
        registry_entries: List[RegistryEntry],
        **details: object,
    ) -> PauseResponse:
        return PauseResponse(
            status="pause",
            pause_kind=kind,
            detail_code=detail_code,
            reason=reason,
            details=details,
            registry_entries=registry_entries,
        )

    def _expected_for(self, boundary: Boundary) -> ExpectedDelta:
        block = boundary.block
        label = boundary.label
        if label.expected_delta is None:
            delta: Dict[str, object] = {}
        else:
            delta = label.expected_delta.model_dump(mode="json", exclude_unset=True)

        if label.category == "enemy":
            outcome = combat_outcome(block)
            delta.update(
                hp=outcome.hp_delta,
                gold=outcome.gold_delta,
                experience=outcome.experience_delta,
            )
        elif label.category in {"door", "resource"}:
            if label.expected_delta is None:
                raise ValueError("INCOMPLETE_LABEL")
        elif label.category == "stair" and "floor_id" not in delta:
            # A human may approve an observed stair before its destination is
            # known.  Explicit null means this one boundary may change floorId;
            # the resulting new floor still pauses as UNKNOWN_FLOOR.
            delta["floor_id"] = None

        if label.category in {"enemy", "door", "resource"}:
            delta["removed_blocks"] = [
                BlockRef(
                    x=block.x,
                    y=block.y,
                    id=block.id,
                    cls=block.cls,
                    trigger=block.trigger,
                    numeric_id=block.numeric_id,
                ).model_dump(mode="json")
            ]
        expected = ExpectedDelta.model_validate(delta)
        if label.boundary and not expected_delta_has_verifiable_non_position_postcondition(expected):
            raise ValueError("INCOMPLETE_LABEL")
        return expected

    def plan(
        self,
        observation: Observation,
        labels: Mapping[tuple, BlockLabel],
        *,
        action_id_factory: Callable[[], str],
        registry_entries: List[RegistryEntry],
        supersedes_action_id: Optional[str] = None,
    ):
        if observation.busy:
            return self._pause(
                PauseKind.UNSUPPORTED_INTERACTION,
                "INTERACTION_ACTIVE",
                "游戏仍处于活动事件或控制锁定状态，当前交互尚未实现。",
                registry_entries,
            )

        # Unknown/invalid damage anywhere on the currently visible floor must
        # stop before route ranking, even when another candidate looks cheaper.
        for block in observation.blocks:
            label = labels[(block.id, block.cls, block.trigger)]
            if label.category != "enemy":
                continue
            try:
                combat_outcome(block)
            except UnknownDamage as exc:
                return self._pause(
                    PauseKind.UNKNOWN_DAMAGE,
                    exc.detail_code,
                    f"坐标 ({block.x},{block.y}) 的当前怪物战损无法解释。",
                    registry_entries,
                    block={
                        "x": block.x,
                        "y": block.y,
                        "id": block.id,
                        "cls": block.cls,
                        "trigger": block.trigger,
                        "numeric_id": block.numeric_id,
                        "damage": block.damage,
                    },
                )

        graph = CurrentFloorGraph(observation, labels)
        boundaries = graph.reachable_boundaries()
        planned: List[PlannedBoundary] = []
        for boundary in boundaries:
            label = boundary.label
            if not label.supported:
                return self._pause(
                    PauseKind.UNSUPPORTED_INTERACTION,
                    "UNSUPPORTED_REGISTERED_INTERACTION",
                    f"坐标 ({boundary.block.x},{boundary.block.y}) 的已登记交互尚未实现。",
                    registry_entries,
                    block={
                        "x": boundary.block.x,
                        "y": boundary.block.y,
                        "id": boundary.block.id,
                        "cls": boundary.block.cls,
                        "trigger": boundary.block.trigger,
                    },
                )
            if block_label_execution_error(label) is not None:
                return self._pause(
                    PauseKind.NEW_OBJECT_OR_MECHANISM,
                    "INCOMPLETE_LABEL",
                    f"坐标 ({boundary.block.x},{boundary.block.y}) 的标签缺少可验证的非位置差分。",
                    registry_entries,
                    block={
                        "x": boundary.block.x,
                        "y": boundary.block.y,
                        "id": boundary.block.id,
                        "cls": boundary.block.cls,
                        "trigger": boundary.block.trigger,
                    },
                )
            try:
                expected = self._expected_for(boundary)
            except ValueError:
                return self._pause(
                    PauseKind.NEW_OBJECT_OR_MECHANISM,
                    "INCOMPLETE_LABEL",
                    f"坐标 ({boundary.block.x},{boundary.block.y}) 的标签缺少可验证差分。",
                    registry_entries,
                    block={
                        "x": boundary.block.x,
                        "y": boundary.block.y,
                        "id": boundary.block.id,
                        "cls": boundary.block.cls,
                        "trigger": boundary.block.trigger,
                    },
                )
            delta_payload = expected.model_dump(mode="json", exclude_unset=True)
            key = f"{boundary.block.x},{boundary.block.y}:{boundary.block.id}:{boundary.block.cls}"
            planned.append(
                PlannedBoundary(
                    boundary=boundary,
                    expected_delta=expected,
                    search_candidate=SearchCandidate(
                        key=key,
                        delta=delta_payload,
                        distance=boundary.distance,
                        progress_bonus=PROGRESS_BONUS.get(label.category, 0.0),
                    ),
                )
            )

        if not planned:
            return IdleResponse(
                status="idle",
                reason="当前已观察层没有可达的已知状态变化边界。",
                registry_entries=registry_entries,
            )

        choice = limited_depth_search(
            ResourceState.from_observation(observation),
            [item.search_candidate for item in planned],
            max_depth=self.search_depth,
        )
        if choice is None:
            return IdleResponse(
                status="idle",
                reason="当前已知边界都会导致生命归零或资源不足，保持现场不行动。",
                registry_entries=registry_entries,
            )
        selected = next(
            item for item in planned if item.search_candidate.key == choice.candidate_key
        )
        block = selected.boundary.block
        label = selected.boundary.label
        action_kind = ACTION_KINDS.get(label.category, "MOVE_TO_BOUNDARY")
        category_name = CATEGORY_NAMES.get(label.category, "已知边界")
        reason = (
            f"有限深度搜索选择距离 {selected.boundary.distance} 的{category_name} "
            f"({block.x},{block.y})；估值 {choice.utility:.1f}，"
            f"搜索 {choice.explored_nodes} 个状态并剪枝 {choice.pruned_nodes} 个。"
        )
        operations = []
        approach = selected.boundary.approach
        start = (observation.hero.loc.x, observation.hero.loc.y)
        approach_path = graph.reachable().path_to(approach)
        corridor_is_fast = bool(approach_path)
        for coordinate in approach_path[1:]:
            corridor_block = graph.blocks.get(coordinate)
            if corridor_block is None:
                continue
            corridor_label = labels[(
                corridor_block.id,
                corridor_block.cls,
                corridor_block.trigger,
            )]
            if (
                corridor_label.boundary
                or not corridor_label.passable
                or not corridor_label.fast_path
                or corridor_block.no_pass
            ):
                corridor_is_fast = False
                break
        if approach != start and corridor_is_fast:
            operations.append(GridOperation(type="grid", x=approach[0], y=approach[1]))
        operations.append(GridOperation(type="grid", x=block.x, y=block.y))
        action_id = action_id_factory()
        return ExecuteResponse(
            status="execute",
            action_id=action_id,
            action_kind=action_kind,
            operations=operations,
            guard=guard_from_observation(observation),
            expected_delta=selected.expected_delta,
            reason=reason,
            supersedes_action_id=supersedes_action_id,
            registry_entries=registry_entries,
        )
