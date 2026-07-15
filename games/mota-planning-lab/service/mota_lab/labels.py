"""Human-label workflow helpers used by the local CLI."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from .api import Settings
from .knowledge import KnowledgeRegistry
from .logging import EvidenceWriter
from .models import (
    BlockLabel,
    CycleRequest,
    ExpectedDelta,
    FloorModel,
    PauseKind,
    PauseResponse,
    block_label_execution_error,
)


class LabelCommandError(ValueError):
    pass


def registry_for_settings(settings: Settings) -> KnowledgeRegistry:
    return KnowledgeRegistry(
        settings.labels_path,
        settings.floors_path,
        bundled_labels_path=settings.bundled_data_dir / "block-labels.json",
        bundled_floors_path=settings.bundled_data_dir / "floor-models.json",
    )


def read_pause(path: Path) -> Dict[str, Any]:
    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise LabelCommandError(f"cannot read pause evidence: {exc}") from exc
    if not isinstance(payload, dict) or "observation" not in payload:
        raise LabelCommandError("pause evidence has no observation")
    return payload


def list_pauses(settings: Settings) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for path in EvidenceWriter(settings.state_dir).list_paths():
        payload = read_pause(path)
        rows.append(
            {
                "path": str(path),
                "pause_kind": payload.get("pause_kind"),
                "detail_code": payload.get("detail_code"),
                "floor_id": payload.get("observation", {}).get("floor_id"),
                "fingerprint": payload.get("fingerprint"),
            }
        )
    return rows


def apply_floor_from_pause(
    settings: Settings,
    pause_path: Path,
    *,
    name: Optional[str] = None,
) -> FloorModel:
    payload = read_pause(pause_path)
    observation = payload["observation"]
    floor_id = observation.get("floor_id")
    if not isinstance(floor_id, str) or not floor_id:
        raise LabelCommandError("pause observation has no valid floor_id")
    model = FloorModel(
        floor_id=floor_id,
        known=True,
        name=name if name is not None else observation.get("floor_name"),
        source="human",
        version=1,
    )
    return registry_for_settings(settings).apply_floor_model(model)


def apply_block_from_pause(
    settings: Settings,
    pause_path: Path,
    *,
    x: int,
    y: int,
    category: str,
    passable: bool,
    boundary: bool,
    fast_path: bool,
    supported: bool = True,
    expected_delta: Optional[Dict[str, Any]] = None,
) -> BlockLabel:
    payload = read_pause(pause_path)
    blocks = payload["observation"].get("blocks", [])
    matches = [block for block in blocks if block.get("x") == x and block.get("y") == y]
    if len(matches) != 1:
        raise LabelCommandError(f"expected exactly one evidence block at ({x},{y})")
    block = matches[0]
    parsed_delta = None if expected_delta is None else ExpectedDelta.model_validate(expected_delta)
    label = BlockLabel(
        id=block["id"],
        cls=block["cls"],
        trigger=block.get("trigger"),
        category=category,
        passable=passable,
        boundary=boundary,
        fast_path=fast_path,
        supported=supported,
        expected_delta=parsed_delta,
        source="human",
        version=1,
    )
    safety_error = block_label_execution_error(label)
    if safety_error is not None:
        raise LabelCommandError(safety_error)
    return registry_for_settings(settings).apply_block_label(label)


def create_evidence_from_request(
    settings: Settings,
    request_path: Path,
    *,
    pause_kind: str,
    detail_code: str,
    reason: str,
) -> Path:
    try:
        with Path(request_path).open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise LabelCommandError(f"cannot read request: {exc}") from exc
    request = CycleRequest.model_validate(raw)
    pause = PauseResponse(
        status="pause",
        pause_kind=PauseKind(pause_kind),
        detail_code=detail_code,
        reason=reason,
        details={},
    )
    return EvidenceWriter(settings.state_dir).write(
        pause_kind=pause.pause_kind,
        detail_code=pause.detail_code,
        reason=pause.reason,
        observation=request.observation,
        details={"created_by": "labels-cli"},
    )
