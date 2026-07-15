const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadRuntime,
  makeObservation,
  makeGuard,
} = require("./helpers/runtime");

const lab = loadRuntime();

test("block delta 稳定投影遵守跨语言共享契约", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(
    __dirname, "../fixtures/block-delta-projection-contract.json",
  ), "utf8"));
  for (const sample of fixture.cases) {
    if (sample.error) {
      assert.throws(() => lab.blockDeltaProjection(sample.before), TypeError, sample.name);
      continue;
    }
    const before = lab.canonicalize(lab.blockDeltaProjection(sample.before));
    const after = lab.canonicalize(lab.blockDeltaProjection(sample.after));
    assert.equal(before === after, sample.equal, sample.name);
  }
});

test("会话 baseline 由当前 observation 动态生成，不含编译期现场", () => {
  const first = lab.baselineSummary(makeObservation());
  const second = lab.baselineSummary(makeObservation({
    floor_id: "another-runtime-map",
    dimensions: { width: 7, height: 19 },
    hero: { hp: 999, loc: { x: 6, y: 18 } },
  }));
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(second.floor_id, "another-runtime-map");
  assert.deepEqual(JSON.parse(JSON.stringify(second.dimensions)), { width: 7, height: 19 });
  assert.equal(second.hero.hp, 999);
});

test("guard 要求楼层、位置、完整面板和三种钥匙", () => {
  const observation = makeObservation();
  assert.equal(lab.compareGuard(observation, makeGuard(observation)).ok, true);
  const incomplete = makeGuard(observation);
  delete incomplete.gold;
  delete incomplete.keys.red;
  const result = lab.compareGuard(observation, incomplete);
  assert.equal(result.ok, false);
  assert.deepEqual(
    Array.from(result.differences, (difference) => difference.field),
    ["gold", "keys.red"],
  );
});

test("expected_delta 验证 +200 HP 资源并默认要求其余资源不变", () => {
  const before = makeObservation({
    blocks: [{
      x: 9, y: 3, numeric_id: 31, id: "redPotion", cls: "items",
      trigger: "getItem", no_pass: false, damage: null, enemy: null,
    }],
  });
  const after = makeObservation({
    hero: { hp: 408, loc: { x: 9, y: 3 } },
    blocks: [],
  });
  const expected = {
    hp: 200,
    position: { x: 9, y: 3 },
    removed_blocks: [{
      x: 9, y: 3, numeric_id: 31, id: "redPotion", cls: "items", trigger: "getItem",
    }],
  };
  assert.equal(lab.compareExpectedDelta(before, after, expected).ok, true);
  after.hero.gold += 1;
  const mismatch = lab.compareExpectedDelta(before, after, expected);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.differences.some((difference) => difference.field === "gold"));
});

test("removed_blocks 按服务实际声明字段匹配，最小 x/y/id 可用", () => {
  const removed = {
    x: 2, y: 3, numeric_id: 88, id: "syntheticResource", cls: "items",
    trigger: "getItem", no_pass: false, damage: null, enemy: null,
  };
  const before = makeObservation({ blocks: [removed] });
  const after = makeObservation({ blocks: [] });
  assert.equal(lab.compareExpectedDelta(before, after, {
    removed_blocks: [{ x: 2, y: 3, id: "syntheticResource" }],
  }, { allowPositionChange: true }).ok, true);
  assert.equal(lab.compareExpectedDelta(before, after, {
    removed_blocks: [{ x: 2, y: 3, id: "wrong" }],
  }, { allowPositionChange: true }).ok, false);
});

test("AUTO-F 红宝石增益不会把其他怪物的派生 damage 误算为方块变化", () => {
  const redGem = {
    x: 3, y: 4, numeric_id: 27, id: "redGem", cls: "items",
    trigger: "getItem", no_pass: false, damage: null, enemy: null,
  };
  const monster = (x, y, id, damage) => ({
    x, y, numeric_id: 209, id, cls: "enemys", trigger: "battle",
    no_pass: true, damage,
    enemy: { hp: 110, attack: 25, defense: 5, gold: 5, experience: 4, special: [] },
  });
  const beforeMonsters = [
    monster(2, 4, "skeleton", 24),
    monster(9, 5, "blackSlime", 210),
    monster(2, 6, "skeletonSoilder", 931),
    monster(7, 6, "bluePriest", null),
    monster(2, 9, "skeletonSoilder", 931),
  ];
  const afterDamage = [20, 168, 456, 3596, 456];
  const afterMonsters = beforeMonsters.map((block, index) => Object.assign(
    {}, JSON.parse(JSON.stringify(block)), { damage: afterDamage[index] },
  ));
  const before = makeObservation({
    hero: { attack: 23, loc: { x: 4, y: 3, direction: "left" } },
    blocks: [redGem, ...beforeMonsters],
  });
  const after = makeObservation({
    hero: { attack: 26, loc: { x: 3, y: 3, direction: "down" } },
    blocks: afterMonsters,
  });
  const result = lab.compareExpectedDelta(before, after, {
    attack: 3,
    removed_blocks: [{
      x: 3, y: 4, numeric_id: 27, id: "redGem", cls: "items", trigger: "getItem",
    }],
  }, { allowPositionChange: true });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.actual.removed)), [redGem]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.actual.added)), []);
  assert.equal(before.blocks[1].damage, 24);
  assert.equal(after.blocks[0].damage, 20);

  const pending = {
    action_id: "AUTO-000000000000000F",
    pre_fingerprint: lab.fingerprintObservation(before),
    pre_observation: before,
    expected_delta: {
      attack: 3,
      removed_blocks: [{ x: 3, y: 4, id: "redGem" }],
    },
    operations: [{ type: "grid", x: 3, y: 3 }, { type: "grid", x: 3, y: 4 }],
    requires_non_position_change: true,
  };
  const recovery = lab.classifyPendingRecovery(
    pending, after, lab.fingerprintObservation(after),
  );
  assert.equal(recovery.phase, "completed");
  assert.equal(recovery.pending_action_id, pending.action_id);
});

test("怪物稳定语义变化仍算未声明方块差分", () => {
  const enemy = {
    x: 2, y: 3, numeric_id: 9, id: "syntheticEnemy", cls: "enemy48",
    trigger: "battle", no_pass: true, damage: 10,
    enemy: { hp: 20, attack: 5, defense: 2, gold: 1, experience: 1, special: [] },
  };
  const changedEnemy = JSON.parse(JSON.stringify(enemy));
  changedEnemy.enemy.hp = 21;
  const result = lab.compareExpectedDelta(
    makeObservation({ blocks: [enemy] }),
    makeObservation({ blocks: [changedEnemy] }),
    {},
    { allowPositionChange: true },
  );
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((difference) => difference.field === "removed_blocks"));
  assert.ok(result.differences.some((difference) => difference.field === "added_blocks"));
});

test("怪物 damage 的数值、null 和未知哨兵变化不污染身份", () => {
  const enemy = {
    x: 2, y: 3, numeric_id: 9, id: "syntheticEnemy", cls: "enemy48",
    trigger: "battle", no_pass: true, damage: 10,
    enemy: { hp: 20, attack: 5, defense: 2, gold: 1, experience: 1, special: [] },
  };
  for (const damage of [11, null, "???"]) {
    const changed = JSON.parse(JSON.stringify(enemy));
    changed.damage = damage;
    assert.equal(lab.compareExpectedDelta(
      makeObservation({ blocks: [enemy] }),
      makeObservation({ blocks: [changed] }),
      {},
      { allowPositionChange: true },
    ).ok, true);
  }
  for (const damage of [
    -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    true, [], { unknown: true }, "unknown",
  ]) {
    const changed = JSON.parse(JSON.stringify(enemy));
    changed.damage = damage;
    assert.throws(() => lab.compareExpectedDelta(
      makeObservation({ blocks: [enemy] }),
      makeObservation({ blocks: [changed] }),
      {},
      { allowPositionChange: true },
    ), /Invalid observed enemy damage/);
    assert.throws(() => lab.compareExpectedDelta(
      makeObservation({ blocks: [changed] }),
      makeObservation({ blocks: [] }),
      { removed_blocks: [{ x: 2, y: 3, id: "syntheticEnemy" }] },
      { allowPositionChange: true },
    ), /Invalid observed enemy damage/);
  }
});

test("未知 block 字段不会被稳定投影静默忽略", () => {
  const enemy = {
    x: 2, y: 3, numeric_id: 9, id: "syntheticEnemy", cls: "enemy48",
    trigger: "battle", no_pass: true, damage: 10,
    enemy: { hp: 20, attack: 5, defense: 2, gold: 1, experience: 1, special: [] },
  };
  const changed = JSON.parse(JSON.stringify(enemy));
  changed.future_semantic = { mode: "changed" };
  const result = lab.compareExpectedDelta(
    makeObservation({ blocks: [enemy] }),
    makeObservation({ blocks: [changed] }),
    {},
    { allowPositionChange: true },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(Array.from(result.differences, (item) => item.field), [
    "removed_blocks", "added_blocks",
  ]);
});

test("资源未移除、额外稳定方块变化和错误属性增益仍 fail closed", () => {
  const gem = {
    x: 3, y: 4, numeric_id: 27, id: "redGem", cls: "items",
    trigger: "getItem", no_pass: false, damage: null, enemy: null,
  };
  const wall = {
    x: 4, y: 4, numeric_id: 1, id: "yellowWall", cls: "animates",
    trigger: null, no_pass: true, damage: null, enemy: null,
  };
  const before = makeObservation({ hero: { attack: 23 }, blocks: [gem, wall] });
  const expected = { attack: 3, removed_blocks: [{ x: 3, y: 4, id: "redGem" }] };
  assert.equal(lab.compareExpectedDelta(before, makeObservation({
    hero: { attack: 26 }, blocks: [gem, wall],
  }), expected, { allowPositionChange: true }).ok, false);
  assert.equal(lab.compareExpectedDelta(before, makeObservation({
    hero: { attack: 26 }, blocks: [],
  }), expected, { allowPositionChange: true }).ok, false);
  const replacement = Object.assign({}, wall, { id: "blueWall", numeric_id: 3 });
  assert.equal(lab.compareExpectedDelta(before, makeObservation({
    hero: { attack: 26 }, blocks: [replacement],
  }), expected, { allowPositionChange: true }).ok, false);
  assert.equal(lab.compareExpectedDelta(before, makeObservation({
    hero: { attack: 25 }, blocks: [wall],
  }), expected, { allowPositionChange: true }).ok, false);
});

test("floor_id=null 只在楼梯上下文允许且必须实际换层", () => {
  assert.throws(() => lab.validateExpectedDelta({ floor_id: null }), /only allowed for stairs/);
  assert.doesNotThrow(() => lab.validateExpectedDelta(
    { floor_id: null },
    { allowUnknownFloor: true },
  ));
  const before = makeObservation();
  const changed = makeObservation({
    floor_id: "synthetic-floor-new", floor_name: null, floor_number: null,
    map_instance_id: "map:synthetic-floor-new:topology-a",
  });
  assert.equal(lab.compareExpectedDelta(before, changed, { floor_id: null }, {
    allowUnknownFloor: true,
    allowPositionChange: true,
  }).ok, true);
  assert.equal(lab.compareExpectedDelta(before, before, { floor_id: null }, {
    allowUnknownFloor: true,
    allowPositionChange: true,
  }).ok, false);
});

test("expected_delta 拒绝 null、非整数和未知字段", () => {
  assert.throws(() => lab.validateExpectedDelta({ hp: null }), /Invalid expected delta/);
  assert.throws(() => lab.validateExpectedDelta({ hp: 0.5 }), /Invalid expected delta/);
  assert.throws(() => lab.validateExpectedDelta({ unknown: 0 }), /Unsupported/);
  assert.throws(() => lab.validateExpectedDelta({ keys: { yellow: Infinity } }), /Invalid key delta/);
});

test("恢复三分法：pre 相同、预期 post、无法解释的中间态", () => {
  const before = makeObservation();
  const beforeFingerprint = lab.fingerprintObservation(before);
  const pending = {
    action_id: "AUTO-1234567890ABCDEF",
    pre_fingerprint: beforeFingerprint,
    pre_observation: before,
    expected_delta: { hp: -24, gold: 5, experience: 4, position: { x: 9, y: 3 } },
  };
  const notExecuted = lab.classifyPendingRecovery(pending, before, beforeFingerprint);
  assert.equal(notExecuted.phase, "not_executed");

  const completedObservation = makeObservation({
    hero: { hp: 184, gold: 21, experience: 67, loc: { x: 9, y: 3 } },
  });
  const completed = lab.classifyPendingRecovery(
    pending,
    completedObservation,
    lab.fingerprintObservation(completedObservation),
  );
  assert.equal(completed.phase, "completed");

  const ambiguous = makeObservation({ hero: { hp: 190, loc: { x: 9, y: 3 } } });
  const mismatch = lab.classifyPendingRecovery(
    pending,
    ambiguous,
    lab.fingerprintObservation(ambiguous),
  );
  assert.equal(mismatch.phase, "mismatch");
  assert.equal(mismatch.detail_code, "RECOVERY_STATE_AMBIGUOUS");
});

test("menu_choice 恢复严格区分未打开、只打开与精确购买一次", () => {
  const choice = {
    choice_id: "moneyShop1:1:attack:4:25", index: 1, text: "攻击+4", cost: 25,
    effect: { field: "attack", amount: 4 }, counter_flag: "shop_atk", purchase_count: 2,
  };
  const before = makeObservation({ hero: { gold: 54 }, shops: [{
    supported: true, shop_id: "moneyShop1", repeatable: true, choices: [null, choice],
  }] });
  const operation = {
    type: "menu_choice", shop_id: "moneyShop1", menu_id: `sha256:${"a".repeat(64)}`,
    choice_id: choice.choice_id, choice_index: 1, expected_cost: 25,
    expected_effect: { field: "attack", amount: 4 }, expected_purchase_count: 2,
  };
  const pending = {
    action_id: "AUTO-A50F000000000001", pre_fingerprint: lab.fingerprintObservation(before),
    pre_observation: before, expected_delta: { gold: -25, attack: 4 },
    operations: [{ type: "grid", x: 1, y: 0 }, operation],
    requires_non_position_change: true,
  };
  assert.equal(lab.classifyPendingRecovery(
    pending, before, lab.fingerprintObservation(before),
  ).phase, "not_executed");

  const opened = structuredClone(before);
  opened.active_menu = { shop_id: operation.shop_id, menu_id: operation.menu_id, ready: true,
    selection: 1, choices: [choice.choice_id] };
  const openResult = lab.classifyPendingRecovery(pending, opened, lab.fingerprintObservation(opened));
  assert.equal(openResult.phase, "not_executed");
  // The runtime fingerprint intentionally excludes transient menu chrome, so an opened menu
  // with unchanged authoritative state is the same safe not-executed classification.
  assert.equal(openResult.detail_code, null);

  const purchased = makeObservation({ hero: { gold: 29, attack: 27 }, shops: [{
    supported: true, shop_id: "moneyShop1", repeatable: true,
    choices: [null, { ...choice, purchase_count: 3 }],
  }] });
  assert.equal(lab.classifyPendingRecovery(
    pending, purchased, lab.fingerprintObservation(purchased),
  ).phase, "completed");

  for (const mutate of [
    (value) => { value.shops[0].shop_id = "foreign"; },
    (value) => { value.shops[0].choices[1].choice_id = "stale"; },
    (value) => { value.shops[0].choices[1].purchase_count = 2; },
    (value) => { value.shops[0].choices[1].purchase_count = 4; },
  ]) {
    const invalid = structuredClone(purchased);
    mutate(invalid);
    const result = lab.classifyPendingRecovery(pending, invalid, lab.fingerprintObservation(invalid));
    assert.equal(result.phase, "mismatch");
    assert.equal(result.detail_code, "SHOP_COUNTER_MISMATCH");
  }
});

test("旧 pending 边界仅发生位置变化不得恢复为 completed", () => {
  const boundary = {
    x: 9, y: 3, numeric_id: 31, id: "syntheticResource", cls: "items",
    trigger: "getItem", no_pass: false, damage: null, enemy: null,
  };
  const before = makeObservation({ blocks: [boundary] });
  const pending = {
    action_id: "AUTO-ABCDEF0123456789",
    pre_fingerprint: lab.fingerprintObservation(before),
    pre_observation: before,
    expected_delta: {},
    operations: [{ type: "grid", x: 9, y: 3 }],
  };
  const onlyMoved = makeObservation({ hero: { loc: { x: 9, y: 3 } }, blocks: [boundary] });
  const result = lab.classifyPendingRecovery(
    pending,
    onlyMoved,
    lab.fingerprintObservation(onlyMoved),
  );
  assert.equal(result.phase, "mismatch");
  assert.equal(result.detail_code, "RECOVERY_STATE_AMBIGUOUS");
});

test("fingerprint 对 block 内容变化敏感", () => {
  const first = makeObservation({
    blocks: [{
      x: 1, y: 1, numeric_id: 2, id: "door", cls: "terrains",
      trigger: "openDoor", no_pass: true, damage: null, enemy: null,
    }],
  });
  const second = makeObservation({ blocks: [] });
  assert.notEqual(lab.fingerprintObservation(first), lab.fingerprintObservation(second));
});
