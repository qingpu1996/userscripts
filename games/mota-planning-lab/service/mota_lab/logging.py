"""Minimal JSONL decision audit log and structured pause evidence."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from threading import Lock, get_ident
from typing import Any, Dict, Optional

from .models import Observation, PauseKind, model_to_dict
from .state import observation_fingerprint


def _atomic_write(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{get_ident()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, sort_keys=True, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


class DecisionLogger:
    ALLOWED_KEYS = {
        "timestamp",
        "event",
        "observation_fingerprint",
        "floor_id",
        "position",
        "status",
        "action_id",
        "supersedes_action_id",
        "pause_kind",
        "detail_code",
        "reason",
    }

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def write(self, event: str, observation: Observation, **fields: object) -> None:
        record: Dict[str, object] = {
            "timestamp": int(time.time() * 1000),
            "event": event,
            "observation_fingerprint": observation_fingerprint(observation),
            "floor_id": observation.floor_id,
            "position": {"x": observation.hero.loc.x, "y": observation.hero.loc.y},
        }
        for key, value in fields.items():
            if key in self.ALLOWED_KEYS and value is not None:
                record[key] = value
        with self._lock:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
                handle.write("\n")


class EvidenceWriter:
    def __init__(self, state_dir: Path) -> None:
        self.pause_dir = Path(state_dir) / "pauses"

    def write(
        self,
        *,
        pause_kind: PauseKind,
        detail_code: str,
        reason: str,
        observation: Observation,
        details: Optional[Dict[str, Any]] = None,
        action: Optional[Dict[str, Any]] = None,
    ) -> Path:
        fingerprint = observation_fingerprint(observation)
        directory = self.pause_dir / f"{fingerprint[7:23]}-{pause_kind.value.lower()}-{detail_code.lower()}"
        path = directory / "pause.json"
        payload: Dict[str, Any] = {
            "protocol": 1,
            "created_at": int(time.time() * 1000),
            "pause_kind": pause_kind.value,
            "detail_code": detail_code,
            "reason": reason,
            "fingerprint": fingerprint,
            "observation": model_to_dict(observation),
            "details": details or {},
        }
        if action is not None:
            payload["action"] = action
        _atomic_write(path, payload)
        return path

    def list_paths(self) -> list[Path]:
        if not self.pause_dir.exists():
            return []
        return sorted(self.pause_dir.glob("*/pause.json"))
