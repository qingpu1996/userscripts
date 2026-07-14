MotaLab.createController = function createController(dependencies, options = {}) {
  const { adapter, journal, registry, client, panel } = dependencies;
  const observeRaw = dependencies.observe || (() => MotaLab.collectObservation(adapter));
  const observeFastRaw = dependencies.observeFast || (dependencies.observe
    ? observeRaw
    : () => MotaLab.collectObservation({
      readRuntimeSnapshot: () => adapter.readFastRuntimeSnapshot(),
    }));
  const attachSession = (observation) => {
    observation.session_id = journal.snapshot().session_id || "UNCONFIRMED";
    return observation;
  };
  const observe = () => attachSession(observeRaw());
  const observeFast = () => attachSession(observeFastRaw());
  const logger = dependencies.logger || console;
  const autoSchedule = options.autoSchedule === true;
  const cycleDelayMs = MotaLab.isFiniteInteger(options.cycleDelayMs) ? options.cycleDelayMs : 300;
  const schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
  let state = "STOPPED";
  let currentObservation = null;
  let currentActionId = null;
  let lastReason = "等待显式确认会话基线";
  let cyclePromise = null;
  let unsafeResponseCount = 0;
  let duplicatePendingCount = 0;

  function locationText(observation) {
    return observation
      ? `${observation.floor_name || observation.floor_id} (${observation.hero.loc.x},${observation.hero.loc.y})`
      : "—";
  }

  function refreshPanel(extra = {}) {
    let snapshot;
    try { snapshot = journal.snapshot(); }
    catch (_) {
      snapshot = { autopilot_enabled: false, last_pause: null };
    }
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
        currentObservation.session_id = journal.snapshot().session_id || "UNCONFIRMED";
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
    try { journal.setPause(record); } catch (journalError) {
      record.journal_write_blocked = true;
      record.journal_error = journalError && journalError.message
        ? journalError.message : String(journalError);
    }
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
      if (snapshot.corruption_required) {
        const storageUnstable = snapshot.corrupt_evidence.some(
          (item) => item.status === "storage_unstable",
        );
        return pause(
          storageUnstable ? "ENGINE_API_INCOMPATIBLE" : "GUARD_MISMATCH",
          storageUnstable ? "JOURNAL_STORAGE_UNSTABLE" : "JOURNAL_CORRUPT",
          storageUnstable
            ? { evidence: snapshot.corrupt_evidence, retry_only: true }
            : { evidence: snapshot.corrupt_evidence, required_command: "archiveCorruptJournal" },
          observation,
        );
      }
      if (snapshot.migration_required) {
        return pause(
          "GUARD_MISMATCH",
          "JOURNAL_V1_MIGRATION_REQUIRED",
          { legacy_protocol: 1, required_protocol: 2 },
          observation,
        );
      }
      if (!snapshot.baseline || !snapshot.session_id) {
        journal.setAutopilot(false);
        state = "AWAITING_BASELINE_CONFIRMATION";
        lastReason = "已读取首次稳定现场；请显式确认会话基线";
        refreshPanel({ autopilot: false, pause_kind: null });
        return {
          verified: false,
          requires_confirmation: true,
          fingerprint,
          baseline: MotaLab.baselineSummary(observation),
          auto_started: false,
        };
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

  function confirmBaseline({
    mode = "new_game",
    expected_guard = null,
    session_id = null,
  } = {}) {
    try {
      if (journal.snapshot().corruption_required) {
        const corruptSnapshot = journal.snapshot();
        const storageUnstable = corruptSnapshot.corrupt_evidence.some(
          (item) => item.status === "storage_unstable",
        );
        return pause(
          storageUnstable ? "ENGINE_API_INCOMPATIBLE" : "GUARD_MISMATCH",
          storageUnstable ? "JOURNAL_STORAGE_UNSTABLE" : "JOURNAL_CORRUPT",
          storageUnstable
            ? { evidence: corruptSnapshot.corrupt_evidence, retry_only: true }
            : { required_command: "archiveCorruptJournal + beginV2AfterCorruptArchive" },
        );
      }
      if (journal.snapshot().migration_required) {
        return pause(
          "GUARD_MISMATCH",
          "JOURNAL_V1_MIGRATION_REQUIRED",
          { required_command: "archiveLegacyJournal + beginV2AfterLegacyArchive" },
        );
      }
      if (!MotaLab.SESSION_MODES.includes(mode)) throw new TypeError("Invalid session mode");
      const observation = capture();
      const provisionalFingerprint = MotaLab.fingerprintObservation(observation);
      const id = session_id || `SESSION-${MotaLab.sha256(`${provisionalFingerprint}:${Date.now()}`).slice(0, 24)}`;
      observation.session_id = id;
      if (mode === "handoff_expected_guard") {
        if (!expected_guard) throw new TypeError("handoff_expected_guard requires expected_guard");
        const matched = MotaLab.compareGuard(observation, expected_guard);
        if (!matched.ok) {
          return pause(
            "GUARD_MISMATCH",
            "SESSION_BASELINE_MISMATCH",
            { differences: matched.differences },
            observation,
          );
        }
      }
      if (mode === "resume_existing_ledger" && !session_id) {
        throw new TypeError("resume_existing_ledger requires session_id");
      }
      const fingerprint = MotaLab.fingerprintObservation(observation);
      journal.establishSession({
        session_id: id,
        mode,
        baseline: MotaLab.baselineSummary(observation),
        expected_guard,
      });
      journal.setAutopilot(false);
      state = "BASELINE_VERIFIED";
      lastReason = `会话基线已显式确认（${mode}），等待启动`;
      refreshPanel({ autopilot: false, pause_kind: null });
      return { verified: true, session_id: id, mode, fingerprint };
    } catch (error) {
      return handleError(error, "GUARD_MISMATCH", "INVALID_SESSION_BASELINE");
    }
  }

  function archiveLegacyJournal() {
    try {
      const archive = journal.archiveLegacyJournal();
      lastReason = `v1 journal 已本地归档（${archive.archive_id.slice(0, 24)}…），仍禁止行动`;
      refreshPanel({ autopilot: false, pause_kind: "GUARD_MISMATCH" });
      return archive;
    } catch (error) {
      handleError(error, "GUARD_MISMATCH", "LEGACY_ARCHIVE_FAILED");
      return { archived: false, error: error.message };
    }
  }

  function beginV2AfterLegacyArchive({
    archive_id,
    confirmation,
    mode = "new_game",
    expected_guard = null,
    session_id = null,
  } = {}) {
    try {
      journal.authorizeV2AfterLegacyArchive({ archive_id, confirmation });
    } catch (error) {
      return pause(
        "GUARD_MISMATCH",
        "LEGACY_DISPOSITION_NOT_CONFIRMED",
        { message: error.message, archive_id: archive_id || null },
      );
    }
    return confirmBaseline({ mode, expected_guard, session_id });
  }

  function archiveCorruptJournal() {
    try {
      const archive = journal.archiveCorruptJournal();
      lastReason = `损坏 journal 摘要已归档（${archive.archive_id.slice(0, 25)}…），仍禁止行动`;
      refreshPanel({ autopilot: false, pause_kind: "GUARD_MISMATCH" });
      return archive;
    } catch (error) {
      handleError(error, "GUARD_MISMATCH", "CORRUPT_JOURNAL_ARCHIVE_FAILED");
      return { archived: false, error: error.message };
    }
  }

  function beginV2AfterCorruptArchive({
    archive_id, confirmation, mode = "new_game", expected_guard = null, session_id = null,
  } = {}) {
    try {
      journal.authorizeV2AfterCorruptArchive({ archive_id, confirmation });
    } catch (error) {
      return pause(
        "GUARD_MISMATCH", "CORRUPT_JOURNAL_DISPOSITION_NOT_CONFIRMED",
        { message: error.message, archive_id: archive_id || null },
      );
    }
    return confirmBaseline({ mode, expected_guard, session_id });
  }

  async function start() {
    try {
      const snapshot = journal.snapshot();
      if (!snapshot.baseline || !snapshot.session_id
        || snapshot.migration_required || snapshot.corruption_required) {
        const result = await initialize();
        if (!result || !result.verified) return result;
      }
      journal.setAutopilot(true);
      state = "OBSERVING";
      lastReason = "用户已启动自动驾驶";
      refreshPanel({ autopilot: true, pause_kind: null });
      return runSingleCycle();
    } catch (error) {
      return handleError(error);
    }
  }

  function manualPause() {
    try { adapter.stopAutomaticRoute(); } catch (_) { /* best-effort stop */ }
    try {
      journal.setAutopilot(false);
      state = "STOPPED";
      lastReason = "用户手动暂停";
      refreshPanel({ autopilot: false, pause_kind: null });
      return { stopped: true };
    } catch (error) {
      return handleError(error);
    }
  }

  function clearPending() {
    if (journal.snapshot().autopilot_enabled || cyclePromise || state === "EXECUTING") {
      lastReason = "请先暂停自动驾驶，待当前执行结算后再清除 pending";
      refreshPanel();
      return { cleared: false, reason: "AUTOPILOT_ACTIVE" };
    }
    try {
      journal.clearPending();
      currentActionId = null;
      lastReason = "待执行行动已清除；游戏现场未改变";
      refreshPanel();
      return { cleared: true };
    } catch (error) {
      const record = handleError(error);
      return Object.assign(record, { cleared: false });
    }
  }

  function prepareRecovery(snapshot, fingerprint) {
    const pending = snapshot.pending_action;
    if (!pending) {
      return { recovery: {
          phase: "none",
          pending_action_id: null,
          pre_fingerprint: null,
          current_fingerprint: fingerprint,
        }, completionRecord: null,
      };
    }
    const recovery = MotaLab.classifyPendingRecovery(pending, currentObservation, fingerprint);
    if (recovery.phase === "mismatch") {
      pause("EXPECTED_DELTA_MISMATCH", recovery.detail_code, recovery, currentObservation);
      return null;
    }
    const completionRecord = recovery.phase === "completed" ? {
        action_id: pending.action_id,
        fingerprint,
        observation: MotaLab.cloneObservationForWire(currentObservation),
        completed_at: Date.now(),
        recovered: true,
      } : null;
    return { recovery, completionRecord };
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
    const preparedRecovery = prepareRecovery(snapshot, fingerprint);
    if (!preparedRecovery) return { paused: true };
    const { recovery, completionRecord } = preparedRecovery;
    snapshot = journal.snapshot();
    const completedActionId = completionRecord ? completionRecord.action_id
      : snapshot.last_completed_action
      && snapshot.last_acknowledged_action_id !== snapshot.last_completed_action.action_id
      ? snapshot.last_completed_action.action_id : null;
    const request = MotaLab.createCycleRequest({
      observation,
      completedActionId,
      recovery,
      session: Object.assign({
        mode: snapshot.session_mode,
        command: snapshot.service_session_confirmed ? "observe" : "confirm",
      }, snapshot.session_mode === "handoff_expected_guard" ? {
        expected_guard: snapshot.expected_guard,
      } : {}),
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
    if (completedActionId) {
      if (response.status !== "idle" || response.acknowledged_action_id !== completedActionId) {
        return pause(
          "DECISION_SERVICE_UNAVAILABLE", "RECOVERY_ACK_MISSING",
          { completed_action_id: completedActionId, response_status: response.status,
            acknowledged_action_id: response.acknowledged_action_id || null }, observation,
        );
      }
      if (completionRecord) journal.markCompleted(completionRecord);
      journal.acknowledge(completedActionId);
    } else if (response.acknowledged_action_id) {
      return pause(
        "DECISION_SERVICE_UNAVAILABLE", "RECOVERY_ACK_IDENTITY_MISMATCH",
        { acknowledged_action_id: response.acknowledged_action_id }, observation,
      );
    }
    if (!snapshot.service_session_confirmed) journal.markServiceSessionConfirmed();
    try {
      validateAndReplaceRegistry(response.registry_entries || [], observation);
      if (response.scan_state) journal.setScanState(response.scan_state);
    } catch (error) {
      return handleError(error, "DECISION_SERVICE_UNAVAILABLE", "INVALID_RESPONSE");
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
    let retryingSameAction = false;
    if (pending) {
      if (response.action_id === pending.action_id) {
        if (recovery.phase === "not_executed") {
          if (response.supersedes_action_id) {
            return pause(
              "DECISION_SERVICE_UNAVAILABLE",
              "INVALID_RECOVERY_REISSUE",
              {
                pending_action_id: pending.action_id,
                action_id: response.action_id,
                supersedes_action_id: response.supersedes_action_id,
              },
              observation,
            );
          }
          if (pending.rejection_detail_code) {
            unsafeResponseCount = Math.max(
              unsafeResponseCount,
              MotaLab.isFiniteInteger(pending.rejection_count) ? pending.rejection_count : 1,
            );
          }
          duplicatePendingCount = 0;
          retryingSameAction = true;
        } else {
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
      } else {
        return pause(
          "DECISION_SERVICE_UNAVAILABLE",
          "INVALID_RECOVERY_REISSUE",
          {
            pending_action_id: pending.action_id,
            action_id: response.action_id,
            supersedes_action_id: response.supersedes_action_id || null,
          },
          observation,
        );
      }
      if (!retryingSameAction) {
        journal.abandonPending();
        duplicatePendingCount = 0;
      }
    } else if (response.supersedes_action_id) {
      return pause(
        "DECISION_SERVICE_UNAVAILABLE",
        "INVALID_RECOVERY_REISSUE",
        { supersedes_action_id: response.supersedes_action_id },
        observation,
      );
    }

    const actionState = journal.actionState(response.action_id);
    if (!retryingSameAction && actionState === "completed") {
      scheduleNext();
      return { duplicate_completed: true, executed: false };
    }
    if (!retryingSameAction && actionState) {
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
    // The decision observation is the complete runtime snapshot.  Execution
    // performs a fresh lightweight guard read immediately before the engine
    // API call, so rebuilding the complete cross-floor model here is both
    // redundant and a visible main-thread stall.
    const freshObservation = observation;
    const freshFingerprint = fingerprint;
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
      const allowUnknownMapInstance = response.expected_delta.map_instance_id === null
        && planned.length > 0 && planned[planned.length - 1].category === "stair";
      MotaLab.validateExpectedDelta(response.expected_delta, {
        allowUnknownFloor,
        allowUnknownMapInstance,
        dimensions: freshObservation.dimensions,
        topology: freshObservation.topology,
      });
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
            allow_unknown_floor: response.expected_delta.floor_id === null,
            allow_unknown_map_instance: response.expected_delta.map_instance_id === null,
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
      allow_unknown_map_instance: response.expected_delta.map_instance_id === null,
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
        observeFast,
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
        allowUnknownMapInstance: pendingRecord.allow_unknown_map_instance,
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
      if (journal.snapshot().corruption_required) {
        return pause(
          "GUARD_MISMATCH",
          "JOURNAL_CORRUPT",
          { reconnect_blocked: true },
        );
      }
      if (journal.snapshot().migration_required) {
        return pause(
          "GUARD_MISMATCH",
          "JOURNAL_V1_MIGRATION_REQUIRED",
          { reconnect_blocked: true },
        );
      }
      const observation = capture();
      const fingerprint = MotaLab.fingerprintObservation(observation);
      let snapshot = journal.snapshot();
      const preparedRecovery = prepareRecovery(snapshot, fingerprint);
      if (!preparedRecovery) return { connected: false, paused: true, executed: false };
      const { recovery, completionRecord } = preparedRecovery;
      snapshot = journal.snapshot();
      const completedActionId = completionRecord ? completionRecord.action_id
        : snapshot.last_completed_action
        && snapshot.last_acknowledged_action_id !== snapshot.last_completed_action.action_id
        ? snapshot.last_completed_action.action_id : null;
      const request = MotaLab.createCycleRequest({
        observation,
        completedActionId,
        recovery,
        intent: "reconnect_only",
        session: snapshot.session_id ? Object.assign({
          mode: snapshot.session_mode,
          command: "observe",
        }, snapshot.session_mode === "handoff_expected_guard" ? {
          expected_guard: snapshot.expected_guard,
        } : {}) : { mode: "new_game", command: "observe" },
      });
      const response = await client.postCycle(request);
      if (response.status === "execute") {
        const record = pause(
          "DECISION_SERVICE_UNAVAILABLE", "RECONNECT_UNEXPECTED_EXECUTE",
          {
            response_status: response.status,
            action_id: response.action_id,
            response_fingerprint: `sha256:${MotaLab.sha256(MotaLab.canonicalize(response))}`,
            guard: MotaLab.cloneJsonValue(response.guard),
          },
          observation,
        );
        return Object.assign(record, {
          connected: false, response_status: "execute", executed: false,
        });
      }
      if (response.status === "pause") {
        const record = pause(
          response.pause_kind, response.detail_code, response.details || {}, observation,
        );
        return Object.assign(record, { connected: false, response_status: "pause", executed: false });
      }
      if (response.status === "error") {
        const record = pause(
          "DECISION_SERVICE_UNAVAILABLE", response.error_code,
          { reason: response.reason, errors: response.errors || [] }, observation,
        );
        return Object.assign(record, { connected: false, response_status: "error", executed: false });
      }
      if (completedActionId) {
        if (response.status !== "idle" || response.acknowledged_action_id !== completedActionId) {
          const record = pause(
            "DECISION_SERVICE_UNAVAILABLE", "RECOVERY_ACK_MISSING",
            { completed_action_id: completedActionId, response_status: response.status,
              acknowledged_action_id: response.acknowledged_action_id || null }, observation,
          );
          return Object.assign(record, { connected: false, response_status: response.status, executed: false });
        }
        if (completionRecord) journal.markCompleted(completionRecord);
        journal.acknowledge(completedActionId);
      } else if (response.acknowledged_action_id) {
        const record = pause(
          "DECISION_SERVICE_UNAVAILABLE", "RECOVERY_ACK_IDENTITY_MISMATCH",
          { acknowledged_action_id: response.acknowledged_action_id }, observation,
        );
        return Object.assign(record, { connected: false, response_status: response.status, executed: false });
      }
      validateAndReplaceRegistry(response.registry_entries || [], observation);
      if (response.scan_state) journal.setScanState(response.scan_state);
      lastReason = "localhost 重新连接成功；未执行返回行动";
      refreshPanel({ connected: true });
      return { connected: true, response_status: response.status, executed: false };
    } catch (error) {
      const record = MotaLab.isPauseError(error)
        ? handleError(error)
        : pause(
          "DECISION_SERVICE_UNAVAILABLE",
          error.detail_code || "CONNECTION_FAILED",
          { message: error.message },
        );
      return Object.assign(record, { connected: false, executed: false });
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

  function getLegacyArchive() {
    const archive = journal.snapshot().legacy_archive;
    return archive ? MotaLab.cloneJsonValue(archive) : null;
  }

  function getCorruptArchive() {
    const archive = journal.snapshot().corrupt_archive;
    return archive ? MotaLab.cloneJsonValue(archive) : null;
  }

  return Object.freeze({
    initialize,
    confirmBaseline,
    archiveLegacyJournal,
    beginV2AfterLegacyArchive,
    archiveCorruptJournal,
    beginV2AfterCorruptArchive,
    start,
    manualPause,
    clearPending,
    reconnectOnly,
    runSingleCycle,
    getCurrentObservation,
    getLegacyArchive,
    getCorruptArchive,
    getState: () => state,
  });
};
