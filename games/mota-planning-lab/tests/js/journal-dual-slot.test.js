const assert = require("node:assert/strict");
const test = require("node:test");

const { loadRuntime, makeObservation } = require("./helpers/runtime.js");

const lab = loadRuntime();

function establish(journal, sessionId = "SESSION-DUAL-SLOT-0001") {
  journal.establishSession({
    session_id: sessionId,
    mode: "new_game",
    baseline: lab.baselineSummary(makeObservation()),
  });
}

function faultingStorage(base, decide) {
  return {
    inspect: (key) => base.inspect(key),
    get: (key, fallback) => base.get(key, fallback),
    set(key, value) {
      const mode = decide(key, value);
      if (mode === "partial-then-throw") {
        base.set(key, { storage_protocol: 1, generation: value.generation });
        throw new Error("synthetic partial write");
      }
      if (mode === "complete-then-throw") {
        base.set(key, value);
        throw new Error("synthetic post-write throw");
      }
      if (mode === "truncate") {
        base.set(key, JSON.stringify(value).slice(0, 80));
        return { verified: true };
      }
      if (mode === "noop") return { verified: true };
      return base.set(key, value);
    },
    delete: (key) => base.delete(key),
  };
}

function rehashEnvelope(envelope) {
  envelope.state_hash = `sha256:${lab.sha256(lab.canonicalize(envelope.state))}`;
  const core = {
    storage_protocol: envelope.storage_protocol,
    generation: envelope.generation,
    previous_generation: envelope.previous_generation,
    previous_commit_hash: envelope.previous_commit_hash,
    state: envelope.state,
    state_hash: envelope.state_hash,
    import_witness: envelope.import_witness,
  };
  envelope.commit_hash = `sha256:${lab.sha256(lab.canonicalize(core))}`;
}

test("journal 使用无单点 pointer 的 A/B generation 槽并连续交替", () => {
  assert.equal(lab.JOURNAL_SLOT_KEYS.length, 2);
  const storage = lab.createMemoryStorage();
  const journal = lab.createJournal(storage);
  establish(journal);
  journal.setAutopilot(true);
  journal.setPause({ pause_kind: "DECISION_SERVICE_UNAVAILABLE", detail_code: "TEST" });
  journal.setAutopilot(true);
  const slots = lab.JOURNAL_SLOT_KEYS.map((key) => storage.get(key, null));
  assert.equal(JSON.stringify(slots.map((item) => item.generation).sort((a, b) => a - b)), "[3,4]");
  for (const envelope of slots) {
    assert.equal(envelope.storage_protocol, 1);
    assert.match(envelope.state_hash, /^sha256:[a-f0-9]{64}$/u);
    assert.match(envelope.commit_hash, /^sha256:[a-f0-9]{64}$/u);
  }
  assert.equal(journal.snapshot().session_id, "SESSION-DUAL-SLOT-0001");
});

test("generation envelope 自身必须声明严格相邻前代，base 与整数边界 fail closed", () => {
  const baseStorage = lab.createMemoryStorage();
  establish(lab.createJournal(baseStorage));
  const baseKey = lab.JOURNAL_SLOT_KEYS.find((key) => baseStorage.get(key, null));
  const base = baseStorage.get(baseKey, null);
  assert.equal(base.generation, 1);
  assert.equal(base.previous_generation, 0);
  assert.equal(base.previous_commit_hash, null);

  for (const mutate of [
    (envelope) => { envelope.previous_generation = null; },
    (envelope) => { envelope.previous_generation = 1; },
    (envelope) => { envelope.previous_commit_hash = `sha256:${"0".repeat(64)}`; },
  ]) {
    const storage = lab.createMemoryStorage();
    const malformed = structuredClone(base);
    mutate(malformed);
    rehashEnvelope(malformed);
    storage.set(baseKey, malformed);
    assert.throws(() => lab.createJournal(storage).snapshot(),
      (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE");
  }

  const gapStorage = lab.createMemoryStorage();
  const gap = structuredClone(base);
  gap.generation = 100;
  gap.previous_generation = 1;
  gap.previous_commit_hash = `sha256:${"1".repeat(64)}`;
  rehashEnvelope(gap);
  gapStorage.set(baseKey, gap);
  assert.throws(() => lab.createJournal(gapStorage).snapshot(),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE");

  const adjacentStorage = lab.createMemoryStorage();
  const adjacent = structuredClone(base);
  adjacent.generation = 2;
  adjacent.previous_generation = 1;
  adjacent.previous_commit_hash = `sha256:${"2".repeat(64)}`;
  rehashEnvelope(adjacent);
  adjacentStorage.set(baseKey, adjacent);
  assert.equal(lab.createJournal(adjacentStorage).snapshot().session_id, "SESSION-DUAL-SLOT-0001");

  const highStorage = lab.createMemoryStorage();
  const high = structuredClone(base);
  high.generation = 100;
  high.previous_generation = 99;
  high.previous_commit_hash = `sha256:${"4".repeat(64)}`;
  rehashEnvelope(high);
  highStorage.set(baseKey, high);
  assert.equal(lab.createJournal(highStorage).snapshot().session_id, "SESSION-DUAL-SLOT-0001");

  const maxStorage = lab.createMemoryStorage();
  const maximum = structuredClone(base);
  maximum.generation = Number.MAX_SAFE_INTEGER;
  maximum.previous_generation = Number.MAX_SAFE_INTEGER - 1;
  maximum.previous_commit_hash = `sha256:${"3".repeat(64)}`;
  rehashEnvelope(maximum);
  maxStorage.set(baseKey, maximum);
  const maximumJournal = lab.createJournal(maxStorage);
  assert.equal(maximumJournal.snapshot().session_id, "SESSION-DUAL-SLOT-0001");
  assert.throws(() => maximumJournal.setAutopilot(true),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE");
});

test("pending candidate 部分写失败后刷新恢复旧 identity 且未执行态不丢", () => {
  const durable = lab.createMemoryStorage();
  establish(lab.createJournal(durable));
  const oldSlot = lab.JOURNAL_SLOT_KEYS.find((key) => durable.get(key, null));
  const target = lab.JOURNAL_SLOT_KEYS.find((key) => key !== oldSlot);
  const failing = lab.createJournal(faultingStorage(durable,
    (key) => (key === target ? "partial-then-throw" : null)));
  assert.throws(() => failing.setPending({ action_id: "AUTO-DUALSLOT-PENDING", phase: "prepared" }));
  const recovered = lab.createJournal(durable).snapshot();
  assert.equal(recovered.session_id, "SESSION-DUAL-SLOT-0001");
  assert.equal(recovered.pending_action, null);
});

test("完整 candidate 后调用抛错，刷新选择完整新 pending identity", () => {
  const durable = lab.createMemoryStorage();
  establish(lab.createJournal(durable));
  const target = lab.JOURNAL_SLOT_KEYS.find((key) => !durable.get(key, null));
  const failing = lab.createJournal(faultingStorage(durable,
    (key) => (key === target ? "complete-then-throw" : null)));
  assert.throws(() => failing.setPending({ action_id: "AUTO-DUALSLOT-COMMIT", phase: "prepared" }));
  const recovered = lab.createJournal(durable).snapshot();
  assert.equal(recovered.session_id, "SESSION-DUAL-SLOT-0001");
  assert.equal(recovered.pending_action.action_id, "AUTO-DUALSLOT-COMMIT");
});

test("completed candidate 截断失败后刷新仍保留 pending 链", () => {
  const durable = lab.createMemoryStorage();
  const journal = lab.createJournal(durable);
  establish(journal);
  journal.setPending({ action_id: "AUTO-DUALSLOT-COMPLETE", phase: "executing" });
  const currentGenerations = lab.JOURNAL_SLOT_KEYS.map((key) => durable.get(key, null)?.generation || 0);
  const target = lab.JOURNAL_SLOT_KEYS[currentGenerations[0] > currentGenerations[1] ? 1 : 0];
  const failing = lab.createJournal(faultingStorage(durable,
    (key) => (key === target ? "truncate" : null)));
  assert.throws(() => failing.markCompleted({ action_id: "AUTO-DUALSLOT-COMPLETE" }),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE");
  const recovered = lab.createJournal(durable).snapshot();
  assert.equal(recovered.pending_action.action_id, "AUTO-DUALSLOT-COMPLETE");
  assert.equal(recovered.last_completed_action, null);
});

test("旧单 key v2 安全导入 slot 且原 witness 保留不覆盖", () => {
  const legacyState = lab.createJournal(lab.createMemoryStorage()).snapshot();
  legacyState.session_id = "SESSION-SINGLE-KEY-WITNESS";
  legacyState.session_mode = "new_game";
  legacyState.baseline = lab.baselineSummary(makeObservation());
  const storage = lab.createMemoryStorage({ [lab.JOURNAL_KEY]: legacyState });
  const journal = lab.createJournal(storage);
  assert.equal(journal.snapshot().session_id, "SESSION-SINGLE-KEY-WITNESS");
  journal.setAutopilot(true);
  assert.deepEqual(storage.get(lab.JOURNAL_KEY, null), legacyState);
  assert.equal(lab.JOURNAL_SLOT_KEYS.some((key) => storage.get(key, null)), true);
});

test("双槽同 generation、链断裂和 unexpected higher 均 fail closed", () => {
  for (const mutate of [
    (slots) => { slots[0] = structuredClone(slots[1]); },
    (slots) => {
      slots[1].previous_commit_hash = `sha256:${"0".repeat(64)}`;
      rehashEnvelope(slots[1]);
    },
    (slots) => { slots[1].generation += 9; rehashEnvelope(slots[1]); },
  ]) {
    const storage = lab.createMemoryStorage();
    const journal = lab.createJournal(storage);
    establish(journal);
    journal.setAutopilot(true);
    const slots = lab.JOURNAL_SLOT_KEYS.map((key) => storage.get(key, null));
    slots.sort((a, b) => a.generation - b.generation);
    mutate(slots);
    for (let index = 0; index < slots.length; index += 1) {
      storage.set(lab.JOURNAL_SLOT_KEYS[index], slots[index]);
    }
    assert.throws(() => lab.createJournal(storage).snapshot(),
      (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE");
  }
});

test("GM A/B candidate 的 no-op、截断、变形、throw 均保留旧槽，完整后 throw 可恢复新槽", () => {
  const seed = lab.createMemoryStorage();
  establish(lab.createJournal(seed));
  const initial = new Map(lab.JOURNAL_SLOT_KEYS
    .filter((key) => seed.get(key, null))
    .map((key) => [key, seed.get(key, null)]));
  const target = lab.JOURNAL_SLOT_KEYS.find((key) => !initial.has(key));
  for (const mode of ["noop", "truncate", "morph", "throw", "complete-then-throw"]) {
    const values = new Map([...initial].map(([key, value]) => [key, structuredClone(value)]));
    let armed = true;
    const scope = {
      GM_listValues: () => [...values.keys()],
      GM_getValue: (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : structuredClone(fallback),
      GM_setValue(key, value) {
        if (key !== target || !armed) { values.set(key, structuredClone(value)); return; }
        armed = false;
        if (mode === "noop") return;
        if (mode === "truncate") { values.set(key, "{\"storage_protocol\":1"); return; }
        if (mode === "morph") { values.set(key, { storage_protocol: 1, generation: value.generation }); return; }
        if (mode === "throw") throw new Error("synthetic GM throw");
        values.set(key, structuredClone(value));
        throw new Error("synthetic GM post-write throw");
      },
      GM_deleteValue: (key) => values.delete(key),
      GM_xmlhttpRequest() { throw new Error("network not used"); },
    };
    const environment = lab.createRuntimeEnvironment(scope, "userscript");
    assert.throws(
      () => lab.createJournal(environment.storage)
        .setPending({ action_id: `AUTO-GM-${mode}`, phase: "prepared" }),
      (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
      mode,
    );
    const recovered = lab.createJournal(lab.createRuntimeEnvironment(scope, "userscript").storage).snapshot();
    assert.equal(recovered.session_id, "SESSION-DUAL-SLOT-0001", mode);
    assert.equal(recovered.pending_action?.action_id || null,
      mode === "complete-then-throw" ? `AUTO-GM-${mode}` : null, mode);
  }
});

test("direct-mount A/B candidate 部分写与 complete-then-throw 刷新后身份可判定", () => {
  const seed = lab.createMemoryStorage();
  establish(lab.createJournal(seed));
  const physical = [
    "mota-planning-lab:direct-mount:journal:v2:slot:a",
    "mota-planning-lab:direct-mount:journal:v2:slot:b",
  ];
  for (const mode of ["truncate", "complete-then-throw"]) {
    const values = new Map([[physical[0], JSON.stringify(seed.get(lab.JOURNAL_SLOT_KEYS[0], null))]]);
    let armed = true;
    const scope = {
      localStorage: {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem(key, value) {
          if (key !== physical[1] || !armed) { values.set(key, value); return; }
          armed = false;
          if (mode === "truncate") { values.set(key, value.slice(0, 80)); return; }
          values.set(key, value);
          throw new Error("synthetic localStorage post-write throw");
        },
        removeItem: (key) => values.delete(key),
      },
      fetch() { throw new Error("network not used"); }, setTimeout, clearTimeout,
    };
    const environment = lab.createRuntimeEnvironment(scope, "direct-mount");
    assert.throws(
      () => lab.createJournal(environment.storage)
        .setPending({ action_id: `AUTO-DIRECT-${mode}`, phase: "prepared" }),
      (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
    );
    const recovered = lab.createJournal(lab.createRuntimeEnvironment(scope, "direct-mount").storage).snapshot();
    assert.equal(recovered.pending_action?.action_id || null,
      mode === "complete-then-throw" ? `AUTO-DIRECT-${mode}` : null);
  }
});

test("corrupt 单 key 归档进 generation 后保留 witness，内容变化重新 quarantine", () => {
  const storage = lab.createMemoryStorage({ [lab.JOURNAL_KEY]: "{" });
  const journal = lab.createJournal(storage);
  assert.equal(journal.snapshot().corruption_required, true);
  const archive = journal.archiveCorruptJournal();
  assert.equal(storage.get(lab.JOURNAL_KEY, null), "{");
  journal.authorizeV2AfterCorruptArchive({
    archive_id: archive.archive_id,
    confirmation: "ARCHIVE_CORRUPT_AND_START_V2",
  });
  assert.equal(journal.snapshot().corruption_required, false);
  storage.set(lab.JOURNAL_KEY, "[broken-again]");
  assert.equal(journal.snapshot().corruption_required, true);
});
