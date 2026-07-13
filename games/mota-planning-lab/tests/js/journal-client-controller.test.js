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

test("localhost client 固定 endpoint、headers、POST 与最小 request 根字段", async () => {
  let captured;
  const client = lab.createLocalhostClient((request) => {
    captured = request;
    request.onload({ status: 200, responseText: JSON.stringify({ status: "idle", reason: "ok" }) });
  });
  const payload = lab.createCycleRequest({ observation: makeObservation() });
  const response = await client.postCycle(payload);
  assert.equal(response.status, "idle");
  assert.equal(captured.method, "POST");
  assert.equal(captured.url, "http://127.0.0.1:18724/cycle");
  assert.deepEqual(JSON.parse(JSON.stringify(captured.headers)), {
    "Content-Type": "application/json",
    "X-Mota-Lab": "1",
  });
  assert.deepEqual(Object.keys(JSON.parse(captured.data)).sort(), [
    "completed_action_id", "observation", "recovery", "source",
  ]);
  assert.equal(client.isConnected(), true);
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

test("协议只允许八类 pause_kind、lowercase registry 与统一 recovery phases", () => {
  assert.deepEqual(Array.from(lab.PAUSE_KINDS), [
    "NEW_OBJECT_OR_MECHANISM", "UNKNOWN_DAMAGE", "UNKNOWN_FLOOR",
    "EXPECTED_DELTA_MISMATCH", "GUARD_MISMATCH", "UNSUPPORTED_INTERACTION",
    "DECISION_SERVICE_UNAVAILABLE", "ENGINE_API_INCOMPATIBLE",
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
      recovery: { phase },
    }));
  }
  assert.throws(() => lab.createCycleRequest({
    observation: makeObservation(), recovery: { phase: "rejected" },
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
  assert.equal(lab.validateCycleResponse(fixtures.error).status, "error");
});

test("浏览器响应校验与 protocol 1 严格对齐所有嵌套字段", () => {
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
  journal.verifyBaseline(lab.fingerprintObservation(current.value));
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

test("物理 save/load 永久禁用且 slot 8 不触发 doSL", () => {
  const fake = makePoisonCore();
  const adapter = lab.createEngineAdapter(fake.scope);
  const result = adapter.physicalSaveLoad(8, "save");
  assert.equal(result.executed, false);
  assert.equal(result.protected_slot, 8);
  assert.equal(adapter.capabilities().physical_save_load_enabled, false);
  assert.equal(fake.calls.saveLoad, 0);
});

test("首次现场核对通过后仍保持 STOPPED 且零行动", async () => {
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
  assert.equal(result.verified, true);
  assert.equal(result.auto_started, false);
  assert.equal(controller.getState(), "BASELINE_VERIFIED");
  assert.equal(journal.snapshot().autopilot_enabled, false);
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});

test("首次现场不符暂停 GUARD_MISMATCH 且零行动", async () => {
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
  assert.equal(journal.snapshot().last_pause.pause_kind, "GUARD_MISMATCH");
  assert.equal(journal.snapshot().last_pause.detail_code, "INITIAL_BASELINE_MISMATCH");
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});

test("已 completed action_id 的重复响应绝不执行", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  journal.verifyBaseline(lab.fingerprintObservation(current.value));
  journal.setAutopilot(true);
  journal.markCompleted({ action_id: "AUTO-0123456789ABCDEF", fingerprint: "sha256:done" });
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
  journal.verifyBaseline(lab.fingerprintObservation(current.value));
  journal.setAutopilot(true);
  journal.markCompleted({ action_id: "AUTO-AAAAAAAAAAAAAAAA", fingerprint: "sha256:old" });
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

test("pending 相同 action_id 只恢复判断不重放，重复两次后安全暂停", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  const fingerprint = lab.fingerprintObservation(current.value);
  journal.verifyBaseline(fingerprint);
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
  });
  const first = await controller.runSingleCycle();
  assert.equal(first.duplicate_pending, true);
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
  const second = await controller.runSingleCycle();
  assert.equal(second.pause_kind, "DECISION_SERVICE_UNAVAILABLE");
  assert.equal(journal.snapshot().last_pause.detail_code, "DUPLICATE_PENDING_RESPONSE");
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});

test("not_executed 只有新 action_id + supersedes 才能重签并执行", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  const fingerprint = lab.fingerprintObservation(current.value);
  journal.verifyBaseline(fingerprint);
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
  assert.equal(result.completed, true);
  assert.equal(adapter.calls.direct, 1);
  assert.equal(journal.actionState("AUTO-AAAAAAAAAAAAAAAA"), "abandoned");
  assert.equal(journal.actionState("AUTO-BBBBBBBBBBBBBBBB"), "completed");
});

test("registry_entries 超出当前 observation 范围时拒绝且零行动", async () => {
  const current = { value: makeObservation() };
  const adapter = makeControllerAdapter(current);
  const journal = lab.createJournal(lab.createMemoryStorage());
  journal.verifyBaseline(lab.fingerprintObservation(current.value));
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
  journal.verifyBaseline(lab.fingerprintObservation(current.value));
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
  journal.verifyBaseline(lab.fingerprintObservation(current.value));
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

test("不安全多边界响应先请求重签，刷新后再次出现才暂停且始终零行动", async () => {
  const door = {
    x: 9, y: 3, numeric_id: 21, id: "syntheticDoor", cls: "terrains",
    trigger: "openDoor", no_pass: true, damage: null, enemy: null,
  };
  const current = { value: makeObservation({ blocks: [door] }) };
  const adapter = makeControllerAdapter(current);
  const storage = lab.createMemoryStorage();
  const journal = lab.createJournal(storage);
  journal.verifyBaseline(lab.fingerprintObservation(current.value));
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
      postCycle: async () => unsafeResponse(
        "AUTO-2222222222222222",
        "AUTO-1111111111111111",
      ),
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

test("五个菜单完整注册，清 pending 要确认，重新连接不执行行动", async () => {
  const labels = [];
  const calls = { start: 0, pause: 0, export: 0, clear: 0, reconnect: 0 };
  const controller = {
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
    "启动自动驾驶", "暂停自动驾驶", "导出当前层运行态",
    "清除待执行行动", "仅重新连接本地决策器",
  ]);
  for (const label of labels) handlers.get(label)();
  assert.deepEqual(calls, { start: 1, pause: 1, export: 1, clear: 0, reconnect: 1 });
});
