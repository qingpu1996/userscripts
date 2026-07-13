"""Exact pre-action guard construction and comparison."""

from __future__ import annotations

from typing import Any, Dict, List

from .models import Guard, Observation


def guard_from_observation(observation: Observation) -> Guard:
    hero = observation.hero
    return Guard(
        session_id=observation.session_id,
        map_instance_id=observation.map_instance_id,
        dimensions=observation.dimensions,
        topology_fingerprint=observation.topology_fingerprint,
        floor_id=observation.floor_id,
        floor=observation.floor_number,
        position=hero.loc,
        hp=hero.hp,
        attack=hero.attack,
        defense=hero.defense,
        gold=hero.gold,
        experience=hero.experience,
        keys=observation.keys,
    )


def compare_guard(guard: Guard, observation: Observation) -> List[Dict[str, Any]]:
    actual = guard_from_observation(observation)
    expected_payload = guard.model_dump(mode="json")
    actual_payload = actual.model_dump(mode="json")
    differences: List[Dict[str, Any]] = []

    def walk(path: str, expected: Any, found: Any) -> None:
        if isinstance(expected, dict) and isinstance(found, dict):
            for key in sorted(set(expected) | set(found)):
                walk(f"{path}.{key}" if path else key, expected.get(key), found.get(key))
            return
        if expected != found:
            differences.append({"field": path, "expected": expected, "actual": found})

    walk("", expected_payload, actual_payload)
    return differences
