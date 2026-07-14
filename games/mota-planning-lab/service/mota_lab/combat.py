"""Combat truth handling from the current live observation only.

The service never recomputes loss from hidden enemy tables.  A finite current
``damage`` is the combat-loss truth; the same observation's hero attack and
coordinate-local enemy defense are used only to explain why the engine reports
null/``???`` as currently unfightable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .models import Block


class UnknownDamage(ValueError):
    def __init__(self, detail_code: str, block: Block):
        super().__init__(detail_code)
        self.detail_code = detail_code
        self.block = block


@dataclass(frozen=True)
class CombatOutcome:
    hp_delta: int
    gold_delta: int
    experience_delta: int


def combat_availability(block: Block, hero_attack: int) -> str:
    """Classify the current engine-reported combat result without a monster cache.

    A missing/``???`` damage is explainable only when this observation's hero
    cannot penetrate this coordinate's current enemy defense.  Every cycle
    calls this function with the fresh live attack value, so the classification
    is deliberately not persisted.
    """

    damage = block.damage
    if isinstance(damage, bool):
        raise UnknownDamage("DAMAGE_UNEXPLAINED", block)
    if isinstance(damage, int):
        if damage < 0 or block.enemy is None:
            raise UnknownDamage("DAMAGE_UNEXPLAINED", block)
        return "fightable"
    if damage is None or damage == "???":
        enemy = block.enemy
        defense = None if enemy is None else enemy.defense
        if (
            isinstance(hero_attack, int)
            and not isinstance(hero_attack, bool)
            and isinstance(defense, int)
            and not isinstance(defense, bool)
            and hero_attack <= defense
        ):
            return "known_unfightable"
        raise UnknownDamage("DAMAGE_UNEXPLAINED", block)
    raise UnknownDamage("DAMAGE_UNEXPLAINED", block)


def combat_outcome(block: Block, hero_hp: Optional[int] = None) -> CombatOutcome:
    damage = block.damage
    if damage is None:
        raise UnknownDamage("DAMAGE_NULL", block)
    if damage == "???":
        raise UnknownDamage("DAMAGE_UNEXPLAINED", block)
    if isinstance(damage, bool) or not isinstance(damage, int) or damage < 0:
        raise UnknownDamage("DAMAGE_UNEXPLAINED", block)
    if block.enemy is None:
        raise UnknownDamage("ENEMY_INFO_MISSING", block)
    if hero_hp is not None and hero_hp - damage <= 0:
        raise UnknownDamage("DAMAGE_LETHAL", block)
    return CombatOutcome(
        hp_delta=-damage,
        gold_delta=block.enemy.gold,
        experience_delta=block.enemy.experience,
    )
