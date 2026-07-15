"""Canonical observations and current-floor graph construction."""

from __future__ import annotations

import hashlib
import json
from collections import deque
from dataclasses import dataclass
from typing import Dict, Iterable, List, Mapping, Optional, Set, Tuple

from .models import Block, BlockLabel, Observation


Coordinate = Tuple[int, int]


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def observation_payload(observation: Observation, *, include_timestamp: bool = True) -> dict:
    payload = observation.model_dump(mode="json", exclude_unset=True)
    if not include_timestamp:
        payload.pop("captured_at", None)
    payload["blocks"] = sorted(
        payload["blocks"],
        key=lambda block: (block["y"], block["x"], block["numeric_id"], block["id"]),
    )
    return payload


def historical_map_fact_payload(observation: Observation, fingerprint: str) -> dict:
    """Project an observation into revisioned map facts safe for planning.

    Full observations remain action/recovery evidence in the ledger.  World
    planning receives this narrower shape so a historical hero panel or key
    vector cannot accidentally become current state.
    """

    payload = observation_payload(observation)
    return {
        "snapshot_fingerprint": fingerprint,
        "session_id": payload["session_id"],
        "floor_id": payload["floor_id"],
        "floor_name": payload["floor_name"],
        "floor_number": payload["floor_number"],
        "dimensions": payload["dimensions"],
        "topology": payload["topology"],
        "topology_fingerprint": payload["topology_fingerprint"],
        "map_instance_id": payload["map_instance_id"],
        "observed_anchor": {
            "x": payload["hero"]["loc"]["x"],
            "y": payload["hero"]["loc"]["y"],
        },
        "blocks": payload["blocks"],
        "captured_at": payload["captured_at"],
    }


def fingerprint_payload(observation: Observation) -> dict:
    payload = observation_payload(observation, include_timestamp=False)
    result = {
        "floor_id": payload["floor_id"],
        "session_id": payload["session_id"],
        "map_instance_id": payload["map_instance_id"],
        "dimensions": payload["dimensions"],
        "topology": payload["topology"],
        "topology_fingerprint": payload["topology_fingerprint"],
        "hero": payload["hero"],
        "keys": payload["keys"],
        "blocks": payload["blocks"],
    }
    if observation.engine_model is not None:
        result["catalog_hash"] = observation.engine_model.catalog_hash
        result["engine_model_hash"] = observation.engine_model.model_hash
    return result


def observation_fingerprint(observation: Observation) -> str:
    digest = hashlib.sha256(
        canonical_json(fingerprint_payload(observation)).encode("utf-8")
    ).hexdigest()
    return "sha256:" + digest


@dataclass(frozen=True)
class Reachability:
    distances: Mapping[Coordinate, int]
    parents: Mapping[Coordinate, Optional[Coordinate]]

    @property
    def coordinates(self) -> Set[Coordinate]:
        return set(self.distances)

    def path_to(self, target: Coordinate) -> List[Coordinate]:
        if target not in self.distances:
            return []
        path: List[Coordinate] = []
        cursor: Optional[Coordinate] = target
        while cursor is not None:
            path.append(cursor)
            cursor = self.parents[cursor]
        path.reverse()
        return path


@dataclass(frozen=True)
class Boundary:
    block: Block
    label: BlockLabel
    distance: int
    approach: Coordinate


class CurrentFloorGraph:
    """A graph derived solely from one dynamically-sized current observation."""

    def __init__(self, observation: Observation, labels: Mapping[tuple, BlockLabel]):
        self.observation = observation
        self.labels = labels
        self.width = observation.dimensions.width
        self.height = observation.dimensions.height
        if observation.topology.valid_cells is None:
            self.valid_cells = {
                (x, y) for y in range(self.height) for x in range(self.width)
            }
        else:
            self.valid_cells = {(cell.x, cell.y) for cell in observation.topology.valid_cells}
        self.blocks: Dict[Coordinate, Block] = {
            (block.x, block.y): block for block in observation.blocks
        }
        self._blocked: Set[Coordinate] = set()
        for coordinate, block in self.blocks.items():
            label = labels.get((block.id, block.cls, block.trigger))
            if label is None or label.boundary or not label.passable or block.no_pass:
                self._blocked.add(coordinate)

    def neighbors(self, coordinate: Coordinate) -> Iterable[Coordinate]:
        x, y = coordinate
        for next_coordinate in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            nx, ny = next_coordinate
            if (nx, ny) in self.valid_cells:
                yield next_coordinate

    def is_traversable(self, coordinate: Coordinate) -> bool:
        return coordinate in self.valid_cells and coordinate not in self._blocked

    def reachable(self) -> Reachability:
        start = (self.observation.hero.loc.x, self.observation.hero.loc.y)
        if not self.is_traversable(start):
            # The hero coordinate is always a valid origin, even if a transient
            # dynamic block was reported there.
            self._blocked.discard(start)
        distances: Dict[Coordinate, int] = {start: 0}
        parents: Dict[Coordinate, Optional[Coordinate]] = {start: None}
        queue = deque([start])
        while queue:
            coordinate = queue.popleft()
            for neighbor in self.neighbors(coordinate):
                if neighbor in distances or not self.is_traversable(neighbor):
                    continue
                distances[neighbor] = distances[coordinate] + 1
                parents[neighbor] = coordinate
                queue.append(neighbor)
        return Reachability(distances=distances, parents=parents)

    def reachable_boundaries(self) -> List[Boundary]:
        reachable = self.reachable()
        boundaries: List[Boundary] = []
        for coordinate, block in self.blocks.items():
            label = self.labels.get((block.id, block.cls, block.trigger))
            if label is None or not label.boundary:
                continue
            approaches = [
                neighbor
                for neighbor in self.neighbors(coordinate)
                if neighbor in reachable.distances
            ]
            if not approaches:
                continue
            approach = min(
                approaches,
                key=lambda item: (reachable.distances[item], item[1], item[0]),
            )
            boundaries.append(
                Boundary(
                    block=block,
                    label=label,
                    distance=reachable.distances[approach] + 1,
                    approach=approach,
                )
            )
        return sorted(
            boundaries,
            key=lambda boundary: (
                boundary.distance,
                boundary.block.y,
                boundary.block.x,
                boundary.block.id,
            ),
        )
