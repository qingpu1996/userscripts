"""Ephemeral planner labels derived from the game's authoritative engine model."""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from typing import Dict, Mapping, Optional, Tuple

from .models import (
    BlockLabel, EngineFloorDefinition, ExpectedDelta, Observation, RegistryEntry,
)


_HERO_FIELDS = {
    "hp": "hp", "atk": "attack", "attack": "attack", "def": "defense",
    "defense": "defense", "money": "gold", "gold": "gold",
    "exp": "experience", "experience": "experience",
}
_ALLOWED_BINARY = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod)
_ALLOWED_UNARY = (ast.UAdd, ast.USub)
_ASSIGNMENT = re.compile(r"^(.+?)\s*(\+=|-=|\*=|/=|=)\s*(.+)$", re.S)
_POSTFIX = re.compile(r"^(.+?)(\+\+|--)$", re.S)
_ADD_ITEM = re.compile(
    r"^core\.addItem\(\s*(['\"])([^'\"]+)\1\s*,\s*(.+)\)$", re.S
)
_HERO_TARGET = re.compile(r"^(?:core\.status\.)?hero\.(hp|atk|attack|def|defense|money|gold|exp|experience)$")
_ITEM_TARGET = re.compile(
    r"^(?:core\.status\.)?hero\.items\.[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)$"
)
_REFERENCE = re.compile(
    r"core\.status\.hero\.(hp|atk|attack|def|defense|money|gold|exp|experience)"
    r"|hero\.(hp|atk|attack|def|defense|money|gold|exp|experience)"
    r"|core\.values\.([A-Za-z_$][\w$]*)"
    r"|(?:core\.status\.thisMap|floor)\.ratio"
)


class UnsupportedItemEffect(ValueError):
    pass


def _numeric_expression(source: str, observation: Observation, ratio: float) -> float:
    hero = observation.hero

    def replace(match: re.Match[str]) -> str:
        field = match.group(1) or match.group(2)
        if field is not None:
            return repr(getattr(hero, _HERO_FIELDS[field]))
        value_name = match.group(3)
        if value_name is not None:
            model = observation.engine_model
            value = None if model is None else model.values.get(value_name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise UnsupportedItemEffect(f"unknown core.values.{value_name}")
            return repr(value)
        return repr(ratio)

    translated = _REFERENCE.sub(replace, source.strip())
    try:
        tree = ast.parse(translated, mode="eval")
    except SyntaxError as exc:
        raise UnsupportedItemEffect("invalid numeric expression") from exc
    for node in ast.walk(tree):
        if isinstance(node, (ast.Expression, ast.Load, ast.Constant)):
            continue
        if isinstance(node, ast.BinOp) and isinstance(node.op, _ALLOWED_BINARY):
            continue
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, _ALLOWED_UNARY):
            continue
        if isinstance(node, _ALLOWED_BINARY + _ALLOWED_UNARY):
            continue
        raise UnsupportedItemEffect(f"unsupported expression node {type(node).__name__}")

    def calculate(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return calculate(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) \
                and not isinstance(node.value, bool):
            return node.value
        if isinstance(node, ast.UnaryOp):
            value = calculate(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp):
            left, right = calculate(node.left), calculate(node.right)
            if isinstance(node.op, ast.Add): return left + right
            if isinstance(node.op, ast.Sub): return left - right
            if isinstance(node.op, ast.Mult): return left * right
            if isinstance(node.op, ast.Div): return left / right
            if isinstance(node.op, ast.FloorDiv): return left // right
            if isinstance(node.op, ast.Mod): return left % right
        raise UnsupportedItemEffect("unsupported numeric expression")

    try:
        value = calculate(tree)
    except ArithmeticError as exc:
        raise UnsupportedItemEffect("invalid arithmetic result") from exc
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not float(value).is_integer():
        raise UnsupportedItemEffect("effect result is not an integer")
    return int(value)


def _key_color(item_id: str, observation: Observation) -> Optional[str]:
    if observation.engine_model is None:
        return None
    for color, slot in observation.engine_model.inventory.key_slots.items():
        if slot == item_id:
            return color
    return None


def _inventory_count(item_id: str, observation: Observation) -> int:
    if observation.engine_model is None:
        return 0
    return sum(items.get(item_id, 0) for items in observation.engine_model.inventory.classes.values())


def interpret_item_effect(effect: str, observation: Observation, ratio: float = 1) -> ExpectedDelta:
    """Interpret the small arithmetic subset used by ordinary pickup effects."""

    hero_delta: Dict[str, int] = {}
    inventory_delta: Dict[str, int] = {}
    key_delta: Dict[str, int] = {}
    hero_values = {name: getattr(observation.hero, name) for name in _HERO_FIELDS.values()}
    item_values: Dict[str, int] = {}

    def current_target(target: str) -> Tuple[str, str, int]:
        hero_match = _HERO_TARGET.fullmatch(target.strip())
        if hero_match:
            field = _HERO_FIELDS[hero_match.group(1)]
            return "hero", field, hero_values[field] + hero_delta.get(field, 0)
        item_match = _ITEM_TARGET.fullmatch(target.strip())
        if item_match:
            item_id = item_match.group(1)
            current = item_values.get(item_id, _inventory_count(item_id, observation))
            return "item", item_id, current
        raise UnsupportedItemEffect("unsupported assignment target")

    statements = [part.strip() for part in effect.split(";") if part.strip()]
    if not statements:
        raise UnsupportedItemEffect("empty item effect")
    for statement in statements:
        add_item = _ADD_ITEM.fullmatch(statement)
        if add_item:
            item_id = add_item.group(2)
            amount = _numeric_expression(add_item.group(3), observation, ratio)
            color = _key_color(item_id, observation)
            if color is not None:
                key_delta[color] = key_delta.get(color, 0) + amount
            else:
                inventory_delta[item_id] = inventory_delta.get(item_id, 0) + amount
            item_values[item_id] = _inventory_count(item_id, observation) + amount
            continue
        postfix = _POSTFIX.fullmatch(statement)
        if postfix:
            kind, name, current = current_target(postfix.group(1))
            new_value = current + (1 if postfix.group(2) == "++" else -1)
        else:
            assignment = _ASSIGNMENT.fullmatch(statement)
            if assignment is None:
                raise UnsupportedItemEffect("unsupported item effect statement")
            kind, name, current = current_target(assignment.group(1))
            right = _numeric_expression(assignment.group(3), observation, ratio)
            operator = assignment.group(2)
            new_value = {
                "=": right, "+=": current + right, "-=": current - right,
                "*=": current * right, "/=": current / right,
            }[operator]
            if not isinstance(new_value, (int, float)) or not float(new_value).is_integer():
                raise UnsupportedItemEffect("assignment result is not an integer")
            new_value = int(new_value)
        delta = new_value - current
        if kind == "hero":
            hero_delta[name] = hero_delta.get(name, 0) + delta
        else:
            color = _key_color(name, observation)
            if color is not None:
                key_delta[color] = key_delta.get(color, 0) + delta
            else:
                inventory_delta[name] = inventory_delta.get(name, 0) + delta
            item_values[name] = new_value
    payload: Dict[str, object] = dict(hero_delta)
    if key_delta: payload["keys"] = key_delta
    if inventory_delta: payload["inventory"] = inventory_delta
    return ExpectedDelta.model_validate(payload)


@dataclass(frozen=True)
class EngineAuthority:
    floor_known: bool
    labels: Mapping[tuple[str, str, Optional[str]], BlockLabel]
    catalog_hash: Optional[str]


def registry_entries(
    observation: Observation,
    labels: Mapping[tuple[str, str, Optional[str]], BlockLabel],
) -> list[RegistryEntry]:
    entries: Dict[tuple[str, str, Optional[str]], RegistryEntry] = {}
    for block in observation.blocks:
        identity = (block.id, block.cls, block.trigger)
        label = labels.get(identity)
        if label is None:
            continue
        entries[identity] = RegistryEntry(
            id=label.id, cls=label.cls, trigger=label.trigger, category=label.category,
            passable=label.passable, boundary=label.boundary, fast_path=label.fast_path,
            version=label.version,
        )
    return [entries[key] for key in sorted(entries, key=lambda item: (item[0], item[1], item[2] or ""))]


def derive_engine_authority(observation: Observation) -> EngineAuthority:
    model = observation.engine_model
    if model is None:
        return EngineAuthority(False, {}, None)
    floors = {floor.floor_id: floor for floor in model.floors}
    floor = floors.get(observation.floor_id)
    if floor is None:
        return EngineAuthority(False, {}, model.catalog_hash)
    if floor.width != observation.dimensions.width or floor.height != observation.dimensions.height:
        return EngineAuthority(False, {}, model.catalog_hash)
    definitions = {(item.numeric_id, item.id): item for item in model.blocks}
    items = {item.id: item for item in model.items}
    labels: Dict[tuple[str, str, Optional[str]], BlockLabel] = {}

    def label_for(block: object, block_floor: EngineFloorDefinition) -> BlockLabel:
        definition = definitions.get((block.numeric_id, block.id))
        trigger = block.trigger
        payload = dict(
            id=block.id, cls=block.cls, trigger=trigger, source="engine", version=1,
            fast_path=False,
        )
        expected: Optional[ExpectedDelta] = None
        if trigger == "battle" or getattr(block, "enemy", None) is not None \
                or str(block.cls).lower().startswith("enemy"):
            payload.update(category="enemy", passable=False, boundary=True, supported=True)
        elif trigger == "openDoor":
            costs = {} if definition is None or definition.door_info is None \
                else definition.door_info.keys
            keys: Dict[str, int] = {}
            unsupported = False
            for item_id, amount in costs.items():
                color = _key_color(item_id, observation)
                if color is None:
                    unsupported = True
                    break
                keys[color] = keys.get(color, 0) - amount
            if costs and not unsupported:
                expected = ExpectedDelta(keys=keys)
                payload.update(category="door", passable=False, boundary=True, supported=True,
                               expected_delta=expected)
            else:
                payload.update(category="mechanism", passable=False, boundary=True, supported=False)
        elif trigger == "changeFloor":
            destination = next(
                (item for item in block_floor.change_floor if item.x == block.x and item.y == block.y), None
            )
            delta = {"map_instance_id": None}
            if destination is not None and destination.floor_id is not None:
                delta["floor_id"] = destination.floor_id
            expected = ExpectedDelta.model_validate(delta)
            payload.update(category="stair", passable=False, boundary=True, supported=True,
                           expected_delta=expected)
        elif trigger == "getItem" or block.id in items:
            item = items.get(block.id)
            try:
                if item is None or item.complex:
                    raise UnsupportedItemEffect("complex or missing item definition")
                if item.cls != "items":
                    color = _key_color(item.id, observation)
                    expected = ExpectedDelta.model_validate(
                        {"keys": {color: 1}} if color is not None else {"inventory": {item.id: 1}}
                    )
                elif item.item_effect:
                    expected = interpret_item_effect(item.item_effect, observation, float(block_floor.ratio))
                else:
                    raise UnsupportedItemEffect("ordinary item has no effect")
                payload.update(category="resource", passable=False, boundary=True, supported=True,
                               expected_delta=expected)
            except UnsupportedItemEffect:
                payload.update(category="resource", passable=False, boundary=True, supported=False)
        elif trigger is None:
            passable = not block.no_pass
            payload.update(category="terrain" if passable else "wall", passable=passable,
                           boundary=False, supported=True, fast_path=passable)
        else:
            category = "npc" if "npc" in block.cls.lower() else "mechanism"
            payload.update(category=category, passable=False, boundary=True, supported=False)
        return BlockLabel.model_validate(payload)

    # Catalog semantics are global, while dynamic blocks and dimensions are
    # refreshed every request.  Current rich blocks are applied last so live
    # battle/trigger information wins over a sparse future-floor projection.
    for block_floor in model.floors:
        for block in block_floor.blocks:
            labels[(block.id, block.cls, block.trigger)] = label_for(block, block_floor)
    for block in observation.blocks:
        labels[(block.id, block.cls, block.trigger)] = label_for(block, floor)
    return EngineAuthority(True, labels, model.catalog_hash)
