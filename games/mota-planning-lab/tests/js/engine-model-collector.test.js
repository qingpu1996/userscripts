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

function decode(dynamicMap, definitionMap, width, height) {
  const fail = (code, details) => {
    const error = new Error(code);
    error.detail_code = code;
    error.details = details;
    throw error;
  };
  return lab.decodeDetachedDynamicMap("MT-test", dynamicMap, definitionMap, width, height, fail);
}

test("detached dynamic map 解压官方 0/-1 token，保留动态值且不修改输入", () => {
  const definition = [[1, 2, 3], [4, 5, 6]];
  const dynamic = [0, [-1, 0, 124]];
  const beforeDefinition = structuredClone(definition);
  const beforeDynamic = structuredClone(dynamic);
  const decoded = decode(dynamic, definition, 3, 2);
  assert.deepEqual(decoded, [[1, 2, 3], [4, 0, 124]]);
  assert.deepEqual(definition, beforeDefinition);
  assert.deepEqual(dynamic, beforeDynamic);
  assert.notEqual(decoded[0], definition[0]);
  assert.notEqual(decoded[1], dynamic[1]);
});

test("detached dynamic map 支持全压缩、部分压缩、动态尺寸和完整二维回归", () => {
  const definition = [[7, 8], [9, 10], [11, 12]];
  assert.deepEqual(decode([0, 0, 0], definition, 2, 3), definition);
  assert.deepEqual(decode([0, [-1, 23], [0, -1]], definition, 2, 3), [
    [7, 8], [9, 23], [0, 12],
  ]);
  const full = [[0, 2], [3, 4], [5, 6]];
  const decoded = decode(full, definition, 2, 3);
  assert.deepEqual(decoded, full);
  assert.notEqual(decoded, full);
  assert.notEqual(decoded[0], full[0]);
  assert.deepEqual(decode(undefined, definition, 2, 3), definition);
});

test("detached dynamic map 对非法压缩 token、定义和尺寸 fail closed", () => {
  const definition = [[1, 2], [3, 4]];
  const cases = [
    { dynamic: [1, 0], definition, width: 2, height: 2, reason: "dynamic_row_token_invalid" },
    { dynamic: [[-2, -1], 0], definition, width: 2, height: 2, reason: "dynamic_cell_token_invalid" },
    { dynamic: [[NaN, -1], 0], definition, width: 2, height: 2, reason: "dynamic_cell_token_invalid" },
    { dynamic: [[1.5, -1], 0], definition, width: 2, height: 2, reason: "dynamic_cell_token_invalid" },
    { dynamic: [["1", -1], 0], definition, width: 2, height: 2, reason: "dynamic_cell_token_invalid" },
    { dynamic: [[null, -1], 0], definition, width: 2, height: 2, reason: "dynamic_cell_token_invalid" },
    { dynamic: [[{}, -1], 0], definition, width: 2, height: 2, reason: "dynamic_cell_token_invalid" },
    { dynamic: [[-1], 0], definition, width: 2, height: 2, reason: "dynamic_width_mismatch" },
    { dynamic: [[-1, -1, -1], 0], definition, width: 2, height: 2, reason: "dynamic_width_mismatch" },
    { dynamic: [0], definition, width: 2, height: 2, reason: "dynamic_height_mismatch" },
    { dynamic: [0, 0], definition: undefined, width: 2, height: 2, reason: "definition_height_mismatch" },
    { dynamic: [0, 0], definition: [[1, 2]], width: 2, height: 2, reason: "definition_height_mismatch" },
    { dynamic: [0, 0], definition: [[1], [2]], width: 2, height: 2, reason: "definition_width_mismatch" },
    { dynamic: [0, 0], definition: [[1, -1], [2, 3]], width: 2, height: 2, reason: "definition_cell_invalid" },
  ];
  for (const item of cases) {
    assert.throws(
      () => decode(item.dynamic, item.definition, item.width, item.height),
      (error) => error.detail_code === "ENGINE_MODEL_MAP_COMPRESSION_INVALID"
        && error.details.floor_id === "MT-test" && error.details.reason === item.reason,
      item.reason,
    );
  }
});

test("真实 MT0/MT1/MT3 压缩 token 与 MT4 完整地图均可采集且不调用解压 API", () => {
  const staticMap = grid(13, 13, 7);
  const maps = {
    MT0: { width: 13, height: 13, map: [
      0, 0, 0, 0, 0, 0, 0, 0,
      [-1, -1, -1, -1, -1, -1, 0, -1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, 124, -1, -1, -1, -1, -1, -1, -1],
      0, 0, 0,
    ] },
    MT1: { width: 13, height: 13, map: [
      0, [-1, -1, -1, 0, 0, 0, 0, -1, -1, -1, -1, -1, -1],
      0, 0, 0, 0, 0, 0, 0,
      [-1, -1, -1, -1, -1, -1, 0, -1, -1, -1, -1, -1, -1],
      0, 0, 0,
    ] },
    MT3: { width: 13, height: 13, map: [
      0,
      [-1, 0, 0, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1],
      [-1, 0, 0, -1, -1, -1, -1, -1, -1, -1, 0, -1, -1],
      [-1, 0, 0, -1, -1, -1, 0, -1, -1, -1, -1, -1, -1],
      [-1, -1, 0, -1, -1, -1, 0, -1, -1, 0, -1, 0, -1],
      [-1, -1, -1, -1, -1, -1, -1, -1, -1, 0, -1, 0, -1],
      [-1, 0, -1, -1, 0, 0, 0, -1, -1, 0, -1, 0, -1],
      [-1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1, -1, -1, 0, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, 0, -1, 0, -1, 0, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1, -1, 0, 0, 0, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1, -1, 0, 0, 0, -1, -1, -1],
      0,
    ] },
    MT4: { width: 13, height: 13, map: grid(13, 13, 4) },
  };
  let blockCalls = 0;
  const core = {
    status: { maps, hero: { items: {} } },
    floors: Object.fromEntries(Object.keys(maps).map((id) => [id, {
      width: 13, height: 13, map: structuredClone(staticMap),
    }])),
    maps: { blocksInfo: {} }, material: { items: {}, enemys: {} }, values: {},
    getMapBlocksObj() { blockCalls += 1; return []; },
    decompressMap() { throw new Error("runtime decompressMap must not be called"); },
    extractBlocks() { throw new Error("runtime extractBlocks must not be called"); },
  };
  const model = lab.collectEngineModel(core, {});
  assert.equal(blockCalls, 4);
  for (const floor of model.floors) {
    assert.equal(floor.map.length, 13);
    assert.ok(floor.map.every((row) => row.length === 13));
  }
  assert.equal(model.floors.find((floor) => floor.floor_id === "MT0").map[9][5], 124);
  assert.equal(model.floors.find((floor) => floor.floor_id === "MT1").map[1][6], 0);
  assert.equal(model.floors.find((floor) => floor.floor_id === "MT3").map[6][5], 0);
  assert.equal(model.floors.find((floor) => floor.floor_id === "MT4").map[2][11], 4);
});

test("engine model cache warm refresh 也只解码 detached 当前楼层", () => {
  const core = fakeCore();
  core.status.maps.MT0.map = Array.from({ length: 11 }, (_, y) => (
    y === 5 ? Array.from({ length: 11 }, (_, x) => x === 4 ? 23 : -1) : 0
  ));
  const before = structuredClone(core.status.maps.MT0.map);
  const cache = {};
  lab.collectEngineModel(core, {}, { cache, currentFloorId: "MT0" });
  const warm = lab.collectEngineModel(core, {}, { cache, currentFloorId: "MT0" });
  assert.equal(warm.floors.find((floor) => floor.floor_id === "MT0").map[5][4], 23);
  assert.deepEqual(core.status.maps.MT0.map, before);
});

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

test("solver 投影只接受可证明的资源增量并保留未知脚本 blocker", () => {
  const keySlots = { yellow: "yellowKey", blue: "blueKey", red: "redKey" };
  for (const [id, color] of [["yellowKey", "yellow"], ["blueKey", "blue"], ["redKey", "red"]]) {
    const parsed = lab.parseSolverItemDelta({ id, item_effect: null, complex: false }, {}, keySlots);
    assert.equal(parsed.supported, true);
    assert.equal(parsed.delta.keys[color], 1);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(lab.parseSolverItemDelta({
    item_effect: "core.status.hero.atk += core.values.redGem; core.status.hero.items.tools.yellowKey++",
    complex: false,
  }, { redGem: 3 }, keySlots))), {
    supported: true,
    delta: { hp: 0, attack: 3, defense: 0, gold: 0, experience: 0,
      keys: { yellow: 1, blue: 0, red: 0 }, inventory: {} },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(lab.parseSolverItemDelta(
    { item_effect: "evil()", complex: false }, {}, keySlots,
  ))), {
    supported: false, reason: "resource_effect_opaque",
  });
});

test("solver 投影结构化终局、资源、换层和门，未知 special fail closed", () => {
  const model = {
    floors: [{ floor_id: "F1", width: 3, height: 1, topology: { kind: "rectangle" },
      terminal_goals: [], opaque_events: [], change_floor: [{ x: 2, y: 0, floor_id: "F2", loc: { x: 0, y: 0 }, opaque: false }],
      blocks: [{ x: 1, y: 0, numeric_id: 1, id: "redGem", trigger: "getItem", no_pass: false },
        { x: 2, y: 0, numeric_id: 2, id: "downFloor", trigger: "changeFloor", no_pass: false }] },
    { floor_id: "F2", width: 3, height: 1, topology: { kind: "rectangle" },
      terminal_goals: [{ kind: "location", floor_id: "F2", x: 2, y: 0 }], opaque_events: [], change_floor: [],
      blocks: [{ x: 0, y: 0, numeric_id: 4, id: "wall", trigger: null, no_pass: true },
        { x: 1, y: 0, numeric_id: 3, id: "yellowDoor", trigger: "openDoor", no_pass: true }] }],
    blocks: [{ numeric_id: 1, id: "redGem", trigger: "getItem" },
      { numeric_id: 2, id: "downFloor", trigger: "changeFloor" },
      { numeric_id: 3, id: "yellowDoor", trigger: "openDoor", door_info: { keys: { yellowKey: 1 } } },
      { numeric_id: 4, id: "wall", trigger: null }],
    items: [{ id: "redGem", item_effect: "core.status.hero.atk += core.values.redGem", complex: false }],
    enemies: [], values: { redGem: 3 }, inventory: { key_slots: { yellow: "yellowKey" } },
  };
  const solver = lab.buildSolverModel(model, []);
  assert.deepEqual(JSON.parse(JSON.stringify(solver.terminal)), { kind: "location", floor_id: "F2", x: 2, y: 0 });
  assert.equal(solver.floors[0].blocks[0].delta.attack, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(solver.floors[0].blocks[1].target)), { floor_id: "F2", x: 0, y: 0 });
  assert.equal(solver.floors[1].blocks[0].reason, "wall");
  assert.equal(solver.floors[1].blocks[1].key_cost.yellow, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(solver.blockers)), []);
});

test("solver 投影保留多个明确 win 终局供全局路线择优", () => {
  const floor = (floor_id, x) => ({ floor_id, width: 2, height: 1,
    topology: { kind: "rectangle" }, blocks: [], opaque_events: [], change_floor: [],
    terminal_goals: [{ kind: "location", floor_id, x, y: 0 }] });
  const solver = lab.buildSolverModel({ floors: [floor("F1", 0), floor("F2", 1)],
    blocks: [], items: [], enemies: [], values: {}, inventory: { key_slots: {} } }, []);
  assert.deepEqual(JSON.parse(JSON.stringify(solver.terminal)), {
    kind: "any_location", locations: [
      { kind: "location", floor_id: "F1", x: 0, y: 0 },
      { kind: "location", floor_id: "F2", x: 1, y: 0 },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(solver.blockers)), []);
});

test("solver 商店仅绑定运行态 event.data 的唯一严格 openShop", () => {
  const definition = { width: 3, height: 1, map: [[0, 0, 0]], events: {} };
  const dynamic = { width: 3, height: 1, map: [[0, 0, 0]], events: {} };
  const rawBlocks = [
    { x: 1, y: 0, id: 1, event: { id: "shopNpc", cls: "npc", trigger: "action", noPass: true,
      data: [{ type: "openShop", id: "moneyShop", open: true }] } },
    { x: 2, y: 0, id: 2, event: { id: "badShop", cls: "npc", trigger: "action", noPass: true,
      data: [{ type: "openShop", id: "a", open: true }, { type: "openShop", id: "b", open: true }] } },
  ];
  const floor = lab.collectEngineFloor({ getMapBlocksObj: () => rawBlocks }, "F", definition, dynamic,
    (code) => { throw new Error(code); });
  assert.equal(floor.blocks[0].shop_id, "moneyShop");
  assert.equal(floor.blocks[1].shop_id, undefined);
  const shop = { supported: true, shop_id: "moneyShop", repeatable: true, choices: [{
    choice_id: "moneyShop:0:attack:4:25", index: 0, text: "attack+4", cost: 25,
    base_cost: 25, increment_per_purchase: 0,
    effect: { field: "attack", amount: 4 }, counter_flag: "shop_atk", purchase_count: 2,
  }] };
  const solver = lab.buildSolverModel({ floors: [{ ...floor, terminal_goals: [{
    kind: "location", floor_id: "F", x: 0, y: 0,
  }] }], blocks: [], items: [], enemies: [], values: {}, inventory: { key_slots: {} } }, [shop]);
  assert.equal(solver.floors[0].blocks[0].kind, "shop");
  assert.equal(solver.floors[0].blocks[0].shop_id, "moneyShop");
  assert.equal(solver.shops[0].choices[0].purchase_count, 2);
  assert.equal(solver.floors[0].blocks[1].kind, "opaque");
  assert.deepEqual(JSON.parse(JSON.stringify(solver.blockers)), [{
    code: "EVENT_UNSUPPORTED", detail: "F:2,0",
  }]);
});

test("普通静态历史事件不会重建 blocker，当前运行态事件仍阻路，静态 win 仍可作终局", () => {
  const definition = { width: 3, height: 1, map: [[0, 0, 0]], events: {
    "0,0": [{ type: "text", text: "already consumed" }],
    "2,0": [{ type: "win" }],
  } };
  const dynamic = { width: 3, height: 1, map: [[0, 0, 0]], events: {
    "1,0": [{ type: "text", text: "active" }],
  } };
  const floor = lab.collectEngineFloor({ getMapBlocksObj: () => [] }, "F", definition, dynamic,
    (code) => { throw new Error(code); });
  assert.deepEqual(JSON.parse(JSON.stringify(floor.opaque_events)), [{ x: 1, y: 0, reason: "event_script" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(floor.terminal_goals)), [{
    kind: "location", floor_id: "F", x: 2, y: 0,
  }]);
});

test("嵌套 afterBattle 明确 win 规范化为终局，任意元数据不冒充终局", () => {
  const definition = { width: 4, height: 1, map: [[0, 0, 0, 0]], events: {},
    afterBattle: {
      "1,0": [{ type: "if", condition: "flag:x", true: [{ type: "win" }], false: [] }],
      "2,0": [{ type: "function", function: "return;", metadata: { type: "win" } }],
      "3,0": [{ type: "text", text: "not terminal", payload: { type: "win" } }],
    } };
  const floor = lab.collectEngineFloor({ getMapBlocksObj: () => [] }, "F", definition,
    { width: 4, height: 1, map: [[0, 0, 0, 0]], events: {} },
    (code) => { throw new Error(code); });
  assert.deepEqual(JSON.parse(JSON.stringify(floor.terminal_goals)), [
    { kind: "location", floor_id: "F", x: 1, y: 0 },
  ]);
});

test("core.floorIds 展开 :next/:before 并使用目标层 stair 落点", () => {
  const core = fakeCore();
  core.floorIds = ["MT0", "MT1B", "MT1A", "MT2"];
  core.floors.MT0.changeFloor = { "10,10": { floorId: ":next", stair: "upFloor" } };
  core.floors.MT1B.upFloor = [2, 1];
  core.floors.MT1B.changeFloor = { "1,1": { floorId: ":before", stair: "downFloor" } };
  core.floors.MT0.downFloor = [9, 8];
  const model = lab.collectEngineModel(core, {});
  assert.deepEqual(JSON.parse(JSON.stringify(model.floors[0].change_floor[0])), {
    x: 10, y: 10, floor_id: "MT1B", loc: { x: 2, y: 1 }, direction: null,
    stair: "upFloor", time: null, ignore_change_floor: false, opaque: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(model.floors[1].change_floor[0].loc)), { x: 9, y: 8 });
});
