const assert = require("node:assert/strict");
const test = require("node:test");

const {
  loadRuntime, makeObservation, makePoisonCore,
} = require("./helpers/runtime.js");

const lab = loadRuntime();

function makeGmEnvironment(initial = {}, options = {}) {
  const values = new Map(Object.entries(initial));
  const clone = (value) => {
    if (value === undefined || value === null || typeof value !== "object") return value;
    return JSON.parse(JSON.stringify(value));
  };
  const scope = {
    GM_listValues() {
      if (options.listThrows) throw new Error("GM_listValues failed");
      if (typeof options.listValues === "function") return options.listValues(values);
      return Array.from(values.keys());
    },
    GM_getValue(key, fallback) {
      if (options.readThrows === key) throw new Error("GM_getValue failed");
      if (typeof options.readValue === "function") return options.readValue(key, fallback, values, clone);
      return values.has(key) ? clone(values.get(key)) : clone(fallback);
    },
    GM_setValue(key, value) {
      if (options.writeThrows) throw new Error("GM_setValue failed");
      if (options.writeNoop) return;
      if (options.writeOldValue) {
        values.set(key, clone(options.writeOldValue));
        return;
      }
      if (options.writeTruncated) {
        values.set(key, { protocol: value.protocol, session_id: value.session_id });
        return;
      }
      if (options.writeMutateClone) {
        const changed = clone(value);
        changed.session_id = "SESSION-TAMPERED";
        values.set(key, changed);
        return;
      }
      values.set(key, clone(value));
    },
    GM_deleteValue(key) {
      if (options.deleteThrows) throw new Error("GM_deleteValue failed");
      if (options.deleteNoop) return;
      values.delete(key);
    },
    GM_xmlhttpRequest() { throw new Error("network must not be used"); },
  };
  return { environment: lab.createRuntimeEnvironment(scope), values, scope };
}

test("userscript/direct 模式只能由显式 marker 选择，GM API 缺失绝不降级 localStorage", () => {
  const required = [
    "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues", "GM_xmlhttpRequest",
  ];
  for (const missing of required) {
    const localCalls = [];
    const scope = makeGmEnvironment().scope;
    delete scope[missing];
    scope.localStorage = {
      getItem(key) { localCalls.push(["get", key]); return null; },
      setItem(key) { localCalls.push(["set", key]); },
    };
    const environment = lab.createRuntimeEnvironment(scope, "userscript");
    assert.equal(environment.mode, "userscript", missing);
    assert.equal(environment.available, false, missing);
    assert.equal(environment.detail_code, "USERSCRIPT_API_UNAVAILABLE", missing);
    assert.throws(() => environment.assertAvailable(), /USERSCRIPT_API_UNAVAILABLE/u, missing);
    assert.deepEqual(localCalls, [], missing);
  }

  const directCalls = [];
  const direct = lab.createRuntimeEnvironment({
    localStorage: {
      getItem(key) { directCalls.push(["get", key]); return null; },
      setItem(key) { directCalls.push(["set", key]); },
    },
    fetch() { throw new Error("not called"); }, setTimeout, clearTimeout,
  }, "direct-mount");
  assert.equal(direct.mode, "direct-mount");
  assert.equal(direct.available, true);
  assert.equal(direct.storage.inspect(lab.JOURNAL_KEY).status, "absent");
  assert.equal(directCalls.length, 1);
  assert.throws(() => lab.createRuntimeEnvironment({}, "unknown"), /runtime mode/iu);
});

test("Tampermonkey key 双探针交叉验证 stale list、undefined 与调用间变化", () => {
  const key = lab.JOURNAL_KEY;
  const valid = lab.createJournal(lab.createMemoryStorage()).snapshot();

  const staleOmission = makeGmEnvironment({ [key]: valid }, { listValues: () => [] });
  assert.equal(staleOmission.environment.storage.inspect(key).status, "parsed");
  const undefinedOmission = makeGmEnvironment({ [key]: undefined }, { listValues: () => [] });
  assert.notEqual(undefinedOmission.environment.storage.inspect(key).status, "absent");

  const staleInclusion = makeGmEnvironment({}, { listValues: () => [key] });
  assert.equal(staleInclusion.environment.storage.inspect(key).status, "absent");

  let read = 0;
  const changingRead = makeGmEnvironment({ [key]: valid }, {
    readValue(_key, fallback, values, clone) {
      read += 1;
      return read === 1 ? clone(values.get(key)) : clone(fallback);
    },
  });
  assert.equal(changingRead.environment.storage.inspect(key).status, "storage_unstable");

  let listed = 0;
  const changingList = makeGmEnvironment({ [key]: valid }, {
    listValues: () => (++listed === 1 ? [key] : []),
  });
  assert.equal(changingList.environment.storage.inspect(key).status, "storage_unstable");
});

test("Tampermonkey 存储读写删异常全部 fail closed", () => {
  const key = lab.JOURNAL_KEY;
  const valid = lab.createJournal(lab.createMemoryStorage()).snapshot();
  assert.equal(makeGmEnvironment({ [key]: valid }, { readThrows: key })
    .environment.storage.inspect(key).status, "storage_unstable");
  assert.throws(() => makeGmEnvironment({}, { writeThrows: true })
    .environment.storage.set(key, valid), /JOURNAL_STORAGE_UNSTABLE/u);
  assert.throws(() => makeGmEnvironment({ [key]: valid }, { deleteThrows: true })
    .environment.storage.delete(key), /JOURNAL_STORAGE_UNSTABLE/u);
  assert.throws(
    () => makeGmEnvironment().environment.request({}),
    (error) => error.detail_code === "USERSCRIPT_API_UNAVAILABLE",
  );
});

test("Tampermonkey canonical 写后验证拒绝 no-op、旧值、截断、变形与删除 no-op", () => {
  const key = lab.JOURNAL_KEY;
  const valid = lab.createJournal(lab.createMemoryStorage()).snapshot();
  for (const options of [
    { writeNoop: true },
    { writeOldValue: Object.assign({}, valid, { session_id: "SESSION-OLD" }) },
    { writeTruncated: true },
    { writeMutateClone: true },
  ]) {
    const gm = makeGmEnvironment({}, options);
    assert.throws(
      () => gm.environment.storage.set(key, valid),
      (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
    );
  }
  const deletion = makeGmEnvironment({ [key]: valid }, { deleteNoop: true });
  assert.throws(
    () => deletion.environment.storage.delete(key),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
  );
});

test("Tampermonkey structured clone 的 canonical 语义等价写入通过", () => {
  const key = lab.JOURNAL_KEY;
  const valid = lab.createJournal(lab.createMemoryStorage()).snapshot();
  const gm = makeGmEnvironment();
  assert.doesNotThrow(() => gm.environment.storage.set(key, valid));
  assert.deepEqual(
    JSON.parse(JSON.stringify(gm.environment.storage.inspect(key).value)),
    JSON.parse(JSON.stringify(valid)),
  );
});

test("Tampermonkey 写后独立读回发生变化或抛错均 fail closed", () => {
  const key = lab.JOURNAL_KEY;
  const valid = lab.createJournal(lab.createMemoryStorage()).snapshot();
  let changingReads = 0;
  const changing = makeGmEnvironment({}, {
    readValue(item, fallback, values, clone) {
      if (item !== key || !values.has(item)) return clone(fallback);
      changingReads += 1;
      const stored = clone(values.get(item));
      if (changingReads >= 3) stored.session_id = "SESSION-CHANGED-BETWEEN-READBACKS";
      return stored;
    },
  });
  assert.throws(
    () => changing.environment.storage.set(key, valid),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
  );

  const throwing = makeGmEnvironment({}, {
    readValue(item, fallback, values, clone) {
      if (item === key && values.has(item)) throw new Error("readback failed");
      return clone(fallback);
    },
  });
  assert.throws(
    () => throwing.environment.storage.set(key, valid),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
  );
});

test("Journal mutation 绑定读写 witness，读后写前 identity 变化时不覆盖", () => {
  const durable = lab.createMemoryStorage();
  const setup = lab.createJournal(durable);
  setup.establishSession({
    session_id: "SESSION-WITNESS-STABLE",
    mode: "new_game",
    baseline: lab.baselineSummary(makeObservation()),
  });
  let journalInspects = 0;
  let attemptedWrites = 0;
  const changing = {
    inspect(key) {
      if (key === lab.JOURNAL_KEY) {
        journalInspects += 1;
        if (journalInspects === 3) {
          const changed = lab.createJournal(lab.createMemoryStorage()).snapshot();
          changed.session_id = "SESSION-CHANGED-BEFORE-WRITE";
          durable.set(key, changed);
        }
      }
      return durable.inspect(key);
    },
    get: durable.get,
    set(key, value) { attemptedWrites += 1; return durable.set(key, value); },
    delete: durable.delete,
  };
  const journal = lab.createJournal(changing);
  assert.throws(
    () => journal.setAutopilot(true),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
  );
  assert.equal(attemptedWrites, 0);
  assert.equal(durable.get(lab.JOURNAL_KEY, null).session_id, "SESSION-CHANGED-BEFORE-WRITE");
});

test("direct mount localStorage setItem/removeItem 静默 no-op 均 fail closed", () => {
  const valid = lab.createJournal(lab.createMemoryStorage()).snapshot();
  const makeDirect = ({ initial = null, setNoop = false, deleteNoop = false } = {}) => {
    let value = initial;
    return lab.createRuntimeEnvironment({
      localStorage: {
        getItem() { return value; },
        setItem(_key, next) { if (!setNoop) value = next; },
        removeItem() { if (!deleteNoop) value = null; },
      },
      fetch() { throw new Error("not called"); }, setTimeout, clearTimeout,
    }, "direct-mount");
  };
  assert.throws(
    () => makeDirect({ setNoop: true }).storage.set(lab.JOURNAL_KEY, valid),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
  );
  assert.throws(
    () => makeDirect({ initial: JSON.stringify(valid), deleteNoop: true })
      .storage.delete(lab.JOURNAL_KEY),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
  );
  const normal = makeDirect();
  assert.doesNotThrow(() => normal.storage.set(lab.JOURNAL_KEY, valid));
  assert.doesNotThrow(() => normal.storage.delete(lab.JOURNAL_KEY));
});

test("direct mount 写后读回变化与抛错 fail closed", () => {
  const valid = lab.createJournal(lab.createMemoryStorage()).snapshot();
  let raw = null;
  let reads = 0;
  const changing = lab.createRuntimeEnvironment({
    localStorage: {
      setItem(_key, value) { raw = value; reads = 0; },
      getItem() { reads += 1; return reads === 1 ? raw : `${raw} `; },
      removeItem() { raw = null; },
    },
    fetch() { throw new Error("not called"); }, setTimeout, clearTimeout,
  }, "direct-mount");
  assert.throws(
    () => changing.storage.set(lab.JOURNAL_KEY, valid),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
  );

  const throwing = lab.createRuntimeEnvironment({
    localStorage: {
      setItem() {}, getItem() { throw new Error("readback failed"); }, removeItem() {},
    },
    fetch() { throw new Error("not called"); }, setTimeout, clearTimeout,
  }, "direct-mount");
  assert.throws(
    () => throwing.storage.set(lab.JOURNAL_KEY, valid),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
  );
});

test("不稳定 userscript journal 在建 session、请求和行动前暂停", async () => {
  const key = lab.JOURNAL_KEY;
  const valid = lab.createJournal(lab.createMemoryStorage()).snapshot();
  const gm = makeGmEnvironment({ [key]: valid }, { readThrows: key });
  let requests = 0;
  const journal = lab.createJournal(gm.environment.storage);
  const controller = lab.createController({
    adapter: { assertRequiredCapabilities() {}, stopAutomaticRoute() {} },
    journal,
    registry: lab.createBlockRegistry(),
    client: {
      isConnected: () => false,
      async postCycle() { requests += 1; throw new Error("must not request"); },
    },
    panel: { update() {} }, observe: () => makeObservation(), logger: { error() {} },
  });
  const result = await controller.initialize();
  assert.equal(result.detail_code, "JOURNAL_STORAGE_UNSTABLE");
  assert.equal(result.pause_kind, "ENGINE_API_INCOMPATIBLE");
  assert.equal(requests, 0);
  assert.equal(gm.values.get(key).session_id, null);
});

test("Tampermonkey storage 以 key existence 区分 absent 与真实损坏值", async () => {
  const validV2 = lab.createJournal(lab.createMemoryStorage()).snapshot();
  const v1Key = "mota-planning-lab:journal:v1";
  const v2Key = lab.JOURNAL_KEY;

  const fresh = makeGmEnvironment();
  assert.equal(fresh.environment.mode, "userscript");
  assert.equal(fresh.environment.storage.inspect(v1Key).status, "absent");
  assert.equal(fresh.environment.storage.inspect(v2Key).status, "absent");
  const freshJournal = lab.createJournal(fresh.environment.storage);
  assert.equal(freshJournal.snapshot().corruption_required, false);
  const controller = lab.createController({
    adapter: { assertRequiredCapabilities() {}, stopAutomaticRoute() {} },
    journal: freshJournal, registry: lab.createBlockRegistry(),
    client: { isConnected: () => false, async postCycle() { throw new Error("not called"); } },
    panel: { update() {} }, observe: () => makeObservation(), logger: { error() {} },
  });
  await controller.initialize();
  assert.equal(controller.confirmBaseline({ mode: "new_game" }).verified, true);
  assert.equal(lab.JOURNAL_SLOT_KEYS.some((key) => fresh.values.has(key)), true);

  const onlyV2 = makeGmEnvironment({ [v2Key]: validV2 }).environment.storage;
  assert.equal(onlyV2.inspect(v1Key).status, "absent");
  assert.equal(onlyV2.inspect(v2Key).status, "parsed");
  assert.equal(lab.createJournal(onlyV2).snapshot().corruption_required, false);
  const onlyV1 = makeGmEnvironment({ [v1Key]: { protocol: 1 } }).environment.storage;
  assert.equal(onlyV1.inspect(v1Key).status, "parsed");
  assert.equal(onlyV1.inspect(v2Key).status, "absent");
  assert.equal(lab.createJournal(onlyV1).snapshot().migration_required, true);

  for (const [name, value] of [
    ["old-string-sentinel", "__MOTA_LAB_ABSENT_0123456789abcdef__"],
    ["undefined", undefined], ["null", null], ["primitive", 7], ["array", []],
  ]) {
    const storage = makeGmEnvironment({ [v2Key]: value }).environment.storage;
    assert.notEqual(storage.inspect(v2Key).status, "absent", name);
    assert.equal(lab.createJournal(storage).snapshot().corruption_required, true, name);
  }

  const cloned = makeGmEnvironment({ [v2Key]: validV2 });
  assert.equal(lab.createJournal(cloned.environment.storage).snapshot().corruption_required, false);
  cloned.scope.GM_deleteValue(v2Key);
  assert.equal(cloned.environment.storage.inspect(v2Key).status, "absent");

  const readFailed = makeGmEnvironment({ [v2Key]: validV2 }, { readThrows: v2Key });
  assert.equal(readFailed.environment.storage.inspect(v2Key).status, "storage_unstable");
  assert.equal(lab.createJournal(readFailed.environment.storage).snapshot().corruption_required, true);
  const listFailed = makeGmEnvironment({}, { listThrows: true });
  assert.equal(listFailed.environment.storage.inspect(v2Key).status, "storage_unstable");
});

test("运行态尺寸驱动 13x13 与 7x19，且 hero.exp/缺失钥匙归一化", () => {
  for (const [width, height] of [[13, 13], [7, 19]]) {
    const hero = {
      hp: 1000, atk: 10, def: 10, money: 0, exp: 7,
      loc: { x: width - 1, y: height - 1, direction: "up" },
    };
    const fake = makePoisonCore({
      floorId: `runtime-${width}x${height}`,
      currentMap: { title: "动态地图", width, height },
      hero,
    });
    const observation = lab.collectObservation(lab.createEngineAdapter(fake.scope));
    assert.deepEqual(JSON.parse(JSON.stringify(observation.dimensions)), { width, height });
    assert.equal(observation.hero.experience, 7);
    assert.deepEqual(JSON.parse(JSON.stringify(observation.keys)), { yellow: 0, blue: 0, red: 0 });
    assert.equal(observation.topology.kind, "rectangle");
    assert.match(observation.map_instance_id, /^map:[a-f0-9]{64}$/u);
  }
});

test("异形 current dynamic grid 产生 valid_cells，寻路不穿过空洞", () => {
  const grid = [[0, 0, 0], [], [0, 0, 0]];
  const fake = makePoisonCore({
    floorId: "irregular",
    currentMap: { title: "异形", width: undefined, height: undefined, map: grid },
    hero: {
      hp: 10, atk: 1, def: 1, money: 0, exp: 0,
      loc: { x: 2, y: 0, direction: "left" },
    },
  });
  const observation = lab.collectObservation(lab.createEngineAdapter(fake.scope));
  assert.equal(observation.topology.kind, "valid_cells");
  assert.equal(observation.topology.valid_cells.length, 6);
  const registry = lab.createBlockRegistry();
  assert.equal(lab.findSafePath(
    observation, registry, observation.hero.loc, { x: 2, y: 2 }, false,
  ), null);
});

test("v1 journal fail closed，新会话未经显式确认不能启动", async () => {
  const storage = lab.createMemoryStorage({
    "mota-planning-lab:journal:v1": { protocol: 1, pending_action: null },
  });
  assert.equal(lab.createJournal(storage).snapshot().migration_required, true);

  const observation = makeObservation();
  const journal = lab.createJournal(lab.createMemoryStorage());
  let requests = 0;
  const controller = lab.createController({
    adapter: {
      assertRequiredCapabilities() {}, stopAutomaticRoute() {},
    },
    journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => false, async postCycle() { requests += 1; return { status: "idle", reason: "x" }; } },
    panel: { update() {} },
    observe: () => observation,
    logger: { error() {} },
  });
  const initialized = await controller.initialize();
  assert.equal(initialized.requires_confirmation, true);
  const blocked = await controller.start();
  assert.equal(blocked.requires_confirmation, true);
  assert.equal(requests, 0);
  const confirmed = controller.confirmBaseline({ mode: "new_game" });
  assert.equal(confirmed.verified, true);
  assert.match(journal.snapshot().session_id, /^SESSION-/u);
});

test("v1 journal 普通确认/启动/重连均不能绕过，专用归档处置留下审计链", async () => {
  const legacy = {
    protocol: 1,
    pending_action: {
      action_id: "AUTO-00000000000000AA",
      phase: "executing",
      pre_fingerprint: `sha256:${"a".repeat(64)}`,
    },
    recovery: { phase: "pending" },
  };
  const storage = lab.createMemoryStorage({
    "mota-planning-lab:journal:v1": legacy,
  });
  const journal = lab.createJournal(storage);
  let requests = 0;
  const controller = lab.createController({
    adapter: { assertRequiredCapabilities() {}, stopAutomaticRoute() {} },
    journal,
    registry: lab.createBlockRegistry(),
    client: {
      isConnected: () => false,
      async postCycle() { requests += 1; return { status: "idle", reason: "x" }; },
    },
    panel: { update() {} },
    observe: () => makeObservation(),
    logger: { error() {} },
  });

  const initialized = await controller.initialize();
  assert.equal(initialized.detail_code, "JOURNAL_V1_MIGRATION_REQUIRED");
  assert.equal(controller.confirmBaseline({ mode: "new_game" }).verified, undefined);
  assert.equal(journal.snapshot().migration_required, true);
  await controller.start();
  await controller.reconnectOnly();
  assert.equal(requests, 0);
  assert.equal(journal.snapshot().migration_required, true);

  const archive = controller.archiveLegacyJournal();
  assert.match(archive.archive_id, /^legacy-archive:[a-f0-9]{64}$/u);
  assert.equal(archive.has_pending_or_recovery, true);
  assert.deepEqual(JSON.parse(JSON.stringify(archive.entries[0].payload)), legacy);
  assert.equal(controller.beginV2AfterLegacyArchive({
    archive_id: "legacy-archive:wrong",
    confirmation: "START_V2_NEW_SESSION",
  }).verified, undefined);
  const accepted = controller.beginV2AfterLegacyArchive({
    archive_id: archive.archive_id,
    confirmation: "START_V2_NEW_SESSION",
  });
  assert.equal(accepted.verified, true);
  const snapshot = journal.snapshot();
  assert.equal(snapshot.migration_required, false);
  assert.equal(snapshot.legacy_disposition.archive_id, archive.archive_id);
  assert.equal(snapshot.legacy_disposition.command, "START_V2_NEW_SESSION");
  assert.equal(snapshot.legacy_archive.entries[0].payload.pending_action.action_id,
    "AUTO-00000000000000AA");
});

test("v1 disposition 不得丢失既有 v2 recovery evidence，且 legacy 内容变化后重新 quarantine", () => {
  const legacyKey = "mota-planning-lab:journal:v1";
  const v2Key = "mota-planning-lab:journal:v2";
  const v2Evidence = Object.assign(
    lab.createJournal(lab.createMemoryStorage()).snapshot(), {
    session_id: "SESSION-V2-EVIDENCE",
    session_mode: "resume_existing_ledger",
    baseline: { fingerprint: `sha256:${"1".repeat(64)}` },
    pending_action: { action_id: "AUTO-00000000000000BB", pre_fingerprint: `sha256:${"2".repeat(64)}` },
    last_completed_action: { action_id: "AUTO-00000000000000BA", fingerprint: `sha256:${"3".repeat(64)}` },
    last_acknowledged_action_id: "AUTO-00000000000000B9",
    seen_action_ids: {
      "AUTO-00000000000000B9": "completed",
      "AUTO-00000000000000BA": "completed",
      "AUTO-00000000000000BB": "pending",
    },
    },
  );
  const storage = lab.createMemoryStorage({
    [legacyKey]: { protocol: 1, pending_action: { action_id: "AUTO-00000000000000AA" } },
    [v2Key]: v2Evidence,
  });
  const journal = lab.createJournal(storage);
  const archive = journal.archiveLegacyJournal();
  assert.throws(() => journal.authorizeV2AfterLegacyArchive({
    archive_id: archive.archive_id,
    confirmation: "START_V2_NEW_SESSION",
  }), /v2.*evidence|recovery evidence/iu);
  const preserved = journal.snapshot();
  assert.equal(preserved.pending_action.action_id, "AUTO-00000000000000BB");
  assert.equal(preserved.last_completed_action.action_id, "AUTO-00000000000000BA");
  assert.equal(preserved.last_acknowledged_action_id, "AUTO-00000000000000B9");
  assert.deepEqual(JSON.parse(JSON.stringify(preserved.seen_action_ids)), v2Evidence.seen_action_ids);
  assert.equal(preserved.migration_required, true);

  const cleanStorage = lab.createMemoryStorage({
    [legacyKey]: { protocol: 1, pending_action: { action_id: "AUTO-00000000000000AA" } },
  });
  const cleanJournal = lab.createJournal(cleanStorage);
  const cleanArchive = cleanJournal.archiveLegacyJournal();
  cleanJournal.authorizeV2AfterLegacyArchive({
    archive_id: cleanArchive.archive_id,
    confirmation: "START_V2_NEW_SESSION",
  });
  assert.equal(cleanJournal.snapshot().migration_required, false);
  cleanStorage.set(legacyKey, {
    protocol: 1,
    pending_action: { action_id: "AUTO-00000000000000CC" },
  });
  const changed = cleanJournal.snapshot();
  assert.equal(changed.migration_required, true);
  assert.notEqual(changed.legacy_disposition.archive_id,
    `legacy-archive:${lab.sha256(lab.canonicalize([{ key: legacyKey, payload: cleanStorage.get(legacyKey) }]))}`);
});

test("dimensions 与动态 grid 联合校验：ragged/缺行/短行转 valid_cells，完整矩形才 confirmed", () => {
  const cases = [
    { name: "empty-middle", grid: [[0, 0, 0], [], [0, 0, 0]], count: 6 },
    { name: "missing-tail", grid: [[0, 0, 0], [0, 0, 0]], count: 6 },
    { name: "short-row", grid: [[0, 0, 0], [0], [0, 0, 0]], count: 7 },
  ];
  for (const item of cases) {
    const fake = makePoisonCore({
      floorId: item.name,
      currentMap: { title: item.name, width: 3, height: 3, map: item.grid },
      hero: { hp: 10, atk: 1, def: 1, money: 0, exp: 0,
        loc: { x: 0, y: 0, direction: "down" } },
    });
    const observation = lab.collectObservation(lab.createEngineAdapter(fake.scope));
    assert.equal(observation.topology.kind, "valid_cells", item.name);
    assert.equal(observation.topology.confidence, "inferred", item.name);
    assert.equal(observation.topology.valid_cells.length, item.count, item.name);
  }
  const full = makePoisonCore({
    currentMap: { title: "full", width: 3, height: 3,
      map: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] },
    hero: { hp: 10, atk: 1, def: 1, money: 0, exp: 0,
      loc: { x: 0, y: 0, direction: "down" } },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(lab.collectObservation(lab.createEngineAdapter(full.scope)).topology)),
    { kind: "rectangle", source: "engine_current_map", confidence: "confirmed" },
  );
  const conflict = makePoisonCore({
    currentMap: { title: "conflict", width: 3, height: 3,
      map: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], valid_cells: [{ x: 0, y: 0 }] },
    hero: { hp: 10, atk: 1, def: 1, money: 0, exp: 0,
      loc: { x: 0, y: 0, direction: "down" } },
  });
  assert.throws(
    () => lab.collectObservation(lab.createEngineAdapter(conflict.scope)),
    (error) => error.detail_code === "TOPOLOGY_SOURCE_CONFLICT",
  );
});

test("同 floorId 的 map instance 转移按换图结算且不跨图比较 blocks", () => {
  const before = makeObservation({
    floor_id: "F1", map_instance_id: "map:A",
    blocks: [{ x: 1, y: 0, numeric_id: 1, id: "upFloor", cls: "terrains",
      trigger: "changeFloor", no_pass: true, damage: null, enemy: null }],
  });
  const after = makeObservation({
    floor_id: "F1", map_instance_id: "map:B",
    hero: { loc: { x: 5, y: 5, direction: "down" } },
    blocks: [{ x: 9, y: 9, numeric_id: 2, id: "wall", cls: "terrains",
      trigger: null, no_pass: true, damage: null, enemy: null }],
  });
  const unknown = lab.compareExpectedDelta(before, after, { map_instance_id: null }, {
    allowUnknownMapInstance: true, allowPositionChange: true,
  });
  assert.equal(unknown.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(unknown.actual)), {
    map_instance_changed: true, removed: [], added: [],
  });
  assert.equal(lab.compareExpectedDelta(before, after, { map_instance_id: "map:B" }, {
    allowUnknownMapInstance: true, allowPositionChange: true,
  }).ok, true);
  assert.equal(lab.compareExpectedDelta(before, before, { map_instance_id: null }, {
    allowUnknownMapInstance: true, allowPositionChange: true,
  }).ok, false);
});

test("服务 scan_state 通过严格 parser 后持久进入浏览器 journal", async () => {
  const observation = makeObservation();
  const journal = lab.createJournal(lab.createMemoryStorage());
  const scanState = {
    phase: "complete",
    anchor_map_instance_id: observation.map_instance_id,
    current_map_instance_id: observation.map_instance_id,
    scanned_map_instance_ids: [observation.map_instance_id],
    pending_transition_count: 0,
    traversed_transition_count: 0,
    frontier_count: 0,
    reason: "scan complete",
  };
  const controller = lab.createController({
    adapter: { assertRequiredCapabilities() {}, stopAutomaticRoute() {} },
    journal,
    registry: lab.createBlockRegistry(),
    client: {
      isConnected: () => true,
      async postCycle() {
        return lab.validateCycleResponse({
          status: "idle", reason: "[scan:complete] synthetic", scan_state: scanState,
        });
      },
    },
    panel: { update() {} }, observe: () => observation, logger: { error() {} },
  });
  controller.confirmBaseline({ mode: "new_game" });
  const result = await controller.start();
  assert.equal(result.idle, true);
  assert.deepEqual(JSON.parse(JSON.stringify(journal.snapshot().scan_state)), scanState);
});

test("handoff baseline逐字段校验，resume要求既有session id", () => {
  const observation = makeObservation();
  const makeController = () => {
    const journal = lab.createJournal(lab.createMemoryStorage());
    return {
      journal,
      controller: lab.createController({
        adapter: { assertRequiredCapabilities() {}, stopAutomaticRoute() {} },
        journal,
        registry: lab.createBlockRegistry(),
        client: { isConnected: () => false }, panel: { update() {} },
        observe: () => observation, logger: { error() {} },
      }),
    };
  };
  const mismatch = makeController();
  const guard = require("./helpers/runtime.js").makeGuard(observation);
  guard.hp += 1;
  mismatch.controller.confirmBaseline({ mode: "handoff_expected_guard", expected_guard: guard });
  assert.equal(mismatch.journal.snapshot().last_pause.detail_code, "SESSION_BASELINE_MISMATCH");

  const resumed = makeController();
  resumed.controller.confirmBaseline({ mode: "resume_existing_ledger" });
  assert.equal(resumed.journal.snapshot().last_pause.detail_code, "INVALID_SESSION_BASELINE");
  const accepted = makeController();
  assert.equal(accepted.controller.confirmBaseline({
    mode: "resume_existing_ledger", session_id: "SESSION-EXISTING",
  }).verified, true);
});

test("direct mount fake core完成只读初始化且只使用隔离的 witness/A-B namespace", async () => {
  const calls = [];
  const values = new Map();
  const scope = {
    localStorage: {
      getItem(key) { calls.push(["get", key]); return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { calls.push(["set", key]); values.set(key, value); },
    },
    fetch() { throw new Error("not called"); }, setTimeout, clearTimeout,
  };
  const environment = lab.createRuntimeEnvironment(scope, "direct-mount");
  assert.equal(environment.mode, "direct-mount");
  const pristineJournal = lab.createJournal(lab.createMemoryStorage()).snapshot();
  environment.storage.set(lab.JOURNAL_KEY, pristineJournal);
  assert.deepEqual(
    JSON.parse(JSON.stringify(environment.storage.get(lab.JOURNAL_KEY, null))),
    JSON.parse(JSON.stringify(pristineJournal)),
  );
  assert.deepEqual(new Set(calls.map((call) => call[1])), new Set([
    "mota-planning-lab:direct-mount:journal:v2",
  ]));
  assert.throws(() => environment.storage.set("foreign", {}), /namespace/u);
  const fake = makePoisonCore({
    floorId: "direct-runtime",
    currentMap: { title: "Direct", width: 13, height: 13 },
    hero: {
      hp: 100, atk: 10, def: 10, money: 0, exp: 0,
      loc: { x: 6, y: 10, direction: "up" },
    },
  });
  const journal = lab.createJournal(environment.storage);
  const controller = lab.createController({
    adapter: lab.createEngineAdapter(fake.scope), journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => false }, panel: { update() {} }, logger: { error() {} },
  });
  const initialized = await controller.initialize();
  assert.equal(initialized.requires_confirmation, true);
  assert.equal(fake.calls.direct.length + fake.calls.route.length, 0);
  assert.equal(controller.confirmBaseline({ mode: "new_game" }).verified, true);
  assert.equal(fake.calls.direct.length + fake.calls.route.length, 0);
  assert.deepEqual(new Set(values.keys()), new Set([
    "mota-planning-lab:direct-mount:journal:v2",
    "mota-planning-lab:direct-mount:journal:v2:slot:a",
    "mota-planning-lab:direct-mount:journal:v2:slot:b",
  ]));
});

test("direct mount 使用独立 v1 quarantine key 且普通 baseline 无法绕过", async () => {
  const values = new Map([[
    "mota-planning-lab:direct-mount:journal:v1",
    JSON.stringify({ protocol: 1, pending_action: { action_id: "AUTO-00000000000000AA" } }),
  ]]);
  const scope = {
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, value); },
    },
    fetch() { throw new Error("not called"); }, setTimeout, clearTimeout,
  };
  const environment = lab.createRuntimeEnvironment(scope, "direct-mount");
  const journal = lab.createJournal(environment.storage);
  assert.equal(journal.snapshot().migration_required, true);
  const controller = lab.createController({
    adapter: { assertRequiredCapabilities() {}, stopAutomaticRoute() {} }, journal,
    registry: lab.createBlockRegistry(), client: { isConnected: () => false },
    panel: { update() {} }, observe: () => makeObservation(), logger: { error() {} },
  });
  controller.confirmBaseline({ mode: "new_game" });
  assert.equal(journal.snapshot().migration_required, true);
  assert.equal(journal.snapshot().session_id, null);
});

test("固定 journal key 的 malformed、错误 shape/protocol 与读取异常全部 fail closed", async () => {
  const validShape = {
    protocol: 2, autopilot_enabled: false, session_id: null, session_mode: null,
    expected_guard: null, baseline: null, service_session_confirmed: false,
    migration_required: false, corruption_required: false, legacy_archive: null,
    legacy_disposition: null, corrupt_archive: null, corrupt_disposition: null,
    corrupt_evidence: [], scan_state: null, pending_action: null,
    last_completed_action: null, last_acknowledged_action_id: null,
    seen_action_ids: {}, last_pause: null, registry_entries: [],
  };
  const cases = [
    ["malformed-v1", "mota-planning-lab:direct-mount:journal:v1", "{"],
    ["malformed-v2", "mota-planning-lab:direct-mount:journal:v2", "{"],
    ["primitive-v2", "mota-planning-lab:direct-mount:journal:v2", "null"],
    ["array-v2", "mota-planning-lab:direct-mount:journal:v2", "[]"],
    ["wrong-protocol", "mota-planning-lab:direct-mount:journal:v2", JSON.stringify({ protocol: 1 })],
    ["missing-fields", "mota-planning-lab:direct-mount:journal:v2", JSON.stringify({ protocol: 2 })],
    ["extra-identity", "mota-planning-lab:direct-mount:journal:v2",
      JSON.stringify(Object.assign({}, validShape, { surprise_identity: "x" }))],
  ];
  for (const [name, key, raw] of cases) {
    const values = new Map([[key, raw]]);
    let requests = 0;
    const environment = lab.createRuntimeEnvironment({
      localStorage: {
        getItem(item) { return values.has(item) ? values.get(item) : null; },
        setItem(item, value) { values.set(item, value); },
      },
      fetch() { requests += 1; throw new Error("must not request"); }, setTimeout, clearTimeout,
    }, "direct-mount");
    const journal = lab.createJournal(environment.storage);
    const snapshot = journal.snapshot();
    assert.equal(snapshot.corruption_required, true, name);
    assert.equal(snapshot.autopilot_enabled, false, name);
    assert.ok(snapshot.corrupt_evidence.length >= 1, name);
    assert.match(snapshot.corrupt_evidence[0].content_hash, /^sha256:[a-f0-9]{64}$/u, name);
    assert.equal(Object.hasOwn(snapshot.corrupt_evidence[0], "raw"), false, name);
    const controller = lab.createController({
      adapter: { assertRequiredCapabilities() {}, stopAutomaticRoute() {} }, journal,
      registry: lab.createBlockRegistry(), client: { isConnected: () => false,
        async postCycle() { requests += 1; return { status: "idle", reason: "x" }; } },
      panel: { update() {} }, observe: () => makeObservation(), logger: { error() {} },
    });
    assert.equal((await controller.initialize()).detail_code, "JOURNAL_CORRUPT");
    assert.equal(controller.confirmBaseline({ mode: "new_game" }).verified, undefined, name);
    await controller.start();
    await controller.reconnectOnly();
    assert.equal(requests, 0, name);
  }

  const storage = {
    inspect() { return { status: "read_failed", key: lab.JOURNAL_KEY, raw_length: 0,
      content_hash: `sha256:${"0".repeat(64)}` }; },
    get() { throw new Error("read failed"); },
    set() { throw new Error("must not write"); },
  };
  assert.throws(
    () => lab.createJournal(storage).snapshot(),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
  );

  const readFailureEnvironment = lab.createRuntimeEnvironment({
    localStorage: {
      getItem() { throw new Error("storage unavailable"); },
      setItem() { throw new Error("must not write"); },
    },
    fetch() { throw new Error("must not request"); }, setTimeout, clearTimeout,
  }, "direct-mount");
  assert.throws(
    () => lab.createJournal(readFailureEnvironment.storage).snapshot(),
    (error) => error.detail_code === "JOURNAL_STORAGE_UNSTABLE",
  );
});

test("corrupt journal 处置与内容 fingerprint 绑定，改写后重新 quarantine", () => {
  const key = "mota-planning-lab:direct-mount:journal:v1";
  const values = new Map([[key, "{"]]);
  const environment = lab.createRuntimeEnvironment({
    localStorage: {
      getItem(item) { return values.has(item) ? values.get(item) : null; },
      setItem(item, value) { values.set(item, value); },
    }, fetch() { throw new Error("not called"); }, setTimeout, clearTimeout,
  }, "direct-mount");
  const journal = lab.createJournal(environment.storage);
  const archive = journal.archiveCorruptJournal();
  assert.match(archive.archive_id, /^corrupt-archive:[a-f0-9]{64}$/u);
  assert.throws(() => journal.authorizeV2AfterCorruptArchive({
    archive_id: "corrupt-archive:wrong", confirmation: "ARCHIVE_CORRUPT_AND_START_V2",
  }));
  journal.authorizeV2AfterCorruptArchive({
    archive_id: archive.archive_id, confirmation: "ARCHIVE_CORRUPT_AND_START_V2",
  });
  assert.equal(journal.snapshot().corruption_required, false);
  values.set(key, "{changed");
  const changed = journal.snapshot();
  assert.equal(changed.corruption_required, true);
  assert.notEqual(changed.corrupt_evidence[0].content_hash, archive.evidence[0].content_hash);
});

test("精确 map target 的浏览器差分 A→B 通过而 A→C 拒绝", () => {
  const before = makeObservation({ floor_id: "same", map_instance_id: "A" });
  const b = makeObservation({ floor_id: "same", map_instance_id: "B" });
  const c = makeObservation({ floor_id: "same", map_instance_id: "C" });
  assert.equal(lab.compareExpectedDelta(before, b, {
    floor_id: "same", map_instance_id: "B",
  }, { allowPositionChange: true }).ok, true);
  const mismatch = lab.compareExpectedDelta(before, c, {
    floor_id: "same", map_instance_id: "B",
  }, { allowPositionChange: true });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.differences.some((item) => item.field === "map_instance_id"));
});
