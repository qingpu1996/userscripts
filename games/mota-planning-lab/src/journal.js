MotaLab.createMemoryStorage = function createMemoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    inspect(key) {
      if (!values.has(key)) return { status: "absent", key };
      const raw = values.get(key);
      let rawText;
      try { rawText = typeof raw === "string" ? raw : JSON.stringify(raw); } catch (_) { rawText = ""; }
      const evidence = { key, raw_length: rawText ? rawText.length : 0,
        content_hash: `sha256:${MotaLab.sha256(rawText || `[${typeof raw}]`)}` };
      if (typeof raw === "string") {
        try { return Object.assign({ status: "parsed", value: JSON.parse(raw) }, evidence); }
        catch (_) { return Object.assign({ status: "parse_failed" }, evidence); }
      }
      try { return Object.assign({ status: "parsed", value: JSON.parse(rawText) }, evidence); }
      catch (_) { return Object.assign({ status: "wrong_shape" }, evidence); }
    },
    get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    set(key, value) {
      const clone = MotaLab.cloneJsonValue(value);
      values.set(key, clone);
      return Object.freeze({ verified: true, key,
        canonical_hash: `sha256:${MotaLab.sha256(MotaLab.canonicalize(clone))}` });
    },
    delete(key) {
      values.delete(key);
      return Object.freeze({ verified: true, key, absent: true });
    },
  };
};

MotaLab.createJournal = function createJournal(storage) {
  const STORAGE_PROTOCOL = 1;
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
  const JOURNAL_FIELDS = Object.freeze(Object.keys(defaults()).sort());
  const ENVELOPE_FIELDS = Object.freeze([
    "commit_hash", "generation", "import_witness", "previous_commit_hash",
    "previous_generation", "state", "state_hash", "storage_protocol",
  ].sort());

  function pauseStorage(operation, details = {}) {
    return MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE", "JOURNAL_STORAGE_UNSTABLE",
      Object.assign({ operation }, details),
    );
  }

  function inspectKey(key) {
    if (storage && typeof storage.inspect === "function") return storage.inspect(key);
    try {
      const marker = Object.freeze({ absent: true });
      const value = storage.get(key, marker);
      if (value === marker) return { status: "absent", key };
      const raw = JSON.stringify(value);
      return { status: "parsed", key, value: MotaLab.cloneJsonValue(value),
        raw_length: raw.length, content_hash: `sha256:${MotaLab.sha256(raw)}` };
    } catch (_) {
      return { status: "read_failed", key, raw_length: 0,
        content_hash: `sha256:${MotaLab.sha256("storage-read-failed")}` };
    }
  }

  function isPlainObject(value) {
    return Boolean(value && Object.prototype.toString.call(value) === "[object Object]");
  }

  function validateV2State(value) {
    if (!isPlainObject(value) || value.protocol !== MotaLab.PROTOCOL_VERSION) return false;
    if (Object.keys(value).sort().join("\u0000") !== JOURNAL_FIELDS.join("\u0000")) return false;
    if (typeof value.autopilot_enabled !== "boolean"
      || typeof value.service_session_confirmed !== "boolean"
      || typeof value.migration_required !== "boolean"
      || typeof value.corruption_required !== "boolean") return false;
    for (const field of ["session_id", "session_mode", "last_acknowledged_action_id"]) {
      if (value[field] !== null && (typeof value[field] !== "string" || value[field].length < 1)) return false;
    }
    if (value.session_mode !== null && !MotaLab.SESSION_MODES.includes(value.session_mode)) return false;
    for (const field of [
      "expected_guard", "baseline", "legacy_archive", "legacy_disposition",
      "corrupt_archive", "corrupt_disposition", "scan_state", "pending_action",
      "last_completed_action", "last_pause",
    ]) {
      if (value[field] !== null && !isPlainObject(value[field])) return false;
    }
    if (!isPlainObject(value.seen_action_ids) || !Array.isArray(value.registry_entries)
      || !Array.isArray(value.corrupt_evidence)) return false;
    if (Object.values(value.seen_action_ids).some((item) => typeof item !== "string")) return false;
    for (const field of ["pending_action", "last_completed_action"]) {
      if (value[field] !== null
        && (typeof value[field].action_id !== "string" || value[field].action_id.length < 1)) return false;
    }
    return value.corrupt_evidence.every((item) => isPlainObject(item)
      && typeof item.key === "string" && Number.isInteger(item.raw_length)
      && typeof item.content_hash === "string" && /^sha256:[a-f0-9]{64}$/.test(item.content_hash));
  }

  function rawInspectionIdentity(inspected) {
    if (!inspected) return "missing";
    if (inspected.status === "parsed") {
      try { return `parsed:sha256:${MotaLab.sha256(MotaLab.canonicalize(inspected.value))}`; }
      catch (_) { return `parsed-invalid:${inspected.raw_length || 0}:${inspected.content_hash || "missing"}`; }
    }
    return `${inspected.status}:${inspected.raw_length || 0}:${inspected.content_hash || "none"}`;
  }

  function inspectionIdentity(inspected) {
    if (!inspected || ["storage_unstable", "read_failed"].includes(inspected.status)) {
      throw pauseStorage("journal-storage-witness", {
        observed_status: inspected && inspected.status,
        key: inspected && inspected.key,
      });
    }
    return rawInspectionIdentity(inspected);
  }

  function importWitness(inspected, classification, evidence = null) {
    return {
      key: MotaLab.JOURNAL_KEY,
      identity: inspectionIdentity(inspected),
      classification,
      evidence: evidence ? MotaLab.cloneJsonValue(evidence) : null,
    };
  }

  function envelopeCore(envelope) {
    return {
      storage_protocol: envelope.storage_protocol,
      generation: envelope.generation,
      previous_generation: envelope.previous_generation,
      previous_commit_hash: envelope.previous_commit_hash,
      state: envelope.state,
      state_hash: envelope.state_hash,
      import_witness: envelope.import_witness,
    };
  }

  function validateEnvelope(value) {
    if (!isPlainObject(value)
      || Object.keys(value).sort().join("\u0000") !== ENVELOPE_FIELDS.join("\u0000")
      || value.storage_protocol !== STORAGE_PROTOCOL
      || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !isPlainObject(value.import_witness)
      || value.import_witness.key !== MotaLab.JOURNAL_KEY
      || typeof value.import_witness.identity !== "string"
      || !["absent", "valid_v2", "corrupt"].includes(value.import_witness.classification)
      || (value.import_witness.evidence !== null && !isPlainObject(value.import_witness.evidence))
      || (value.import_witness.classification === "corrupt" && !isPlainObject(value.import_witness.evidence))
      || !validateV2State(value.state)) return false;
    if (value.generation === 1) {
      if (value.previous_generation !== 0 || value.previous_commit_hash !== null) return false;
    } else if (!Number.isSafeInteger(value.previous_generation)
      || value.previous_generation < 1
      || value.previous_generation !== value.generation - 1
      || typeof value.previous_commit_hash !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(value.previous_commit_hash)) return false;
    if (typeof value.state_hash !== "string" || typeof value.commit_hash !== "string") return false;
    const stateHash = `sha256:${MotaLab.sha256(MotaLab.canonicalize(value.state))}`;
    if (stateHash !== value.state_hash) return false;
    const commitHash = `sha256:${MotaLab.sha256(MotaLab.canonicalize(envelopeCore(value)))}`;
    return commitHash === value.commit_hash;
  }

  function buildEnvelope(state, active, witness) {
    if (active && active.envelope.generation >= Number.MAX_SAFE_INTEGER) {
      throw pauseStorage("journal-generation-build", { reason: "generation-overflow" });
    }
    const envelope = {
      storage_protocol: STORAGE_PROTOCOL,
      generation: active ? active.envelope.generation + 1 : 1,
      previous_generation: active ? active.envelope.generation : 0,
      previous_commit_hash: active ? active.envelope.commit_hash : null,
      state: MotaLab.cloneJsonValue(state),
      state_hash: `sha256:${MotaLab.sha256(MotaLab.canonicalize(state))}`,
      import_witness: MotaLab.cloneJsonValue(witness),
      commit_hash: null,
    };
    envelope.commit_hash = `sha256:${MotaLab.sha256(MotaLab.canonicalize(envelopeCore(envelope)))}`;
    return envelope;
  }

  function evidenceFromInspection(inspected, reason = null) {
    return {
      key: inspected.key,
      status: reason || inspected.status,
      raw_length: Number.isInteger(inspected.raw_length) ? inspected.raw_length : 0,
      content_hash: typeof inspected.content_hash === "string"
        ? inspected.content_hash : `sha256:${MotaLab.sha256("unreadable")}`,
    };
  }

  function loadContextOnce() {
    const slotInspections = MotaLab.JOURNAL_SLOT_KEYS.map(inspectKey);
    for (const inspected of slotInspections) inspectionIdentity(inspected);
    const valid = [];
    for (let index = 0; index < slotInspections.length; index += 1) {
      const inspected = slotInspections[index];
      if (inspected.status === "parsed" && validateEnvelope(inspected.value)) {
        valid.push({ key: MotaLab.JOURNAL_SLOT_KEYS[index], envelope: inspected.value });
      }
    }
    let active = null;
    if (valid.length === 2) {
      const sorted = valid.slice().sort((left, right) => left.envelope.generation - right.envelope.generation);
      const lower = sorted[0].envelope;
      const higher = sorted[1].envelope;
      if (lower.generation === higher.generation) {
        throw pauseStorage("journal-slot-selection", { reason: "same-generation-conflict" });
      }
      if (higher.generation !== lower.generation + 1
        || higher.previous_generation !== lower.generation
        || higher.previous_commit_hash !== lower.commit_hash
        || MotaLab.canonicalize(higher.import_witness) !== MotaLab.canonicalize(lower.import_witness)) {
        throw pauseStorage("journal-slot-selection", { reason: "generation-chain-broken" });
      }
      active = sorted[1];
    } else if (valid.length === 1) {
      active = valid[0];
      for (const inspected of slotInspections) {
        const rawGeneration = inspected.status === "parsed" && isPlainObject(inspected.value)
          ? inspected.value.generation : null;
        if (Number.isSafeInteger(rawGeneration)
          && rawGeneration > active.envelope.generation + 1) {
          throw pauseStorage("journal-slot-selection", { reason: "unexpected-higher-generation" });
        }
      }
    } else if (slotInspections.some((item) => item.status !== "absent")) {
      throw pauseStorage("journal-slot-selection", { reason: "no-valid-generation" });
    }

    const singleV2 = inspectKey(MotaLab.JOURNAL_KEY);
    const legacy = MotaLab.LEGACY_JOURNAL_KEYS.map(inspectKey);
    const corruptEvidence = [];
    let sourceState = null;
    let witness = null;
    if (active) {
      inspectionIdentity(singleV2);
      sourceState = active.envelope.state;
      witness = active.envelope.import_witness;
      if (witness.identity !== rawInspectionIdentity(singleV2)) {
        corruptEvidence.push(evidenceFromInspection(singleV2, "legacy_v2_witness_changed"));
      } else if (witness.classification === "corrupt") {
        corruptEvidence.push(MotaLab.cloneJsonValue(witness.evidence));
      }
    } else if (singleV2.status === "parsed" && validateV2State(singleV2.value)) {
      sourceState = singleV2.value;
      witness = importWitness(singleV2, "valid_v2");
    } else if (singleV2.status === "absent") {
      witness = importWitness(singleV2, "absent");
    } else if (singleV2.status !== "absent") {
      const reason = singleV2.status === "parsed"
        ? (isPlainObject(singleV2.value) && singleV2.value.protocol !== MotaLab.PROTOCOL_VERSION
          ? "wrong_protocol" : "wrong_shape") : null;
      const evidence = evidenceFromInspection(singleV2, reason);
      if (!["storage_unstable", "read_failed"].includes(singleV2.status)) {
        witness = importWitness(singleV2, "corrupt", evidence);
      }
      corruptEvidence.push(evidence);
    }

    const legacyEntries = [];
    for (const inspected of legacy) {
      if (inspected.status === "absent") continue;
      if (inspected.status === "parsed" && isPlainObject(inspected.value)
        && inspected.value.protocol === 1) {
        legacyEntries.push({ key: inspected.key, payload: MotaLab.cloneJsonValue(inspected.value) });
      } else {
        corruptEvidence.push(evidenceFromInspection(
          inspected, inspected.status === "parsed" ? "wrong_shape_or_protocol" : null,
        ));
      }
    }
    return { active, sourceState, witness, slotInspections, singleV2,
      legacyEntries, corruptEvidence };
  }

  function contextIdentity(context) {
    return MotaLab.canonicalize({
      slots: context.slotInspections.map(inspectionIdentity),
      single: rawInspectionIdentity(context.singleV2),
      legacy: context.legacyEntries,
      active: context.active ? {
        key: context.active.key,
        generation: context.active.envelope.generation,
        commit_hash: context.active.envelope.commit_hash,
      } : null,
      corruption: context.corruptEvidence,
    });
  }

  function loadStableContext(operation = "journal-read") {
    const first = loadContextOnce();
    const second = loadContextOnce();
    if (contextIdentity(first) !== contextIdentity(second)) {
      throw pauseStorage(operation, { reason: "two-slot-read-changed" });
    }
    return second;
  }

  function legacyArchiveId(entries) {
    return `legacy-archive:${MotaLab.sha256(MotaLab.canonicalize(entries))}`;
  }

  function stateFromContext(context) {
    const result = context.sourceState ? MotaLab.cloneJsonValue(context.sourceState) : defaults();
    result.autopilot_enabled = result.autopilot_enabled === true;
    result.corrupt_evidence = MotaLab.cloneJsonValue(context.corruptEvidence);
    if (context.legacyEntries.length > 0) {
      const currentArchiveId = legacyArchiveId(context.legacyEntries);
      const dispositionMatches = Boolean(
        result.legacy_archive && result.legacy_archive.archive_id === currentArchiveId
        && result.legacy_disposition && result.legacy_disposition.archive_id === currentArchiveId
      );
      result.migration_required = !dispositionMatches;
    } else if (result.legacy_archive && !result.legacy_disposition) {
      result.migration_required = true;
    }
    if (context.corruptEvidence.length > 0) {
      const currentArchiveId = `corrupt-archive:${MotaLab.sha256(MotaLab.canonicalize(context.corruptEvidence))}`;
      const dispositionMatches = Boolean(
        result.corrupt_archive && result.corrupt_archive.archive_id === currentArchiveId
        && result.corrupt_disposition && result.corrupt_disposition.archive_id === currentArchiveId
      );
      result.corruption_required = !dispositionMatches;
    } else if (result.corrupt_archive && !result.corrupt_disposition) {
      result.corruption_required = true;
    }
    if (result.corruption_required) result.autopilot_enabled = false;
    return result;
  }

  function read() { return stateFromContext(loadStableContext()); }

  function write(next, context, allowInitialCorruptArchive = false) {
    if (next.corruption_required && !next.corrupt_archive && !allowInitialCorruptArchive) {
      throw new TypeError("Corrupt journal evidence must be archived before a generation is written");
    }
    if (!validateV2State(next)) throw pauseStorage("journal-write", { reason: "invalid-state" });
    if (!context.witness) {
      throw pauseStorage("journal-write", { reason: "unstable-import-witness" });
    }
    const precondition = loadStableContext("journal-write-precondition");
    if (contextIdentity(precondition) !== contextIdentity(context)) {
      throw pauseStorage("journal-write-precondition", { reason: "read-write-witness-changed" });
    }
    const target = context.active
      ? MotaLab.JOURNAL_SLOT_KEYS.find((key) => key !== context.active.key)
      : MotaLab.JOURNAL_SLOT_KEYS[0];
    const envelope = buildEnvelope(next, context.active, context.witness);
    let writeError = null;
    try { storage.set(target, MotaLab.cloneJsonValue(envelope)); }
    catch (error) { writeError = error; }
    const first = inspectKey(target);
    const second = inspectKey(target);
    let committed = false;
    try {
      committed = first.status === "parsed" && second.status === "parsed"
        && validateEnvelope(first.value) && validateEnvelope(second.value)
        && MotaLab.canonicalize(first.value) === MotaLab.canonicalize(envelope)
        && MotaLab.canonicalize(second.value) === MotaLab.canonicalize(envelope);
    } catch (_) { committed = false; }
    if (!committed || writeError) {
      throw pauseStorage("journal-generation-write", {
        reason: writeError ? "write-call-uncertain" : "candidate-readback-invalid",
        target_slot: target,
        candidate_generation: envelope.generation,
        complete_candidate_observed: committed,
      });
    }
    const after = loadStableContext("journal-generation-commit");
    if (!after.active || after.active.key !== target
      || after.active.envelope.commit_hash !== envelope.commit_hash) {
      throw pauseStorage("journal-generation-commit", { reason: "candidate-not-selected" });
    }
    return Object.freeze({
      verified: true,
      state: MotaLab.cloneJsonValue(next),
      generation: envelope.generation,
      commit_hash: envelope.commit_hash,
    });
  }

  function update(mutator) {
    const context = loadStableContext("journal-update-read");
    const state = stateFromContext(context);
    mutator(state);
    return write(state, context);
  }

  function hasV2RecoveryEvidence(state) {
    return Boolean(state.session_id || state.session_mode || state.baseline || state.expected_guard
      || state.service_session_confirmed || state.scan_state || state.pending_action
      || state.last_completed_action || state.last_acknowledged_action_id
      || Object.keys(state.seen_action_ids || {}).length > 0);
  }

  return Object.freeze({
    snapshot: read,
    setAutopilot(enabled) { return update((state) => { state.autopilot_enabled = enabled === true; }); },
    establishSession({ session_id, mode, baseline, expected_guard = null }) {
      if (typeof session_id !== "string" || session_id.length < 1
        || !MotaLab.SESSION_MODES.includes(mode) || !baseline) throw new TypeError("Invalid session baseline");
      return update((state) => {
        if (state.migration_required || state.corruption_required) {
          throw new TypeError("Journal quarantine requires explicit archived disposition");
        }
        state.session_id = session_id;
        state.session_mode = mode;
        state.baseline = MotaLab.cloneJsonValue(baseline);
        state.expected_guard = expected_guard ? MotaLab.cloneJsonValue(expected_guard) : null;
        state.service_session_confirmed = false;
      });
    },
    archiveLegacyJournal() {
      const context = loadStableContext("legacy-archive-read");
      if (context.legacyEntries.length === 0) throw new TypeError("No legacy journal is present");
      const archiveId = legacyArchiveId(context.legacyEntries);
      const archive = {
        archive_id: archiveId,
        archived_at: Date.now(),
        has_pending_or_recovery: context.legacyEntries.some((entry) => Boolean(entry.payload
          && (entry.payload.pending_action || entry.payload.recovery || entry.payload.last_completed_action))),
        entries: MotaLab.cloneJsonValue(context.legacyEntries),
      };
      const result = update((state) => {
        state.migration_required = true;
        state.legacy_archive = archive;
        state.legacy_disposition = null;
        state.autopilot_enabled = false;
      });
      if (legacyArchiveId(loadStableContext().legacyEntries) !== archiveId) {
        throw pauseStorage("legacy-archive-postcondition", { reason: "legacy-content-changed" });
      }
      return MotaLab.cloneJsonValue(archive);
    },
    authorizeV2AfterLegacyArchive({ archive_id, confirmation }) {
      if (confirmation !== "START_V2_NEW_SESSION") {
        throw new TypeError("Explicit legacy disposition confirmation is required");
      }
      const result = update((state) => {
        const current = loadStableContext("legacy-disposition-read").legacyEntries;
        const currentArchiveId = current.length > 0 ? legacyArchiveId(current) : null;
        if (!state.migration_required || !state.legacy_archive
          || state.legacy_archive.archive_id !== archive_id || currentArchiveId !== archive_id) {
          throw new TypeError("Legacy archive identity does not match");
        }
        if (hasV2RecoveryEvidence(state)) {
          throw new TypeError("Existing v2 recovery evidence requires a separate audited disposition");
        }
        state.legacy_disposition = {
          kind: "archived_then_new_v2_session", archive_id, command: confirmation,
          confirmed_at: Date.now(),
          had_pending_or_recovery: state.legacy_archive.has_pending_or_recovery === true,
        };
        state.migration_required = false;
      });
      const current = loadStableContext().legacyEntries;
      if (current.length === 0 || legacyArchiveId(current) !== archive_id) {
        throw pauseStorage("legacy-disposition-postcondition", { reason: "legacy-content-changed" });
      }
      return result;
    },
    archiveCorruptJournal() {
      const context = loadStableContext("corrupt-archive-read");
      if (context.corruptEvidence.length === 0) throw new TypeError("No corrupt journal is present");
      const archive = {
        archive_id: `corrupt-archive:${MotaLab.sha256(MotaLab.canonicalize(context.corruptEvidence))}`,
        archived_at: Date.now(), evidence: MotaLab.cloneJsonValue(context.corruptEvidence),
      };
      const state = stateFromContext(context);
      if (hasV2RecoveryEvidence(state)) {
        throw new TypeError("Existing v2 recovery evidence requires a separate audited corrupt-journal disposition");
      }
      state.autopilot_enabled = false;
      state.corruption_required = true;
      state.corrupt_evidence = MotaLab.cloneJsonValue(context.corruptEvidence);
      state.corrupt_archive = archive;
      state.corrupt_disposition = null;
      write(state, context, true);
      if (MotaLab.canonicalize(loadStableContext().corruptEvidence)
        !== MotaLab.canonicalize(archive.evidence)) {
        throw pauseStorage("corrupt-archive-postcondition", { reason: "content-changed" });
      }
      return MotaLab.cloneJsonValue(archive);
    },
    authorizeV2AfterCorruptArchive({ archive_id, confirmation }) {
      if (confirmation !== "ARCHIVE_CORRUPT_AND_START_V2") {
        throw new TypeError("Explicit corrupt journal disposition confirmation is required");
      }
      const result = update((state) => {
        if (!state.corruption_required || !state.corrupt_archive
          || state.corrupt_archive.archive_id !== archive_id) {
          throw new TypeError("Corrupt journal archive identity does not match");
        }
        if (hasV2RecoveryEvidence(state)) {
          throw new TypeError("Existing v2 recovery evidence requires a separate audited disposition");
        }
        const current = loadStableContext("corrupt-disposition-read").corruptEvidence;
        if (MotaLab.canonicalize(current) !== MotaLab.canonicalize(state.corrupt_archive.evidence)) {
          throw new TypeError("Corrupt journal content changed after archive");
        }
        state.corrupt_disposition = {
          kind: "fingerprint_bound_corrupt_archive", archive_id,
          command: confirmation, confirmed_at: Date.now(),
        };
        state.corruption_required = false;
        state.corrupt_evidence = [];
      });
      return result;
    },
    markServiceSessionConfirmed() { return update((state) => { state.service_session_confirmed = true; }); },
    setPending(pending) {
      return update((state) => {
        state.pending_action = MotaLab.cloneJsonValue(pending);
        state.seen_action_ids[pending.action_id] = "pending";
      });
    },
    updatePending(fields) {
      return update((state) => { if (state.pending_action) Object.assign(state.pending_action, fields); });
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
        state.last_completed_action = MotaLab.cloneJsonValue(record);
        state.pending_action = null;
        state.seen_action_ids[record.action_id] = "completed";
      });
    },
    acknowledge(actionId) { return update((state) => { state.last_acknowledged_action_id = actionId; }); },
    actionState(actionId) { return read().seen_action_ids[actionId] || null; },
    setPause(pause) {
      return update((state) => { state.last_pause = MotaLab.cloneJsonValue(pause); state.autopilot_enabled = false; });
    },
    setRegistryEntries(entries) {
      return update((state) => { state.registry_entries = MotaLab.cloneJsonValue(entries); });
    },
    setScanState(scanState) {
      return update((state) => { state.scan_state = scanState ? MotaLab.cloneJsonValue(scanState) : null; });
    },
  });
};
