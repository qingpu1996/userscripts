const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadRuntime,
  makeObservation,
  makeGuard,
} = require("./helpers/runtime");

const lab = loadRuntime();

function makeAction(observation, operations, expectedDelta = {}) {
  return {
    status: "execute",
    action_id: "AUTO-DEADBEEFDEADBEEF",
    action_kind: "TEST",
    operations,
    guard: makeGuard(observation),
    expected_delta: expectedDelta,
    reason: "synthetic test",
  };
}

function makeAdapter(onMove = () => {}) {
  const calls = { can: [], direct: [], route: [], stop: 0 };
  return {
    calls,
    canMoveDirectly(x, y) { calls.can.push({ x, y }); return true; },
    moveDirectly(x, y) { calls.direct.push({ x, y }); onMove(x, y, "direct"); },
    setAutomaticRoute(x, y) { calls.route.push({ x, y }); onMove(x, y, "route"); },
    stopAutomaticRoute() { calls.stop += 1; },
    readBusy() { return { moving: false, lock_control: false, event_active: false }; },
  };
}

const fastStability = {
  pollMs: 0,
  sleep: async () => {},
  now: (() => { let tick = 0; return () => tick++; })(),
  timeoutMs: 100,
};

test("纯空走廊经 canMoveDirectly 证明后使用 moveDirectly", async () => {
  const before = makeObservation();
  let current = before;
  const adapter = makeAdapter((x, y) => {
    current = makeObservation({ hero: { loc: { x, y } } });
  });
  const action = makeAction(before, [{ type: "grid", x: 10, y: 3 }], {
    position: { x: 10, y: 3 },
  });
  const result = await lab.executeAction({
    action,
    initialObservation: before,
    registry: lab.createBlockRegistry(),
    adapter,
    observe: () => current,
    stabilityOptions: fastStability,
  });
  assert.deepEqual(adapter.calls.direct, [{ x: 10, y: 3 }]);
  assert.deepEqual(adapter.calls.route, []);
  assert.equal(result.observation.hero.loc.x, 10);
});

test("多段纯走廊逐段稳定后执行且不逐格调用", async () => {
  const before = makeObservation();
  let current = before;
  const adapter = makeAdapter((x, y) => {
    current = makeObservation({ hero: { loc: { x, y } } });
  });
  const action = makeAction(before, [
    { type: "grid", x: 9, y: 3 },
    { type: "grid", x: 10, y: 3 },
  ], { position: { x: 10, y: 3 } });
  await lab.executeAction({
    action,
    initialObservation: before,
    registry: lab.createBlockRegistry(),
    adapter,
    observe: () => current,
    stabilityOptions: Object.assign({}, fastStability, {
      now: (() => { let tick = 0; return () => tick++; })(),
    }),
  });
  assert.deepEqual(adapter.calls.direct, [{ x: 9, y: 3 }, { x: 10, y: 3 }]);
});

test("门作为唯一末端边界使用 setAutomaticRoute 并在状态变化后停止", async () => {
  const door = {
    x: 9, y: 3, numeric_id: 21, id: "syntheticDoor", cls: "terrains",
    trigger: "openDoor", no_pass: true, damage: null, enemy: null,
  };
  const before = makeObservation({ blocks: [door] });
  let current = before;
  const adapter = makeAdapter((x, y, method) => {
    assert.equal(method, "route");
    current = makeObservation({
      hero: { loc: { x, y } },
      keys: { yellow: 3 },
      blocks: [],
    });
  });
  const registry = lab.createBlockRegistry([{
    id: door.id, cls: door.cls, trigger: door.trigger,
    category: "door", passable: false, boundary: true, fast_path: false, version: 1,
  }]);
  const action = makeAction(before, [{ type: "grid", x: 9, y: 3 }], {
    keys: { yellow: -1 },
    position: { x: 9, y: 3 },
    removed_blocks: [{
      x: door.x,
      y: door.y,
      numeric_id: door.numeric_id,
      id: door.id,
      cls: door.cls,
      trigger: door.trigger,
    }],
  });
  const result = await lab.executeAction({
    action,
    initialObservation: before,
    registry,
    adapter,
    observe: () => current,
    stabilityOptions: Object.assign({}, fastStability, {
      now: (() => { let tick = 0; return () => tick++; })(),
    }),
  });
  assert.deepEqual(adapter.calls.direct, []);
  assert.deepEqual(adapter.calls.route, [{ x: 9, y: 3 }]);
  assert.equal(adapter.calls.stop, 1);
  assert.equal(result.boundary_reached, true);
});

test("非 fast_path 地块即使可通行也不用 moveDirectly", () => {
  const tile = {
    x: 9, y: 3, numeric_id: 7, id: "syntheticTile", cls: "terrains",
    trigger: null, no_pass: false, damage: null, enemy: null,
  };
  const observation = makeObservation({ blocks: [tile] });
  const registry = lab.createBlockRegistry([{
    id: tile.id, cls: tile.cls, trigger: tile.trigger,
    category: "terrain", passable: true, boundary: false, fast_path: false,
  }]);
  const adapter = makeAdapter();
  const plan = lab.planOperations(
    makeAction(observation, [{ type: "grid", x: 9, y: 3 }]),
    observation,
    registry,
    adapter,
  );
  assert.equal(plan[0].pure, false);
});

test("观察到 no_pass 的普通地块不能被空走廊证明穿越", () => {
  const blocked = {
    x: 9, y: 3, numeric_id: 7, id: "syntheticBlocked", cls: "terrains",
    trigger: null, no_pass: true, damage: null, enemy: null,
  };
  const observation = makeObservation({ blocks: [blocked] });
  const registry = lab.createBlockRegistry([{
    id: blocked.id, cls: blocked.cls, trigger: blocked.trigger,
    category: "terrain", passable: true, boundary: false, fast_path: true,
  }]);
  assert.throws(
    () => lab.planOperations(
      makeAction(observation, [{ type: "grid", x: 9, y: 3 }]),
      observation,
      registry,
      makeAdapter(),
    ),
    (error) => error.detail_code === "UNSAFE_ROUTE_RESPONSE",
  );
});

test("非末段边界和未知 block 的计划在行动 API 前被拒绝", () => {
  const door = {
    x: 9, y: 3, numeric_id: 21, id: "syntheticDoor", cls: "terrains",
    trigger: "openDoor", no_pass: true, damage: null, enemy: null,
  };
  const observation = makeObservation({ blocks: [door] });
  const registry = lab.createBlockRegistry([{
    id: door.id, cls: door.cls, trigger: door.trigger,
    category: "door", passable: false, boundary: true, fast_path: false,
  }]);
  const adapter = makeAdapter();
  assert.throws(
    () => lab.planOperations(makeAction(observation, [
      { type: "grid", x: 9, y: 3 },
      { type: "grid", x: 10, y: 3 },
    ]), observation, registry, adapter),
    (error) => error.detail_code === "UNSAFE_MULTI_BOUNDARY_RESPONSE",
  );
  assert.throws(
    () => lab.planOperations(makeAction(observation, [
      { type: "grid", x: 9, y: 3 },
    ]), observation, lab.createBlockRegistry(), adapter),
    (error) => error.pause_kind === "NEW_OBJECT_OR_MECHANISM",
  );
  assert.equal(adapter.calls.direct.length + adapter.calls.route.length, 0);
});

test("guard 不符时所有行动 API 调用数为零", async () => {
  const observation = makeObservation();
  const action = makeAction(observation, [{ type: "grid", x: 9, y: 3 }]);
  action.guard.hp += 1;
  const adapter = makeAdapter();
  await assert.rejects(
    lab.executeAction({
      action,
      initialObservation: observation,
      registry: lab.createBlockRegistry(),
      adapter,
      observe: () => observation,
      stabilityOptions: fastStability,
    }),
    (error) => error.pause_kind === "GUARD_MISMATCH",
  );
  assert.equal(adapter.calls.direct.length + adapter.calls.route.length, 0);
});

test("稳定判定要求 fingerprint 改变、非 busy 且连续两次一致", async () => {
  const before = makeObservation();
  const changedBusy = makeObservation({ hero: { loc: { x: 9, y: 3 } }, busy: true });
  const changed = makeObservation({ hero: { loc: { x: 9, y: 3 } }, busy: false });
  const sequence = [changedBusy, changed, changed];
  let index = 0;
  const result = await lab.waitForStability({
    adapter: { readBusy: () => ({ moving: false, lock_control: false, event_active: false }) },
    observe: () => sequence[Math.min(index++, sequence.length - 1)],
    preFingerprint: lab.fingerprintObservation(before),
    pollMs: 0,
    stablePolls: 2,
    timeoutMs: 100,
    now: (() => { let tick = 0; return () => tick++; })(),
    sleep: async () => {},
  });
  assert.equal(index, 3);
  assert.equal(result.observation.busy, false);
});

test("稳定超时按交互态或引擎态归入允许的 pause_kind", async () => {
  const before = makeObservation();
  async function timeoutWith(busyState) {
    return lab.waitForStability({
      adapter: { readBusy: () => busyState },
      observe: () => makeObservation({ busy: true }),
      preFingerprint: lab.fingerprintObservation(before),
      pollMs: 0,
      timeoutMs: 2,
      now: (() => { let tick = 0; return () => tick++; })(),
      sleep: async () => {},
    });
  }
  await assert.rejects(
    timeoutWith({ moving: false, lock_control: true, event_active: true }),
    (error) => error.pause_kind === "UNSUPPORTED_INTERACTION",
  );
  await assert.rejects(
    timeoutWith({ moving: true, lock_control: false, event_active: false }),
    (error) => error.pause_kind === "ENGINE_API_INCOMPATIBLE",
  );
});

test("只有已登记 stair 可用 floor_id=null 执行未知目的换层", async () => {
  const stair = {
    x: 9, y: 3, numeric_id: 90, id: "syntheticStair", cls: "terrains",
    trigger: "changeFloor", no_pass: false, damage: null, enemy: null,
  };
  const before = makeObservation({ blocks: [stair] });
  let current = before;
  const adapter = makeAdapter((x, y, method) => {
    assert.equal(method, "route");
    current = makeObservation({
      floor_id: "synthetic-floor-new",
      map_instance_id: "map:synthetic-floor-new:topology-a",
      floor_name: null,
      floor_number: null,
      hero: { loc: { x, y } },
      blocks: [],
    });
  });
  const registry = lab.createBlockRegistry([{
    id: stair.id, cls: stair.cls, trigger: stair.trigger,
    category: "stair", passable: true, boundary: true, fast_path: false,
  }]);
  const action = makeAction(before, [{ type: "grid", x: 9, y: 3 }], {
    floor_id: null,
    position: { x: 9, y: 3 },
  });
  const result = await lab.executeAction({
    action,
    initialObservation: before,
    registry,
    adapter,
    observe: () => current,
    stabilityOptions: {
      pollMs: 0,
      timeoutMs: 100,
      sleep: async () => {},
      now: (() => { let tick = 0; return () => tick++; })(),
    },
  });
  assert.equal(result.observation.floor_id, "synthetic-floor-new");
  assert.equal(lab.compareExpectedDelta(before, result.observation, action.expected_delta, {
    allowPositionChange: true,
    allowUnknownFloor: true,
    allowUnknownMapInstance: true,
  }).ok, true);
});
