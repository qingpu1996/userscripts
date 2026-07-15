const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");

const {
  loadRuntime,
  makePoisonCore,
  projectDir,
} = require("../js/helpers/runtime.js");

const MotaLab = loadRuntime();
const HOST = "127.0.0.1";
let port = null;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function canConnect() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(250, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitUntilReady(child, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`decision service exited early (${child.exitCode}): ${stderr.join("")}`);
    }
    if (await canConnect()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`decision service did not open ${HOST}:${port}: ${stderr.join("")}`);
}

function gmRequest(options) {
  const url = new URL(options.url);
  const request = http.request({
    host: url.hostname,
    port: url.port,
    path: url.pathname,
    method: options.method,
    headers: options.headers,
  }, (response) => {
    let responseText = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { responseText += chunk; });
    response.on("end", () => options.onload({ status: response.statusCode, responseText }));
  });
  request.setTimeout(options.timeout, () => {
    request.destroy();
    options.ontimeout();
  });
  request.on("error", (error) => options.onerror(error));
  request.end(options.data);
}

function writeKnowledge(knowledgeDir) {
  fs.writeFileSync(path.join(knowledgeDir, "floor-models.json"), `${JSON.stringify({
    protocol: 1,
    floors: [{
      floor_id: "synthetic-floor-4",
      known: true,
      name: "Synthetic 4F",
      source: "human",
      version: 1,
    }],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(knowledgeDir, "block-labels.json"), `${JSON.stringify({
    protocol: 1,
    labels: [
      {
        id: "syntheticEnemy",
        cls: "enemy48",
        trigger: "battle",
        category: "enemy",
        passable: false,
        boundary: true,
        fast_path: false,
        supported: true,
        expected_delta: null,
        source: "human",
        version: 1,
      },
      {
        id: "syntheticRedPotion",
        cls: "items",
        trigger: "getItem",
        category: "resource",
        passable: true,
        boundary: true,
        fast_path: false,
        supported: true,
        expected_delta: { hp: 200 },
        source: "human",
        version: 1,
      },
    ],
  }, null, 2)}\n`);
}

async function terminate(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("fake core → localhost service → atomic execution → settled report is end-to-end safe", {
  timeout: 30000,
}, async (t) => {
  port = await findFreePort();
  assert.equal(await canConnect(), false, `${HOST}:${port} must be free before integration QA`);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mota-lab-integration-"));
  const stateDir = path.join(temporaryRoot, "state");
  const knowledgeDir = path.join(temporaryRoot, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  writeKnowledge(knowledgeDir);

  const python = process.env.MOTA_LAB_PYTHON || "python3";
  const serviceDir = path.join(projectDir, "service");
  const pythonPath = [
    serviceDir,
    process.env.MOTA_LAB_PYTHONPATH,
    process.env.PYTHONPATH,
  ].filter(Boolean).join(path.delimiter);
  const stderr = [];
  const testServer = [
    "from dataclasses import replace",
    "from pathlib import Path",
    "import os, uvicorn",
    "from mota_lab.api import Settings, create_app",
    "settings=replace(Settings.from_env(), bundled_data_dir=Path(os.environ['MOTA_LAB_TEST_BUNDLED_DATA_DIR']))",
    `uvicorn.run(create_app(settings), host='${HOST}', port=${port})`,
  ].join("; ");
  const child = spawn(python, ["-c", testServer], {
    cwd: projectDir,
    env: Object.assign({}, process.env, {
      PYTHONPATH: pythonPath,
      MOTA_LAB_STATE_DIR: stateDir,
      MOTA_LAB_KNOWLEDGE_DIR: knowledgeDir,
      MOTA_LAB_TEST_BUNDLED_DATA_DIR: knowledgeDir,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(async () => {
    await terminate(child);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await waitUntilReady(child, stderr);

  const rawBlocks = [
    {
      x: 5,
      y: 3,
      id: 9003,
      event: {
        id: "syntheticEnemy",
        cls: "enemy48",
        trigger: "battle",
        noPass: true,
      },
    },
    {
      x: 6,
      y: 3,
      id: 9004,
      event: {
        id: "syntheticRedPotion",
        cls: "items",
        trigger: "getItem",
        noPass: false,
      },
    },
  ];
  const fake = makePoisonCore({
    instrumentAuthority: true,
    floorId: "synthetic-floor-4",
    currentMap: { title: "Synthetic 4F", width: 11, height: 11 },
    blocks: rawBlocks,
    enemyInfo: {
      syntheticEnemy: {
        hp: 100,
        atk: 30,
        def: 10,
        money: 5,
        experience: 4,
        special: [],
      },
    },
    damage: { syntheticEnemy: 24 },
    onDirect(x, y, hero) {
      hero.loc.x = x;
      hero.loc.y = y;
    },
    onRoute(x, y, hero, authority) {
      const index = authority.blocks.findIndex((block) => block.x === x && block.y === y);
      assert.notEqual(index, -1, "automatic route must stop at a current known boundary");
      const [block] = authority.blocks.splice(index, 1);
      hero.loc.x = x;
      hero.loc.y = y;
      if (block.event.id === "syntheticRedPotion") hero.hp += 200;
      if (block.event.id === "syntheticEnemy") {
        hero.hp -= 24;
        hero.money += 5;
        hero.experience += 4;
      }
    },
  });
  const adapter = MotaLab.createEngineAdapter(fake.scope);
  const cycleEndpoint = `http://${HOST}:${port}/cycle`;
  const client = MotaLab.createLocalhostClient(gmRequest, { timeoutMs: 3000, cycleEndpoint });

  const firstObservation = MotaLab.collectObservation(adapter, () => 1234567890);
  assert.deepEqual(fake.calls.authoritativeWrites, [],
    "collector must not write authoritative runtime state");
  assert.deepEqual(fake.calls.illegalWrites, []);
  firstObservation.session_id = "SESSION-INTEGRATION-0001";
  const firstRequest = MotaLab.createCycleRequest({
    observation: firstObservation,
    session: { mode: "new_game", command: "observe" },
    recovery: {
      phase: "none",
      pending_action_id: null,
      pre_fingerprint: null,
      current_fingerprint: MotaLab.fingerprintObservation(firstObservation),
      detail_code: null,
    },
  });
  const confirmationRequired = await client.postCycle(firstRequest);
  assert.equal(confirmationRequired.status, "pause");
  assert.equal(confirmationRequired.pause_kind, "SESSION_CONFIRMATION_REQUIRED");
  const issuedBeforeRefresh = await client.postCycle(MotaLab.createCycleRequest({
    observation: firstObservation,
    session: { mode: "new_game", command: "confirm" },
    recovery: firstRequest.recovery,
  }));
  assert.equal(issuedBeforeRefresh.status, "execute");
  const firstFingerprint = MotaLab.fingerprintObservation(firstObservation);
  const unexplainedObservation = JSON.parse(JSON.stringify(firstObservation));
  unexplainedObservation.hero.loc.x -= 1;
  unexplainedObservation.captured_at += 1;
  const unexplainedFingerprint = MotaLab.fingerprintObservation(unexplainedObservation);
  const unresolvedConflict = await client.postCycle(MotaLab.createCycleRequest({
    observation: unexplainedObservation,
    session: { mode: "resume_existing_ledger", command: "observe" },
    recovery: {
      phase: "none",
      pending_action_id: null,
      pre_fingerprint: null,
      current_fingerprint: unexplainedFingerprint,
      detail_code: null,
    },
  }));
  assert.equal(unresolvedConflict.status, "pause");
  assert.equal(unresolvedConflict.detail_code, "RECOVERY_JOURNAL_LEDGER_MISMATCH");

  const journal = MotaLab.createJournal(MotaLab.createMemoryStorage());
  journal.establishSession({
    session_id: firstObservation.session_id,
    mode: "new_game",
    baseline: MotaLab.baselineSummary(firstObservation),
  });
  journal.markServiceSessionConfirmed();
  journal.setPending({
    action_id: issuedBeforeRefresh.action_id,
    pre_fingerprint: firstFingerprint,
    pre_observation: firstObservation,
    guard: issuedBeforeRefresh.guard,
    expected_delta: issuedBeforeRefresh.expected_delta,
    requires_non_position_change: true,
    allow_unknown_floor: false,
    allow_unknown_map_instance: false,
    operations: issuedBeforeRefresh.operations,
    operation_index: 0,
    phase: "prepared",
    started_at: 1234567890,
  });
  const panelUpdates = [];
  const controller = MotaLab.createController({
    adapter,
    journal,
    registry: MotaLab.createBlockRegistry(),
    client,
    panel: { update(value) { panelUpdates.push(value); } },
    logger: { error() {} },
  }, {
    autoSchedule: false,
    stabilityOptions: {
      pollMs: 0,
      timeoutMs: 500,
      stablePolls: 2,
      sleep: async () => {},
    },
  });

  const initialized = await controller.initialize();
  assert.equal(initialized.verified, true);
  assert.equal(initialized.auto_started, false);
  assert.equal(fake.calls.direct.length + fake.calls.route.length, 0);
  assert.deepEqual(fake.calls.authoritativeWrites, [],
    "client/service/initialization must not write authoritative runtime state");

  const resource = await controller.start();
  assert.equal(resource.completed, true, JSON.stringify(resource));
  assert.equal(resource.action_id, issuedBeforeRefresh.action_id,
    "refresh recovery must retain the one unresolved action id");
  assert.equal(fake.calls.direct.length, 1, "safe empty approach must use moveDirectly");
  assert.equal(fake.calls.route.length, 1, "resource is one state boundary");
  assert.equal(fake.hero.hp, 408);
  assert.equal(fake.authority.blocks.length, 1);

  const enemy = await controller.runSingleCycle();
  assert.equal(enemy.completed, true);
  assert.equal(journal.snapshot().last_acknowledged_action_id, resource.action_id);
  assert.equal(fake.calls.route.length, 2, "enemy is a separate next-cycle boundary");
  assert.equal(fake.hero.hp, 384);
  assert.equal(fake.hero.money, 21);
  assert.equal(fake.hero.experience, 67);
  assert.equal(fake.authority.blocks.length, 0);

  const enemyAck = await controller.runSingleCycle();
  assert.equal(enemyAck.idle, true);
  assert.equal(journal.snapshot().last_acknowledged_action_id, enemy.action_id);
  const reported = await controller.runSingleCycle();
  assert.equal(reported.idle, true);
  assert.equal(journal.snapshot().pending_action, null);
  assert.equal(journal.snapshot().last_acknowledged_action_id,
    journal.snapshot().last_completed_action.action_id);
  assert.equal(fake.calls.saveLoad, 0);
  assert.deepEqual(fake.calls.forbidden, []);
  assert.deepEqual(fake.calls.illegalWrites, []);
  assert.ok(fake.calls.authoritativeWrites.length > 0);
  assert.deepEqual([...new Set(fake.calls.authoritativeWrites.map((item) => item.api))].sort(), [
    "moveDirectly", "setAutomaticRoute",
  ]);
  assert.ok(fake.calls.authoritativeWrites.every((item) => (
    item.api !== null
      && ["moveDirectly", "setAutomaticRoute"].includes(item.api)
      && ["set", "delete", "define"].includes(item.operation)
      && (item.path.startsWith("hero.") || item.path.startsWith("blocks."))
  )), JSON.stringify(fake.calls.authoritativeWrites));
  assert.ok(panelUpdates.length > 0);

  assert.equal(fs.existsSync(stateDir), false, "serve must not create runtime state files");
});
