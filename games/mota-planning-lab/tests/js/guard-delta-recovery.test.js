const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadRuntime,
  makeObservation,
  makeGuard,
} = require("./helpers/runtime");

const lab = loadRuntime();

test("首次 4F 基线精确匹配且任何面板差异失败", () => {
  const baseline = makeObservation();
  assert.equal(lab.compareInitialBaseline(baseline).ok, true);
  for (const mutate of [
    (value) => { value.floor_number = 5; },
    (value) => { value.hero.loc.x = 7; },
    (value) => { value.hero.hp = 209; },
    (value) => { value.hero.attack = 24; },
    (value) => { value.hero.defense = 20; },
    (value) => { value.hero.gold = 15; },
    (value) => { value.hero.experience = 62; },
    (value) => { value.keys.yellow = 3; },
    (value) => { value.keys.blue = 0; },
    (value) => { value.keys.red = 1; },
  ]) {
    const value = makeObservation();
    mutate(value);
    assert.equal(lab.compareInitialBaseline(value).ok, false);
  }
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

test("同坐标 block 内容异常变化也算未声明差分", () => {
  const enemy = {
    x: 2, y: 3, numeric_id: 9, id: "syntheticEnemy", cls: "enemy48",
    trigger: "battle", no_pass: true, damage: 10,
    enemy: { hp: 20, attack: 5, defense: 2, gold: 1, experience: 1, special: [] },
  };
  const changedEnemy = JSON.parse(JSON.stringify(enemy));
  changedEnemy.damage = 11;
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

test("floor_id=null 只在楼梯上下文允许且必须实际换层", () => {
  assert.throws(() => lab.validateExpectedDelta({ floor_id: null }), /only allowed for stairs/);
  assert.doesNotThrow(() => lab.validateExpectedDelta(
    { floor_id: null },
    { allowUnknownFloor: true },
  ));
  const before = makeObservation();
  const changed = makeObservation({ floor_id: "synthetic-floor-new", floor_name: null, floor_number: null });
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
