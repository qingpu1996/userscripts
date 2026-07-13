"""Strict protocol and knowledge models.

The request models deliberately enumerate every accepted observation field.  They
must never grow a catch-all field: rejecting unexpected data is part of the
blind-play boundary, not merely input hygiene.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Set, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    conint,
    constr,
    model_validator,
)


NonNegativeInt = conint(strict=True, ge=0)
Coordinate = conint(strict=True, ge=0, le=255)
NonEmptyString = constr(strict=True, min_length=1, max_length=256)
ActionId = constr(strict=True, pattern=r"^AUTO-[A-F0-9]{16}$")
Fingerprint = constr(strict=True, pattern=r"^sha256:[a-f0-9]{64}$")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class PauseKind(str, Enum):
    NEW_OBJECT_OR_MECHANISM = "NEW_OBJECT_OR_MECHANISM"
    UNKNOWN_DAMAGE = "UNKNOWN_DAMAGE"
    UNKNOWN_FLOOR = "UNKNOWN_FLOOR"
    EXPECTED_DELTA_MISMATCH = "EXPECTED_DELTA_MISMATCH"
    GUARD_MISMATCH = "GUARD_MISMATCH"
    UNSUPPORTED_INTERACTION = "UNSUPPORTED_INTERACTION"
    DECISION_SERVICE_UNAVAILABLE = "DECISION_SERVICE_UNAVAILABLE"
    ENGINE_API_INCOMPATIBLE = "ENGINE_API_INCOMPATIBLE"
    SESSION_CONFIRMATION_REQUIRED = "SESSION_CONFIRMATION_REQUIRED"
    PLANNING_BUDGET_EXHAUSTED = "PLANNING_BUDGET_EXHAUSTED"


class Dimensions(StrictModel):
    width: conint(strict=True, ge=1, le=256)
    height: conint(strict=True, ge=1, le=256)

    @model_validator(mode="after")
    def bounded_area(self) -> "Dimensions":
        if self.width * self.height > 65536:
            raise ValueError("map area exceeds 65536 cells")
        return self


class Position(StrictModel):
    x: Coordinate
    y: Coordinate


class Location(Position):
    direction: Literal["up", "down", "left", "right"]


class Hero(StrictModel):
    hp: NonNegativeInt
    attack: NonNegativeInt
    defense: NonNegativeInt
    gold: NonNegativeInt
    experience: NonNegativeInt
    loc: Location


class Keys(StrictModel):
    yellow: NonNegativeInt
    blue: NonNegativeInt
    red: NonNegativeInt


class Enemy(StrictModel):
    hp: NonNegativeInt
    attack: Optional[NonNegativeInt]
    defense: Optional[NonNegativeInt]
    gold: NonNegativeInt
    experience: NonNegativeInt
    special: List[Union[StrictInt, StrictStr]] = Field(default_factory=list, max_length=64)


class Block(StrictModel):
    x: Coordinate
    y: Coordinate
    numeric_id: NonNegativeInt
    id: NonEmptyString
    cls: NonEmptyString
    trigger: Optional[constr(strict=True, max_length=128)]
    no_pass: StrictBool
    damage: Union[StrictInt, Literal["???"], None] = None
    enemy: Optional[Enemy] = None


class Topology(StrictModel):
    kind: Literal["rectangle", "valid_cells"]
    valid_cells: Optional[List[Position]] = Field(default=None, max_length=65536)
    source: Literal["engine_current_map", "runtime_observed"]
    confidence: Literal["confirmed", "inferred"]

    @model_validator(mode="before")
    @classmethod
    def reject_null_valid_cells(cls, value: Any) -> Any:
        if isinstance(value, dict) and "valid_cells" in value and value["valid_cells"] is None:
            raise ValueError("valid_cells may be omitted but cannot be null")
        return value

    @model_validator(mode="after")
    def validate_shape(self) -> "Topology":
        if self.kind == "rectangle" and self.valid_cells is not None:
            raise ValueError("rectangle topology must omit valid_cells")
        if self.kind == "valid_cells" and not self.valid_cells:
            raise ValueError("valid_cells topology requires at least one cell")
        if self.valid_cells is not None:
            cells = [(cell.x, cell.y) for cell in self.valid_cells]
            if len(cells) != len(set(cells)):
                raise ValueError("valid_cells must be unique")
        return self


class Observation(StrictModel):
    protocol: Literal[2]
    page: Literal["/games/24/"]
    session_id: constr(strict=True, min_length=1, max_length=128)
    floor_id: NonEmptyString
    floor_name: Optional[constr(strict=True, max_length=128)]
    floor_number: Optional[StrictInt]
    dimensions: Dimensions
    topology: Topology
    topology_fingerprint: Fingerprint
    map_instance_id: constr(strict=True, min_length=1, max_length=256)
    hero: Hero
    keys: Keys
    busy: StrictBool
    blocks: List[Block] = Field(max_length=8192)
    captured_at: NonNegativeInt

    @model_validator(mode="after")
    def unique_block_coordinates(self) -> "Observation":
        width, height = self.dimensions.width, self.dimensions.height
        coordinates_to_check = [(self.hero.loc.x, self.hero.loc.y)] + [
            (block.x, block.y) for block in self.blocks
        ]
        if self.topology.valid_cells is not None:
            coordinates_to_check += [(cell.x, cell.y) for cell in self.topology.valid_cells]
        for x, y in coordinates_to_check:
            if x >= width or y >= height:
                raise ValueError(f"coordinate ({x},{y}) is outside dimensions")
        coordinates = [(block.x, block.y) for block in self.blocks]
        if len(coordinates) != len(set(coordinates)):
            raise ValueError("blocks must have unique coordinates")
        if self.topology.valid_cells is not None:
            valid = {(cell.x, cell.y) for cell in self.topology.valid_cells}
            if (self.hero.loc.x, self.hero.loc.y) not in valid:
                raise ValueError("hero must be on a valid cell")
            if any(coordinate not in valid for coordinate in coordinates):
                raise ValueError("blocks must be on valid cells")
        return self


SessionMode = Literal["new_game", "handoff_expected_guard", "resume_existing_ledger"]


class Recovery(StrictModel):
    phase: Literal["none", "pending", "not_executed", "completed", "mismatch"] = "none"
    pending_action_id: Optional[ActionId] = None
    pre_fingerprint: Optional[Fingerprint] = None
    current_fingerprint: Optional[Fingerprint] = None
    detail_code: Optional[constr(strict=True, pattern=r"^[A-Z][A-Z0-9_]{2,95}$")] = None


class CycleRequest(StrictModel):
    source: Literal["mota-planning-lab-userscript"]
    intent: Literal["cycle", "reconnect_only"]
    completed_action_id: Optional[ActionId]
    observation: Observation
    recovery: Optional[Recovery] = None
    session: "SessionControl"

    @model_validator(mode="before")
    @classmethod
    def reject_null_recovery(cls, value: Any) -> Any:
        if isinstance(value, dict) and "recovery" in value and value["recovery"] is None:
            raise ValueError("recovery may be omitted but cannot be null")
        return value


class BlockRef(StrictModel):
    x: Coordinate
    y: Coordinate
    id: NonEmptyString
    cls: Optional[NonEmptyString] = None
    trigger: Optional[constr(strict=True, max_length=128)] = None
    numeric_id: Optional[NonNegativeInt] = None

    @model_validator(mode="before")
    @classmethod
    def reject_non_nullable_nulls(cls, value: Any) -> Any:
        if isinstance(value, dict):
            for field in ("cls", "numeric_id"):
                if field in value and value[field] is None:
                    raise ValueError(f"{field} may be omitted but cannot be null")
        return value


class KeyDelta(StrictModel):
    yellow: Optional[StrictInt] = None
    blue: Optional[StrictInt] = None
    red: Optional[StrictInt] = None

    @model_validator(mode="before")
    @classmethod
    def reject_explicit_nulls(cls, value: Any) -> Any:
        if isinstance(value, dict):
            for field in ("yellow", "blue", "red"):
                if field in value and value[field] is None:
                    raise ValueError(f"{field} may be omitted but cannot be null")
        return value


class ExpectedDelta(StrictModel):
    hp: Optional[StrictInt] = None
    attack: Optional[StrictInt] = None
    defense: Optional[StrictInt] = None
    gold: Optional[StrictInt] = None
    experience: Optional[StrictInt] = None
    keys: Optional[KeyDelta] = None
    position: Optional[Position] = None
    floor_id: Optional[NonEmptyString] = None
    map_instance_id: Optional[constr(strict=True, min_length=1, max_length=256)] = None
    removed_blocks: Optional[List[BlockRef]] = Field(default=None, max_length=8192)
    added_blocks: Optional[List[BlockRef]] = Field(default=None, max_length=8192)

    @model_validator(mode="before")
    @classmethod
    def reject_non_nullable_nulls(cls, value: Any) -> Any:
        if isinstance(value, dict):
            for field in (
                "hp",
                "attack",
                "defense",
                "gold",
                "experience",
                "keys",
                "position",
                "removed_blocks",
                "added_blocks",
            ):
                if field in value and value[field] is None:
                    raise ValueError(f"{field} may be omitted but cannot be null")
        return value

    @model_validator(mode="after")
    def map_transition_does_not_compare_foreign_blocks(self) -> "ExpectedDelta":
        if "map_instance_id" in self.model_fields_set and (
            "removed_blocks" in self.model_fields_set or "added_blocks" in self.model_fields_set
        ):
            raise ValueError("map transition cannot compare blocks from different instances")
        return self


class BlockLabel(StrictModel):
    id: NonEmptyString
    cls: NonEmptyString
    trigger: Optional[constr(strict=True, max_length=128)]
    category: Literal[
        "terrain",
        "wall",
        "door",
        "resource",
        "enemy",
        "npc",
        "mechanism",
        "stair",
        "other",
    ]
    passable: StrictBool
    boundary: StrictBool
    fast_path: StrictBool
    supported: StrictBool = True
    expected_delta: Optional[ExpectedDelta] = None
    source: Literal["human", "bundled", "observed"] = "human"
    version: conint(strict=True, ge=1) = 1

    @property
    def identity(self) -> tuple[str, str, Optional[str]]:
        return (self.id, self.cls, self.trigger)


def expected_delta_has_verifiable_non_position_postcondition(
    expected_delta: ExpectedDelta,
) -> bool:
    payload = expected_delta.model_dump(mode="json", exclude_unset=True)
    for field in ("hp", "attack", "defense", "gold", "experience"):
        if payload.get(field, 0) != 0:
            return True
    key_deltas = payload.get("keys") or {}
    if any(key_deltas.get(color, 0) != 0 for color in ("yellow", "blue", "red")):
        return True
    if "floor_id" in payload:
        return True
    if "map_instance_id" in payload:
        return True
    return any(payload.get(field) for field in ("removed_blocks", "added_blocks"))


def block_label_execution_error(label: BlockLabel) -> Optional[str]:
    if not label.boundary or not label.supported:
        return None
    if label.fast_path:
        return "boundary labels cannot enable fast_path"
    if label.category in {"enemy", "stair"}:
        return None
    if label.category in {"door", "resource"}:
        if label.expected_delta is None:
            return f"supported {label.category} boundary requires expected_delta"
        return None
    if label.expected_delta is None or not expected_delta_has_verifiable_non_position_postcondition(
        label.expected_delta
    ):
        return (
            f"supported {label.category} boundary requires a verifiable non-position "
            "postcondition"
        )
    return None


class FloorModel(StrictModel):
    floor_id: NonEmptyString
    known: Literal[True]
    name: Optional[constr(strict=True, max_length=128)] = None
    source: Literal["human", "observed"] = "human"
    version: conint(strict=True, ge=1) = 1


class BlockLabelsFile(StrictModel):
    protocol: Literal[1]
    labels: List[BlockLabel]

    @model_validator(mode="after")
    def unique_labels(self) -> "BlockLabelsFile":
        identities = [label.identity for label in self.labels]
        if len(identities) != len(set(identities)):
            raise ValueError("block label identities must be unique")
        return self


class FloorModelsFile(StrictModel):
    protocol: Literal[1]
    floors: List[FloorModel]

    @model_validator(mode="after")
    def unique_floors(self) -> "FloorModelsFile":
        floor_ids = [floor.floor_id for floor in self.floors]
        if len(floor_ids) != len(set(floor_ids)):
            raise ValueError("floor ids must be unique")
        return self


class GridOperation(StrictModel):
    type: Literal["grid"]
    x: Coordinate
    y: Coordinate


class RegistryEntry(StrictModel):
    id: NonEmptyString
    cls: NonEmptyString
    trigger: Optional[constr(strict=True, max_length=128)]
    category: Literal[
        "terrain",
        "wall",
        "door",
        "resource",
        "enemy",
        "npc",
        "mechanism",
        "stair",
        "other",
    ]
    passable: StrictBool
    boundary: StrictBool
    fast_path: StrictBool
    version: conint(strict=True, ge=1)


class Guard(StrictModel):
    session_id: constr(strict=True, min_length=1, max_length=128)
    map_instance_id: constr(strict=True, min_length=1, max_length=256)
    dimensions: Dimensions
    topology_fingerprint: Fingerprint
    floor_id: NonEmptyString
    floor: Optional[StrictInt]
    position: Location
    hp: NonNegativeInt
    attack: NonNegativeInt
    defense: NonNegativeInt
    gold: NonNegativeInt
    experience: NonNegativeInt
    keys: Keys


class SessionControl(StrictModel):
    mode: SessionMode
    command: Literal["observe", "confirm"] = "observe"
    expected_guard: Optional[Guard] = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_expected_guard(cls, value: Any) -> Any:
        if isinstance(value, dict) and "expected_guard" in value and value["expected_guard"] is None:
            raise ValueError("expected_guard may be omitted but cannot be null")
        return value

    @model_validator(mode="after")
    def mode_contract(self) -> "SessionControl":
        if self.mode == "handoff_expected_guard" and self.expected_guard is None:
            raise ValueError("handoff_expected_guard requires expected_guard")
        if self.mode != "handoff_expected_guard" and self.expected_guard is not None:
            raise ValueError("expected_guard is only valid for handoff_expected_guard")
        return self


class ScanStateWire(StrictModel):
    phase: Literal["anchor", "discover", "sweep", "complete", "paused"]
    anchor_map_instance_id: constr(strict=True, min_length=1, max_length=256)
    current_map_instance_id: constr(strict=True, min_length=1, max_length=256)
    scanned_map_instance_ids: List[constr(strict=True, min_length=1, max_length=256)] = Field(
        max_length=65536
    )
    pending_transition_count: NonNegativeInt
    traversed_transition_count: NonNegativeInt
    frontier_count: NonNegativeInt
    reason: constr(strict=True, min_length=1, max_length=512)

    @model_validator(mode="after")
    def unique_scanned_instances(self) -> "ScanStateWire":
        if len(self.scanned_map_instance_ids) != len(set(self.scanned_map_instance_ids)):
            raise ValueError("scanned map instances must be unique")
        if self.current_map_instance_id not in self.scanned_map_instance_ids:
            raise ValueError("current map instance must be scanned")
        return self


class ExecuteResponse(StrictModel):
    status: Literal["execute"]
    action_id: ActionId
    action_kind: constr(strict=True, pattern=r"^[A-Z][A-Z0-9_]{2,63}$")
    operations: List[GridOperation] = Field(min_length=1, max_length=2)
    guard: Guard
    expected_delta: ExpectedDelta
    reason: constr(strict=True, min_length=1, max_length=512)
    supersedes_action_id: Optional[ActionId] = None
    registry_entries: List[RegistryEntry] = Field(default_factory=list, max_length=8192)
    scan_state: Optional[ScanStateWire] = None
    acknowledged_action_id: Optional[ActionId] = None

    @model_validator(mode="before")
    @classmethod
    def reject_explicit_null_scan_state(cls, value: Any) -> Any:
        if isinstance(value, dict):
            if "scan_state" in value and value["scan_state"] is None:
                raise ValueError("scan_state may be omitted but cannot be null")
            if "acknowledged_action_id" in value and value["acknowledged_action_id"] is None:
                raise ValueError("acknowledged_action_id may be omitted but cannot be null")
        return value

    @model_validator(mode="after")
    def expected_delta_must_declare_a_postcondition(self) -> "ExecuteResponse":
        if not self.expected_delta.model_fields_set:
            raise ValueError("execute expected_delta must declare at least one postcondition")
        for operation in self.operations:
            if operation.x >= self.guard.dimensions.width or operation.y >= self.guard.dimensions.height:
                raise ValueError("operation coordinate is outside guard dimensions")
        return self


class PauseResponse(StrictModel):
    status: Literal["pause"]
    pause_kind: PauseKind
    detail_code: constr(strict=True, pattern=r"^[A-Z][A-Z0-9_]{2,95}$")
    reason: constr(strict=True, min_length=1, max_length=512)
    details: Dict[str, Any]
    evidence_path: Optional[StrictStr] = None
    registry_entries: List[RegistryEntry] = Field(default_factory=list, max_length=8192)
    scan_state: Optional[ScanStateWire] = None
    acknowledged_action_id: Optional[ActionId] = None

    @model_validator(mode="before")
    @classmethod
    def reject_explicit_null_optionals(cls, value: Any) -> Any:
        if isinstance(value, dict) and "evidence_path" in value and value["evidence_path"] is None:
            raise ValueError("evidence_path may be omitted but cannot be null")
        if isinstance(value, dict) and "scan_state" in value and value["scan_state"] is None:
            raise ValueError("scan_state may be omitted but cannot be null")
        if isinstance(value, dict) and "acknowledged_action_id" in value \
                and value["acknowledged_action_id"] is None:
            raise ValueError("acknowledged_action_id may be omitted but cannot be null")
        return value


class IdleResponse(StrictModel):
    status: Literal["idle"]
    reason: constr(strict=True, min_length=1, max_length=512)
    registry_entries: List[RegistryEntry] = Field(default_factory=list, max_length=8192)
    scan_state: Optional[ScanStateWire] = None
    acknowledged_action_id: Optional[ActionId] = None

    @model_validator(mode="before")
    @classmethod
    def reject_explicit_null_scan_state(cls, value: Any) -> Any:
        if isinstance(value, dict) and "scan_state" in value and value["scan_state"] is None:
            raise ValueError("scan_state may be omitted but cannot be null")
        if isinstance(value, dict) and "acknowledged_action_id" in value \
                and value["acknowledged_action_id"] is None:
            raise ValueError("acknowledged_action_id may be omitted but cannot be null")
        return value


class ErrorResponse(StrictModel):
    status: Literal["error"]
    error_code: constr(strict=True, min_length=1, max_length=128)
    reason: constr(strict=True, max_length=1000)
    errors: List[Dict[str, Any]] = Field(default_factory=list)
    acknowledged_action_id: Optional[ActionId] = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_acknowledgement(cls, value: Any) -> Any:
        if isinstance(value, dict) and "acknowledged_action_id" in value \
                and value["acknowledged_action_id"] is None:
            raise ValueError("acknowledged_action_id may be omitted but cannot be null")
        return value


DecisionResponse = Union[ExecuteResponse, PauseResponse, IdleResponse, ErrorResponse]

CycleRequest.model_rebuild()


NUMERIC_HERO_FIELDS: Set[str] = {"hp", "attack", "defense", "gold", "experience"}


def model_to_dict(model: BaseModel, *, exclude_none: bool = False) -> Dict[str, Any]:
    return model.model_dump(mode="json", exclude_none=exclude_none)


def model_to_wire_dict(model: BaseModel) -> Dict[str, Any]:
    """Serialize protocol/knowledge models without deleting required nulls.

    ``exclude_none`` is unsafe for Protocol v2 because Pydantic uses a required
    ``Optional`` field for values that must be present and may explicitly be
    null (for example ``Guard.floor`` and ``RegistryEntry.trigger``).
    ``exclude_unset`` is field-aware: it retains every value supplied for a
    required or explicitly-set nullable field while omitting only optional
    fields that were genuinely absent from the model input.
    """

    return model.model_dump(mode="json", exclude_unset=True)
