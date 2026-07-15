"""Finite-depth state search with resource dominance pruning."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from .valuation import ResourceState, apply_delta, value_delta


@dataclass(frozen=True)
class SearchCandidate:
    key: str
    delta: Mapping[str, object]
    distance: int
    progress_bonus: float = 0.0


@dataclass(frozen=True)
class SearchChoice:
    candidate_key: str
    utility: float
    explored_nodes: int
    pruned_nodes: int


def dominates(left: ResourceState, right: ResourceState) -> bool:
    left_values = (
        left.hp,
        left.attack,
        left.defense,
        left.gold,
        left.experience,
        left.yellow,
        left.blue,
        left.red,
    )
    right_values = (
        right.hp,
        right.attack,
        right.defense,
        right.gold,
        right.experience,
        right.yellow,
        right.blue,
        right.red,
    )
    return all(a >= b for a, b in zip(left_values, right_values)) and any(
        a > b for a, b in zip(left_values, right_values)
    )


@dataclass(frozen=True)
class _Node:
    state: ResourceState
    remaining: Tuple[int, ...]
    first: int
    utility: float
    depth: int


def limited_depth_search(
    initial: ResourceState,
    candidates: Sequence[SearchCandidate],
    *,
    max_depth: int = 3,
) -> Optional[SearchChoice]:
    if max_depth < 1:
        raise ValueError("max_depth must be at least 1")
    frontier: List[_Node] = []
    explored = 0
    pruned = 0
    for index, candidate in enumerate(candidates):
        next_state = apply_delta(initial, candidate.delta)
        explored += 1
        if next_state is None:
            continue
        frontier.append(
            _Node(
                state=next_state,
                remaining=tuple(i for i in range(len(candidates)) if i != index),
                first=index,
                utility=value_delta(
                    candidate.delta,
                    distance=candidate.distance,
                    progress_bonus=candidate.progress_bonus,
                ),
                depth=1,
            )
        )
    if not frontier:
        return None

    best_by_first: Dict[int, float] = {node.first: node.utility for node in frontier}
    dominance_buckets: Dict[Tuple[int, Tuple[int, ...]], List[ResourceState]] = {}
    while frontier:
        node = frontier.pop(0)
        best_by_first[node.first] = max(best_by_first.get(node.first, node.utility), node.utility)
        if node.depth >= max_depth:
            continue
        for index in node.remaining:
            candidate = candidates[index]
            next_state = apply_delta(node.state, candidate.delta)
            explored += 1
            if next_state is None:
                continue
            remaining = tuple(item for item in node.remaining if item != index)
            bucket_key = (node.first, remaining)
            bucket = dominance_buckets.setdefault(bucket_key, [])
            if any(dominates(existing, next_state) or existing == next_state for existing in bucket):
                pruned += 1
                continue
            bucket[:] = [existing for existing in bucket if not dominates(next_state, existing)]
            bucket.append(next_state)
            frontier.append(
                _Node(
                    state=next_state,
                    remaining=remaining,
                    first=node.first,
                    utility=node.utility
                    + value_delta(
                        candidate.delta,
                        distance=candidate.distance,
                        progress_bonus=candidate.progress_bonus,
                    ),
                    depth=node.depth + 1,
                )
            )

    best_index = max(
        best_by_first,
        key=lambda index: (
            best_by_first[index],
            -candidates[index].distance,
            candidates[index].key,
        ),
    )
    return SearchChoice(
        candidate_key=candidates[best_index].key,
        utility=best_by_first[best_index],
        explored_nodes=explored,
        pruned_nodes=pruned,
    )
