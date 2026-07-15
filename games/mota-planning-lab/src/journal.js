/* Ephemeral controller state.  The game runtime is authoritative; this object
 * deliberately never reads or writes GM storage/localStorage. */
MotaLab.createMemoryStorage = function createMemoryStorage() {
  return Object.freeze({
    inspect(key) { return { status: "absent", key }; },
    get(_key, fallback) { return fallback; },
    set() { throw new TypeError("Runtime persistence is disabled"); },
    delete() { return Object.freeze({ verified: true, absent: true }); },
  });
};

MotaLab.createJournal = function createJournal(_ignoredStorage) {
  const defaults = () => ({
    protocol: MotaLab.PROTOCOL_VERSION,
    autopilot_enabled: false,
    session_id: null,
    session_mode: null,
    expected_guard: null,
    baseline: null,
    service_session_confirmed: false,
    migration_required: false,
    corruption_required: false,
    legacy_archive: null,
    legacy_disposition: null,
    corrupt_archive: null,
    corrupt_disposition: null,
    corrupt_evidence: [],
    scan_state: null,
    pending_action: null,
    last_completed_action: null,
    last_acknowledged_action_id: null,
    seen_action_ids: {},
    last_pause: null,
    registry_entries: [],
  });
  let state = defaults();
  let mutations = 0;
  const clone = (value) => MotaLab.cloneJsonValue(value);
  const result = () => Object.freeze({ verified: true, memory_only: true });
  function update(mutator) { mutator(state); mutations += 1; return result(); }
  return Object.freeze({
    snapshot() { return clone(state); },
    getDiagnostics() { return { memory_only: true, mutations, persistent_writes: 0 }; },
    setAutopilot(enabled) { return update((s) => { s.autopilot_enabled = enabled === true; }); },
    establishSession({ session_id, mode, baseline, expected_guard = null }) {
      if (typeof session_id !== "string" || !session_id || !MotaLab.SESSION_MODES.includes(mode)) {
        throw new TypeError("Invalid session baseline");
      }
      return update((s) => {
        s.session_id = session_id; s.session_mode = mode; s.baseline = clone(baseline);
        s.expected_guard = expected_guard ? clone(expected_guard) : null;
        s.service_session_confirmed = false; s.pending_action = null;
        s.last_completed_action = null; s.last_acknowledged_action_id = null;
        s.seen_action_ids = {}; s.scan_state = null;
      });
    },
    markServiceSessionConfirmed() { return update((s) => { s.service_session_confirmed = true; }); },
    setPending(pending) { return update((s) => {
      s.pending_action = clone(pending); s.seen_action_ids[pending.action_id] = "pending";
    }); },
    updatePending(fields) { return update((s) => { if (s.pending_action) Object.assign(s.pending_action, clone(fields)); }); },
    abandonPending() { return update((s) => {
      if (s.pending_action) s.seen_action_ids[s.pending_action.action_id] = "abandoned";
      s.pending_action = null;
    }); },
    clearPending() { return update((s) => {
      if (s.pending_action) s.seen_action_ids[s.pending_action.action_id] = "cleared";
      s.pending_action = null;
    }); },
    markCompleted(record) { return update((s) => {
      s.last_completed_action = clone(record); delete s.last_completed_action.observation;
      s.pending_action = null; s.seen_action_ids[record.action_id] = "completed";
    }); },
    markCompletedAndAcknowledge(record, actionId) { return update((s) => {
      s.last_completed_action = clone(record); delete s.last_completed_action.observation;
      s.pending_action = null; s.seen_action_ids[record.action_id] = "completed";
      s.last_acknowledged_action_id = actionId;
    }); },
    acknowledge(actionId) { return update((s) => { s.last_acknowledged_action_id = actionId; }); },
    actionState(actionId) { return state.seen_action_ids[actionId] || null; },
    setPause(pause) { return update((s) => { s.last_pause = clone(pause); s.autopilot_enabled = false; }); },
    setRegistryEntries(entries) { return update((s) => { s.registry_entries = clone(entries); }); },
    setScanState(scanState) { return update((s) => { s.scan_state = scanState ? clone(scanState) : null; }); },
    archiveLegacyJournal() { throw new TypeError("Persistent journal is disabled"); },
    authorizeV2AfterLegacyArchive() { throw new TypeError("Persistent journal is disabled"); },
    archiveCorruptJournal() { throw new TypeError("Persistent journal is disabled"); },
    authorizeV2AfterCorruptArchive() { throw new TypeError("Persistent journal is disabled"); },
  });
};
