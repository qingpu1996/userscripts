MotaLab.createMemoryStorage = function createMemoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    get(key, fallback) {
      return values.has(key) ? values.get(key) : fallback;
    },
    set(key, value) {
      values.set(key, value);
    },
  };
};

MotaLab.createJournal = function createJournal(storage) {
  const defaults = () => ({
    protocol: MotaLab.PROTOCOL_VERSION,
    autopilot_enabled: false,
    initial_baseline_verified_fingerprint: null,
    pending_action: null,
    last_completed_action: null,
    last_acknowledged_action_id: null,
    seen_action_ids: {},
    last_pause: null,
    registry_entries: [],
  });

  function read() {
    const stored = storage.get(MotaLab.JOURNAL_KEY, null);
    if (!stored || typeof stored !== "object" || stored.protocol !== MotaLab.PROTOCOL_VERSION) {
      return defaults();
    }
    return Object.assign(defaults(), stored, {
      seen_action_ids: stored.seen_action_ids && typeof stored.seen_action_ids === "object"
        ? Object.assign({}, stored.seen_action_ids) : {},
      registry_entries: Array.isArray(stored.registry_entries) ? stored.registry_entries : [],
    });
  }

  function write(next) {
    storage.set(MotaLab.JOURNAL_KEY, next);
    return next;
  }

  function update(mutator) {
    const state = read();
    mutator(state);
    return write(state);
  }

  return Object.freeze({
    snapshot: read,
    setAutopilot(enabled) {
      return update((state) => { state.autopilot_enabled = enabled === true; });
    },
    verifyBaseline(fingerprint) {
      return update((state) => { state.initial_baseline_verified_fingerprint = fingerprint; });
    },
    setPending(pending) {
      return update((state) => {
        state.pending_action = pending;
        state.seen_action_ids[pending.action_id] = "pending";
      });
    },
    updatePending(fields) {
      return update((state) => {
        if (state.pending_action) Object.assign(state.pending_action, fields);
      });
    },
    abandonPending() {
      return update((state) => {
        if (state.pending_action) state.seen_action_ids[state.pending_action.action_id] = "abandoned";
        state.pending_action = null;
      });
    },
    clearPending() {
      return update((state) => {
        if (state.pending_action) state.seen_action_ids[state.pending_action.action_id] = "cleared";
        state.pending_action = null;
      });
    },
    markCompleted(record) {
      return update((state) => {
        state.last_completed_action = record;
        state.pending_action = null;
        state.seen_action_ids[record.action_id] = "completed";
      });
    },
    acknowledge(actionId) {
      return update((state) => { state.last_acknowledged_action_id = actionId; });
    },
    actionState(actionId) {
      return read().seen_action_ids[actionId] || null;
    },
    setPause(pause) {
      return update((state) => {
        state.last_pause = pause;
        state.autopilot_enabled = false;
      });
    },
    setRegistryEntries(entries) {
      return update((state) => { state.registry_entries = entries; });
    },
  });
};
