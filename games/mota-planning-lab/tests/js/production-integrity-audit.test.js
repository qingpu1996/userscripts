const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { makePoisonCore, projectDir } = require("./helpers/runtime.js");

async function auditModule() {
  return import(pathToFileURL(path.join(projectDir, "scripts", "production-integrity-audit.mjs")).href);
}

test("实际 production tree 通过独立执行完整性审计", async () => {
  const { auditProductionTree, ACTION_ENGINE_APIS, READ_ONLY_ENGINE_APIS } = await auditModule();
  const result = auditProductionTree();
  assert.equal(result.status, "pass", JSON.stringify(result.failures));
  assert.equal(result.assurance, "controlled-project-source-audit-not-a-javascript-sandbox");
  assert.deepEqual(result.engine_api_inventory.action, ACTION_ENGINE_APIS.slice().sort());
  assert.ok(result.engine_api_inventory.read.every((name) => READ_ONLY_ENGINE_APIS.includes(name)));
  assert.deepEqual(result.failures, []);
});

test("production tree gate 对临时 actual-adapter alias 注入 fail closed", async () => {
  const { auditProductionTree } = await auditModule();
  const actualAdapter = fs.readFileSync(path.join(projectDir, "src", "engine-adapter.js"), "utf8");
  const injected = `${actualAdapter}\n${[
    "const injectedEngine = runtime;",
    "injectedEngine.unknownAction();",
    "scope.core.unknownScopedAction();",
  ].join("\n")}\n`;
  const result = auditProductionTree({ engineAdapterSource: injected });
  assert.equal(result.status, "fail");
  assert.equal(result.failures.filter((failure) => (
    failure.includes("UNCLASSIFIED_ENGINE_API")
  )).length, 2, JSON.stringify(result));
});

test("实际 source gate 对权威 alias 写与未分类引擎 API fail closed", async () => {
  const { auditEngineAdapter } = await auditModule();
  const result = auditEngineAdapter([
    "function requireRuntime(){return core;}",
    "const runtime=requireRuntime();",
    "const hero=runtime.status.hero;",
    "hero.hp=1;",
    "runtime.unknownAction();",
  ].join("\n"));
  assert.equal(result.failures.some((item) => item.reason.includes("authoritative runtime alias")), true);
  assert.equal(result.failures.some((item) => item.reason.includes("unclassified engine API")), true);
});

test("engine API inventory 追踪 runtime/core 简单 alias 与 scope/globalThis core", async () => {
  const { auditEngineAdapter } = await auditModule();
  const result = auditEngineAdapter([
    "const engine = runtime;",
    "engine.unknownAction();",
    "scope.core.unknownScopedAction();",
    "globalThis.core.unknownGlobalAction();",
    "runtime[dynamicMethod]();",
  ].join("\n"));
  assert.equal(result.failures.filter((item) => (
    item.reason.includes("unclassified engine API")
  )).length, 4, JSON.stringify(result));
});

test("engine API inventory 分类 destructured/member/bound aliases 且未知 member fail closed", async () => {
  const { auditEngineAdapter } = await auditModule();
  const result = auditEngineAdapter([
    "const engine = requireRuntime();",
    "const { getDamage: damageAt, moveDirectly: directMove, mystery } = engine;",
    "const enemyInfo = engine.getEnemyInfo;",
    "const route = engine.setAutomaticRoute.bind(engine);",
    "damageAt('e', 1, 2, 'f');",
    "enemyInfo.call(engine, 'e', null, 1, 2, 'f');",
    "directMove.apply(engine, [1, 2]);",
    "route(1, 2, []);",
    "mystery();",
  ].join("\n"));
  assert.deepEqual(result.calls.read, ["getDamage", "getEnemyInfo"]);
  assert.deepEqual(result.calls.action, ["moveDirectly", "setAutomaticRoute"]);
  assert.equal(result.failures.some((item) => (
    item.reason.includes("unclassified engine API call: mystery")
  )), true, JSON.stringify(result));
});

test("engine API inventory 对 direct/dynamic member 的 call apply bind fail closed", async () => {
  const { auditEngineAdapter } = await auditModule();
  const result = auditEngineAdapter([
    "runtime.unknownAction.call(runtime);",
    "runtime[dynamicMethod].apply(runtime, []);",
    "const f=runtime[dynamicMethod]; f();",
    "runtime.getDamage.call(runtime, 'e', null, 1, 2, 'f');",
    "runtime['getEnemyInfo'].apply(runtime, ['e', null, 1, 2, 'f']);",
    "runtime.moveDirectly.bind(runtime)(1, 2);",
    "const readAlias = runtime.getMapBlocksObj; readAlias.bind(runtime)('f', true);",
    "const actionAlias = runtime.setAutomaticRoute; actionAlias.call(runtime, 1, 2, []);",
  ].join("\n"));
  assert.deepEqual(result.calls.read, ["getDamage", "getEnemyInfo", "getMapBlocksObj"]);
  assert.deepEqual(result.calls.action, ["moveDirectly", "setAutomaticRoute"]);
  assert.equal(result.failures.some((item) => (
    item.reason.includes("unclassified engine API call: unknownAction")
  )), true, JSON.stringify(result));
  assert.equal(result.failures.filter((item) => (
    item.reason.includes("DYNAMIC_ENGINE_API")
  )).length >= 2, true, JSON.stringify(result));
});

test("production source discovery 递归且与 userscript manifest 精确一致", async () => {
  const { discoverProductionSources } = await auditModule();
  const result = discoverProductionSources();
  assert.deepEqual(result.failures, []);
  assert.ok(result.browserFiles.every((file) => file.startsWith(path.join(projectDir, "src"))));
  assert.ok(result.serviceFiles.every((file) => file.startsWith(path.join(projectDir, "service", "mota_lab"))));
  assert.ok(result.browserFiles.every((file) => !file.includes(`${path.sep}tests${path.sep}`)));
  assert.ok(result.browserFiles.every((file) => !file.includes(`${path.sep}qa${path.sep}`)));
  assert.equal(result.browserFiles.length, result.manifestFiles.length);
});

test("production source discovery 会发现未进入 manifest 的嵌套 production 模块", async (t) => {
  const { discoverProductionSources } = await auditModule();
  const nestedDir = path.join(projectDir, "src", ".audit-recursive-fixture");
  const fixture = path.join(nestedDir, "nested.js");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(fixture, "MotaLab.__auditFixture = true;\n", "utf8");
  t.after(() => fs.rmSync(nestedDir, { recursive: true, force: true }));
  const result = discoverProductionSources();
  assert.ok(result.browserFiles.includes(fixture));
  assert.ok(result.failures.some((failure) => failure.includes("missing from userscript manifest")));
  assert.equal(result.serviceFiles.some((file) => file.startsWith(os.tmpdir())), false);
});

test("fake core 对所有权威 root/container 的 set/delete/defineProperty fail closed", () => {
  const fake = makePoisonCore({
    instrumentAuthority: true,
    currentMap: { map: [[0, 0]] },
    blocks: [{ x: 1, y: 0, event: { id: "enemy", trigger: "battle" } }],
    enemyInfo: { enemy: { hp: 10, atk: 10, def: 0, money: 1, experience: 1 } },
  });
  const core = fake.scope.core;
  const floorId = core.status.floorId;
  const enemy = core.getEnemyInfo("enemy", null, 1, 0, floorId);
  const targets = [
    ["core", core, "status"],
    ["status", core.status, "maps"],
    ["maps", core.status.maps, floorId],
    ["hero", core.status.hero, "hp"],
    ["hero container", core.status.hero.loc, "x"],
    ["map", core.status.maps[floorId], "title"],
    ["map grid", core.status.maps[floorId].map[0], 0],
    ["blocks", core.getMapBlocksObj(floorId, true), 0],
    ["block", core.getMapBlocksObj(floorId, true)[0], "x"],
    ["enemy", enemy, "hp"],
  ];
  for (const [label, target, key] of targets) {
    assert.throws(() => { target[key] = target[key]; }, /outside public action API/, `${label} set`);
    assert.throws(() => { delete target[key]; }, /outside public action API/, `${label} delete`);
    assert.throws(() => Object.defineProperty(target, key, {
      configurable: true, value: target[key], writable: true,
    }), /outside public action API/, `${label} defineProperty`);
  }
  assert.equal(fake.calls.illegalWrites.length, targets.length * 3);
  assert.deepEqual(fake.calls.authoritativeWrites, []);
});

test("fake core 只有模拟公开行动 API 的内部回调能开启写入归因", () => {
  const readMutation = makePoisonCore({
    instrumentAuthority: true,
    onBlocks(_count, hero) { hero.hp += 1; },
  });
  assert.throws(() => readMutation.scope.core.getMapBlocksObj("synthetic-floor-4", true),
    /outside public action API/);
  assert.equal(readMutation.calls.illegalWrites.length, 1);
  assert.deepEqual(readMutation.calls.authoritativeWrites, []);

  const actionMutation = makePoisonCore({
    instrumentAuthority: true,
    onDirect(x, y, hero) {
      hero.loc.x = x;
      hero.loc.y = y;
    },
  });
  actionMutation.scope.core.moveDirectly(2, 3);
  assert.deepEqual(actionMutation.calls.illegalWrites, []);
  assert.ok(actionMutation.calls.authoritativeWrites.length > 0);
  assert.ok(actionMutation.calls.authoritativeWrites.every((item) => (
    item.api === "moveDirectly" && item.path.startsWith("hero.loc.")
  )));
});
