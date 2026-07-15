"""Current-observation planner producing one atomic grid boundary action."""

from __future__ import annotations

from dataclasses import dataclass
from collections import deque
import hashlib
import json
from typing import Any, Callable, Dict, FrozenSet, List, Mapping, Optional, Tuple

from .combat import UnknownDamage, combat_availability, combat_outcome
from .guards import guard_from_observation
from .models import (
    BlockLabel,
    BlockRef,
    ExecuteResponse,
    ExpectedDelta,
    GridOperation,
    MenuChoiceOperation,
    HistoricalMapFact,
    IdleResponse,
    Observation,
    PauseKind,
    PauseResponse,
    RegistryEntry,
    ScanStateWire,
    block_label_execution_error,
    expected_delta_has_verifiable_non_position_postcondition,
)
from .search import SearchCandidate
from .state import (
    Boundary,
    CurrentFloorGraph,
    canonical_json,
    historical_map_fact_payload,
    observation_fingerprint,
)
from .valuation import ResourceState, apply_delta, value_delta


@dataclass(frozen=True)
class PlannedBoundary:
    boundary: Boundary
    expected_delta: ExpectedDelta
    search_candidate: SearchCandidate


@dataclass(frozen=True)
class WorldSearchResult:
    first: PlannedBoundary
    target: PlannedBoundary
    target_map_instance_id: str
    score: float
    explored_nodes: int
    path_length: int


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
    # A verified stair is transport, not progress.  Opaque stairs are still
    # discovered by the takeover scan, while verified stairs receive value
    # only from an executable downstream frontier.
    "stair": 0.0,
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
    def __init__(self, *, planning_budget: int = 4096) -> None:
        if planning_budget < 1:
            raise ValueError("planning_budget must be positive")
        self.planning_budget = planning_budget

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
    def _pause_for_unsupported(
        self,
        boundaries: List[Boundary],
        registry_entries: List[RegistryEntry],
    ) -> PauseResponse:
        """Pause on the deterministic nearest unresolved interaction frontier."""

        boundary = min(
            boundaries,
            key=lambda item: (
                item.distance,
                item.block.y,
                item.block.x,
                item.block.id,
                item.block.cls,
                item.block.trigger or "",
            ),
        )
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

    @staticmethod
    def _transition_key(edge: Mapping[str, Any]) -> tuple:
        return (
            str(edge.get("from_map_instance_id")), int(edge.get("from_x")),
            int(edge.get("from_y")), str(edge.get("to_map_instance_id")),
            int(edge.get("to_x")), int(edge.get("to_y")),
        )

    @staticmethod
    def _stair_is_scan_safe(label: BlockLabel) -> bool:
        if label.category != "stair" or not label.supported:
            return False
        if label.expected_delta is None:
            return True
        payload = label.expected_delta.model_dump(mode="json", exclude_unset=True)
        if any(payload.get(field, 0) != 0 for field in ("hp", "attack", "defense", "gold", "experience")):
            return False
        key_deltas = payload.get("keys") or {}
        if any(key_deltas.get(color, 0) != 0 for color in ("yellow", "blue", "red")):
            return False
        return not payload.get("removed_blocks") and not payload.get("added_blocks")

    @staticmethod
    def _scan_wire(state: Mapping[str, Any], frontier_count: int) -> ScanStateWire:
        return ScanStateWire(
            phase=state["phase"],
            anchor_map_instance_id=state["anchor_map_instance_id"],
            current_map_instance_id=state["current_map_instance_id"],
            scanned_map_instance_ids=sorted(set(state["scanned_map_instance_ids"])),
            pending_transition_count=len(state.get("pending_exits", [])),
            traversed_transition_count=len(state.get("traversed_transitions", [])),
            frontier_count=frontier_count,
            reason=state["reason"],
        )

    @staticmethod
    def _world_facts(
        observation: Observation, world_context: Mapping[str, object]
    ) -> Dict[str, HistoricalMapFact]:
        facts: Dict[str, HistoricalMapFact] = {}
        for payload in world_context.get("map_facts", []):
            try:
                item = HistoricalMapFact.model_validate(payload)
            except Exception:
                continue
            if item.session_id == observation.session_id:
                facts[item.map_instance_id] = item
        live_fact = HistoricalMapFact.model_validate(
            historical_map_fact_payload(observation, observation_fingerprint(observation))
        )
        facts[observation.map_instance_id] = live_fact
        instance_rows = {
            str(row.get("map_instance_id")): row
            for row in world_context.get("map_instances", [])
            if isinstance(row, Mapping)
        }
        if instance_rows:
            facts = {
                map_id: item for map_id, item in facts.items()
                if map_id in instance_rows and (
                    instance_rows[map_id].get("floor_id") == item.floor_id
                    and instance_rows[map_id].get("topology_fingerprint")
                    == item.topology_fingerprint
                    and instance_rows[map_id].get("dimensions_json")
                    == canonical_json(item.dimensions.model_dump(mode="json"))
                )
            }
        return facts

    @staticmethod
    def _fact_observation(
        fact: HistoricalMapFact,
        live: Observation,
        resources: ResourceState,
        position: Tuple[int, int],
    ) -> Observation:
        """Materialize topology for simulation with only live-derived resources."""

        return Observation.model_validate({
            "protocol": live.protocol,
            "page": live.page,
            "session_id": fact.session_id,
            "floor_id": fact.floor_id,
            "floor_name": fact.floor_name,
            "floor_number": fact.floor_number,
            "dimensions": fact.dimensions.model_dump(mode="json"),
            "topology": fact.topology.model_dump(mode="json", exclude_unset=True),
            "topology_fingerprint": fact.topology_fingerprint,
            "map_instance_id": fact.map_instance_id,
            "hero": {
                "hp": resources.hp,
                "attack": resources.attack,
                "defense": resources.defense,
                "gold": resources.gold,
                "experience": resources.experience,
                "loc": {
                    "x": position[0],
                    "y": position[1],
                    "direction": live.hero.loc.direction,
                },
            },
            "keys": {
                "yellow": resources.yellow,
                "blue": resources.blue,
                "red": resources.red,
            },
            "busy": False,
            "blocks": [block.model_dump(mode="json") for block in fact.blocks],
            "captured_at": fact.captured_at,
        })

    def _fact_base_observation(
        self, fact: HistoricalMapFact, live: Observation
    ) -> Observation:
        if fact.map_instance_id == live.map_instance_id:
            return live
        return self._fact_observation(
            fact,
            live,
            ResourceState.from_observation(live),
            (fact.observed_anchor.x, fact.observed_anchor.y),
        )

    @staticmethod
    def _valid_position(observation: Observation, x: object, y: object) -> bool:
        if not isinstance(x, int) or isinstance(x, bool) or not isinstance(y, int) or isinstance(y, bool):
            return False
        if x < 0 or y < 0 or x >= observation.dimensions.width or y >= observation.dimensions.height:
            return False
        if observation.topology.valid_cells is None:
            return True
        return (x, y) in {(cell.x, cell.y) for cell in observation.topology.valid_cells}

    def _resolved_exit_target(
        self,
        observation: Observation,
        block: object,
        world_context: Mapping[str, object],
    ) -> tuple[str, Optional[Dict[str, Any]]]:
        """Return opaque, exact, or ambiguous for one observed exit endpoint."""
        facts = self._world_facts(observation, world_context)
        candidates: Dict[tuple[str, str, int, int], Dict[str, Any]] = {}
        for edge in world_context.get("transitions", []):
            if not isinstance(edge, Mapping) \
                    or edge.get("from_map_instance_id") != observation.map_instance_id \
                    or edge.get("from_x") != getattr(block, "x", None) \
                    or edge.get("from_y") != getattr(block, "y", None):
                continue
            target_id = edge.get("to_map_instance_id")
            target = facts.get(str(target_id))
            if target is None or not self._valid_position(target, edge.get("to_x"), edge.get("to_y")):
                continue
            key = (target.map_instance_id, target.floor_id, int(edge["to_x"]), int(edge["to_y"]))
            candidates[key] = {
                "map_instance_id": target.map_instance_id,
                "floor_id": target.floor_id,
                "to_x": key[2], "to_y": key[3],
            }
        if not candidates:
            return "opaque", None
        if len(candidates) != 1:
            return "ambiguous", None
        return "exact", next(iter(candidates.values()))

    def refresh_scan_state(
        self,
        observation: Observation,
        labels: Mapping[tuple, BlockLabel],
        world_context: Mapping[str, object],
        scan_state: Mapping[str, Any],
    ) -> Dict[str, Any]:
        """Rebuild the auditable scan frontier from legally observed snapshots."""

        facts = self._world_facts(observation, world_context)
        scanned = set(str(item) for item in scan_state.get("scanned_map_instance_ids", []))
        scanned.add(observation.map_instance_id)
        traversed = list(scan_state.get("traversed_transitions", []))
        transitions = [
            item for item in world_context.get("transitions", []) if isinstance(item, Mapping)
        ]
        pending: List[Dict[str, Any]] = []
        for map_id in sorted(scanned):
            fact = facts.get(map_id)
            if fact is None:
                continue
            try:
                graph = CurrentFloorGraph(
                    self._fact_base_observation(fact, observation), labels
                )
                boundaries = graph.reachable_boundaries()
            except (KeyError, ValueError):
                continue
            for boundary in boundaries:
                label = boundary.label
                if not self._stair_is_scan_safe(label):
                    continue
                matching = [
                    edge for edge in transitions
                    if edge.get("from_map_instance_id") == map_id
                    and edge.get("from_x") == boundary.block.x
                    and edge.get("from_y") == boundary.block.y
                ]
                if not matching:
                    pending.append({
                        "kind": "opaque",
                        "from_map_instance_id": map_id,
                        "from_x": boundary.block.x,
                        "from_y": boundary.block.y,
                        "block_id": boundary.block.id,
                        "target_floor_number_hint": None,
                    })
                    continue
                valid_targets = []
                for edge in matching:
                    target_id = str(edge.get("to_map_instance_id"))
                    target = facts.get(target_id)
                    if target is None:
                        continue
                    try:
                        key = self._transition_key(edge)
                    except (TypeError, ValueError):
                        continue
                    if not self._valid_position(target, key[4], key[5]):
                        continue
                    valid_targets.append((edge, target, key))
                if not valid_targets:
                    pending.append({
                        "kind": "opaque", "from_map_instance_id": map_id,
                        "from_x": boundary.block.x, "from_y": boundary.block.y,
                        "block_id": boundary.block.id, "target_floor_number_hint": None,
                    })
                    continue
                identities = {
                    (str(target.map_instance_id), str(target.floor_id), key[4], key[5])
                    for _edge, target, key in valid_targets
                }
                if len(identities) > 1:
                    pending.append({
                        "kind": "ambiguous", "from_map_instance_id": map_id,
                        "from_x": boundary.block.x, "from_y": boundary.block.y,
                        "block_id": boundary.block.id, "target_floor_number_hint": None,
                    })
                    continue
                # A unique verified edge is already discovered.  It is not a
                # scan frontier of its own and must never be traversed merely
                # to mark the edge as progress.  _plan_scan may still use it
                # as a BFS repositioning edge toward a different opaque exit.
        phase = "complete" if not pending else ("discover" if len(scanned) == 1 else "sweep")
        hints = sorted(
            item["target_floor_number_hint"] for item in pending
            if isinstance(item.get("target_floor_number_hint"), int)
        )
        hint_text = "none" if not hints else f"{hints[0]}..{hints[-1]}"
        reason = (
            f"scan {phase}: {len(scanned)} map instances observed; "
            f"{len(pending)} safe exits pending; display-floor hint {hint_text}"
        )
        return {
            "phase": phase,
            "anchor_map_instance_id": scan_state["anchor_map_instance_id"],
            "current_map_instance_id": observation.map_instance_id,
            "scanned_map_instance_ids": sorted(scanned),
            "pending_exits": pending,
            "traversed_transitions": traversed,
            "reason": reason,
        }

    def _plan_scan(
        self,
        observation: Observation,
        labels: Mapping[tuple, BlockLabel],
        *,
        action_id_factory: Callable[[], str],
        registry_entries: List[RegistryEntry],
        supersedes_action_id: Optional[str],
        world_context: Mapping[str, object],
        scan_state: Mapping[str, Any],
    ):
        refreshed = self.refresh_scan_state(observation, labels, world_context, scan_state)
        frontier_count = len(world_context.get("frontiers", []))
        wire = self._scan_wire(refreshed, frontier_count)
        if refreshed["phase"] == "complete":
            return IdleResponse(
                status="idle",
                reason="[scan:complete] 当前安全可达地图实例已完成物理遍历；下一轮进入资源规划。",
                registry_entries=registry_entries,
                scan_state=wire,
            )

        facts = self._world_facts(observation, world_context)
        transitions = [
            item for item in world_context.get("transitions", []) if isinstance(item, Mapping)
        ]

        def boundaries_for(map_id: str) -> Dict[Tuple[int, int], Boundary]:
            fact = facts.get(map_id)
            if fact is None:
                return {}
            try:
                return {
                    (item.block.x, item.block.y): item
                    for item in CurrentFloorGraph(
                        self._fact_base_observation(fact, observation), labels
                    ).reachable_boundaries()
                    if self._stair_is_scan_safe(item.label)
                }
            except (KeyError, ValueError):
                return {}

        pending = list(refreshed["pending_exits"])
        local = [
            item for item in pending
            if item["from_map_instance_id"] == observation.map_instance_id
        ]
        selected: Optional[Mapping[str, Any]] = None
        if local:
            selected = min(
                local,
                key=lambda item: (
                    item.get("target_floor_number_hint") is None,
                    item.get("target_floor_number_hint") or 0,
                    item["from_y"], item["from_x"], item["kind"],
                ),
            )
        else:
            # Reposition only along already observed, non-consuming transition
            # edges.  BFS identity is map_instance_id; floor_number is merely a
            # deterministic target-order hint.
            targets = {item["from_map_instance_id"] for item in pending}
            queue = deque([(observation.map_instance_id, None)])
            visited = {observation.map_instance_id}
            while queue and selected is None:
                map_id, first_edge = queue.popleft()
                if map_id in targets and first_edge is not None:
                    selected = first_edge
                    break
                reachable = boundaries_for(map_id)
                for edge in transitions:
                    if edge.get("from_map_instance_id") != map_id:
                        continue
                    coordinate = (edge.get("from_x"), edge.get("from_y"))
                    target_id = str(edge.get("to_map_instance_id"))
                    if coordinate not in reachable or target_id not in facts or target_id in visited:
                        continue
                    if not self._valid_position(
                        facts[target_id], edge.get("to_x"), edge.get("to_y")
                    ):
                        continue
                    visited.add(target_id)
                    edge_choice = {
                        "kind": "verified",
                        "from_map_instance_id": map_id,
                        "from_x": coordinate[0], "from_y": coordinate[1],
                        "block_id": reachable[coordinate].block.id,
                        "to_map_instance_id": target_id,
                        "to_x": edge.get("to_x"), "to_y": edge.get("to_y"),
                        "target_floor_id": facts[target_id].floor_id,
                        "target_floor_number_hint": facts[target_id].floor_number,
                    }
                    queue.append((target_id, first_edge or edge_choice))
        if selected is None or selected["from_map_instance_id"] != observation.map_instance_id:
            paused = dict(refreshed)
            paused["phase"] = "paused"
            paused["reason"] = "scan paused: pending safe exits are not reachable from the current directed world graph"
            return IdleResponse(
                status="idle",
                reason="[scan:paused] 仍有安全出口，但当前单向世界图无法返回其起点；不消耗资源扩图。",
                registry_entries=registry_entries,
                scan_state=self._scan_wire(paused, frontier_count),
            )

        if selected["kind"] == "ambiguous":
            return self._pause(
                PauseKind.EXPECTED_DELTA_MISMATCH,
                "TRANSITION_TARGET_AMBIGUOUS",
                "同一出口存在多个冲突的已观察目标，不能签发精确换图行动。",
                registry_entries,
                map_instance_id=observation.map_instance_id,
                x=selected["from_x"], y=selected["from_y"],
            )

        graph = CurrentFloorGraph(observation, labels)
        boundary = next(
            (
                item for item in graph.reachable_boundaries()
                if item.block.x == selected["from_x"] and item.block.y == selected["from_y"]
                and item.label.category == "stair"
            ),
            None,
        )
        if boundary is None:
            paused = dict(refreshed)
            paused["phase"] = "paused"
            paused["reason"] = "scan paused: selected transition exit is not currently reachable"
            return IdleResponse(
                status="idle", reason="[scan:paused] 当前无法安全接近待遍历出口。",
                registry_entries=registry_entries,
                scan_state=self._scan_wire(paused, frontier_count),
            )
        expected_payload: Dict[str, Any]
        if selected["kind"] == "opaque":
            expected_payload = {"map_instance_id": None}
            action_kind = "SCAN_OPAQUE_EXIT"
        else:
            expected_payload = {
                "map_instance_id": selected["to_map_instance_id"],
                "floor_id": selected["target_floor_id"],
            }
            action_kind = "SCAN_VERIFIED_TRANSITION"
        operations: List[GridOperation] = []
        start = (observation.hero.loc.x, observation.hero.loc.y)
        approach_path = graph.reachable().path_to(boundary.approach)
        if boundary.approach != start and approach_path:
            operations.append(GridOperation(type="grid", x=boundary.approach[0], y=boundary.approach[1]))
        operations.append(GridOperation(type="grid", x=boundary.block.x, y=boundary.block.y))
        return ExecuteResponse(
            status="execute",
            action_id=action_id_factory(),
            action_kind=action_kind,
            operations=operations,
            guard=guard_from_observation(observation),
            expected_delta=ExpectedDelta.model_validate(expected_payload),
            reason=(
                f"[scan:{refreshed['phase']}] traverse {selected['kind']} exit "
                f"{observation.map_instance_id}@{boundary.block.x},{boundary.block.y}; "
                "no enemy, door, resource, NPC or mechanism may be consumed during takeover scan."
            ),
            supersedes_action_id=supersedes_action_id,
            registry_entries=registry_entries,
            scan_state=wire,
        )

    def _state_observation(
        self,
        fact: HistoricalMapFact,
        live: Observation,
        resources: ResourceState,
        position: Tuple[int, int],
        removed: FrozenSet[Tuple[str, int, int, str]],
    ) -> Observation:
        payload = self._fact_observation(fact, live, resources, position).model_dump(
            mode="json", exclude_unset=True
        )
        payload["blocks"] = [
            block for block in payload["blocks"]
            if (fact.map_instance_id, block["x"], block["y"], block["id"]) not in removed
        ]
        return Observation.model_validate(payload)

    def _world_search(
        self,
        observation: Observation,
        labels: Mapping[tuple, BlockLabel],
        world_context: Mapping[str, object],
    ) -> Tuple[Optional[WorldSearchResult], bool]:
        """Search the already-observed map-instance graph with topology updates.

        Each simulated boundary is consumed before reachability is rebuilt.  A
        cross-map step is possible only through a transition that was recorded
        from a real completed action.  The returned action is still only the
        first atomic boundary of the best audited path.  Historical enemy facts
        may be terminal goals only after verified zero-delta transport and only
        while the simulated resources still equal the live panel.  Any
        simulated resource/block mutation invalidates their combat panel.
        """
        facts = self._world_facts(observation, world_context)
        transitions: Dict[Tuple[str, int, int], List[Mapping[str, Any]]] = {}
        for row in world_context.get("transitions", []):
            if not isinstance(row, Mapping):
                continue
            key = (str(row.get("from_map_instance_id")), row.get("from_x"), row.get("from_y"))
            transitions.setdefault(key, []).append(row)

        initial_resources = ResourceState.from_observation(observation)
        initial_position = (observation.hero.loc.x, observation.hero.loc.y)
        queue = deque([(
            observation.map_instance_id,
            initial_position,
            initial_resources,
            frozenset(),
            0.0,
            None,
            0,
        )])
        seen = set()
        root_state_key = (
            observation.map_instance_id, initial_position, initial_resources, frozenset()
        )
        best_enqueued_score = {root_state_key: 0.0}
        best: Optional[WorldSearchResult] = None
        explored = 0
        exhausted = False
        while queue:
            if explored >= self.planning_budget:
                exhausted = True
                break
            map_id, position, resources, removed, score, first, depth = queue.popleft()
            state_key = (map_id, position, resources, removed)
            if state_key in seen:
                continue
            seen.add(state_key)
            explored += 1
            fact = facts.get(map_id)
            if fact is None:
                continue
            live_root = (
                depth == 0
                and first is None
                and map_id == observation.map_instance_id
                and position == initial_position
                and resources == initial_resources
                and not removed
            )
            simulated = observation if live_root else self._state_observation(
                fact, observation, resources, position, removed
            )
            graph = CurrentFloorGraph(simulated, labels)
            for boundary in graph.reachable_boundaries():
                label = boundary.label
                if boundary.block.shop_id and first is not None:
                    shop = next((item for item in observation.shops
                                 if item.shop_id == boundary.block.shop_id), None)
                    affordable = [] if shop is None else [choice for choice in shop.choices
                        if choice.index <= 8 and resources.gold >= choice.cost]
                    if affordable:
                        choice = max(affordable, key=lambda item: (
                            item.effect.amount * {"attack": 100.0, "defense": 95.0, "hp": 0.1}[item.effect.field]
                            - item.cost, -item.index,
                        ))
                        delta = {"gold": -choice.cost, choice.effect.field: choice.effect.amount}
                        next_score = score + value_delta(delta, distance=boundary.distance,
                                                         progress_bonus=20.0)
                        target = PlannedBoundary(
                            boundary=boundary,
                            expected_delta=ExpectedDelta.model_validate(delta),
                            search_candidate=SearchCandidate(
                                key=f"{map_id}:{boundary.block.x},{boundary.block.y}:shop:{shop.shop_id}",
                                delta=delta, distance=boundary.distance, progress_bonus=20.0,
                            ),
                        )
                        if best is None or (next_score, -(depth + 1)) > (best.score, -best.path_length):
                            best = WorldSearchResult(first, target, map_id, next_score,
                                                     explored, depth + 1)
                    continue
                if not label.supported or block_label_execution_error(label) is not None:
                    continue
                if label.category == "enemy" and not live_root:
                    # A historical combat panel is usable only on a genuinely
                    # remote map after verified zero-delta transport. Returning
                    # to the live map does not make its old panel fresh again.
                    if (
                        map_id == observation.map_instance_id
                        or resources != initial_resources
                        or removed
                    ):
                        continue
                    # Historical damage is not live engine truth.  Even if an
                    # older fact contains a numeric damage value, never route
                    # toward it when the simulated hero cannot penetrate the
                    # coordinate-local defense recorded in that same fact.
                    defense = None if boundary.block.enemy is None else boundary.block.enemy.defense
                    if (
                        isinstance(defense, int)
                        and not isinstance(defense, bool)
                        and resources.attack <= defense
                    ):
                        continue
                    try:
                        availability = combat_availability(block=boundary.block,
                                                           hero_attack=resources.attack)
                    except UnknownDamage:
                        continue
                    if availability != "fightable":
                        continue
                try:
                    expected = self._expected_for(boundary)
                except (ValueError, UnknownDamage):
                    continue
                delta = expected.model_dump(mode="json", exclude_unset=True)
                next_resources = apply_delta(resources, delta)
                if next_resources is None:
                    continue
                candidate = PlannedBoundary(
                    boundary=boundary,
                    expected_delta=expected,
                    search_candidate=SearchCandidate(
                        key=f"{map_id}:{boundary.block.x},{boundary.block.y}:{boundary.block.id}",
                        delta=delta,
                        distance=boundary.distance,
                        progress_bonus=PROGRESS_BONUS.get(label.category, 0.0),
                    ),
                )
                first_candidate = first or candidate
                path_length = depth + 1
                transition_rows = transitions.get(
                    (map_id, boundary.block.x, boundary.block.y), []
                ) if label.category == "stair" else []
                valid_transition_successors = []
                for edge in transition_rows:
                    target_id = str(edge.get("to_map_instance_id"))
                    if target_id not in facts:
                        continue
                    try:
                        target_position = (int(edge.get("to_x")), int(edge.get("to_y")))
                    except (TypeError, ValueError):
                        continue
                    if not self._valid_position(facts[target_id], *target_position):
                        continue
                    valid_transition_successors.append((target_id, target_position))
                valid_transition_successors = sorted(set(valid_transition_successors))
                if len(valid_transition_successors) > 1:
                    # Conflicting observed targets are never guessed inside a
                    # historical branch.  A current ambiguous exit is handled
                    # by the explicit fail-closed pause in plan().
                    continue
                if valid_transition_successors:
                    # A verified transition has exactly zero reward and is not
                    # a terminal candidate.  Check dominance before enqueueing
                    # so A->B->A cannot manufacture progress or a candidate.
                    for target_id, target_position in valid_transition_successors:
                        successor_key = (target_id, target_position, next_resources, removed)
                        if successor_key in seen:
                            continue
                        previous_score = best_enqueued_score.get(successor_key)
                        if previous_score is not None and previous_score >= score:
                            continue
                        best_enqueued_score[successor_key] = score
                        queue.append((
                            target_id, target_position, next_resources, removed,
                            score, first_candidate, path_length,
                        ))
                    continue

                next_score = score + value_delta(
                    delta,
                    distance=boundary.distance,
                    progress_bonus=PROGRESS_BONUS.get(label.category, 0.0),
                )
                # A scarce blue/red door is transport to a possible payoff,
                # not progress by itself. A negative standalone door may
                # become the first step only if a later reachable supported
                # frontier makes the complete branch preferable.
                key_delta = delta.get("keys") or {}
                consumes_scarce_key = any(
                    key_delta.get(color, 0) < 0 for color in ("blue", "red")
                )
                terminal_door = consumes_scarce_key and next_score < score
                if not terminal_door and (
                    best is None or (next_score, -path_length) > (best.score, -best.path_length)
                ):
                    best = WorldSearchResult(
                        first_candidate, candidate, map_id, next_score, explored, path_length
                    )

                if label.category == "enemy":
                    # A live combat boundary is one atomic terminal candidate.
                    # Its outcome cannot authorize any simulated successor.
                    continue
                if label.category == "stair":
                    # Unknown destination is opaque.  The branch ends at the
                    # physical traversal itself; no remote/current-map future
                    # may be fabricated beyond this point.
                    continue
                consumed = removed | frozenset({(
                    map_id, boundary.block.x, boundary.block.y, boundary.block.id,
                )})
                successor_position = (boundary.block.x, boundary.block.y)
                successor_key = (map_id, successor_position, next_resources, consumed)
                previous_score = best_enqueued_score.get(successor_key)
                if successor_key in seen or (
                    previous_score is not None and previous_score >= next_score
                ):
                    continue
                best_enqueued_score[successor_key] = next_score
                queue.append((map_id, successor_position, next_resources,
                              consumed, next_score, first_candidate, path_length))
        if best is not None:
            best = WorldSearchResult(
                best.first, best.target, best.target_map_instance_id,
                best.score, explored, best.path_length,
            )
        return best, exhausted

    def plan(
        self,
        observation: Observation,
        labels: Mapping[tuple, BlockLabel],
        *,
        action_id_factory: Callable[[], str],
        registry_entries: List[RegistryEntry],
        supersedes_action_id: Optional[str] = None,
        world_context: Optional[Mapping[str, object]] = None,
        scan_state: Optional[Mapping[str, Any]] = None,
    ):
        if observation.busy:
            return self._pause(
                PauseKind.UNSUPPORTED_INTERACTION,
                "INTERACTION_ACTIVE",
                "游戏仍处于活动事件或控制锁定状态，当前交互尚未实现。",
                registry_entries,
            )

        # Only genuinely unexplained damage is a floor-wide hard gate.  An
        # engine null/??? explained by the fresh live attack being unable to
        # penetrate this coordinate's fresh defense is an ordinary blocked
        # frontier and must not veto independent progress.
        known_unfightable_coordinates = set()
        for block in observation.blocks:
            label = labels[(block.id, block.cls, block.trigger)]
            if label.category != "enemy":
                continue
            try:
                availability = combat_availability(block, observation.hero.attack)
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
                        "enemy": None if block.enemy is None else block.enemy.model_dump(mode="json"),
                        "hero_attack": observation.hero.attack,
                    },
                )
            if availability == "known_unfightable":
                known_unfightable_coordinates.add((block.x, block.y))

        if scan_state is not None and scan_state.get("phase") != "complete":
            return self._plan_scan(
                observation,
                labels,
                action_id_factory=action_id_factory,
                registry_entries=registry_entries,
                supersedes_action_id=supersedes_action_id,
                world_context=world_context or {},
                scan_state=scan_state,
            )

        graph = CurrentFloorGraph(observation, labels)
        boundaries = graph.reachable_boundaries()
        shop_by_id = {shop.shop_id: shop for shop in observation.shops}
        shop_candidates = []
        for boundary in boundaries:
            shop_id = boundary.block.shop_id
            shop = shop_by_id.get(shop_id) if shop_id else None
            if shop is None:
                continue
            for choice in shop.choices:
                if choice.index > 8 or observation.hero.gold < choice.cost:
                    continue
                # Stable, generic marginal utility. Attack/defense upgrades are
                # preferred over HP when all are affordable; no floor/route is hard-coded.
                weight = {"attack": 100.0, "defense": 95.0, "hp": 0.1}[choice.effect.field]
                score = choice.effect.amount * weight - choice.cost - boundary.distance
                if score > 0:
                    shop_candidates.append((score, boundary, shop, choice))
        if shop_candidates:
            _, boundary, shop, choice = max(shop_candidates, key=lambda item: (
                item[0], -item[1].distance, -item[3].index,
            ))
            menu_payload = [{
                "text": item.text, "cost": item.cost,
                "effect": item.effect.model_dump(mode="json"),
                "counter_flag": item.counter_flag,
            } for item in shop.choices]
            menu_id = "sha256:" + hashlib.sha256(json.dumps(
                menu_payload, ensure_ascii=False, sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")).hexdigest()
            operations: List[Any] = []
            start = (observation.hero.loc.x, observation.hero.loc.y)
            path = graph.reachable().path_to(boundary.approach)
            if boundary.approach != start and path:
                operations.append(GridOperation(type="grid", x=boundary.approach[0], y=boundary.approach[1]))
            operations.append(GridOperation(type="grid", x=boundary.block.x, y=boundary.block.y))
            operations.append(MenuChoiceOperation(
                type="menu_choice", shop_id=shop.shop_id, menu_id=menu_id,
                choice_id=choice.choice_id, choice_index=choice.index,
                expected_cost=choice.cost, expected_effect=choice.effect,
                expected_purchase_count=choice.purchase_count,
            ))
            delta = {"gold": -choice.cost, choice.effect.field: choice.effect.amount}
            return ExecuteResponse(
                status="execute", action_id=action_id_factory(), action_kind="PURCHASE_UPGRADE",
                operations=operations, guard=guard_from_observation(observation),
                expected_delta=ExpectedDelta.model_validate(delta),
                reason=f"购买已静态验证的商店升级 {shop.shop_id}/{choice.choice_id}。",
                supersedes_action_id=supersedes_action_id, registry_entries=registry_entries,
            )
        unsupported = [boundary for boundary in boundaries if not boundary.label.supported]
        planned: List[PlannedBoundary] = []
        for boundary in boundaries:
            label = boundary.label
            if (
                label.category == "enemy"
                and (boundary.block.x, boundary.block.y) in known_unfightable_coordinates
            ):
                continue
            if not label.supported:
                # An unsupported boundary is an impassable unresolved frontier,
                # not a global veto.  CurrentFloorGraph already excludes it
                # from every corridor, so other independently reachable and
                # executable boundaries may still be considered.
                continue
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
            if unsupported:
                return self._pause_for_unsupported(unsupported, registry_entries)
            if known_unfightable_coordinates:
                return IdleResponse(
                    status="idle",
                    reason="当前可达 frontier 仅包含按实时攻防确认的当前不可战斗怪物；保持现场不行动。",
                    registry_entries=registry_entries,
                )
            return IdleResponse(
                status="idle",
                reason="当前已观察层没有可达的已知状态变化边界。",
                registry_entries=registry_entries,
            )

        # Protocol v2 intentionally does not permute a fixed depth of current
        # candidates.  Every cycle rebuilds reachability from the complete
        # observed topology; world_context supplies persisted map/transition
        # facts and the bounded scoring pass considers each currently exposed
        # frontier exactly once.
        initial = ResourceState.from_observation(observation)
        scored = []
        known_transition_exits = set()
        ambiguous_transition_exits = set()
        for item in planned:
            if item.boundary.label.category != "stair":
                continue
            target_kind, _target = self._resolved_exit_target(
                observation, item.boundary.block, world_context or {},
            )
            coordinate = (item.boundary.block.x, item.boundary.block.y)
            if target_kind == "exact":
                known_transition_exits.add(coordinate)
            elif target_kind == "ambiguous":
                ambiguous_transition_exits.add(coordinate)
        if ambiguous_transition_exits:
            x, y = min(ambiguous_transition_exits, key=lambda item: (item[1], item[0]))
            return self._pause(
                PauseKind.EXPECTED_DELTA_MISMATCH,
                "TRANSITION_TARGET_AMBIGUOUS",
                "同一出口存在多个冲突目标；保持 opaque 并暂停等待审计。",
                registry_entries,
                map_instance_id=observation.map_instance_id, x=x, y=y,
            )
        for item in planned:
            candidate = item.search_candidate
            next_state = apply_delta(initial, candidate.delta)
            if next_state is None:
                continue
            if (
                item.boundary.label.category == "stair"
                and (item.boundary.block.x, item.boundary.block.y) in known_transition_exits
            ):
                # A verified transition may be selected only when world search
                # proves a downstream executable frontier.  It is never a
                # standalone fallback candidate.
                continue
            score = value_delta(
                candidate.delta,
                distance=candidate.distance,
                progress_bonus=candidate.progress_bonus,
            )
            key_delta = candidate.delta.get("keys") or {}
            consumes_scarce_key = any(
                key_delta.get(color, 0) < 0 for color in ("blue", "red")
            )
            if consumes_scarce_key and score < 0:
                # Do not spend a scarce blue/red key merely because every
                # alternative also has a negative score. World search can
                # still select it when a downstream payoff justifies it.
                continue
            scored.append((score, -candidate.distance, item))
        if len(scored) > self.planning_budget:
            return self._pause(
                PauseKind.PLANNING_BUDGET_EXHAUSTED,
                "WORLD_SEARCH_BUDGET_EXHAUSTED",
                "已探索世界的当前可执行 frontier 超出规划预算，保持现场不行动。",
                registry_entries,
                planning_budget=self.planning_budget,
                frontier_count=len(scored),
            )
        world_result = None
        if world_context is not None and world_context.get("map_facts"):
            world_result, exhausted = self._world_search(observation, labels, world_context)
            if exhausted:
                return self._pause(
                    PauseKind.PLANNING_BUDGET_EXHAUSTED,
                    "WORLD_SEARCH_BUDGET_EXHAUSTED",
                    "已探索世界状态搜索达到规划预算，保持现场不行动。",
                    registry_entries,
                    planning_budget=self.planning_budget,
                )
        if world_result is None and not scored:
            if unsupported:
                return self._pause_for_unsupported(unsupported, registry_entries)
            return IdleResponse(
                status="idle",
                reason=(
                    "当前没有可执行的实际进展；已验证跨图边仅作通往远端目标的中间边，"
                    "不会因往返本身签发行动。"
                ),
                registry_entries=registry_entries,
            )
        if world_result is not None:
            selected = world_result.first
            selected_score = world_result.score
            explored_nodes = world_result.explored_nodes
            path_length = world_result.path_length
            world_target = world_result.target
            world_target_map_id = world_result.target_map_instance_id
        else:
            explored_nodes = len(scored)
            selected_score, _, selected = max(
                scored,
                key=lambda row: (row[0], row[1], -row[2].boundary.block.y, -row[2].boundary.block.x),
            )
            path_length = 1
            world_target = selected
            world_target_map_id = observation.map_instance_id
        block = selected.boundary.block
        label = selected.boundary.label
        action_kind = ACTION_KINDS.get(label.category, "MOVE_TO_BOUNDARY")
        category_name = CATEGORY_NAMES.get(label.category, "已知边界")
        known_transition = (
            label.category == "stair"
            and (block.x, block.y) in known_transition_exits
        )
        if label.category == "stair":
            target_kind, target = self._resolved_exit_target(
                observation, block, world_context or {},
            )
            if target_kind == "ambiguous":
                return self._pause(
                    PauseKind.EXPECTED_DELTA_MISMATCH,
                    "TRANSITION_TARGET_AMBIGUOUS",
                    "同一出口存在多个冲突目标；保持 opaque 并暂停等待审计。",
                    registry_entries,
                    map_instance_id=observation.map_instance_id, x=block.x, y=block.y,
                )
            if target_kind == "exact" and target is not None:
                selected = PlannedBoundary(
                    boundary=selected.boundary,
                    expected_delta=ExpectedDelta.model_validate({
                        "map_instance_id": target["map_instance_id"],
                        "floor_id": target["floor_id"],
                    }),
                    search_candidate=selected.search_candidate,
                )
                known_transition = True
            else:
                selected = PlannedBoundary(
                    boundary=selected.boundary,
                    expected_delta=ExpectedDelta.model_validate({"map_instance_id": None}),
                    search_candidate=selected.search_candidate,
                )
                known_transition = False
        reason = (
            f"世界图 frontier 搜索选择距离 {selected.boundary.distance} 的{category_name} "
            f"({block.x},{block.y})；估值 {selected_score:.1f}，"
            f"检查 {explored_nodes} 个世界状态，最佳已知路径 {path_length} 个原子边界。"
            + (
                f" 该已验证跨图边仅作为通往 {world_target_map_id} 的实际目标 "
                f"{world_target.boundary.block.id}@"
                f"{world_target.boundary.block.x},{world_target.boundary.block.y} 的第一步。"
                if known_transition and world_target is not selected else ""
            )
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
