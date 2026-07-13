MotaLab.classifyPendingRecovery = function classifyPendingRecovery(pending, observation, fingerprint) {
  if (!pending || !MotaLab.validateActionId(pending.action_id)
    || typeof pending.pre_fingerprint !== "string") {
    return { phase: "mismatch", detail_code: "INVALID_PENDING_JOURNAL" };
  }
  if (fingerprint === pending.pre_fingerprint) {
    return {
      phase: "not_executed",
      pending_action_id: pending.action_id,
      pre_fingerprint: pending.pre_fingerprint,
      current_fingerprint: fingerprint,
      detail_code: pending.rejection_detail_code || null,
    };
  }
  if (!pending.pre_observation || !pending.expected_delta) {
    return { phase: "mismatch", detail_code: "RECOVERY_STATE_AMBIGUOUS" };
  }
  const declaredFields = pending.expected_delta
    && typeof pending.expected_delta === "object" && !Array.isArray(pending.expected_delta)
    ? Object.keys(pending.expected_delta) : [];
  if (declaredFields.length === 0) {
    return { phase: "mismatch", detail_code: "RECOVERY_STATE_AMBIGUOUS" };
  }
  let requiresNonPositionChange = pending.requires_non_position_change === true;
  if (pending.requires_non_position_change === undefined
    && Array.isArray(pending.operations) && pending.operations.length > 0) {
    const target = pending.operations[pending.operations.length - 1];
    const targetBlock = pending.pre_observation.blocks.find(
      (block) => block.x === target.x && block.y === target.y,
    );
    requiresNonPositionChange = Boolean(targetBlock
      && (targetBlock.trigger !== null || targetBlock.enemy !== null || targetBlock.damage !== null));
  }
  if (requiresNonPositionChange
    && !MotaLab.hasVerifiableNonPositionPostcondition(pending.expected_delta)) {
    return { phase: "mismatch", detail_code: "RECOVERY_STATE_AMBIGUOUS" };
  }
  let delta;
  try {
    delta = MotaLab.compareExpectedDelta(
      pending.pre_observation,
      observation,
      pending.expected_delta,
      {
        allowPositionChange: true,
        allowUnknownFloor: pending.allow_unknown_floor === true,
      },
    );
  } catch (error) {
    return { phase: "mismatch", detail_code: "RECOVERY_STATE_AMBIGUOUS", error: error.message };
  }
  if (delta.ok && requiresNonPositionChange
    && !MotaLab.stateChangedBeyondPosition(pending.pre_observation, observation)) {
    return {
      phase: "mismatch",
      detail_code: "RECOVERY_STATE_AMBIGUOUS",
      pending_action_id: pending.action_id,
      pre_fingerprint: pending.pre_fingerprint,
      current_fingerprint: fingerprint,
      differences: [{
        field: "boundary_state_change",
        expected: "non-position state change",
        actual: "position-only change",
      }],
    };
  }
  if (delta.ok) {
    return {
      phase: "completed",
      pending_action_id: pending.action_id,
      pre_fingerprint: pending.pre_fingerprint,
      current_fingerprint: fingerprint,
      delta,
    };
  }
  return {
    phase: "mismatch",
    detail_code: "RECOVERY_STATE_AMBIGUOUS",
    pending_action_id: pending.action_id,
    pre_fingerprint: pending.pre_fingerprint,
    current_fingerprint: fingerprint,
    differences: delta.differences,
  };
};
