const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { loadRuntime } = require("./helpers/runtime");

const lab = loadRuntime();

function grid(size, value = 0) {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => value));
}

function performanceCore() {
  const floorIds = Array.from({ length: 27 }, (_, index) => `MT${index}`);
  const floors = {};
  const maps = {};
  const dynamic = {};
  for (const [index, floorId] of floorIds.entries()) {
    floors[floorId] = { title: `${index}F`, width: 13, height: 13, map: grid(13) };
    maps[floorId] = { title: `${index}F`, width: 13, height: 13, map: grid(13) };
    dynamic[floorId] = Array.from({ length: 12 }, (_, blockIndex) => ({
      x: blockIndex % 12,
      y: 1 + Math.floor(blockIndex / 12),
      id: 100 + blockIndex,
      event: { id: `item${blockIndex}`, cls: "items", trigger: "getItem", noPass: true },
    }));
  }
  const items = Object.fromEntries(Array.from({ length: 62 }, (_, index) => [
    `item${index}`,
    { cls: "items", name: `item ${index}`, itemEffect: "core.status.hero.hp+=1" },
  ]));
  const enemies = Object.fromEntries(Array.from({ length: 66 }, (_, index) => [
    `enemy${index}`,
    { hp: 10 + index, atk: 5, def: 1, money: 1, exp: 1, special: [] },
  ]));
  return {
    status: {
      floorId: "MT0",
      hero: {
        hp: 1000, atk: 10, def: 10, money: 0, exp: 0,
        loc: { x: 6, y: 12, direction: "up" },
        items: { tools: { yellowKey: 1, blueKey: 1 } },
      },
      maps,
      lockControl: false,
      event: { id: null },
    },
    floors,
    maps: { blocksInfo: {} },
    material: { items, enemys: enemies },
    values: { redGem: 3, blueGem: 3 },
    getMapBlocksObj(floorId) { return dynamic[floorId]; },
    getEnemyInfo() { return null; },
    getDamage() { return null; },
    isMoving() { return false; },
    setAutomaticRoute() {},
    moveDirectly() {},
    canMoveDirectly() { return true; },
    stopAutomaticRoute() {},
    _dynamic: dynamic,
  };
}

test("27-floor model caches catalog, keeps current runtime fresh, and supports invalidation", (t) => {
  const core = performanceCore();
  const adapter = lab.createEngineAdapter({ core });
  const timed = (callback) => {
    const started = performance.now();
    const value = callback();
    return { value, elapsed: performance.now() - started };
  };

  const cold = timed(() => lab.collectObservation(adapter));
  const warm = timed(() => lab.collectObservation(adapter));
  const fastAdapter = { readRuntimeSnapshot: () => adapter.readFastRuntimeSnapshot() };
  const fast = timed(() => lab.collectObservation(fastAdapter));
  t.diagnostic(
    `cold_full=${cold.elapsed.toFixed(3)}ms warm_full=${warm.elapsed.toFixed(3)}ms fast=${fast.elapsed.toFixed(3)}ms`,
  );

  assert.equal(cold.value.engine_model.floors.length, 27);
  assert.equal(warm.value.engine_model.catalog_hash, cold.value.engine_model.catalog_hash);
  assert.ok(warm.elapsed < cold.elapsed * 0.5, `cold=${cold.elapsed} warm=${warm.elapsed}`);
  assert.ok(fast.elapsed < cold.elapsed * 0.2, `cold=${cold.elapsed} fast=${fast.elapsed}`);

  core.status.hero.items.tools.yellowKey = 2;
  core._dynamic.MT0.pop();
  const refreshed = lab.collectObservation(adapter);
  assert.equal(refreshed.engine_model.inventory.classes.tools.yellowKey, 2);
  assert.equal(refreshed.engine_model.floors[0].blocks.length, 11);
  assert.notEqual(refreshed.engine_model.model_hash, warm.value.engine_model.model_hash);

  core.material.items.item0 = Object.assign({}, core.material.items.item0, { name: "changed" });
  const automaticallyInvalidated = lab.collectObservation(adapter);
  assert.notEqual(
    automaticallyInvalidated.engine_model.catalog_hash,
    refreshed.engine_model.catalog_hash,
  );

  core.material.items.item1.name = "changed in place";
  adapter.invalidateEngineModelCache();
  const explicitlyInvalidated = lab.collectObservation(adapter);
  assert.notEqual(
    explicitlyInvalidated.engine_model.catalog_hash,
    automaticallyInvalidated.engine_model.catalog_hash,
  );
});
