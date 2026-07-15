"""Resource-state transitions and auditable heuristic valuation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

from .models import Observation


@dataclass(frozen=True)
class ResourceState:
    hp: int
    attack: int
    defense: int
    gold: int
    experience: int
    yellow: int
    blue: int
    red: int

    @classmethod
    def from_observation(cls, observation: Observation) -> "ResourceState":
        hero = observation.hero
        return cls(
            hp=hero.hp,
            attack=hero.attack,
            defense=hero.defense,
            gold=hero.gold,
            experience=hero.experience,
            yellow=observation.keys.yellow,
            blue=observation.keys.blue,
            red=observation.keys.red,
        )


WEIGHTS: Mapping[str, float] = {
    "hp": 1.0,
    "attack": 30.0,
    "defense": 30.0,
    "gold": 2.0,
    "experience": 2.0,
    "yellow": 60.0,
    "blue": 120.0,
    "red": 240.0,
}


def _delta_value(delta: Mapping[str, Any], name: str) -> int:
    value = delta.get(name, 0)
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"delta {name} must be an integer")
    return value


def apply_delta(state: ResourceState, delta: Mapping[str, Any]) -> Optional[ResourceState]:
    key_delta = delta.get("keys") or {}
    values: Dict[str, int] = {
        "hp": state.hp + _delta_value(delta, "hp"),
        "attack": state.attack + _delta_value(delta, "attack"),
        "defense": state.defense + _delta_value(delta, "defense"),
        "gold": state.gold + _delta_value(delta, "gold"),
        "experience": state.experience + _delta_value(delta, "experience"),
        "yellow": state.yellow + _delta_value(key_delta, "yellow"),
        "blue": state.blue + _delta_value(key_delta, "blue"),
        "red": state.red + _delta_value(key_delta, "red"),
    }
    if values["hp"] <= 0 or any(value < 0 for key, value in values.items() if key != "hp"):
        return None
    return ResourceState(**values)


def value_delta(delta: Mapping[str, Any], *, distance: int = 0, progress_bonus: float = 0.0) -> float:
    key_delta = delta.get("keys") or {}
    score = 0.0
    for name in ("hp", "attack", "defense", "gold", "experience"):
        score += _delta_value(delta, name) * WEIGHTS[name]
    for name in ("yellow", "blue", "red"):
        score += _delta_value(key_delta, name) * WEIGHTS[name]
    return score + progress_bonus - (float(distance) * 0.5)
