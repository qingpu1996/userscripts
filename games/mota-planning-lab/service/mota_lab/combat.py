"""Combat truth handling.

The service never recomputes engine combat from hidden enemy tables.  The
current observation's ``damage`` field is the only combat-loss truth used.
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
