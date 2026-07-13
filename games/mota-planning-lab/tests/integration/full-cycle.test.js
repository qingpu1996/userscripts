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
const PORT = 18724;

function canConnect() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
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
  throw new Error(`decision service did not open ${HOST}:${PORT}: ${stderr.join("")}`);
}

function gmRequest(options) {
  const url = new URL(options.url);
  const request = http.request({
    host: url.hostname,
    port: Number(url.port),
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
  assert.equal(await canConnect(), false, `${HOST}:${PORT} must be free before integration QA`);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mota-lab-integration-"));
  const stateDir = path.join(temporaryRoot, "state");
  const knowledgeDir = path.join(temporaryRoot, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });

  const python = process.env.MOTA_LAB_PYTHON || "python3";
  const serviceDir = path.join(projectDir, "service");
  const pythonPath = [
    serviceDir,
    process.env.MOTA_LAB_PYTHONPATH,
    process.env.PYTHONPATH,
  ].filter(Boolean).join(path.delimiter);
  const stderr = [];
  const child = spawn(python, [
    "-m", "mota_lab",
    "--state-dir", stateDir,
    "--knowledge-dir", knowledgeDir,
    "serve",
  ], {
    cwd: projectDir,
    env: Object.assign({}, process.env, { PYTHONPATH: pythonPath }),
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
    floorId: "synthetic-floor-4",
    currentMap: { title: "Synthetic 4F" },
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
    onRoute(x, y, hero) {
      const index = rawBlocks.findIndex((block) => block.x === x && block.y === y);
      assert.notEqual(index, -1, "automatic route must stop at a current known boundary");
      const [block] = rawBlocks.splice(index, 1);
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
  const client = MotaLab.createLocalhostClient(gmRequest, { timeoutMs: 3000 });

  const firstObservation = MotaLab.collectObservation(adapter, () => 1234567890);
  const firstRequest = MotaLab.createCycleRequest({
    observation: firstObservation,
    recovery: {
      phase: "none",
      pending_action_id: null,
      pre_fingerprint: null,
      current_fingerprint: MotaLab.fingerprintObservation(firstObservation),
      detail_code: null,
    },
  });
  const unknownFloor = await client.postCycle(firstRequest);
  assert.equal(unknownFloor.status, "pause");
  assert.equal(unknownFloor.pause_kind, "UNKNOWN_FLOOR");

  writeKnowledge(knowledgeDir);

  const journal = MotaLab.createJournal(MotaLab.createMemoryStorage());
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

  const resource = await controller.start();
  assert.equal(resource.completed, true);
  assert.equal(fake.calls.direct.length, 1, "safe empty approach must use moveDirectly");
  assert.equal(fake.calls.route.length, 1, "resource is one state boundary");
  assert.equal(fake.hero.hp, 408);
  assert.equal(rawBlocks.length, 1);

  const enemy = await controller.runSingleCycle();
  assert.equal(enemy.completed, true);
  assert.equal(fake.calls.route.length, 2, "enemy is a separate next-cycle boundary");
  assert.equal(fake.hero.hp, 384);
  assert.equal(fake.hero.money, 21);
  assert.equal(fake.hero.experience, 67);
  assert.equal(rawBlocks.length, 0);

  const reported = await controller.runSingleCycle();
  assert.equal(reported.idle, true);
  assert.equal(journal.snapshot().pending_action, null);
  assert.equal(journal.snapshot().last_acknowledged_action_id,
    journal.snapshot().last_completed_action.action_id);
  assert.equal(fake.calls.saveLoad, 0);
  assert.deepEqual(fake.calls.forbidden, []);
  assert.ok(panelUpdates.length > 0);

  assert.ok(fs.existsSync(path.join(stateDir, "mota-lab.sqlite3")));
  assert.ok(fs.existsSync(path.join(stateDir, "decisions.jsonl")));
  const pauseRoot = path.join(stateDir, "pauses");
  assert.ok(fs.readdirSync(pauseRoot, { withFileTypes: true }).some((entry) => (
    entry.isDirectory() && fs.existsSync(path.join(pauseRoot, entry.name, "pause.json"))
  )));
});
