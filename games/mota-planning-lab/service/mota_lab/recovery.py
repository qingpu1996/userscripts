"""Recovery protocol checks shared by the cycle service."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .models import Recovery
from .storage import ActionConflict, ActionRecord, Store, UnknownAction


@dataclass(frozen=True)
class RecoveryDirective:
    kind: str
    action: Optional[ActionRecord] = None
    detail_code: Optional[str] = None


def classify_recovery(
    store: Store,
    recovery: Optional[Recovery],
    current_fingerprint: str,
    completed_action_id: Optional[str],
) -> RecoveryDirective:
    if recovery is None:
        return RecoveryDirective("normal")
    if recovery.current_fingerprint is not None and recovery.current_fingerprint != current_fingerprint:
        raise ActionConflict("recovery current_fingerprint does not match observation")
    if recovery.phase == "none":
        return RecoveryDirective("normal")
    if recovery.phase == "mismatch":
        return RecoveryDirective(
            "mismatch",
            detail_code=recovery.detail_code or "RECOVERY_STATE_AMBIGUOUS",
        )
    if recovery.pending_action_id is None:
        raise ActionConflict("recovery phase requires pending_action_id")
    action = store.get_action(recovery.pending_action_id)
    if action is None:
        raise UnknownAction(recovery.pending_action_id)
    if recovery.pre_fingerprint is not None and recovery.pre_fingerprint != action.pre_fingerprint:
        raise ActionConflict("recovery pre_fingerprint does not match action ledger")
    if recovery.phase == "not_executed":
        if action.status != "issued":
            raise ActionConflict(f"action in status {action.status} cannot be retried")
        if current_fingerprint != action.pre_fingerprint:
            return RecoveryDirective("mismatch", action, "RECOVERY_STATE_AMBIGUOUS")
        return RecoveryDirective("replay", action)
    if recovery.phase == "pending":
        if current_fingerprint == action.pre_fingerprint:
            return RecoveryDirective("pending", action)
        return RecoveryDirective("mismatch", action, "RECOVERY_STATE_AMBIGUOUS")
    if recovery.phase == "completed":
        if completed_action_id != recovery.pending_action_id:
            raise ActionConflict("completed recovery requires matching completed_action_id")
        return RecoveryDirective("completed", action)
    raise ActionConflict("unsupported recovery phase")
