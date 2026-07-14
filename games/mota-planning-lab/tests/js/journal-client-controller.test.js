const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadRuntime,
  makeObservation,
  makeGuard,
  makePoisonCore,
  projectDir,
} = require("./helpers/runtime");

const lab = loadRuntime();

function establishTestSession(journal, observation) {
  journal.establishSession({
    session_id: "SESSION-SYNTHETIC-0001",
    mode: "new_game",
    baseline: lab.baselineSummary(observation),
  });
}

function makePanel() {
  const states = [];
  return { states, update(value) { states.push(value); } };
}

function makeControllerAdapter(currentRef) {
  const calls = { direct: 0, route: 0, stop: 0 };
  return {
    calls,
    assertRequiredCapabilities() { return {}; },
    stopAutomaticRoute() { calls.stop += 1; },
    canMoveDirectly() { return true; },
    moveDirectly(x, y) {
      calls.direct += 1;
      currentRef.value = makeObservation({ hero: { loc: { x, y } } });
    },
    setAutomaticRoute(x, y) {
      calls.route += 1;
      currentRef.value = makeObservation({ hero: { loc: { x, y } } });
    },
    readBusy() { return { moving: false, lock_control: false, event_active: false }; },
  };
}

function makeExecuteResponse(observation, actionId = "AUTO-0123456789ABCDEF") {
  return {
    status: "execute",
    action_id: actionId,
    action_kind: "MOVE_SAFE",
    operations: [{ type: "grid", x: 9, y: 3 }],
    guard: makeGuard(observation),
    expected_delta: { position: { x: 9, y: 3 } },
    reason: "synthetic safe corridor",
    supersedes_action_id: null,
    registry_entries: [],
  };
}

test("journal 跨实例持久化 pending、completed、cleared 与已见 action_id", () => {
  const storage = lab.createMemoryStorage();
  const first = lab.createJournal(storage);
  first.setPending({ action_id: "AUTO-one", pre_fingerprint: "sha256:one" });
  const second = lab.createJournal(storage);
  assert.equal(second.snapshot().pending_action.action_id, "AUTO-one");
  assert.equal(second.actionState("AUTO-one"), "pending");
  second.markCompleted({ action_id: "AUTO-one", fingerprint: "sha256:two" });
  assert.equal(first.actionState("AUTO-one"), "completed");
  assert.equal(first.snapshot().pending_action, null);
  first.setPending({ action_id: "AUTO-two", pre_fingerprint: "sha256:two" });
  first.clearPending();
  assert.equal(second.actionState("AUTO-two"), "cleared");
});

test("pending canonical 持久化失败时引擎零行动且不请求下一 action", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const durable = lab.createMemoryStorage();
  const setup = lab.createJournal(durable);
  establishTestSession(setup, current.value);
  setup.setAutopilot(true);
  const unstable = {
    inspect: durable.inspect,
    get: durable.get,
    set(key, value) {
      if (value && value.state && value.state.pending_action) return;
      durable.set(key, value);
    },
    delete: durable.delete,
  };
  const journal = lab.createJournal(unstable);
  let requests = 0;
  const controller = lab.createController({
    adapter, journal, registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, async postCycle() {
      requests += 1;
      return makeExecuteResponse(current.value);
    } },
    panel: makePanel(), observe: () => current.value, logger: { error() {} },
  });
  const result = await controller.runSingleCycle();
  assert.equal(result.detail_code, "JOURNAL_STORAGE_UNSTABLE");
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
  assert.equal(requests, 1);
  assert.equal(journal.snapshot().pending_action, null);
  assert.equal(journal.actionState("AUTO-0123456789ABCDEF"), null);
});

test("completed 或 ack canonical 持久化失败保留旧 identity 且零新行动", async () => {
  const before = makeObservation();
  const after = makeObservation({ hero: { hp: before.hero.hp + 10 } });
  const actionId = "AUTO-ABCDABCDABCDABCD";
  for (const failPhase of ["completed", "ack"]) {
    const durable = lab.createMemoryStorage();
    const setup = lab.createJournal(durable);
    establishTestSession(setup, before);
    setup.setPending({
      action_id: actionId,
      pre_fingerprint: lab.fingerprintObservation(before),
      pre_observation: before,
      expected_delta: { hp: 10 },
      allow_unknown_floor: false,
      allow_unknown_map_instance: false,
      requires_non_position_change: true,
      phase: "prepared",
    });
    let faultArmed = true;
    const unstable = {
      inspect: durable.inspect,
      get: durable.get,
      set(key, value) {
        const shouldDrop = faultArmed && (
          (failPhase === "completed" && value.state && value.state.last_completed_action)
          || (failPhase === "ack" && value.state && value.state.last_acknowledged_action_id)
        );
        if (shouldDrop) { faultArmed = false; return; }
        return durable.set(key, value);
      },
      delete: durable.delete,
    };
    const journal = lab.createJournal(unstable);
    const current = { value: after };
    const adapter = makeControllerAdapter(current);
    let requests = 0;
    const controller = lab.createController({
      adapter, journal, registry: lab.createBlockRegistry(),
      client: { isConnected: () => true, async postCycle() {
        requests += 1;
        if (requests === 1) return {
          status: "idle", reason: "accepted", acknowledged_action_id: actionId,
        };
        return makeExecuteResponse(after, "AUTO-NEWNEWNEWNEWNEW1");
      } },
      panel: makePanel(), observe: () => current.value, logger: { error() {} },
    });
    const failed = await controller.reconnectOnly();
    assert.equal(failed.detail_code, "JOURNAL_STORAGE_UNSTABLE", failPhase);
    assert.equal(adapter.calls.direct + adapter.calls.route, 0, failPhase);
    const evidence = journal.snapshot();
    if (failPhase === "completed") {
      assert.equal(evidence.pending_action.action_id, actionId);
      assert.equal(evidence.last_completed_action, null);
    } else {
      assert.equal(evidence.pending_action, null);
      assert.equal(evidence.last_completed_action.action_id, actionId);
    }
    assert.equal(evidence.last_acknowledged_action_id, null, failPhase);

    const repeated = await controller.reconnectOnly();
    assert.notEqual(repeated.completed, true, failPhase);
    assert.equal(adapter.calls.direct + adapter.calls.route, 0, failPhase);
    assert.equal(requests, 2, failPhase);
  }
});

test("localhost client 固定 endpoint、headers、POST 与最小 request 根字段", async () => {
  let captured;
  const client = lab.createLocalhostClient((request) => {
    captured = request;
    request.onload({ status: 200, responseText: JSON.stringify({ status: "idle", reason: "ok" }) });
  });
  const payload = lab.createCycleRequest({
    observation: makeObservation(), session: { mode: "new_game", command: "observe" },
  });
  const response = await client.postCycle(payload);
  assert.equal(response.status, "idle");
  assert.equal(captured.method, "POST");
  assert.equal(captured.url, "http://127.0.0.1:18724/cycle");
  assert.deepEqual(JSON.parse(JSON.stringify(captured.headers)), {
    "Content-Type": "application/json",
    "X-Mota-Lab": "1",
  });
  assert.deepEqual(Object.keys(JSON.parse(captured.data)).sort(), [
    "completed_action_id", "intent", "observation", "recovery", "session", "source",
  ]);
  assert.equal(JSON.parse(captured.data).intent, "cycle");
  assert.throws(() => lab.createCycleRequest({
    observation: makeObservation(), session: { mode: "new_game", command: "observe" },
    intent: null,
  }), /intent/iu);
  assert.equal(client.isConnected(), true);
});

test("localhost client 允许显式隔离端口但拒绝非 loopback endpoint", async () => {
  let captured;
  const client = lab.createLocalhostClient((request) => {
    captured = request;
    request.onload({ status: 200, responseText: JSON.stringify({ status: "idle", reason: "ok" }) });
  }, { cycleEndpoint: "http://127.0.0.1:34567/cycle" });
  await client.postCycle({});
  assert.equal(captured.url, "http://127.0.0.1:34567/cycle");
  for (const endpoint of [
    "http://localhost:34567/cycle",
    "http://0.0.0.0:34567/cycle",
    "https://127.0.0.1:34567/cycle",
    "http://127.0.0.1:34567/other",
    "http://127.0.0.1:70000/cycle",
  ]) {
    assert.throws(() => lab.createLocalhostClient(() => {}, { cycleEndpoint: endpoint }), /cycleEndpoint/iu);
  }
});

test("localhost 断开、500、非法 JSON 与非法响应都安全拒绝", async () => {
  for (const implementation of [
    (request) => request.onerror(new Error("offline")),
    (request) => request.onload({ status: 500, responseText: "{}" }),
    (request) => request.onload({ status: 422, responseText: "{}" }),
    (request) => request.onload({ status: 200, responseText: "{" }),
    (request) => request.onload({ status: 200, responseText: JSON.stringify({ status: "execute" }) }),
  ]) {
    const client = lab.createLocalhostClient(implementation);
    await assert.rejects(client.postCycle({}), (error) => (
      ["CONNECTION_FAILED", "HTTP_ERROR", "INVALID_RESPONSE"].includes(error.detail_code)
    ));
    assert.equal(client.isConnected(), false);
  }
});

test("localhost 非 2xx error envelope 保留服务错误码", async () => {
  const client = lab.createLocalhostClient((request) => request.onload({
    status: 422,
    responseText: JSON.stringify({
      status: "error",
      error_code: "SCHEMA_REJECTED",
      reason: "payload rejected",
    }),
  }));
  await assert.rejects(
    client.postCycle({}),
    (error) => error.detail_code === "SCHEMA_REJECTED" && error.cause === "payload rejected",
  );
});

test("localhost 重复 callback 只结算一次", async () => {
  const client = lab.createLocalhostClient((request) => {
    request.onload({ status: 200, responseText: JSON.stringify({ status: "idle", reason: "first" }) });
    request.onerror(new Error("late"));
  });
  const result = await client.postCycle({});
  assert.equal(result.reason, "first");
  assert.equal(client.isConnected(), true);
});

test("协议只允许登记的 pause_kind、lowercase registry 与统一 recovery phases", () => {
  assert.deepEqual(Array.from(lab.PAUSE_KINDS), [
    "NEW_OBJECT_OR_MECHANISM", "UNKNOWN_DAMAGE", "UNKNOWN_FLOOR",
    "EXPECTED_DELTA_MISMATCH", "GUARD_MISMATCH", "UNSUPPORTED_INTERACTION",
    "DECISION_SERVICE_UNAVAILABLE", "ENGINE_API_INCOMPATIBLE",
    "SESSION_CONFIRMATION_REQUIRED", "PLANNING_BUDGET_EXHAUSTED",
  ]);
  for (const pauseKind of lab.PAUSE_KINDS) {
    assert.equal(lab.validateCycleResponse({
      status: "pause",
      pause_kind: pauseKind,
      detail_code: "SYNTHETIC_PAUSE",
      reason: "synthetic pause",
      details: {},
    }).pause_kind, pauseKind);
  }
  assert.throws(
    () => lab.validateCycleResponse({
      status: "pause",
      pause_kind: "MANUAL",
      detail_code: "SYNTHETIC_PAUSE",
      reason: "synthetic pause",
      details: {},
    }),
    /Invalid pause_kind/,
  );
  assert.doesNotThrow(() => lab.validateRegistryEntries([{
    id: "wall", cls: "terrains", trigger: null, category: "wall",
    passable: false, boundary: false, fast_path: false, version: 1,
  }]));
  assert.throws(() => lab.validateRegistryEntries([{
    id: "wall", cls: "terrains", trigger: null, category: "wall",
    passable: false, boundary: false, fast_path: false,
  }]), /version/);
  assert.throws(() => lab.validateRegistryEntries([{
    id: "wall", cls: "terrains", trigger: null, category: "WALL",
    passable: false, boundary: false, fast_path: false, version: 1,
  }]), /category/);
  for (const phase of ["none", "pending", "not_executed", "completed", "mismatch"]) {
    assert.doesNotThrow(() => lab.createCycleRequest({
      observation: makeObservation(),
      session: { mode: "new_game", command: "observe" },
      recovery: { phase },
    }));
  }
  assert.throws(() => lab.createCycleRequest({
    observation: makeObservation(), session: { mode: "new_game", command: "observe" },
    recovery: { phase: "rejected" },
  }), /phase/);
  assert.deepEqual(JSON.parse(JSON.stringify(lab.validateCycleResponse({
    status: "error", error_code: "SCHEMA_ERROR", reason: "bad payload",
  }))), {
    status: "error", error_code: "SCHEMA_ERROR", reason: "bad payload", errors: [],
  });
});

test("共享 synthetic protocol response fixtures 可由浏览器严格解析", () => {
  const fixtures = JSON.parse(fs.readFileSync(
    path.join(projectDir, "tests/fixtures/protocol-responses.json"),
    "utf8",
  ));
  assert.equal(lab.validateCycleResponse(fixtures.execute).status, "execute");
  assert.equal(lab.validateCycleResponse(fixtures.pause).status, "pause");
  assert.equal(lab.validateCycleResponse(fixtures.idle).status, "idle");
  assert.equal(lab.validateCycleResponse(fixtures.recovery_ack).acknowledged_action_id,
    "AUTO-DEADBEEFDEADBEEF");
  assert.equal(lab.validateCycleResponse(fixtures.error).status, "error");
});

test("浏览器响应校验与 protocol 2 严格对齐所有嵌套字段", () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(projectDir, "tests/fixtures/protocol-responses.json"),
    "utf8",
  )).execute;
  fixture.registry_entries = [{
    id: "syntheticRedPotion",
    cls: "items",
    trigger: "getItem",
    category: "resource",
    passable: true,
    boundary: true,
    fast_path: false,
    version: 1,
  }];
  assert.equal(lab.validateCycleResponse(fixture).status, "execute");
  const stair = JSON.parse(JSON.stringify(fixture));
  stair.action_kind = "MOVE_TO_STAIR";
  stair.expected_delta = { floor_id: null };
  assert.equal(lab.validateCycleResponse(stair).expected_delta.floor_id, null);

  const invalidCases = [
    (value) => { value.action_id = "AUTO-deadbeefdeadbeef"; },
    (value) => { delete value.registry_entries[0].version; },
    (value) => { value.extra = true; },
    (value) => { value.registry_entries[0].extra = true; },
    (value) => { value.operations[0].extra = true; },
    (value) => { value.guard.extra = true; },
    (value) => { value.guard.keys.extra = 0; },
    (value) => { value.expected_delta.extra = 0; },
    (value) => { value.expected_delta.position = { x: 6, y: 3, extra: true }; },
    (value) => { value.expected_delta.keys = { yellow: 0, extra: 0 }; },
    (value) => { value.expected_delta.removed_blocks[0].extra = true; },
  ];
  for (const mutate of invalidCases) {
    const value = JSON.parse(JSON.stringify(fixture));
    mutate(value);
    assert.throws(() => lab.validateCycleResponse(value));
  }
  for (const [key, response] of Object.entries({
    pause: {
      status: "pause",
      pause_kind: "UNKNOWN_FLOOR",
      detail_code: "FLOOR_MODEL_MISSING",
      reason: "synthetic pause",
      details: {},
      extra: true,
    },
    idle: { status: "idle", reason: "synthetic idle", extra: true },
    error: { status: "error", error_code: "BAD", reason: "synthetic error", extra: true },
  })) {
    assert.throws(() => lab.validateCycleResponse(response), undefined, key);
  }
});

test("异常 localhost 响应在行动前映射 INVALID_RESPONSE", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  const invalid = makeExecuteResponse(current.value);
  invalid.guard.mixed_version_field = true;
  const client = lab.createLocalhostClient((request) => request.onload({
    status: 200,
    responseText: JSON.stringify(invalid),
  }));
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client,
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  });

  const result = await controller.runSingleCycle();
  assert.equal(result.pause_kind, "DECISION_SERVICE_UNAVAILABLE");
  assert.equal(journal.snapshot().last_pause.detail_code, "INVALID_RESPONSE");
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});

test("物理 save/load 默认禁用且不触发 doSL", () => {
  const fake = makePoisonCore();
  const adapter = lab.createEngineAdapter(fake.scope);
  const result = adapter.physicalSaveLoad(8, "save");
  assert.equal(result.executed, false);
  assert.equal(Object.hasOwn(result, "protected_slot"), false);
  assert.equal(adapter.capabilities().physical_save_load_enabled, false);
  assert.equal(fake.calls.saveLoad, 0);
});

test("首次稳定现场只展示，显式确认后仍保持 STOPPED 且零行动", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  const panel = makePanel();
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => false },
    panel,
    observe: () => current.value,
    logger: { error() {} },
  });
  const result = await controller.initialize();
  assert.equal(result.verified, false);
  assert.equal(result.requires_confirmation, true);
  assert.equal(result.auto_started, false);
  assert.equal(controller.getState(), "AWAITING_BASELINE_CONFIRMATION");
  const confirmed = controller.confirmBaseline({ mode: "new_game" });
  assert.equal(confirmed.verified, true);
  assert.equal(controller.getState(), "BASELINE_VERIFIED");
  assert.equal(journal.snapshot().autopilot_enabled, false);
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});

test("handoff expected guard 不符暂停且零行动", async () => {
  const current = { value: makeObservation({ hero: { hp: 207 } }) };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => false },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  });
  await controller.initialize();
  const guard = makeGuard(makeObservation());
  controller.confirmBaseline({ mode: "handoff_expected_guard", expected_guard: guard });
  assert.equal(journal.snapshot().last_pause.pause_kind, "GUARD_MISMATCH");
  assert.equal(journal.snapshot().last_pause.detail_code, "SESSION_BASELINE_MISMATCH");
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});

test("已 completed action_id 的重复响应绝不执行", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  journal.markCompleted({ action_id: "AUTO-0123456789ABCDEF", fingerprint: "sha256:done" });
  journal.acknowledge("AUTO-0123456789ABCDEF");
  const response = makeExecuteResponse(current.value);
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, postCycle: async () => response },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  });
  const result = await controller.runSingleCycle();
  assert.equal(result.duplicate_completed, true);
  assert.equal(result.executed, false);
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});

test("相同现场的新 action_id 不受旧 completed 记录阻挡并可执行", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  journal.markCompleted({ action_id: "AUTO-AAAAAAAAAAAAAAAA", fingerprint: "sha256:old" });
  journal.acknowledge("AUTO-AAAAAAAAAAAAAAAA");
  const response = makeExecuteResponse(current.value, "AUTO-BBBBBBBBBBBBBBBB");
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, postCycle: async () => response },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  }, {
    stabilityOptions: {
      pollMs: 0,
      timeoutMs: 100,
      sleep: async () => {},
      now: (() => { let tick = 0; return () => tick++; })(),
    },
  });
  const result = await controller.runSingleCycle();
  assert.equal(result.completed, true);
  assert.equal(adapter.calls.direct, 1);
  assert.equal(journal.actionState("AUTO-AAAAAAAAAAAAAAAA"), "completed");
  assert.equal(journal.actionState("AUTO-BBBBBBBBBBBBBBBB"), "completed");
});

test("pending prestate 不变时相同 action_id 恢复执行且只调用一次 API", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  const fingerprint = lab.fingerprintObservation(current.value);
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  journal.setPending({
    action_id: "AUTO-0123456789ABCDEF",
    pre_fingerprint: fingerprint,
    pre_observation: current.value,
    expected_delta: { position: { x: 9, y: 3 } },
  });
  const response = makeExecuteResponse(current.value);
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, postCycle: async () => response },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  }, {
    stabilityOptions: {
      pollMs: 0,
      timeoutMs: 100,
      sleep: async () => {},
      now: (() => { let tick = 0; return () => tick++; })(),
    },
  });
  const first = await controller.runSingleCycle();
  assert.equal(first.completed, true);
  assert.equal(first.action_id, "AUTO-0123456789ABCDEF");
  assert.equal(adapter.calls.direct, 1);
  assert.equal(adapter.calls.route, 0);
});

test("仅重新连接携带真实 pending recovery 身份且不执行返回行动", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  establishTestSession(journal, current.value);
  const fingerprint = lab.fingerprintObservation(current.value);
  journal.setPending({
    action_id: "AUTO-ABCDEF0123456789",
    pre_fingerprint: fingerprint,
    pre_observation: current.value,
    expected_delta: { position: { x: 9, y: 3 } },
    operations: [{ type: "grid", x: 9, y: 3 }],
  });
  let request;
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: {
      isConnected: () => true,
      async postCycle(payload) {
        request = payload;
        return { status: "idle", reason: "synthetic reconnect" };
      },
    },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  });
  const result = await controller.reconnectOnly();
  assert.equal(result.connected, true);
  assert.equal(result.executed, false);
  assert.deepEqual(JSON.parse(JSON.stringify(request.recovery)), {
    phase: "not_executed",
    pending_action_id: "AUTO-ABCDEF0123456789",
    pre_fingerprint: fingerprint,
    current_fingerprint: fingerprint,
    detail_code: null,
  });
  assert.equal(request.intent, "reconnect_only");
  assert.equal(request.completed_action_id, null);
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
  assert.equal(journal.snapshot().pending_action.action_id, "AUTO-ABCDEF0123456789");
});

test("reconnectOnly 遇到错误 execute 响应零执行并持久隔离 action identity", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  establishTestSession(journal, current.value);
  const unexpected = makeExecuteResponse(current.value, "AUTO-9999999999999999");
  let request;
  const controller = lab.createController({
    adapter, journal, registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, async postCycle(payload) {
      request = payload;
      return unexpected;
    } },
    panel: makePanel(), observe: () => current.value, logger: { error() {} },
  });
  const result = await controller.reconnectOnly();
  assert.equal(request.intent, "reconnect_only");
  assert.equal(result.connected, false);
  assert.equal(result.executed, false);
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
  const evidence = journal.snapshot().last_pause;
  assert.equal(evidence.detail_code, "RECONNECT_UNEXPECTED_EXECUTE");
  assert.equal(evidence.details.action_id, "AUTO-9999999999999999");
  assert.equal(evidence.details.response_status, "execute");
  assert.match(evidence.details.response_fingerprint, /^sha256:[a-f0-9]{64}$/u);
});

test("已证明未执行时服务重发同一 action_id，浏览器最多执行一次", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const storage = lab.createMemoryStorage();
  const beforeRefresh = lab.createJournal(storage);
  establishTestSession(beforeRefresh, current.value);
  beforeRefresh.setAutopilot(true);
  const fingerprint = lab.fingerprintObservation(current.value);
  const actionId = "AUTO-ABCDEF0123456789";
  beforeRefresh.setPending({
    action_id: actionId,
    pre_fingerprint: fingerprint,
    pre_observation: current.value,
    expected_delta: { position: { x: 9, y: 3 } },
    operations: [{ type: "grid", x: 9, y: 3 }],
    phase: "prepared",
  });
  const journal = lab.createJournal(storage);
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, postCycle: async () => makeExecuteResponse(current.value, actionId) },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  }, {
    stabilityOptions: {
      pollMs: 0,
      timeoutMs: 100,
      sleep: async () => {},
      now: (() => { let tick = 0; return () => tick++; })(),
    },
  });
  const result = await controller.runSingleCycle();
  assert.equal(result.completed, true);
  assert.equal(result.action_id, actionId);
  assert.equal(adapter.calls.direct, 1);
  assert.equal(journal.actionState(actionId), "completed");
});

test("not_executed 收到新 action_id 即使带 supersedes 也拒绝且零行动", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  const fingerprint = lab.fingerprintObservation(current.value);
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  journal.setPending({
    action_id: "AUTO-AAAAAAAAAAAAAAAA",
    pre_fingerprint: fingerprint,
    pre_observation: current.value,
    expected_delta: { position: { x: 9, y: 3 } },
  });
  const response = makeExecuteResponse(current.value, "AUTO-BBBBBBBBBBBBBBBB");
  response.supersedes_action_id = "AUTO-AAAAAAAAAAAAAAAA";
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, postCycle: async () => response },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  }, {
    stabilityOptions: {
      pollMs: 0,
      timeoutMs: 100,
      sleep: async () => {},
      now: (() => { let tick = 0; return () => tick++; })(),
    },
  });
  const result = await controller.runSingleCycle();
  assert.equal(result.pause_kind, "DECISION_SERVICE_UNAVAILABLE");
  assert.equal(journal.snapshot().last_pause.detail_code, "INVALID_RECOVERY_REISSUE");
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
  assert.equal(journal.actionState("AUTO-AAAAAAAAAAAAAAAA"), "pending");
  assert.equal(journal.actionState("AUTO-BBBBBBBBBBBBBBBB"), null);
});

test("registry_entries 超出当前 observation 范围时拒绝且零行动", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  const response = makeExecuteResponse(current.value);
  response.registry_entries = [{
    id: "unrelated", cls: "terrains", trigger: null,
    category: "terrain", passable: true, boundary: false, fast_path: true,
  }];
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, postCycle: async () => response },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  });
  await controller.runSingleCycle();
  assert.equal(journal.snapshot().last_pause.detail_code, "REGISTRY_SCOPE_VIOLATION");
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});

test("状态变化边界缺少非位置 postcondition 时行动前拒绝", async () => {
  const resource = {
    x: 9, y: 3, numeric_id: 31, id: "syntheticResource", cls: "items",
    trigger: "getItem", no_pass: false, damage: null, enemy: null,
  };
  const current = { value: makeObservation({ blocks: [resource] }) };
  const calls = { direct: 0, route: 0, stop: 0 };
  const adapter = {
    calls,
    stopAutomaticRoute() { calls.stop += 1; },
    canMoveDirectly() { return true; },
    moveDirectly() { calls.direct += 1; },
    setAutomaticRoute(x, y) {
      calls.route += 1;
      current.value = makeObservation({ hero: { loc: { x, y } }, blocks: [resource] });
    },
    readBusy() { return { moving: false, lock_control: false, event_active: false }; },
  };
  const journal = lab.createJournal(lab.createMemoryStorage());
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  const response = makeExecuteResponse(current.value, "AUTO-CCCCCCCCCCCCCCCC");
  response.action_kind = "MOVE_TO_RESOURCE";
  response.expected_delta = { position: { x: 9, y: 3 } };
  response.registry_entries = [{
    id: resource.id, cls: resource.cls, trigger: resource.trigger, category: "resource",
    passable: true, boundary: true, fast_path: false, version: 1,
  }];
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, postCycle: async () => response },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  }, {
    stabilityOptions: {
      pollMs: 0,
      timeoutMs: 100,
      sleep: async () => {},
      now: (() => { let tick = 0; return () => tick++; })(),
    },
  });

  const result = await controller.runSingleCycle();
  assert.equal(result.pause_kind, "DECISION_SERVICE_UNAVAILABLE");
  assert.equal(journal.snapshot().last_pause.detail_code, "INVALID_RESPONSE");
  assert.equal(journal.actionState(response.action_id), null);
  assert.equal(calls.direct + calls.route, 0);
});

test("边界目标 block 仍存在且只有位置变化时不得 completed", async () => {
  const resource = {
    x: 9, y: 3, numeric_id: 31, id: "syntheticResource", cls: "items",
    trigger: "getItem", no_pass: false, damage: null, enemy: null,
  };
  const current = { value: makeObservation({ blocks: [resource] }) };
  const calls = { direct: 0, route: 0, stop: 0 };
  const adapter = {
    calls,
    stopAutomaticRoute() { calls.stop += 1; },
    canMoveDirectly() { return true; },
    moveDirectly() { calls.direct += 1; },
    setAutomaticRoute(x, y) {
      calls.route += 1;
      current.value = makeObservation({ hero: { loc: { x, y } }, blocks: [resource] });
    },
    readBusy() { return { moving: false, lock_control: false, event_active: false }; },
  };
  const journal = lab.createJournal(lab.createMemoryStorage());
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  const response = makeExecuteResponse(current.value, "AUTO-DDDDDDDDDDDDDDDD");
  response.action_kind = "MOVE_TO_RESOURCE";
  response.expected_delta = {
    position: { x: 9, y: 3 },
    removed_blocks: [{ x: 9, y: 3, id: resource.id }],
  };
  response.registry_entries = [{
    id: resource.id, cls: resource.cls, trigger: resource.trigger, category: "resource",
    passable: true, boundary: true, fast_path: false, version: 1,
  }];
  const controller = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, postCycle: async () => response },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  }, {
    stabilityOptions: {
      pollMs: 0,
      timeoutMs: 100,
      sleep: async () => {},
      now: (() => { let tick = 0; return () => tick++; })(),
    },
  });

  const result = await controller.runSingleCycle();
  assert.equal(result.pause_kind, "EXPECTED_DELTA_MISMATCH");
  assert.equal(journal.snapshot().last_pause.detail_code, "RESOURCE_DELTA_MISMATCH");
  assert.notEqual(journal.actionState(response.action_id), "completed");
  assert.equal(calls.route, 1);
});

test("不安全多边界响应保留同一 ID，刷新后复现即暂停且始终零行动", async () => {
  const door = {
    x: 9, y: 3, numeric_id: 21, id: "syntheticDoor", cls: "terrains",
    trigger: "openDoor", no_pass: true, damage: null, enemy: null,
  };
  const current = { value: makeObservation({ blocks: [door] }) };
  const adapter = makeControllerAdapter(current);
  const storage = lab.createMemoryStorage();
  const journal = lab.createJournal(storage);
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  const registryEntry = {
    id: door.id, cls: door.cls, trigger: door.trigger, category: "door",
    passable: false, boundary: true, fast_path: false, version: 1,
  };
  function unsafeResponse(actionId, supersedes = null) {
    return {
      status: "execute",
      action_id: actionId,
      action_kind: "UNSAFE_SYNTHETIC",
      operations: [
        { type: "grid", x: 9, y: 3 },
        { type: "grid", x: 10, y: 3 },
      ],
      guard: makeGuard(current.value),
      expected_delta: {},
      reason: "synthetic unsafe multi-boundary",
      supersedes_action_id: supersedes,
      registry_entries: [registryEntry],
    };
  }
  const firstController = lab.createController({
    adapter,
    journal,
    registry: lab.createBlockRegistry(),
    client: {
      isConnected: () => true,
      postCycle: async () => unsafeResponse("AUTO-1111111111111111"),
    },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  });
  const first = await firstController.runSingleCycle();
  assert.equal(first.rejected, true);
  assert.equal(journal.snapshot().pending_action.phase, "not_executed");
  assert.equal(journal.snapshot().pending_action.rejection_count, 1);
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);

  const refreshedController = lab.createController({
    adapter,
    journal: lab.createJournal(storage),
    registry: lab.createBlockRegistry(),
    client: {
      isConnected: () => true,
      postCycle: async () => unsafeResponse("AUTO-1111111111111111"),
    },
    panel: makePanel(),
    observe: () => current.value,
    logger: { error() {} },
  });
  const second = await refreshedController.runSingleCycle();
  assert.equal(second.pause_kind, "DECISION_SERVICE_UNAVAILABLE");
  assert.equal(journal.snapshot().last_pause.detail_code, "UNSAFE_MULTI_BOUNDARY_RESPONSE");
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});

test("十个菜单含 v1/损坏 journal 专用归档处置，清 pending 要确认，重连零执行", async () => {
  const labels = [];
  const calls = { confirm: 0, archive: 0, dispose: 0, corruptArchive: 0,
    corruptDispose: 0, start: 0, pause: 0, export: 0, clear: 0, reconnect: 0 };
  const controller = {
    confirmBaseline() { calls.confirm += 1; },
    archiveLegacyJournal() { calls.archive += 1; },
    getLegacyArchive() { return { archive_id: "legacy-archive:test" }; },
    beginV2AfterLegacyArchive() { calls.dispose += 1; },
    archiveCorruptJournal() { calls.corruptArchive += 1; },
    getCorruptArchive() { return { archive_id: "corrupt-archive:test" }; },
    beginV2AfterCorruptArchive() { calls.corruptDispose += 1; },
    start() { calls.start += 1; },
    manualPause() { calls.pause += 1; },
    getCurrentObservation() { return makeObservation(); },
    clearPending() { calls.clear += 1; },
    reconnectOnly() { calls.reconnect += 1; return { executed: false }; },
  };
  const handlers = new Map();
  lab.registerMenus({
    register(label, handler) { labels.push(label); handlers.set(label, handler); },
    controller,
    confirmAction: () => false,
    exporter: () => { calls.export += 1; },
  });
  assert.deepEqual(labels, [
    "确认新会话基线",
    "归档旧 v1 journal 证据", "确认归档后开始 v2 新会话",
    "归档损坏 journal 摘要", "确认损坏 journal 归档后开始 v2",
    "启动自动驾驶", "暂停自动驾驶", "导出当前层运行态",
    "清除待执行行动", "仅重新连接本地决策器",
  ]);
  for (const label of labels) handlers.get(label)();
  assert.deepEqual(calls, {
    confirm: 1, archive: 1, dispose: 0, corruptArchive: 1, corruptDispose: 0,
    start: 1, pause: 1, export: 1, clear: 0, reconnect: 1,
  });
});

test("reconnectOnly 对 pause/error/malformed/network 全部保留 completed recovery，明确 ack 后才结算", async () => {
  const before = makeObservation();
  const after = makeObservation({ hero: { hp: before.hero.hp + 10 } });
  const actionId = "AUTO-AAAAAAAAAAAAAAAA";
  const cases = [
    ["ledger-mismatch", async () => ({
      status: "pause", pause_kind: "EXPECTED_DELTA_MISMATCH",
      detail_code: "RECOVERY_JOURNAL_LEDGER_MISMATCH", reason: "mismatch", details: {},
    }), "RECOVERY_JOURNAL_LEDGER_MISMATCH"],
    ["delta-mismatch", async () => ({
      status: "pause", pause_kind: "EXPECTED_DELTA_MISMATCH",
      detail_code: "EXPECTED_DELTA_MISMATCH", reason: "mismatch", details: {},
    }), "EXPECTED_DELTA_MISMATCH"],
    ["error", async () => ({ status: "error", error_code: "SERVER_ERROR", reason: "bad" }),
      "SERVER_ERROR"],
    ["malformed", async () => { const error = new Error("malformed");
      error.detail_code = "INVALID_RESPONSE"; throw error; }, "INVALID_RESPONSE"],
    ["network", async () => { const error = new Error("offline");
      error.detail_code = "CONNECTION_FAILED"; throw error; }, "CONNECTION_FAILED"],
  ];
  for (const [name, postCycle, detail] of cases) {
    const current = { value: after };
    const adapter = makeControllerAdapter(current);
    const journal = lab.createJournal(lab.createMemoryStorage());
    establishTestSession(journal, before);
    journal.setPending({
      action_id: actionId,
      pre_fingerprint: lab.fingerprintObservation(before),
      pre_observation: before,
      expected_delta: { hp: 10 },
      allow_unknown_floor: false,
      allow_unknown_map_instance: false,
      requires_non_position_change: true,
      phase: "prepared",
    });
    const controller = lab.createController({
      adapter, journal, registry: lab.createBlockRegistry(),
      client: { isConnected: () => false, postCycle }, panel: makePanel(),
      observe: () => current.value, logger: { error() {} },
    });
    const result = await controller.reconnectOnly();
    assert.equal(result.connected, false, name);
    assert.equal(result.executed, false, name);
    assert.equal(journal.snapshot().pending_action.action_id, actionId, name);
    assert.equal(journal.snapshot().last_acknowledged_action_id, null, name);
    assert.equal(journal.snapshot().last_pause.detail_code, detail, name);
    assert.equal(adapter.calls.direct + adapter.calls.route, 0, name);
  }

  const storage = lab.createMemoryStorage();
  const current = { value: after };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(storage);
  establishTestSession(journal, before);
  journal.setPending({
    action_id: actionId,
    pre_fingerprint: lab.fingerprintObservation(before),
    pre_observation: before,
    expected_delta: { hp: 10 },
    allow_unknown_floor: false,
    allow_unknown_map_instance: false,
    requires_non_position_change: true,
    phase: "prepared",
  });
  let calls = 0;
  const controller = lab.createController({
    adapter, journal, registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, async postCycle() {
      calls += 1;
      return Object.assign({ status: "idle", reason: "recovery accepted" },
        calls === 1 ? { acknowledged_action_id: actionId } : {});
    } }, panel: makePanel(), observe: () => current.value, logger: { error() {} },
  });
  const accepted = await controller.reconnectOnly();
  assert.equal(accepted.connected, true);
  assert.equal(accepted.response_status, "idle");
  assert.equal(journal.snapshot().pending_action, null);
  assert.equal(journal.snapshot().last_completed_action.action_id, actionId);
  assert.equal(journal.snapshot().last_acknowledged_action_id, actionId);
  const repeated = await controller.reconnectOnly();
  assert.equal(repeated.connected, true);
  assert.equal(calls, 2);
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});

test("黄钥匙归零字段被 canonical tools 省略后，刷新重连只补记 completed/ack 且不重放", async () => {
  const door = {
    x: 6, y: 8, id: 21,
    event: { id: "yellowDoor", cls: "terrains", trigger: "openDoor", noPass: true },
  };
  const beforeRuntime = makePoisonCore({
    floorId: "MT0",
    currentMap: { title: "0F", width: 11, height: 11 },
    blocks: [door],
    hero: {
      hp: 1000, atk: 10, def: 10, money: 0, exp: 0,
      loc: { x: 6, y: 10, direction: "up" },
      items: { tools: { yellowKey: 1, blueKey: 1, redKey: 1 } },
    },
  });
  const afterRuntime = makePoisonCore({
    floorId: "MT0",
    currentMap: { title: "0F", width: 11, height: 11 },
    blocks: [],
    hero: {
      hp: 1000, atk: 10, def: 10, money: 0, exp: 0,
      loc: { x: 6, y: 9, direction: "up" },
      items: { tools: { blueKey: 1, redKey: 1 } },
    },
  });
  const beforeAdapter = lab.createEngineAdapter(beforeRuntime.scope);
  const afterAdapter = lab.createEngineAdapter(afterRuntime.scope);
  const before = lab.collectObservation(beforeAdapter, () => 1);
  before.session_id = "SESSION-SYNTHETIC-0001";
  const actionId = "AUTO-0000000000000001";
  const storage = lab.createMemoryStorage();
  const setup = lab.createJournal(storage);
  establishTestSession(setup, before);
  setup.setPending({
    action_id: actionId,
    pre_fingerprint: lab.fingerprintObservation(before),
    pre_observation: before,
    expected_delta: {
      keys: { yellow: -1 },
      removed_blocks: [{ x: 6, y: 8, id: "yellowDoor" }],
    },
    allow_unknown_floor: false,
    allow_unknown_map_instance: false,
    requires_non_position_change: true,
    operations: [{ type: "grid", x: 6, y: 9 }, { type: "grid", x: 6, y: 8 }],
    phase: "prepared",
  });

  const requests = [];
  const restarted = lab.createController({
    adapter: afterAdapter,
    journal: lab.createJournal(storage),
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, async postCycle(request) {
      requests.push(request);
      return {
        status: "idle", reason: "recovery accepted",
        acknowledged_action_id: actionId, registry_entries: [],
      };
    } },
    panel: makePanel(),
    observe: () => lab.collectObservation(afterAdapter, () => 2),
    logger: { error() {} },
  });
  const recovered = await restarted.reconnectOnly();
  assert.equal(recovered.connected, true);
  assert.equal(recovered.executed, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].completed_action_id, actionId);
  assert.equal(requests[0].recovery.phase, "completed");
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].observation.keys)), {
    yellow: 0, blue: 1, red: 1,
  });
  const recoveredJournal = lab.createJournal(storage).snapshot();
  assert.equal(recoveredJournal.pending_action, null);
  assert.equal(recoveredJournal.last_completed_action.action_id, actionId);
  assert.equal(recoveredJournal.last_completed_action.recovered, true);
  assert.equal(recoveredJournal.last_acknowledged_action_id, actionId);
  assert.equal(afterRuntime.calls.direct.length + afterRuntime.calls.route.length, 0);

  const reloadedRequests = [];
  const reloaded = lab.createController({
    adapter: afterAdapter,
    journal: lab.createJournal(storage),
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, async postCycle(request) {
      reloadedRequests.push(request);
      return { status: "idle", reason: "already acknowledged", registry_entries: [] };
    } },
    panel: makePanel(),
    observe: () => lab.collectObservation(afterAdapter, () => 3),
    logger: { error() {} },
  });
  const repeated = await reloaded.reconnectOnly();
  assert.equal(repeated.connected, true);
  assert.equal(repeated.executed, false);
  assert.equal(reloadedRequests[0].completed_action_id, null);
  assert.equal(reloadedRequests[0].recovery.phase, "none");
  assert.equal(afterRuntime.calls.direct.length + afterRuntime.calls.route.length, 0);
});

test("换层后出现实时可解释的不可战斗怪物仍先完成 pending/ack 且重连零重放", async () => {
  const stair = {
    x: 1, y: 0, id: 88,
    event: { id: "upFloor", cls: "terrains", trigger: "changeFloor", noPass: true },
  };
  const enemy = {
    x: 0, y: 0, id: 201,
    event: { id: "blackSlime", cls: "enemy48", trigger: "battle", noPass: true },
  };
  const beforeRuntime = makePoisonCore({
    floorId: "MT0",
    currentMap: { title: "0F", width: 2, height: 1 },
    blocks: [stair],
    hero: {
      hp: 1000, atk: 10, def: 10, money: 0, exp: 0,
      loc: { x: 0, y: 0, direction: "right" },
      items: { tools: { blueKey: 1, redKey: 1 } },
    },
  });
  const afterRuntime = makePoisonCore({
    floorId: "MT1",
    currentMap: { title: "1F", width: 2, height: 1 },
    blocks: [enemy],
    damage: { blackSlime: null },
    enemyInfo: {
      blackSlime: { hp: 200, atk: 35, def: 10, money: 5, exp: 5, special: 0 },
    },
    hero: {
      hp: 1000, atk: 10, def: 10, money: 0, exp: 0,
      loc: { x: 1, y: 0, direction: "up" },
      items: { tools: { blueKey: 1, redKey: 1 } },
    },
  });
  const beforeAdapter = lab.createEngineAdapter(beforeRuntime.scope);
  const afterAdapter = lab.createEngineAdapter(afterRuntime.scope);
  const before = lab.collectObservation(beforeAdapter, () => 1);
  before.session_id = "SESSION-SYNTHETIC-0001";
  const actionId = "AUTO-0000000000000002";
  const storage = lab.createMemoryStorage();
  const setup = lab.createJournal(storage);
  establishTestSession(setup, before);
  setup.setPending({
    action_id: actionId,
    pre_fingerprint: lab.fingerprintObservation(before),
    pre_observation: before,
    expected_delta: { map_instance_id: null },
    allow_unknown_floor: true,
    allow_unknown_map_instance: true,
    requires_non_position_change: true,
    operations: [{ type: "grid", x: 1, y: 0 }],
    phase: "prepared",
  });

  const requests = [];
  const restarted = lab.createController({
    adapter: afterAdapter,
    journal: lab.createJournal(storage),
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, async postCycle(request) {
      requests.push(request);
      return {
        status: "idle", reason: "change-map recovery accepted",
        acknowledged_action_id: actionId, registry_entries: [],
      };
    } },
    panel: makePanel(),
    observe: () => lab.collectObservation(afterAdapter, () => 2),
    logger: { error() {} },
  });
  const recovered = await restarted.reconnectOnly();
  assert.equal(recovered.connected, true);
  assert.equal(recovered.executed, false);
  assert.equal(requests[0].completed_action_id, actionId);
  assert.equal(requests[0].recovery.phase, "completed");
  assert.equal(requests[0].observation.floor_id, "MT1");
  assert.equal(requests[0].observation.blocks[0].damage, null);
  assert.equal(requests[0].observation.blocks[0].enemy.defense, 10);
  assert.equal(requests[0].observation.blocks[0].enemy.experience, 5);
  assert.equal(afterRuntime.calls.direct.length + afterRuntime.calls.route.length, 0);

  const durable = lab.createJournal(storage).snapshot();
  assert.equal(durable.pending_action, null);
  assert.equal(durable.last_completed_action.action_id, actionId);
  assert.equal(durable.last_acknowledged_action_id, actionId);

  const reloadedRequests = [];
  const reloaded = lab.createController({
    adapter: afterAdapter,
    journal: lab.createJournal(storage),
    registry: lab.createBlockRegistry(),
    client: { isConnected: () => true, async postCycle(request) {
      reloadedRequests.push(request);
      return { status: "idle", reason: "already acknowledged", registry_entries: [] };
    } },
    panel: makePanel(),
    observe: () => lab.collectObservation(afterAdapter, () => 3),
    logger: { error() {} },
  });
  const repeated = await reloaded.reconnectOnly();
  assert.equal(repeated.executed, false);
  assert.equal(reloadedRequests[0].completed_action_id, null);
  assert.equal(reloadedRequests[0].recovery.phase, "none");
  assert.equal(afterRuntime.calls.direct.length + afterRuntime.calls.route.length, 0);
});
