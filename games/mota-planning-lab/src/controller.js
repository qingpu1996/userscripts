MotaLab.createController = function createController(dependencies, options = {}) {
  const { adapter, journal, registry, client, panel } = dependencies;
  const observe = dependencies.observe || (() => MotaLab.collectObservation(adapter));
  const logger = dependencies.logger || console;
  const autoSchedule = options.autoSchedule === true;
  const cycleDelayMs = MotaLab.isFiniteInteger(options.cycleDelayMs) ? options.cycleDelayMs : 300;
  const schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
  let state = "STOPPED";
  let currentObservation = null;
  let currentActionId = null;
  let lastReason = "等待首次现场核对";
  let cyclePromise = null;
  let unsafeResponseCount = 0;
  let duplicatePendingCount = 0;

  function locationText(observation) {
    return observation
      ? `${observation.floor_name || observation.floor_id} (${observation.hero.loc.x},${observation.hero.loc.y})`
      : "—";
  }

  function refreshPanel(extra = {}) {
    const snapshot = journal.snapshot();
    panel.update(Object.assign({
      autopilot: snapshot.autopilot_enabled,
      action_id: currentActionId,
      location: locationText(currentObservation),
      reason: lastReason,
      connected: client.isConnected(),
      pause_kind: snapshot.last_pause && !snapshot.autopilot_enabled
        ? snapshot.last_pause.pause_kind : null,
    }, extra));
  }

  function capture() {
    try {
      currentObservation = observe();
      refreshPanel();
      return currentObservation;
    } catch (error) {
      if (error && error.observation) {
        currentObservation = error.observation;
        refreshPanel();
      }
      throw error;
    }
  }

  function pause(pauseKind, detailCode, details = {}, observation = currentObservation) {
    try { adapter.stopAutomaticRoute(); } catch (_) { /* best-effort stop while the runtime is unavailable */ }
    const evidenceBlocks = [];
    if (details.block) evidenceBlocks.push(details.block);
    if (Array.isArray(details.blocks)) evidenceBlocks.push(...details.blocks);
    const record = {
      pause_kind: pauseKind,
      detail_code: detailCode || null,
      action_id: currentActionId,
      captured_at: Date.now(),
      observation: observation ? MotaLab.cloneObservationForWire(observation) : null,
      block_evidence: evidenceBlocks,
      details: MotaLab.cloneJsonValue(details),
    };
    journal.setPause(record);
    state = "PAUSED";
    lastReason = detailCode || pauseKind;
    refreshPanel({ autopilot: false, pause_kind: pauseKind });
    logger.error("[Mota Planning Lab pause]", record);
    return record;
  }

  function handleError(error, fallbackKind = "ENGINE_API_INCOMPATIBLE", fallbackCode = "UNEXPECTED_ERROR") {
    if (MotaLab.isPauseError(error)) {
      return pause(
        error.pause_kind,
        error.detail_code,
        error.details || {},
        error.observation || currentObservation,
      );
    }
    return pause(fallbackKind, fallbackCode, { message: error && error.message ? error.message : String(error) });
  }

  function validateAndReplaceRegistry(entries, observation) {
    const currentSignatures = new Set(observation.blocks.map(MotaLab.blockSignature));
    const unrelated = entries.filter((entry) => !currentSignatures.has(MotaLab.blockSignature(entry)));
    if (unrelated.length) {
      throw MotaLab.createPauseError(
        "DECISION_SERVICE_UNAVAILABLE",
        "REGISTRY_SCOPE_VIOLATION",
        { signatures: unrelated.map(MotaLab.blockSignature) },
      );
    }
    registry.replace(entries);
    journal.setRegistryEntries(registry.exportEntries());
  }

  function scheduleNext(delay = cycleDelayMs) {
    if (!autoSchedule || !journal.snapshot().autopilot_enabled) return;
    schedule(() => { runSingleCycle(); }, delay);
  }

  async function initialize() {
    try {
      state = "PREFLIGHT";
      const observation = capture();
      const fingerprint = MotaLab.fingerprintObservation(observation);
      const snapshot = journal.snapshot();
      if (!snapshot.initial_baseline_verified_fingerprint) {
        const baseline = MotaLab.compareInitialBaseline(observation);
        if (!baseline.ok) {
          return pause(
            "GUARD_MISMATCH",
            "INITIAL_BASELINE_MISMATCH",
            { differences: baseline.differences },
            observation,
          );
        }
        adapter.assertRequiredCapabilities();
        journal.verifyBaseline(fingerprint);
        journal.setAutopilot(false);
        state = "BASELINE_VERIFIED";
        lastReason = "现场核对通过，等待手动启动";
        refreshPanel({ autopilot: false, pause_kind: null });
        return { verified: true, fingerprint, auto_started: false };
      }
      adapter.assertRequiredCapabilities();
      state = "STOPPED";
      lastReason = "已恢复现场，等待或恢复安全循环";
      refreshPanel();
      if (snapshot.autopilot_enabled) scheduleNext(0);
      return { verified: true, fingerprint, auto_started: snapshot.autopilot_enabled };
    } catch (error) {
      return handleError(error);
    }
  }

  async function start() {
    const snapshot = journal.snapshot();
    if (!snapshot.initial_baseline_verified_fingerprint) {
      const result = await initialize();
      if (!result || !result.verified) return result;
    }
    journal.setAutopilot(true);
    state = "OBSERVING";
    lastReason = "用户已启动自动驾驶";
    refreshPanel({ autopilot: true, pause_kind: null });
    return runSingleCycle();
  }

  function manualPause() {
    try { adapter.stopAutomaticRoute(); } catch (_) { /* best-effort stop */ }
    journal.setAutopilot(false);
    state = "STOPPED";
    lastReason = "用户手动暂停";
    refreshPanel({ autopilot: false, pause_kind: null });
    return { stopped: true };
  }

  function clearPending() {
    if (journal.snapshot().autopilot_enabled || cyclePromise || state === "EXECUTING") {
      lastReason = "请先暂停自动驾驶，待当前执行结算后再清除 pending";
      refreshPanel();
      return { cleared: false, reason: "AUTOPILOT_ACTIVE" };
    }
    journal.clearPending();
    currentActionId = null;
    lastReason = "待执行行动已清除；游戏现场未改变";
    refreshPanel();
    return { cleared: true };
  }

  function requestRecovery(snapshot, fingerprint) {
    const pending = snapshot.pending_action;
    if (!pending) {
      return {
        phase: "none",
        pending_action_id: null,
        pre_fingerprint: null,
        current_fingerprint: fingerprint,
      };
    }
    const recovery = MotaLab.classifyPendingRecovery(pending, currentObservation, fingerprint);
    if (recovery.phase === "mismatch") {
      pause("EXPECTED_DELTA_MISMATCH", recovery.detail_code, recovery, currentObservation);
      return null;
    }
    if (recovery.phase === "completed") {
      journal.markCompleted({
        action_id: pending.action_id,
        fingerprint,
        observation: MotaLab.cloneObservationForWire(currentObservation),
        completed_at: Date.now(),
        recovered: true,
      });
    } else {
      journal.updatePending({ phase: "not_executed" });
    }
    return recovery;
  }

  async function cycleBody() {
    if (!journal.snapshot().autopilot_enabled) return { skipped: "disabled" };
    state = "OBSERVING";
    const observation = capture();
    if (observation.busy) {
      return pause("UNSUPPORTED_INTERACTION", "GAME_BUSY_BEFORE_DECISION", {}, observation);
    }
    const fingerprint = MotaLab.fingerprintObservation(observation);
    let snapshot = journal.snapshot();
    const recovery = requestRecovery(snapshot, fingerprint);
    if (!recovery) return { paused: true };
    snapshot = journal.snapshot();
    const completedActionId = snapshot.last_completed_action
      && snapshot.last_acknowledged_action_id !== snapshot.last_completed_action.action_id
      ? snapshot.last_completed_action.action_id : null;
    const request = MotaLab.createCycleRequest({
      observation,
      completedActionId,
      recovery,
    });

    state = "REQUESTING";
    let response;
    try {
      response = await client.postCycle(request);
    } catch (error) {
      return pause(
        "DECISION_SERVICE_UNAVAILABLE",
        error.detail_code || "CONNECTION_FAILED",
        { message: error.message },
        observation,
      );
    }
    if (completedActionId) journal.acknowledge(completedActionId);
    try {
      validateAndReplaceRegistry(response.registry_entries || [], observation);
    } catch (error) {
      return handleError(error, "DECISION_SERVICE_UNAVAILABLE", "INVALID_RESPONSE");
    }

    if (response.status === "pause") {
      lastReason = response.reason;
      return pause(response.pause_kind, response.detail_code, response.details, observation);
    }
    if (response.status === "error") {
      return pause(
        "DECISION_SERVICE_UNAVAILABLE",
        response.error_code,
        { reason: response.reason, errors: response.errors },
        observation,
      );
    }
    if (response.status === "idle") {
      state = "OBSERVING";
      lastReason = response.reason;
      refreshPanel({ connected: true });
      scheduleNext();
      return { idle: true };
    }

    currentActionId = response.action_id;
    lastReason = response.reason;
    refreshPanel({ connected: true, action_id: currentActionId });
    const pending = journal.snapshot().pending_action;
    if (pending) {
      if (response.action_id === pending.action_id) {
        duplicatePendingCount += 1;
        if (duplicatePendingCount >= 2) {
          return pause(
            "DECISION_SERVICE_UNAVAILABLE",
            "DUPLICATE_PENDING_RESPONSE",
            { action_id: response.action_id },
            observation,
          );
        }
        scheduleNext();
        return { duplicate_pending: true, executed: false };
      }
      if (recovery.phase !== "not_executed"
        || response.supersedes_action_id !== pending.action_id) {
        return pause(
          "DECISION_SERVICE_UNAVAILABLE",
          "INVALID_RECOVERY_REISSUE",
          { pending_action_id: pending.action_id, action_id: response.action_id },
          observation,
        );
      }
      if (pending.rejection_detail_code) {
        unsafeResponseCount = Math.max(
          unsafeResponseCount,
          MotaLab.isFiniteInteger(pending.rejection_count) ? pending.rejection_count : 1,
        );
      }
      journal.abandonPending();
      duplicatePendingCount = 0;
    } else if (response.supersedes_action_id) {
      return pause(
        "DECISION_SERVICE_UNAVAILABLE",
        "INVALID_RECOVERY_REISSUE",
        { supersedes_action_id: response.supersedes_action_id },
        observation,
      );
    }

    const actionState = journal.actionState(response.action_id);
    if (actionState === "completed") {
      scheduleNext();
      return { duplicate_completed: true, executed: false };
    }
    if (actionState) {
      return pause(
        "DECISION_SERVICE_UNAVAILABLE",
        "STALE_ACTION_ID",
        { action_id: response.action_id, action_state: actionState },
        observation,
      );
    }

    const unknown = registry.unknownBlocks(observation);
    if (unknown.length) {
      return pause(
        "NEW_OBJECT_OR_MECHANISM",
        "UNKNOWN_BLOCK",
        { blocks: unknown.map(MotaLab.blockEvidence) },
        observation,
      );
    }

    state = "GUARD_CHECK";
    const freshObservation = capture();
    const freshFingerprint = MotaLab.fingerprintObservation(freshObservation);
    const guard = MotaLab.compareGuard(freshObservation, response.guard);
    if (!guard.ok) {
      return pause(
        "GUARD_MISMATCH",
        "PRE_ACTION_GUARD_MISMATCH",
        { differences: guard.differences },
        freshObservation,
      );
    }

    let planned;
    let actionConstraints;
    try {
      planned = MotaLab.planOperations(response, freshObservation, registry, adapter);
      const allowUnknownFloor = response.expected_delta.floor_id === null
        && planned.length > 0 && planned[planned.length - 1].category === "stair";
      MotaLab.validateExpectedDelta(response.expected_delta, { allowUnknownFloor });
      actionConstraints = MotaLab.validateActionPostconditions(planned, response.expected_delta);
    } catch (error) {
      if (MotaLab.isPauseError(error)
        && ["UNSAFE_MULTI_BOUNDARY_RESPONSE", "UNSAFE_ROUTE_RESPONSE"].includes(error.detail_code)) {
        unsafeResponseCount += 1;
        if (unsafeResponseCount < 2) {
          journal.setPending({
            action_id: response.action_id,
            pre_fingerprint: freshFingerprint,
            pre_observation: MotaLab.cloneObservationForWire(freshObservation),
            guard: response.guard,
            expected_delta: response.expected_delta,
            requires_non_position_change: Boolean(
              planned && planned.length > 0 && planned[planned.length - 1].boundary,
            ),
            operations: response.operations,
            operation_index: 0,
            phase: "not_executed",
            rejection_detail_code: error.detail_code,
            rejection_count: unsafeResponseCount,
            started_at: Date.now(),
          });
          lastReason = `${error.detail_code}，已要求重新决策`;
          scheduleNext(0);
          return { rejected: true, executed: false };
        }
      }
      return handleError(error, "DECISION_SERVICE_UNAVAILABLE", "INVALID_RESPONSE");
    }
    unsafeResponseCount = 0;

    const pendingRecord = {
      action_id: response.action_id,
      pre_fingerprint: freshFingerprint,
      pre_observation: MotaLab.cloneObservationForWire(freshObservation),
      guard: response.guard,
      expected_delta: response.expected_delta,
      requires_non_position_change: actionConstraints.requires_non_position_change,
      allow_unknown_floor: response.expected_delta.floor_id === null,
      operations: response.operations,
      operation_index: 0,
      phase: "prepared",
      started_at: Date.now(),
    };
    journal.setPending(pendingRecord);
    state = "EXECUTING";
    let result;
    try {
      result = await MotaLab.executeAction({
        action: response,
        initialObservation: freshObservation,
        registry,
        adapter,
        observe,
        stabilityOptions: options.stabilityOptions || {},
      });
    } catch (error) {
      if (error && error.observation) currentObservation = error.observation;
      else {
        try { currentObservation = observe(); } catch (_) { currentObservation = freshObservation; }
      }
      return handleError(error);
    }

    currentObservation = result.observation;
    state = "VERIFYING_DELTA";
    if (pendingRecord.requires_non_position_change
      && !MotaLab.stateChangedBeyondPosition(freshObservation, result.observation)) {
      return pause(
        "EXPECTED_DELTA_MISMATCH",
        "RESOURCE_DELTA_MISMATCH",
        {
          differences: [{
            field: "boundary_state_change",
            expected: "non-position state change",
            actual: "position-only change",
          }],
          actual: { removed: [], added: [] },
        },
        result.observation,
      );
    }
    const delta = MotaLab.compareExpectedDelta(
      freshObservation,
      result.observation,
      response.expected_delta,
      {
        allowPositionChange: true,
        allowUnknownFloor: pendingRecord.allow_unknown_floor,
      },
    );
    if (!delta.ok) {
      return pause(
        "EXPECTED_DELTA_MISMATCH",
        "RESOURCE_DELTA_MISMATCH",
        { differences: delta.differences, actual: delta.actual },
        result.observation,
      );
    }
    journal.markCompleted({
      action_id: response.action_id,
      fingerprint: result.fingerprint,
      observation: MotaLab.cloneObservationForWire(result.observation),
      completed_at: Date.now(),
      recovered: false,
    });
    state = "REPORTING";
    lastReason = `行动 ${response.action_id} 已完成并通过差分校验`;
    refreshPanel();
    scheduleNext(0);
    return { completed: true, action_id: response.action_id, result };
  }

  function runSingleCycle() {
    if (cyclePromise) return cyclePromise;
    cyclePromise = cycleBody().catch((error) => handleError(error))
      .finally(() => { cyclePromise = null; });
    return cyclePromise;
  }

  async function reconnectOnly() {
    try {
      const observation = capture();
      const fingerprint = MotaLab.fingerprintObservation(observation);
      const request = MotaLab.createCycleRequest({
        observation,
        completedActionId: null,
        recovery: {
          phase: "none",
          pending_action_id: null,
          pre_fingerprint: null,
          current_fingerprint: fingerprint,
        },
      });
      const response = await client.postCycle(request);
      validateAndReplaceRegistry(response.registry_entries || [], observation);
      lastReason = "localhost 重新连接成功；未执行返回行动";
      refreshPanel({ connected: true });
      return { connected: true, response_status: response.status, executed: false };
    } catch (error) {
      return pause(
        "DECISION_SERVICE_UNAVAILABLE",
        error.detail_code || "CONNECTION_FAILED",
        { message: error.message },
      );
    }
  }

  function getCurrentObservation() {
    try {
      return MotaLab.cloneObservationForWire(currentObservation || capture());
    } catch (error) {
      handleError(error);
      return null;
    }
  }

  return Object.freeze({
    initialize,
    start,
    manualPause,
    clearPending,
    reconnectOnly,
    runSingleCycle,
    getCurrentObservation,
    getState: () => state,
  });
};
