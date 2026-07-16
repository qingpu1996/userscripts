const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectDir = path.resolve(__dirname, "../..");
const repoDir = path.resolve(projectDir, "../..");
const config = JSON.parse(fs.readFileSync(path.join(projectDir, "userscript.config.json"), "utf8"));
const mainSource = fs.readFileSync(path.join(projectDir, "src/main.js"), "utf8");

function createHarness({ mode = "userscript", ready = false, timeoutMs = 30 } = {}) {
  const globalListeners = new Map();
  const pageListeners = new Map();
  const panel = { updates: [], controls: null, update(value) { this.updates.push(value); }, bindControls(value) { this.controls = value; } };
  const calls = { adapterScopes: [], initialize: 0 };
  const bindEvents = (listeners) => ({
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  });
  const sandbox = {
    console: { error() {} },
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Math,
    Map,
    Set,
    Object,
    Array,
    Number,
    String,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Promise,
    encodeURIComponent,
    unescape,
    document: {},
    ...bindEvents(globalListeners),
  };
  const pageScope = mode === "userscript" ? {
    clearTimeout,
    runtime_scope_kind: "userscript",
    setTimeout,
    ...bindEvents(pageListeners),
  } : sandbox;
  if (mode === "direct-mount") sandbox.runtime_scope_kind = "direct-mount";
  if (mode === "userscript") sandbox.unsafeWindow = pageScope;
  if (ready) pageScope.core = { status: {} };
  const context = vm.createContext(sandbox);
  for (const source of config.sources.filter((file) => !file.endsWith("/main.js"))) {
    vm.runInContext(fs.readFileSync(path.join(repoDir, source), "utf8"), context, { filename: source });
  }
  const lab = vm.runInContext("MotaLab", context);
  lab.RUNTIME_READY_TIMEOUT_MS = timeoutMs;
  lab.RUNTIME_READY_POLL_MS = 1;
  lab.createRuntimeEnvironment = () => ({
    mode,
    registerMenu: null,
    request() {},
    assertAvailable() { return true; },
  });
  lab.createPanel = () => panel;
  lab.createEngineAdapter = (scope) => {
    calls.adapterScopes.push(scope);
    return { capabilities() { return {}; } };
  };
  lab.createJournal = () => ({});
  lab.createBlockRegistry = () => ({});
  lab.createLocalhostClient = () => ({});
  lab.createController = () => ({
    async initialize() { calls.initialize += 1; },
    getCurrentObservation() { return null; },
    confirmBaseline() {},
    start() {},
    manualPause() {},
    reconnectOnly() {},
  });

  vm.runInContext(mainSource, context, { filename: "games/mota-planning-lab/src/main.js" });
  return {
    calls,
    context,
    lab,
    panel,
    pageScope,
    async boot() { return vm.runInContext("globalThis.__motaPlanningLabBoot", context); },
    emit(type) {
      const listeners = mode === "userscript" ? pageListeners : globalListeners;
      const listener = listeners.get(type);
      if (listener) listener();
    },
  };
}

test("userscript reads an already-ready runtime from unsafeWindow synchronously", async () => {
  const harness = createHarness({ mode: "userscript", ready: true });
  assert.equal(harness.calls.initialize, 1);
  assert.equal(harness.calls.adapterScopes[0], harness.pageScope);
  assert.notEqual(harness.panel.controls, null);
  assert.notEqual(harness.context.__motaPlanningLab.controller, null);
  const boot = harness.boot();
  await boot;
  assert.equal(harness.calls.initialize, 1);
  assert.notEqual(harness.panel.controls, null);
  await harness.lab.main();
  assert.equal(harness.calls.initialize, 1);
});

test("userscript waits for unsafeWindow runtime and initializes exactly once", async () => {
  const harness = createHarness({ mode: "userscript", timeoutMs: 100 });
  setTimeout(() => { harness.pageScope.core = { status: {} }; }, 5);
  await harness.boot();
  assert.equal(harness.calls.initialize, 1);
  assert.equal(harness.calls.adapterScopes[0], harness.pageScope);
  assert.notEqual(harness.panel.controls, null);
  await harness.lab.main();
  assert.equal(harness.calls.initialize, 1);
});

test("direct-mount keeps globalThis as the game page scope", async () => {
  const harness = createHarness({ mode: "direct-mount", ready: true });
  await harness.boot();
  assert.equal(harness.calls.initialize, 1);
  assert.equal(harness.calls.adapterScopes[0].runtime_scope_kind, "direct-mount");
  assert.notEqual(harness.panel.controls, null);
});

test("runtime timeout pauses without constructing a controller", async () => {
  const harness = createHarness({ timeoutMs: 5 });
  await harness.boot();
  assert.equal(harness.calls.initialize, 0);
  assert.equal(harness.panel.updates.at(-1).reason, "MISSING_RUNTIME");
  assert.equal(harness.panel.updates.at(-1).pause_kind, "ENGINE_API_INCOMPATIBLE");
  assert.equal(harness.context.__motaPlanningLab.available, false);
});

test("pagehide stops the bounded wait without constructing a controller", async () => {
  const harness = createHarness({ timeoutMs: 100 });
  setTimeout(() => harness.emit("pagehide"), 5);
  await harness.boot();
  assert.equal(harness.calls.initialize, 0);
  assert.equal(harness.panel.updates.at(-1).reason, "MISSING_RUNTIME");
});
