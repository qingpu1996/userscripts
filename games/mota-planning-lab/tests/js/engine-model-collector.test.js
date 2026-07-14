const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRuntime } = require("./helpers/runtime");

const lab = loadRuntime();

function grid(width, height, value = 0) {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => value));
}

function fakeCore() {
  const dynamic = {
    MT0: [
      { x: 1, y: 1, id: 21, event: { id: "yellowDoor", cls: "terrains", trigger: "openDoor", noPass: true } },
      { x: 2, y: 1, id: 31, disable: true, event: { id: "yellowKey", cls: "items", trigger: "getItem" } },
    ],
    MT1A: [{ x: 2, y: 2, id: 101, event: { id: "greenSlime", cls: "enemy48", trigger: "battle", noPass: true } }],
    MT1B: [],
    MT2: [{ x: 12, y: 12, id: 88, event: { id: "upFloor", cls: "terrains", trigger: "changeFloor" } }],
  };
  const irregular = [[0, 0, 0], [0], [0, 0]];
  const cyclic = { kept: 7, fn() { return 1; } };
  cyclic.self = cyclic;
  return {
    status: {
      floorId: "MT0",
      hero: {
        items: {
          tools: { yellowKey: 2, blueKey: 1 },
          constants: { book: 1 },
        },
      },
      maps: {
        MT0: { title: "0F", width: 11, height: 11, map: grid(11, 11) },
        MT1A: { title: "1F-A", width: 3, height: 3, map: irregular },
        MT1B: { title: "1F-B", width: 3, height: 3, map: grid(3, 3) },
        MT2: { title: "2F", width: 13, height: 13, map: grid(13, 13) },
      },
    },
    floors: {
      MT2: { title: "2F", width: 13, height: 13, map: grid(13, 13), ratio: 2 },
      MT1B: { title: "1F-B", width: 3, height: 3, map: grid(3, 3), changeFloor: { "1,1": { floorId: "MT1A", loc: [1, 1] } } },
      MT0: { title: "0F", width: 11, height: 11, map: grid(11, 11), changeFloor: { "10,10": { floorId: "MT1A", stair: "upFloor" } } },
      MT1A: { title: "1F-A", width: 3, height: 3, map: irregular },
    },
    maps: {
      blocksInfo: {
        21: { id: "yellowDoor", cls: "terrains", trigger: null, noPass: true, doorInfo: { keys: { yellowKey: 1 } } },
        31: { id: "yellowKey", cls: "items", trigger: "getItem" },
      },
    },
    material: {
      items: {
        yellowKey: { cls: "items", name: "黄钥匙", text: "获得一把黄钥匙", itemEffect: "core.status.hero.items.tools.yellowKey++", itemEffectTip: "黄钥匙+1" },
        book: { cls: "tools", name: "怪物手册", useItemEvent: [{ type: "text", text: "open" }, cyclic] },
      },
      enemys: {
        greenSlime: { hp: 50, atk: 20, def: 1, money: 1, exp: 1, special: [] },
      },
    },
    values: { floorChangeTime: 500, ignored: cyclic },
    getMapBlocksObj(floorId, includeDisabled) {
      assert.equal(includeDisabled, true);
      return dynamic[floorId];
    },
  };
}

test("完整 engine_model 采集多地图、13x13、异形拓扑和动态 blocks", () => {
  const core = fakeCore();
  const model = lab.collectEngineModel(core, {
    yellow: "yellowKey", blue: "blueKey", red: "redKey",
  });
  assert.equal(model.protocol, 1);
  assert.match(model.catalog_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(model.model_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(JSON.parse(JSON.stringify(model.floors.map((floor) => floor.floor_id))), ["MT0", "MT1A", "MT1B", "MT2"]);
  assert.equal(model.floors.find((floor) => floor.floor_id === "MT2").width, 13);
  assert.equal(model.floors.find((floor) => floor.floor_id === "MT2").height, 13);
  assert.equal(model.floors.find((floor) => floor.floor_id === "MT1A").topology.kind, "valid_cells");
  assert.equal(model.floors.find((floor) => floor.floor_id === "MT1A").topology.valid_cells.length, 6);
  assert.equal(model.floors.find((floor) => floor.floor_id === "MT0").blocks.length, 1);
  assert.equal(model.floors.find((floor) => floor.floor_id === "MT0").blocks[0].id, "yellowDoor");
  assert.equal(model.floors.find((floor) => floor.floor_id === "MT0").change_floor[0].floor_id, "MT1A");
  assert.equal(model.blocks.find((block) => block.id === "yellowDoor").trigger, null);
  assert.deepEqual(JSON.parse(JSON.stringify(
    model.blocks.find((block) => block.id === "yellowDoor").door_info.keys,
  )), { yellowKey: 1 });
  assert.equal(model.items.find((item) => item.id === "yellowKey").item_effect_tip, "黄钥匙+1");
  assert.equal(model.items.find((item) => item.id === "book").complex, true);
  assert.equal(JSON.stringify(model).includes("fn"), false);
  assert.equal(JSON.stringify(model).includes("self"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(model.inventory)), {
    classes: { constants: { book: 1 }, tools: { blueKey: 1, yellowKey: 2 } },
    key_slots: { blue: "blueKey", red: "redKey", yellow: "yellowKey" },
  });
});

test("catalog hash 确定且不受动态地图/inventory影响，静态目录变化会改变", () => {
  const first = fakeCore();
  const second = fakeCore();
  second.status.hero.items.tools.yellowKey = 99;
  second.getMapBlocksObj = (floorId) => floorId === "MT0" ? [] : [];
  const a = lab.collectEngineModel(first, { yellow: "yellowKey", blue: "blueKey", red: "redKey" });
  const b = lab.collectEngineModel(second, { yellow: "yellowKey", blue: "blueKey", red: "redKey" });
  assert.equal(a.catalog_hash, b.catalog_hash);
  assert.notEqual(a.model_hash, b.model_hash);
  const third = fakeCore();
  third.material.items.yellowKey.name = "另一种钥匙";
  const c = lab.collectEngineModel(third, { yellow: "yellowKey", blue: "blueKey", red: "redKey" });
  assert.notEqual(a.catalog_hash, c.catalog_hash);
});

test("engine_model 超限和非法轴尺寸 fail closed", () => {
  const tooMany = fakeCore();
  tooMany.floors = Object.fromEntries(Array.from(
    { length: lab.MAX_ENGINE_FLOORS + 1 },
    (_, index) => [`F${index}`, { width: 1, height: 1, map: [[0]] }],
  ));
  tooMany.status.maps = {};
  assert.throws(
    () => lab.collectEngineModel(tooMany, {}),
    (error) => error.pause_kind === "ENGINE_API_INCOMPATIBLE"
      && error.detail_code === "ENGINE_MODEL_FLOOR_LIMIT_EXCEEDED",
  );

  const badAxis = fakeCore();
  badAxis.floors.MT2.width = lab.MAX_MAP_AXIS + 1;
  badAxis.status.maps.MT2.width = lab.MAX_MAP_AXIS + 1;
  assert.throws(
    () => lab.collectEngineModel(badAxis, {}),
    (error) => error.pause_kind === "ENGINE_API_INCOMPATIBLE"
      && error.detail_code === "ENGINE_MODEL_DIMENSIONS_EXCEEDED",
  );
});

test("observation wire optional 携带完整 engine_model，旧 observation 仍可序列化", () => {
  const oldObservation = {
    protocol: 2, page: "/games/24/", session_id: "S", floor_id: "MT0", floor_name: "0F", floor_number: 0,
    dimensions: { width: 1, height: 1 }, topology: { kind: "rectangle", source: "engine_current_map", confidence: "confirmed" },
    topology_fingerprint: `sha256:${"a".repeat(64)}`, map_instance_id: "m",
    hero: { hp: 1, attack: 1, defense: 1, gold: 0, experience: 0, loc: { x: 0, y: 0, direction: "up" } },
    keys: { yellow: 0, blue: 0, red: 0 }, busy: false, blocks: [], captured_at: 1,
  };
  assert.equal(Object.hasOwn(lab.cloneObservationForWire(oldObservation), "engine_model"), false);
  const model = lab.collectEngineModel(fakeCore(), { yellow: "yellowKey", blue: "blueKey", red: "redKey" });
  oldObservation.engine_model = model;
  const wire = lab.cloneObservationForWire(oldObservation);
  assert.equal(JSON.stringify(wire.engine_model), JSON.stringify(model));
  assert.notEqual(wire.engine_model, model);
  assert.equal(lab.fingerprintProjection(oldObservation).catalog_hash, model.catalog_hash);
  assert.equal(Object.hasOwn(lab.fingerprintProjection(oldObservation), "engine_model"), false);
});

test("非面板 inventory 资源差分可由浏览器执行层校验", () => {
  const model = lab.collectEngineModel(fakeCore(), {
    yellow: "yellowKey", blue: "blueKey", red: "redKey",
  });
  const before = {
    protocol: 2, page: "/games/24/", session_id: "S", floor_id: "MT0",
    floor_name: "0F", floor_number: 0, dimensions: { width: 2, height: 1 },
    topology: { kind: "rectangle", source: "engine_current_map", confidence: "confirmed" },
    topology_fingerprint: `sha256:${"a".repeat(64)}`, map_instance_id: "m",
    hero: { hp: 1, attack: 1, defense: 1, gold: 0, experience: 0,
      loc: { x: 0, y: 0, direction: "up" } },
    keys: { yellow: 2, blue: 1, red: 0 }, busy: false,
    blocks: [{ x: 1, y: 0, numeric_id: 99, id: "book", cls: "items",
      trigger: "getItem", no_pass: true, damage: null, enemy: null }],
    captured_at: 1, engine_model: model,
  };
  const after = JSON.parse(JSON.stringify(before));
  after.hero.loc.x = 1;
  after.blocks = [];
  after.engine_model.inventory.classes.constants.book = 2;
  const expected = { inventory: { book: 1 }, removed_blocks: [{
    x: 1, y: 0, numeric_id: 99, id: "book", cls: "items", trigger: "getItem",
  }] };
  lab.validateExpectedDelta(expected, { dimensions: before.dimensions, topology: before.topology });
  assert.equal(lab.compareExpectedDelta(before, after, expected, { allowPositionChange: true }).ok, true);
});
