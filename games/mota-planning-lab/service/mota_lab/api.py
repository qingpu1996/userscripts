"""FastAPI localhost boundary and cycle coordinator."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .deltas import validate_expected_delta
from .guards import compare_guard
from .knowledge import KnowledgeError, KnowledgeRegistry
from .logging import DecisionLogger, EvidenceWriter
from .models import (
    CycleRequest,
    DecisionResponse,
    ErrorResponse,
    ExecuteResponse,
    ExpectedDelta,
    IdleResponse,
    PauseKind,
    PauseResponse,
    model_to_wire_dict,
)
from .planner import Planner
from .recovery import classify_recovery
from .state import canonical_json, observation_fingerprint
from .storage import LedgerError, Store


DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class Settings:
    state_dir: Path
    knowledge_dir: Path
    bundled_data_dir: Path
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES
    rate_limit_per_second: int = 50
    direct_mount_origin: Optional[str] = None

    def __post_init__(self) -> None:
        if self.max_body_bytes < 1:
            raise ValueError("max_body_bytes must be positive")
        if self.rate_limit_per_second < 0:
            raise ValueError("rate_limit_per_second cannot be negative")
        if self.direct_mount_origin not in (None, "https://h5mota.com"):
            raise ValueError("direct_mount_origin must be exactly https://h5mota.com")

    @classmethod
    def from_env(cls) -> "Settings":
        package_root = Path(__file__).resolve().parent.parent
        state_home = Path(
            os.environ.get(
                "MOTA_LAB_STATE_DIR",
                Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
                / "mota-planning-lab",
            )
        ).expanduser()
        knowledge_home = Path(
            os.environ.get(
                "MOTA_LAB_KNOWLEDGE_DIR",
                Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
                / "mota-planning-lab"
                / "knowledge",
            )
        ).expanduser()
        max_body = int(os.environ.get("MOTA_LAB_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES))
        rate_limit = int(os.environ.get("MOTA_LAB_RATE_LIMIT_PER_SECOND", "50"))
        if max_body < 1024:
            raise ValueError("MOTA_LAB_MAX_BODY_BYTES must be at least 1024")
        if rate_limit < 0:
            raise ValueError("MOTA_LAB_RATE_LIMIT_PER_SECOND cannot be negative")
        return cls(
            state_dir=state_home,
            knowledge_dir=knowledge_home,
            bundled_data_dir=package_root / "data",
            max_body_bytes=max_body,
            rate_limit_per_second=rate_limit,
        )

    @classmethod
    def for_directory(
        cls,
        directory: Path,
        *,
        max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
        rate_limit_per_second: int = 50,
    ) -> "Settings":
        package_root = Path(__file__).resolve().parent.parent
        directory = Path(directory)
        return cls(
            state_dir=directory / "state",
            knowledge_dir=directory / "knowledge",
            bundled_data_dir=package_root / "data",
            max_body_bytes=max_body_bytes,
            rate_limit_per_second=rate_limit_per_second,
        )

    @property
    def database_path(self) -> Path:
        return self.state_dir / "mota-lab.sqlite3"

    @property
    def log_path(self) -> Path:
        return self.state_dir / "decisions.jsonl"

    @property
    def labels_path(self) -> Path:
        return self.knowledge_dir / "block-labels.json"

    @property
    def floors_path(self) -> Path:
        return self.knowledge_dir / "floor-models.json"


class ServiceError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class FixedWindowRateLimiter:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self._window_started = time.monotonic()
        self._count = 0
        self._lock = Lock()

    def allow(self) -> bool:
        if self.limit == 0:
            return True
        now = time.monotonic()
        with self._lock:
            if now - self._window_started >= 1.0:
                self._window_started = now
                self._count = 0
            if self._count >= self.limit:
                return False
            self._count += 1
            return True


class CycleCoordinator:
    def __init__(self, settings: Settings) -> None:
        settings.state_dir.mkdir(parents=True, exist_ok=True)
        settings.knowledge_dir.mkdir(parents=True, exist_ok=True)
        self.store = Store(settings.database_path)
        self.knowledge = KnowledgeRegistry(
            settings.labels_path,
            settings.floors_path,
            bundled_labels_path=settings.bundled_data_dir / "block-labels.json",
            bundled_floors_path=settings.bundled_data_dir / "floor-models.json",
        )
        self.logger = DecisionLogger(settings.log_path)
        self.evidence = EvidenceWriter(settings.state_dir)
        self.planner = Planner()

    @staticmethod
    def _decision_key(
        observation_fp: str,
        knowledge_fp: str,
        *,
        mode: str,
        pending_action_id: Optional[str] = None,
    ) -> str:
        payload = {
            "observation": observation_fp,
            "knowledge": knowledge_fp,
            "mode": mode,
            "pending_action_id": pending_action_id,
        }
        return "sha256:" + hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()

    def _pause(
        self,
        request: CycleRequest,
        *,
        kind: PauseKind,
        detail_code: str,
        reason: str,
        details: Optional[Dict[str, Any]] = None,
        action: Optional[Dict[str, Any]] = None,
    ) -> PauseResponse:
        entries = self.knowledge.registry_entries(request.observation)
        path = self.evidence.write(
            pause_kind=kind,
            detail_code=detail_code,
            reason=reason,
            observation=request.observation,
            details=details,
            action=action,
        )
        return PauseResponse(
            status="pause",
            pause_kind=kind,
            detail_code=detail_code,
            reason=reason,
            details=details or {},
            evidence_path=str(path),
            registry_entries=entries,
        )

    def _log_response(self, request: CycleRequest, response: Dict[str, Any], event: str = "decision") -> None:
        self.logger.write(
            event,
            request.observation,
            status=response.get("status"),
            action_id=response.get("action_id"),
            supersedes_action_id=response.get("supersedes_action_id"),
            pause_kind=response.get("pause_kind"),
            detail_code=response.get("detail_code"),
            reason=response.get("reason"),
        )

    def _latest_replacement(self, action):
        seen = set()
        current = action
        while current.status == "superseded":
            if current.action_id in seen or current.replacement_action_id is None:
                raise ServiceError("LEDGER_CORRUPT", "invalid replacement action chain", 500)
            seen.add(current.action_id)
            replacement = self.store.get_action(current.replacement_action_id)
            if replacement is None:
                raise ServiceError("LEDGER_CORRUPT", "replacement action is missing", 500)
            current = replacement
        return current

    @staticmethod
    def _response_payload(response: DecisionResponse) -> Dict[str, Any]:
        return model_to_wire_dict(response)

    def _confirm_completed_action(self, request: CycleRequest, observation_fp: str) -> Optional[PauseResponse]:
        action_id = request.completed_action_id
        if action_id is None:
            return None
        record = self.store.get_action(action_id)
        if record is None:
            raise ServiceError("UNKNOWN_ACTION_ID", "completed_action_id is not in the ledger")
        if record.status == "completed":
            if record.post_fingerprint != observation_fp:
                raise ServiceError(
                    "ACTION_STATE_CONFLICT",
                    "completed action was previously acknowledged with another poststate",
                )
            return None
        if record.status != "issued":
            raise ServiceError(
                "ACTION_STATE_CONFLICT",
                f"action in status {record.status} cannot be completed",
            )
        pre = self.store.get_observation(record.pre_fingerprint)
        if pre is None:
            raise ServiceError("LEDGER_CORRUPT", "action pre-observation is missing", 500)
        expected = ExpectedDelta.model_validate(record.response["expected_delta"])
        validation = validate_expected_delta(
            pre,
            request.observation,
            expected,
            action_kind=record.response["action_kind"],
        )
        if not validation.matches:
            self.store.mark_mismatch(action_id, observation_fp)
            return self._pause(
                request,
                kind=PauseKind.EXPECTED_DELTA_MISMATCH,
                detail_code="RESOURCE_DELTA_MISMATCH",
                reason=f"行动 {action_id} 的真实结果与 expected_delta 不一致。",
                details={"differences": validation.differences, "actual_delta": validation.actual},
                action=record.response,
            )
        self.store.confirm_action_and_transition(
            action_id, observation_fp, pre, request.observation
        )
        self.logger.write(
            "action_completed",
            request.observation,
            status="completed",
            action_id=action_id,
            reason="浏览器回报的真实状态通过 expected_delta 校验。",
        )
        return None

    def cycle(self, request: CycleRequest) -> Dict[str, Any]:
        observation = request.observation
        if request.session.mode == "handoff_expected_guard":
            differences = compare_guard(request.session.expected_guard, observation)
            if differences:
                pause = self._pause(
                    request,
                    kind=PauseKind.GUARD_MISMATCH,
                    detail_code="HANDOFF_BASELINE_MISMATCH",
                    reason="当前运行态与接管 expected_guard 不一致。",
                    details={"differences": differences},
                )
                response = self._response_payload(pause)
                self._log_response(request, response)
                return response
        try:
            observation_fp, session_status = self.store.ingest_observation(
                observation,
                request.session.mode,
                request.session.expected_guard,
                confirm=request.session.command == "confirm",
            )
        except LedgerError as exc:
            raise ServiceError(exc.code, str(exc)) from exc
        if session_status != "confirmed":
            pause = self._pause(
                request,
                kind=PauseKind.SESSION_CONFIRMATION_REQUIRED,
                detail_code="SESSION_NOT_CONFIRMED",
                reason="首次 observation 已记录；必须显式 confirm 后才允许规划行动。",
                details={"session_id": observation.session_id, "mode": request.session.mode},
            )
            response = self._response_payload(pause)
            self._log_response(request, response)
            return response
        if observation.busy:
            pause = self._pause(
                request,
                kind=PauseKind.UNSUPPORTED_INTERACTION,
                detail_code="INTERACTION_ACTIVE",
                reason="游戏仍处于活动事件或控制锁定状态，当前交互尚未实现。",
            )
            response = self._response_payload(pause)
            self._log_response(request, response)
            return response
        completion_pause = self._confirm_completed_action(request, observation_fp)
        if completion_pause is not None:
            response = self._response_payload(completion_pause)
            self._log_response(request, response)
            return response
        if request.completed_action_id is not None:
            acknowledged = IdleResponse(
                status="idle",
                reason="已明确接收并结算 completed_action_id；下一轮再签发后续原子行动。",
                registry_entries=self.knowledge.registry_entries(observation),
                acknowledged_action_id=request.completed_action_id,
            )
            response = self._response_payload(acknowledged)
            self._log_response(request, response, "completed_action_acknowledged")
            return response

        try:
            unresolved = self.store.issued_action_for_session(observation.session_id)
        except LedgerError as exc:
            raise ServiceError(exc.code, str(exc)) from exc
        recovery_request = request.recovery
        if request.intent == "reconnect_only":
            if unresolved is not None:
                journal_action_id = None if recovery_request is None \
                    else recovery_request.pending_action_id
                if journal_action_id != unresolved.action_id:
                    detail_code = "RECOVERY_JOURNAL_LEDGER_MISMATCH"
                    reason = (
                        "仅重连请求未携带与服务端唯一未决行动一致的浏览器身份。"
                    )
                else:
                    detail_code = "RECONNECT_UNRESOLVED_ACTION"
                    reason = (
                        "仅重连已核对未决行动身份；为避免隐式执行，保持暂停并等待正常恢复循环。"
                    )
                paused = self._pause(
                    request,
                    kind=PauseKind.EXPECTED_DELTA_MISMATCH,
                    detail_code=detail_code,
                    reason=reason,
                    details={
                        "journal_action_id": journal_action_id,
                        "ledger_action_id": unresolved.action_id,
                        "ledger_pre_fingerprint": unresolved.pre_fingerprint,
                        "current_fingerprint": observation_fp,
                    },
                    action=unresolved.response,
                )
                response = self._response_payload(paused)
                self._log_response(request, response, "reconnect_only_unresolved")
                return response
            if recovery_request is not None and recovery_request.pending_action_id is not None:
                paused = self._pause(
                    request,
                    kind=PauseKind.EXPECTED_DELTA_MISMATCH,
                    detail_code="RECOVERY_JOURNAL_LEDGER_MISMATCH",
                    reason="浏览器携带 pending 身份，但服务端 ledger 没有对应未决行动。",
                    details={
                        "journal_action_id": recovery_request.pending_action_id,
                        "ledger_action_id": None,
                        "current_fingerprint": observation_fp,
                    },
                )
                response = self._response_payload(paused)
                self._log_response(request, response, "reconnect_only_identity_mismatch")
                return response
            idle = IdleResponse(
                status="idle",
                reason="localhost 已连接；仅重连观察模式不会签发或执行新行动。",
                registry_entries=self.knowledge.registry_entries(observation),
            )
            response = self._response_payload(idle)
            self._log_response(request, response, "reconnect_only_idle")
            return response
        if unresolved is not None:
            if recovery_request is None or recovery_request.phase == "none":
                if observation_fp == unresolved.pre_fingerprint:
                    self._log_response(request, unresolved.response, "unresolved_action_replayed")
                    return unresolved.response
                pause = self._pause(
                    request,
                    kind=PauseKind.EXPECTED_DELTA_MISMATCH,
                    detail_code="RECOVERY_JOURNAL_LEDGER_MISMATCH",
                    reason="服务端存在未决行动，但浏览器未携带匹配的 pending 身份。",
                    details={
                        "ledger_action_id": unresolved.action_id,
                        "ledger_pre_fingerprint": unresolved.pre_fingerprint,
                        "current_fingerprint": observation_fp,
                    },
                    action=unresolved.response,
                )
                response = self._response_payload(pause)
                self._log_response(request, response)
                return response
            if recovery_request.pending_action_id != unresolved.action_id:
                pause = self._pause(
                    request,
                    kind=PauseKind.EXPECTED_DELTA_MISMATCH,
                    detail_code="RECOVERY_JOURNAL_LEDGER_MISMATCH",
                    reason="浏览器 pending action_id 与服务端唯一未决行动不一致。",
                    details={
                        "journal_action_id": recovery_request.pending_action_id,
                        "ledger_action_id": unresolved.action_id,
                        "current_fingerprint": observation_fp,
                    },
                    action=unresolved.response,
                )
                response = self._response_payload(pause)
                self._log_response(request, response)
                return response

        try:
            recovery = classify_recovery(
                self.store,
                request.recovery,
                observation_fp,
                request.completed_action_id,
            )
        except LedgerError as exc:
            raise ServiceError(exc.code, str(exc)) from exc

        if recovery.kind == "mismatch":
            pause = self._pause(
                request,
                kind=PauseKind.EXPECTED_DELTA_MISMATCH,
                detail_code=recovery.detail_code or "RECOVERY_STATE_AMBIGUOUS",
                reason="刷新或丢包后的当前状态无法由行动账本安全解释。",
                details={
                    "pending_action_id": None if recovery.action is None else recovery.action.action_id,
                    "current_fingerprint": observation_fp,
                },
                action=None if recovery.action is None else recovery.action.response,
            )
            response = self._response_payload(pause)
            self._log_response(request, response)
            return response

        if recovery.kind == "pending":
            idle = IdleResponse(
                status="idle",
                reason="行动执行状态尚未确定；请先分类为 not_executed、completed 或 mismatch。",
                registry_entries=self.knowledge.registry_entries(observation),
            )
            response = self._response_payload(idle)
            self._log_response(request, response)
            return response

        if recovery.kind == "replay" and recovery.action is not None:
            self._log_response(request, recovery.action.response, "unresolved_action_replayed")
            return recovery.action.response

        knowledge_fp = self.knowledge.fingerprint()
        supersedes_action_id = None
        mode = "normal"
        decision_key = self._decision_key(
            observation_fp,
            knowledge_fp,
            mode=mode,
            pending_action_id=supersedes_action_id,
        )
        existing = self.store.get_decision(decision_key)
        if existing is not None:
            scan_before_replay = self.store.get_scan_state(observation.session_id)
            if (
                scan_before_replay is not None
                and scan_before_replay.get("phase") != "complete"
                and existing.get("status") == "execute"
                and not str(existing.get("action_kind", "")).startswith("SCAN_")
            ):
                raise ServiceError(
                    "SCAN_ACTION_CONFLICT",
                    "an older non-scan action is pending while takeover scan is active",
                    409,
                )
            if existing.get("status") == "execute":
                action = self.store.get_action(existing["action_id"])
                if action is None:
                    raise ServiceError("LEDGER_CORRUPT", "cached action is missing", 500)
                current = self._latest_replacement(action)
                if current.status != "completed":
                    self._log_response(request, current.response, "decision_replayed")
                    return current.response
                # A completed action may legitimately lead back to the exact
                # same observation later (for example a stair round-trip).
                # Continue planning so this visit receives a globally fresh
                # action id; Store.save_decision atomically refreshes this one
                # cache row instead of replaying the completed id.
            else:
                self._log_response(request, existing, "decision_replayed")
                return existing

        # A normal retry and an explicit not_executed recovery both replay the
        # byte-equivalent same action ID.  Protocol v2 never signs a replacement
        # while that session action remains unresolved.
        if supersedes_action_id is None:
            issued = self.store.issued_action_for_prestate(observation_fp)
            if issued is not None:
                self._log_response(request, issued.response, "decision_replayed")
                return issued.response

        entries = self.knowledge.registry_entries(observation)
        labels = self.knowledge.labels()
        frontier_coordinates = {
            (block.x, block.y)
            for block in observation.blocks
            if (label := labels.get((block.id, block.cls, block.trigger))) is None
            or label.boundary
        }
        self.store.sync_frontiers(observation, observation_fp, frontier_coordinates)
        if not self.knowledge.is_known_floor(observation.floor_id):
            pause = self._pause(
                request,
                kind=PauseKind.UNKNOWN_FLOOR,
                detail_code="FLOOR_MODEL_MISSING",
                reason=f"楼层 {observation.floor_id} 尚未建立模型。",
                details={"floor_id": observation.floor_id, "floor_name": observation.floor_name},
            )
            planned: DecisionResponse = pause
        else:
            unknown = self.knowledge.unknown_blocks(observation)
            if unknown:
                unknown_details = [
                    {
                        "x": block.x,
                        "y": block.y,
                        "numeric_id": block.numeric_id,
                        "id": block.id,
                        "cls": block.cls,
                        "trigger": block.trigger,
                        "damage": block.damage,
                    }
                    for block in unknown
                ]
                planned = self._pause(
                    request,
                    kind=PauseKind.NEW_OBJECT_OR_MECHANISM,
                    detail_code="UNKNOWN_BLOCK",
                    reason=f"当前层出现 {len(unknown)} 个尚未登记的 block 组合。",
                    details={"blocks": unknown_details},
                )
            else:
                world_context = {
                    "map_instances": self.store.map_instances_for_session(observation.session_id),
                    "observations": self.store.latest_map_observations(observation.session_id),
                    "transitions": self.store.transitions_for_session(observation.session_id),
                    "frontiers": self.store.frontiers_for_session(observation.session_id),
                }
                scan_state = self.store.get_scan_state(observation.session_id)
                if scan_state is None:
                    raise ServiceError(
                        "LEDGER_CORRUPT", "confirmed session has no takeover scan state", 500
                    )
                refreshed_scan = self.planner.refresh_scan_state(
                    observation, labels, world_context, scan_state
                )
                if any(
                    refreshed_scan.get(field) != scan_state.get(field)
                    for field in (
                        "phase", "current_map_instance_id", "scanned_map_instance_ids",
                        "pending_exits", "traversed_transitions", "reason",
                    )
                ):
                    scan_state = self.store.save_scan_state(
                        observation.session_id,
                        refreshed_scan,
                        event="scan_frontier_refreshed",
                    )
                planned = self.planner.plan(
                    observation,
                    labels,
                    action_id_factory=self.store.reserve_action_id,
                    registry_entries=entries,
                    supersedes_action_id=supersedes_action_id,
                    world_context=world_context,
                    scan_state=scan_state,
                )
                if getattr(planned, "scan_state", None) is None:
                    planned = planned.model_copy(update={
                        "scan_state": self.planner._scan_wire(
                            scan_state, len(world_context["frontiers"])
                        )
                    })
                if getattr(planned, "scan_state", None) is not None \
                        and planned.scan_state.phase == "paused":
                    paused_scan = dict(scan_state)
                    paused_scan["phase"] = "paused"
                    paused_scan["reason"] = planned.scan_state.reason
                    self.store.save_scan_state(
                        observation.session_id, paused_scan, event="scan_paused"
                    )
                if isinstance(planned, PauseResponse) and planned.evidence_path is None:
                    planned = self._pause(
                        request,
                        kind=planned.pause_kind,
                        detail_code=planned.detail_code,
                        reason=planned.reason,
                        details=planned.details,
                    )

        response = self._response_payload(planned)
        try:
            persisted = self.store.save_decision(
                decision_key=decision_key,
                observation_fingerprint=observation_fp,
                knowledge_fingerprint=knowledge_fp,
                response=response,
                supersedes_action_id=supersedes_action_id,
                replace_completed_decision=True,
            )
        except LedgerError as exc:
            raise ServiceError(exc.code, str(exc)) from exc
        self._log_response(request, persisted)
        return persisted


def _error(
    code: str,
    message: str,
    status_code: int,
    *,
    errors: Optional[list[Dict[str, Any]]] = None,
) -> JSONResponse:
    payload = ErrorResponse(
        status="error",
        error_code=code,
        reason=message,
        errors=[] if errors is None else errors,
    )
    return JSONResponse(
        status_code=status_code,
        content=model_to_wire_dict(payload),
    )


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or Settings.from_env()
    coordinator = CycleCoordinator(settings)
    rate_limiter = FixedWindowRateLimiter(settings.rate_limit_per_second)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    if settings.direct_mount_origin is not None:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[settings.direct_mount_origin],
            allow_methods=["POST"],
            allow_headers=["Content-Type", "X-Mota-Lab"],
            allow_credentials=False,
            expose_headers=[],
            max_age=600,
        )
    app.state.settings = settings
    app.state.coordinator = coordinator

    @app.post("/cycle")
    async def cycle_endpoint(request: Request):
        if request.headers.get("x-mota-lab") != "1":
            return _error("INVALID_HEADER", "X-Mota-Lab must equal 1", 400)
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            return _error("UNSUPPORTED_CONTENT_TYPE", "Content-Type must be application/json", 415)
        if not rate_limiter.allow():
            return _error("RATE_LIMITED", "local cycle request rate exceeded", 429)
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > settings.max_body_bytes:
                    return _error("REQUEST_TOO_LARGE", "request body exceeds configured limit", 413)
            except ValueError:
                return _error("INVALID_CONTENT_LENGTH", "Content-Length must be an integer", 400)
        chunks = []
        body_size = 0
        async for chunk in request.stream():
            body_size += len(chunk)
            if body_size > settings.max_body_bytes:
                return _error("REQUEST_TOO_LARGE", "request body exceeds configured limit", 413)
            chunks.append(chunk)
        body = b"".join(chunks)
        try:
            raw = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return _error("INVALID_JSON", "request body is not valid JSON", 400)
        try:
            cycle_request = CycleRequest.model_validate(raw)
        except ValidationError as exc:
            errors = [
                {"loc": list(item["loc"]), "type": item["type"], "msg": item["msg"]}
                for item in exc.errors(include_input=False, include_url=False)
            ]
            return _error(
                "SCHEMA_REJECTED",
                "request does not match protocol 2 schema",
                422,
                errors=errors,
            )
        try:
            return coordinator.cycle(cycle_request)
        except ServiceError as exc:
            return _error(exc.code, exc.message, exc.status_code)
        except KnowledgeError:
            return _error("KNOWLEDGE_STORE_ERROR", "knowledge store is invalid", 500)
        except Exception:
            LOGGER.exception("cycle processing failed")
            return _error("INTERNAL_ERROR", "local decision service failed safely", 500)

    return app
