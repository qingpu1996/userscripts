"""Auditable floor/block knowledge stored outside the source tree at runtime."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from threading import RLock, get_ident
from typing import Dict, List, Optional, Tuple

from pydantic import ValidationError

from .models import (
    Block,
    BlockLabel,
    BlockLabelsFile,
    FloorModel,
    FloorModelsFile,
    Observation,
    RegistryEntry,
    block_label_execution_error,
    model_to_wire_dict,
)
from .state import canonical_json


class KnowledgeError(RuntimeError):
    pass


def _read_json(path: Path) -> object:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise KnowledgeError(f"cannot read knowledge file {path}: {exc}") from exc


def _atomic_json_write(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{get_ident()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, sort_keys=True, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


class KnowledgeRegistry:
    def __init__(
        self,
        labels_path: Path,
        floors_path: Path,
        *,
        bundled_labels_path: Optional[Path] = None,
        bundled_floors_path: Optional[Path] = None,
    ) -> None:
        self.labels_path = Path(labels_path)
        self.floors_path = Path(floors_path)
        self.bundled_labels_path = bundled_labels_path
        self.bundled_floors_path = bundled_floors_path
        self._lock = RLock()
        self._bootstrap()

    @classmethod
    def from_bundled_read_only(
        cls,
        labels_path: Path,
        floors_path: Path,
    ) -> "KnowledgeRegistry":
        """Load packaged rules once without creating or mutating any path.

        Production uses this constructor.  The regular constructor remains for
        explicit offline label-authoring commands and tests only.
        """
        instance = cls.__new__(cls)
        instance.labels_path = Path(labels_path)
        instance.floors_path = Path(floors_path)
        instance.bundled_labels_path = None
        instance.bundled_floors_path = None
        instance._lock = RLock()
        try:
            instance._memory_labels = BlockLabelsFile.model_validate(
                _read_json(instance.labels_path)
            )
            instance._memory_floors = FloorModelsFile.model_validate(
                _read_json(instance.floors_path)
            )
        except ValidationError as exc:
            raise KnowledgeError(f"invalid bundled knowledge: {exc}") from exc
        instance._read_only = True
        return instance

    def _bootstrap(self) -> None:
        self._read_only = False
        self._memory_labels = None
        self._memory_floors = None
        self.labels_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.labels_path.exists():
            payload = (
                _read_json(self.bundled_labels_path)
                if self.bundled_labels_path is not None
                else {"protocol": 1, "labels": []}
            )
            _atomic_json_write(self.labels_path, payload)
        if not self.floors_path.exists():
            payload = (
                _read_json(self.bundled_floors_path)
                if self.bundled_floors_path is not None
                else {"protocol": 1, "floors": []}
            )
            _atomic_json_write(self.floors_path, payload)
        # Fail closed on malformed knowledge.
        self._load_labels()
        self._load_floors()

    def _load_labels(self) -> BlockLabelsFile:
        if self._read_only:
            return self._memory_labels
        try:
            return BlockLabelsFile.model_validate(_read_json(self.labels_path))
        except ValidationError as exc:
            raise KnowledgeError(f"invalid block labels: {exc}") from exc

    def _load_floors(self) -> FloorModelsFile:
        if self._read_only:
            return self._memory_floors
        try:
            return FloorModelsFile.model_validate(_read_json(self.floors_path))
        except ValidationError as exc:
            raise KnowledgeError(f"invalid floor models: {exc}") from exc

    def labels(self) -> Dict[Tuple[str, str, Optional[str]], BlockLabel]:
        with self._lock:
            return {label.identity: label for label in self._load_labels().labels}

    def floors(self) -> Dict[str, FloorModel]:
        with self._lock:
            return {floor.floor_id: floor for floor in self._load_floors().floors}

    def is_known_floor(self, floor_id: str) -> bool:
        return floor_id in self.floors()

    def label_for(self, block: Block) -> Optional[BlockLabel]:
        return self.labels().get((block.id, block.cls, block.trigger))

    def unknown_blocks(self, observation: Observation) -> List[Block]:
        labels = self.labels()
        return [
            block
            for block in observation.blocks
            if (block.id, block.cls, block.trigger) not in labels
        ]

    def registry_entries(self, observation: Observation) -> List[RegistryEntry]:
        labels = self.labels()
        entries: Dict[Tuple[str, str, Optional[str]], RegistryEntry] = {}
        for block in observation.blocks:
            identity = (block.id, block.cls, block.trigger)
            label = labels.get(identity)
            if label is None:
                continue
            entries[identity] = RegistryEntry(
                id=label.id,
                cls=label.cls,
                trigger=label.trigger,
                category=label.category,
                passable=label.passable,
                boundary=label.boundary,
                fast_path=label.fast_path,
                version=label.version,
            )
        return [entries[key] for key in sorted(entries, key=lambda item: (item[0], item[1], item[2] or ""))]

    def fingerprint(self) -> str:
        with self._lock:
            payload = {
                "labels": self._load_labels().model_dump(mode="json"),
                "floors": self._load_floors().model_dump(mode="json"),
            }
        return "sha256:" + hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()

    def apply_block_label(self, label: BlockLabel) -> BlockLabel:
        if self._read_only:
            raise KnowledgeError("bundled knowledge is read-only")
        safety_error = block_label_execution_error(label)
        if safety_error is not None:
            raise KnowledgeError(safety_error)
        with self._lock:
            labels_file = self._load_labels()
            labels = {existing.identity: existing for existing in labels_file.labels}
            existing = labels.get(label.identity)
            if existing is not None:
                old_payload = existing.model_dump(mode="json", exclude={"version"})
                new_payload = label.model_dump(mode="json", exclude={"version"})
                if old_payload == new_payload:
                    label = existing
                elif label.version <= existing.version:
                    label = label.model_copy(update={"version": existing.version + 1})
            labels[label.identity] = label
            ordered = [labels[key] for key in sorted(labels, key=lambda item: (item[0], item[1], item[2] or ""))]
            validated = BlockLabelsFile(protocol=1, labels=ordered)
            _atomic_json_write(
                self.labels_path,
                model_to_wire_dict(validated),
            )
            return label

    def apply_floor_model(self, floor: FloorModel) -> FloorModel:
        if self._read_only:
            raise KnowledgeError("bundled knowledge is read-only")
        with self._lock:
            floors_file = self._load_floors()
            floors = {existing.floor_id: existing for existing in floors_file.floors}
            existing = floors.get(floor.floor_id)
            if existing is not None:
                old_payload = existing.model_dump(mode="json", exclude={"version"})
                new_payload = floor.model_dump(mode="json", exclude={"version"})
                if old_payload == new_payload:
                    floor = existing
                elif floor.version <= existing.version:
                    floor = floor.model_copy(update={"version": existing.version + 1})
            floors[floor.floor_id] = floor
            ordered = [floors[key] for key in sorted(floors)]
            validated = FloorModelsFile(protocol=1, floors=ordered)
            _atomic_json_write(self.floors_path, model_to_wire_dict(validated))
            return floor
