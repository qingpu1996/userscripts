const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadRuntime,
  makeObservation,
  makeGuard,
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

function makeController(current, journal, client, adapter = makeControllerAdapter(current), options = {}) {
  const panel = makePanel();
  return {
    adapter,
    panel,
    controller: lab.createController({
      adapter,
      journal,
      registry: lab.createBlockRegistry(),
      client,
      panel,
      observe: () => current.value,
      logger: { error() {} },
    }, Object.assign({
      stabilityOptions: {
        pollMs: 0,
        timeoutMs: 100,
        sleep: async () => {},
        now: (() => { let tick = 0; return () => tick++; })(),
      },
    }, options)),
  };
}

test("localhost client keeps the loopback wire contract and rejects invalid responses", async () => {
  let captured;
  const client = lab.createLocalhostClient((request) => {
    captured = request;
    request.onload({
      status: 200,
      responseText: JSON.stringify({ status: "idle", reason: "ok" }),
    });
  });
  const payload = lab.createCycleRequest({
    observation: makeObservation(),
    session: { mode: "new_game", command: "observe" },
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
  assert.equal(client.isConnected(), true);

  for (const endpoint of [
    "http://localhost:18724/cycle",
    "http://0.0.0.0:18724/cycle",
    "https://127.0.0.1:18724/cycle",
    "http://127.0.0.1:18724/other",
  ]) {
    assert.throws(
      () => lab.createLocalhostClient(() => {}, { cycleEndpoint: endpoint }),
      /cycleEndpoint/iu,
    );
  }

  const invalid = lab.createLocalhostClient((request) => request.onload({
    status: 200,
    responseText: JSON.stringify({ status: "execute" }),
  }));
  await assert.rejects(
    invalid.postCycle({}),
    (error) => error.detail_code === "INVALID_RESPONSE",
  );
  assert.equal(invalid.isConnected(), false);
});

test("browser protocol parser accepts fixtures and rejects nested shape drift", () => {
  const fixtures = JSON.parse(fs.readFileSync(
    path.join(projectDir, "tests/fixtures/protocol-responses.json"),
    "utf8",
  ));
  for (const key of ["execute", "pause", "idle", "recovery_ack", "error"]) {
    assert.doesNotThrow(() => lab.validateCycleResponse(fixtures[key]), key);
  }

  const invalid = JSON.parse(JSON.stringify(fixtures.execute));
  invalid.guard.keys.extra = 0;
  assert.throws(() => lab.validateCycleResponse(invalid));
  assert.throws(() => lab.validateCycleResponse({
    status: "idle", reason: "synthetic", extra: true,
  }));
  assert.throws(() => lab.validateCycleResponse({
    status: "idle",
    reason: "synthetic",
    shadow: { mode: "read_only", reason: "synthetic", cycle: 1, action_id: "AUTO-DEADBEEFDEADBEEF" },
  }));
  const shadowAnalysis = {
    status: "idle",
    reason: "synthetic",
    shadow: {
      mode: "read_only", reason: "synthetic", cycle: 1,
      analysis: {
        scope: "current_floor_immediate", reachable_cell_count: 1,
        candidate_limit: 256, total_candidate_count: 1, truncated: false,
        candidates: [{
          candidate_id: "F:enemy:1,0:1:slime", kind: "enemy", block_id: "slime",
          numeric_id: 1, x: 1, y: 0, distance: 1, feasibility: "unknown_cost",
          hp_loss: null, key_cost: { yellow: 0, blue: 0, red: 0 },
        }],
        global: {
          scope: "global_terminal_route", proof: "proven", reason: "complete terminal route found",
          truncated: false, explored_states: 4, terminal_hp: 90,
          terminal_attack: 20, terminal_defense: 15, blockers: [],
          route: { step_count: 1, steps: [{ step_kind: "terminal", floor_id: "F", x: 2, y: 0, details: {} }] },
          first_suggestion: { step_kind: "terminal", floor_id: "F", x: 2, y: 0, details: {} },
        },
      },
    },
  };
  assert.doesNotThrow(() => lab.validateCycleResponse(shadowAnalysis));
  shadowAnalysis.shadow.analysis.global.first_suggestion.action = "forbidden";
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  delete shadowAnalysis.shadow.analysis.global.first_suggestion.action;
  const global = shadowAnalysis.shadow.analysis.global;
  global.route.step_count = 2;
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  global.route.step_count = 1;
  global.first_suggestion = { ...global.first_suggestion, x: 1 };
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  global.first_suggestion = structuredClone(global.route.steps[0]);
  global.route.steps[0].details = { action: "forbidden" };
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  global.route.steps[0].details = {};
  delete global.terminal_attack;
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  global.terminal_attack = 20;
  delete global.terminal_defense;
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  global.terminal_defense = 15;
  global.proof = "unproven";
  global.reason = "search_budget_exhausted";
  global.truncated = true;
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  Object.assign(global, { proof: "unsupported", reason: "search_budget_exhausted", truncated: false });
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  Object.assign(global, { proof: "proven", reason: "complete terminal route found", truncated: false });
  global.blockers = [{ code: "opaque_event", detail: "requires an unsupported event model" }];
  assert.doesNotThrow(() => lab.validateCycleResponse(shadowAnalysis));
  global.blockers = [{ code: "opaque_event" }];
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  global.blockers = [{ code: "opaque_event", detail: 1 }];
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  global.blockers = [];
  global.route.steps[0] = {
    step_kind: "resource", floor_id: "F", x: 2, y: 0, block_id: "redPotion",
    details: {
      hp: 100, attack: 0, defense: 0, gold: 0, experience: 0,
      keys: { yellow: 0, blue: 0, red: 0 }, inventory: { action: 1 },
    },
  };
  global.first_suggestion = structuredClone(global.route.steps[0]);
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  global.route.steps[0] = { step_kind: "terminal", floor_id: "F", x: 2, y: 0, details: {} };
  global.first_suggestion = structuredClone(global.route.steps[0]);
  global.blockers = Array.from({ length: 65537 }, () => ({ code: "opaque_event", detail: "unsupported" }));
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
  global.blockers = [];
  shadowAnalysis.shadow.analysis.candidates[0].operation = { type: "grid", x: 1, y: 0 };
  assert.throws(() => lab.validateCycleResponse(shadowAnalysis));
});

test("JS and Draft schema agree on global shadow proof, limits, and non-executable details", () => {
  const base = {
    status: "idle", reason: "synthetic",
    shadow: {
      mode: "read_only", reason: "synthetic", cycle: 1,
      analysis: {
        scope: "current_floor_immediate", reachable_cell_count: 1,
        candidate_limit: 256, total_candidate_count: 0, truncated: false, candidates: [],
        global: {
          scope: "global_terminal_route", proof: "unsupported", reason: "solver_model_missing",
          truncated: false, explored_states: 0, blockers: [], route: null, first_suggestion: null,
        },
      },
    },
  };
  const cases = [
    { name: "valid unsupported", value: structuredClone(base), accepted: true },
    { name: "unsupported budget reason", value: structuredClone(base), accepted: false },
    { name: "too many blockers", value: structuredClone(base), accepted: false },
    { name: "nested executable inventory field", value: structuredClone(base), accepted: false },
  ];
  cases[1].value.shadow.analysis.global.reason = "search_budget_exhausted";
  cases[2].value.shadow.analysis.global.blockers = Array.from(
    { length: 65537 }, () => ({ code: "opaque_event", detail: "unsupported" }),
  );
  Object.assign(cases[3].value.shadow.analysis.global, {
    proof: "proven", reason: "complete terminal route found", terminal_hp: 100,
    terminal_attack: 20, terminal_defense: 15,
    route: {
      step_count: 1,
      steps: [{
        step_kind: "resource", floor_id: "F", x: 1, y: 0, block_id: "redPotion",
        details: {
          hp: 100, attack: 0, defense: 0, gold: 0, experience: 0,
          keys: { yellow: 0, blue: 0, red: 0 }, inventory: { action: 1 },
        },
      }],
    },
  });
  cases[3].value.shadow.analysis.global.first_suggestion = structuredClone(
    cases[3].value.shadow.analysis.global.route.steps[0],
  );

  const schemaPath = path.join(projectDir, "protocol/cycle-response.schema.json");
  const python = childProcess.spawnSync("python3", ["-c", [
    "import json, sys, jsonschema",
    "schema=json.load(open(sys.argv[1], encoding='utf-8'))",
    "values=json.load(sys.stdin)",
    "print(json.dumps([not list(jsonschema.Draft202012Validator(schema).iter_errors(v)) for v in values]))",
  ].join("; "), schemaPath], {
    input: JSON.stringify(cases.map(({ value }) => value)), encoding: "utf8",
  });
  assert.equal(python.status, 0, python.stderr);
  const schemaResults = JSON.parse(python.stdout);
  cases.forEach(({ name, value, accepted }, index) => {
    let jsAccepted = true;
    try { lab.validateCycleResponse(value); } catch { jsAccepted = false; }
    assert.equal(jsAccepted, accepted, `${name}: JS`);
    assert.equal(schemaResults[index], accepted, `${name}: Draft schema`);
  });
});

test("controller requires explicit baseline, start, and stop in the current page instance", async () => {
  const current = { value: makeObservation() };
  const journal = lab.createJournal();
  let requests = 0;
  const { adapter, controller } = makeController(current, journal, {
    isConnected: () => true,
    async postCycle() {
      requests += 1;
      return { status: "idle", reason: "no action", registry_entries: [] };
    },
  });

  const initialized = await controller.initialize();
  assert.equal(initialized.requires_confirmation, true);
  assert.equal(controller.getState(), "AWAITING_BASELINE_CONFIRMATION");
  assert.equal(requests, 0);

  const confirmed = controller.confirmBaseline({ mode: "new_game" });
  assert.equal(confirmed.verified, true);
  assert.equal(journal.snapshot().autopilot_enabled, false);
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);

  const started = await controller.start();
  assert.equal(started.idle, true);
  assert.equal(requests, 1);
  assert.equal(journal.snapshot().autopilot_enabled, true);

  const stopped = controller.manualPause();
  assert.equal(stopped.stopped, true);
  assert.equal(controller.getState(), "STOPPED");
  assert.equal(journal.snapshot().autopilot_enabled, false);
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});

test("controller runSingleCycle is single-flight", async () => {
  const current = { value: makeObservation() };
  const journal = lab.createJournal();
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  let requests = 0;
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const { controller } = makeController(current, journal, {
    isConnected: () => true,
    postCycle() {
      requests += 1;
      return responsePromise;
    },
  });

  const first = controller.runSingleCycle();
  const second = controller.runSingleCycle();

  assert.equal(first, second);
  assert.equal(requests, 1);
  resolveResponse({ status: "idle", reason: "settled", registry_entries: [] });
  assert.equal((await first).idle, true);
  assert.equal(requests, 1);
});

test("controller guard mismatch reaches no engine action API", async () => {
  const current = { value: makeObservation() };
  const journal = lab.createJournal();
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  const response = makeExecuteResponse(current.value);
  response.guard.hp += 1;
  const { adapter, controller } = makeController(current, journal, {
    isConnected: () => true,
    async postCycle() { return response; },
  });

  const result = await controller.runSingleCycle();

  assert.equal(result.pause_kind, "GUARD_MISMATCH");
  assert.equal(result.detail_code, "PRE_ACTION_GUARD_MISMATCH");
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
  assert.equal(journal.snapshot().pending_action, null);
});

test("shadowOnly rejects execute without touching any game adapter API", async () => {
  const current = { value: makeObservation() };
  const journal = lab.createJournal();
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  const { adapter, controller } = makeController(current, journal, {
    isConnected: () => true,
    async postCycle() { return makeExecuteResponse(current.value); },
  }, undefined, { shadowOnly: true });

  const result = await controller.runSingleCycle();

  assert.equal(result.pause_kind, "UNSUPPORTED_INTERACTION");
  assert.equal(result.detail_code, "SHADOW_EXECUTION_FORBIDDEN");
  assert.deepEqual(adapter.calls, { direct: 0, route: 0, stop: 0 });
  assert.equal(controller.getState(), "PAUSED");
  assert.equal(journal.snapshot().autopilot_enabled, false);
  assert.equal(journal.snapshot().pending_action, null);
});

test("shadowOnly rejects execute before an unexpected ACK can touch an adapter", async () => {
  const current = { value: makeObservation() };
  const journal = lab.createJournal();
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  const response = makeExecuteResponse(current.value);
  response.acknowledged_action_id = "AUTO-AAAAAAAAAAAAAAAA";
  const { adapter, controller } = makeController(current, journal, {
    isConnected: () => true,
    async postCycle() { return response; },
  }, undefined, { shadowOnly: true });

  const result = await controller.runSingleCycle();

  assert.equal(result.pause_kind, "UNSUPPORTED_INTERACTION");
  assert.equal(result.detail_code, "SHADOW_EXECUTION_FORBIDDEN");
  assert.deepEqual(adapter.calls, { direct: 0, route: 0, stop: 0 });
  assert.equal(controller.getState(), "PAUSED");
  assert.equal(journal.snapshot().autopilot_enabled, false);
  assert.equal(journal.snapshot().pending_action, null);
});

test("shadowOnly rejects execute before a missing completed-action ACK can touch an adapter", async () => {
  const current = { value: makeObservation() };
  const journal = lab.createJournal();
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  journal.markCompleted({
    action_id: "AUTO-AAAAAAAAAAAAAAAA",
    fingerprint: "sha256:synthetic-completed-action",
  });
  const { adapter, controller } = makeController(current, journal, {
    isConnected: () => true,
    async postCycle(request) {
      assert.equal(request.completed_action_id, "AUTO-AAAAAAAAAAAAAAAA");
      return makeExecuteResponse(current.value);
    },
  }, undefined, { shadowOnly: true });

  const result = await controller.runSingleCycle();

  assert.equal(result.pause_kind, "UNSUPPORTED_INTERACTION");
  assert.equal(result.detail_code, "SHADOW_EXECUTION_FORBIDDEN");
  assert.deepEqual(adapter.calls, { direct: 0, route: 0, stop: 0 });
  assert.equal(controller.getState(), "PAUSED");
  assert.equal(journal.snapshot().autopilot_enabled, false);
  assert.equal(journal.snapshot().pending_action, null);
});

test("shadowOnly reconnect rejects execute without touching any game adapter API", async () => {
  const current = { value: makeObservation() };
  const journal = lab.createJournal();
  establishTestSession(journal, current.value);
  const { adapter, controller } = makeController(current, journal, {
    isConnected: () => true,
    async postCycle() { return makeExecuteResponse(current.value); },
  }, undefined, { shadowOnly: true });

  const result = await controller.reconnectOnly();

  assert.equal(result.pause_kind, "UNSUPPORTED_INTERACTION");
  assert.equal(result.detail_code, "SHADOW_EXECUTION_FORBIDDEN");
  assert.deepEqual(adapter.calls, { direct: 0, route: 0, stop: 0 });
  assert.equal(controller.getState(), "PAUSED");
  assert.equal(journal.snapshot().autopilot_enabled, false);
  assert.equal(journal.snapshot().pending_action, null);
});

test("shadow advice is shown as the controller's visible reason", async () => {
  const current = { value: makeObservation() };
  const journal = lab.createJournal();
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  const shadowReason = "synthetic Rust observation only";
  const { controller, panel } = makeController(current, journal, {
    isConnected: () => true,
    async postCycle() {
      return {
        status: "idle",
        reason: shadowReason,
        shadow: { mode: "read_only", reason: shadowReason, cycle: 1 },
      };
    },
  }, undefined, { shadowOnly: true });

  const result = await controller.runSingleCycle();

  assert.equal(result.idle, true);
  assert.equal(panel.states.at(-1).reason, `Shadow（只读）：${shadowReason}`);
});

test("completed delta is reported, ACKed, and followed by at most one new action", async () => {
  const before = makeObservation();
  const after = makeObservation({ hero: { loc: { x: 9, y: 3 } } });
  const previousId = "AUTO-AAAAAAAAAAAAAAAA";
  const nextId = "AUTO-BBBBBBBBBBBBBBBB";
  const current = { value: after };
  const journal = lab.createJournal();
  establishTestSession(journal, before);
  journal.setAutopilot(true);
  journal.setPending({
    action_id: previousId,
    pre_fingerprint: lab.fingerprintObservation(before),
    pre_observation: lab.recoveryObservationProjection(before),
    expected_delta: { position: { x: 9, y: 3 } },
    allow_unknown_floor: false,
    allow_unknown_map_instance: false,
    requires_non_position_change: false,
    phase: "prepared",
  });
  let requests = 0;
  const { adapter, controller } = makeController(current, journal, {
    isConnected: () => true,
    async postCycle(request) {
      requests += 1;
      assert.equal(request.completed_action_id, previousId);
      assert.equal(request.recovery.phase, "completed");
      const response = makeExecuteResponse(after, nextId);
      response.operations = [{ type: "grid", x: 10, y: 3 }];
      response.expected_delta = { position: { x: 10, y: 3 } };
      response.acknowledged_action_id = previousId;
      return response;
    },
  });

  const result = await controller.runSingleCycle();

  assert.equal(result.completed, true);
  assert.equal(requests, 1);
  assert.equal(journal.snapshot().last_acknowledged_action_id, previousId);
  assert.equal(journal.actionState(previousId), "completed");
  assert.equal(journal.actionState(nextId), "completed");
  assert.equal(adapter.calls.direct, 1);
});

test("a completed action identity returned again is never executed twice", async () => {
  const current = { value: makeObservation() };
  const journal = lab.createJournal();
  establishTestSession(journal, current.value);
  journal.setAutopilot(true);
  journal.markCompleted({
    action_id: "AUTO-0123456789ABCDEF",
    fingerprint: "sha256:done",
  });
  journal.acknowledge("AUTO-0123456789ABCDEF");
  const { adapter, controller } = makeController(current, journal, {
    isConnected: () => true,
    async postCycle() { return makeExecuteResponse(current.value); },
  });

  const result = await controller.runSingleCycle();

  assert.equal(result.duplicate_completed, true);
  assert.equal(result.executed, false);
  assert.equal(adapter.calls.direct + adapter.calls.route, 0);
});
