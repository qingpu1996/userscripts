const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadRuntime,
  makeObservation,
  makePoisonCore,
  projectDir,
} = require("./helpers/runtime");

const lab = loadRuntime();

test("adapter 延迟解析页面运行时，未就绪时 stop 也不会掩盖暂停", () => {
  const scope = {};
  const adapter = lab.createEngineAdapter(scope);
  assert.doesNotThrow(() => adapter.stopAutomaticRoute());
  assert.throws(
    () => adapter.readRuntimeSnapshot(),
    (error) => error.pause_kind === "ENGINE_API_INCOMPATIBLE",
  );
  const fake = makePoisonCore();
  scope.core = fake.scope.core;
  assert.equal(lab.collectObservation(adapter).hero.hp, 208);
});

test("canonical hero.items.tools 将省略的零值钥匙归一为 0，显式非法值与冲突 fail closed", () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(projectDir, "tests/fixtures/runtime-hero-shapes-v2.json"),
    "utf8",
  ));
  const liveCase = fixture.cases.find((item) => item.name === "h5mota-24-live-tools-layout");
  const liveShape = makePoisonCore({
    hero: liveCase.hero,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      lab.collectObservation(lab.createEngineAdapter(liveShape.scope)).keys,
    )),
    liveCase.expected_keys,
  );

  const observeKeys = (tools, extraHero = {}) => {
    const fake = makePoisonCore({
      hero: Object.assign({
        hp: 10, atk: 1, def: 1, money: 0, exp: 0,
        loc: { x: 1, y: 1, direction: "up" },
        items: { tools },
      }, extraHero),
    });
    return JSON.parse(JSON.stringify(
      lab.collectObservation(lab.createEngineAdapter(fake.scope)).keys,
    ));
  };
  assert.deepEqual(observeKeys({ blueKey: 1, redKey: 1 }), {
    yellow: 0, blue: 1, red: 1,
  });
  assert.deepEqual(observeKeys({}), { yellow: 0, blue: 0, red: 0 });
  assert.deepEqual(observeKeys({ yellowKey: 2 }), { yellow: 2, blue: 0, red: 0 });
  assert.deepEqual(observeKeys({ yellowKey: 2, yellow: 2, red: 1 }), {
    yellow: 2, blue: 0, red: 1,
  });
  assert.deepEqual(observeKeys(
    { blueKey: 1, redKey: 1 },
    { items: {
      tools: { blueKey: 1, redKey: 1 },
      keys: { yellowKey: 0, blueKey: 1, redKey: 1 },
    } },
  ), { yellow: 0, blue: 1, red: 1 });

  const cases = [
    {
      code: "MISSING_KEY_LAYOUT",
      hero: { hp: 10, atk: 1, def: 1, money: 0, exp: 0,
        loc: { x: 1, y: 1, direction: "up" } },
    },
    {
      code: "INCOMPLETE_KEY_LAYOUT",
      hero: { hp: 10, atk: 1, def: 1, money: 0, exp: 0,
        loc: { x: 1, y: 1, direction: "up" },
        items: { keys: { yellowKey: 1 } } },
    },
    {
      code: "CONFLICTING_KEY_LAYOUT",
      hero: { hp: 10, atk: 1, def: 1, money: 0, exp: 0,
        loc: { x: 1, y: 1, direction: "up" },
        items: { tools: { yellowKey: 1, yellow: 2 } } },
    },
    {
      code: "CONFLICTING_KEY_LAYOUT",
      hero: { hp: 10, atk: 1, def: 1, money: 0, exp: 0,
        loc: { x: 1, y: 1, direction: "up" },
        items: {
          tools: { yellowKey: 1, blueKey: 1, redKey: 1 },
          keys: { yellowKey: 2, blueKey: 1, redKey: 1 },
        } },
    },
  ];
  for (const sample of cases) {
    const fake = makePoisonCore({ hero: sample.hero });
    assert.throws(
      () => lab.collectObservation(lab.createEngineAdapter(fake.scope)),
      (error) => error.pause_kind === "ENGINE_API_INCOMPATIBLE"
        && error.detail_code === sample.code,
    );
  }

  for (const value of [null, "0", false, {}, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    const fake = makePoisonCore({
      hero: {
        hp: 10, atk: 1, def: 1, money: 0, exp: 0,
        loc: { x: 1, y: 1, direction: "up" },
        items: { tools: { yellowKey: value } },
      },
    });
    assert.throws(
      () => lab.collectObservation(lab.createEngineAdapter(fake.scope)),
      (error) => error.pause_kind === "ENGINE_API_INCOMPATIBLE"
        && error.detail_code === "INVALID_RUNTIME_FIELD",
      `explicit invalid key value must fail closed: ${String(value)}`,
    );
  }

  for (const tools of [null, [], "invalid", new Date(0), new Map()]) {
    const fake = makePoisonCore({
      hero: {
        hp: 10, atk: 1, def: 1, money: 0, exp: 0,
        loc: { x: 1, y: 1, direction: "up" },
        items: { tools },
      },
    });
    assert.throws(
      () => lab.collectObservation(lab.createEngineAdapter(fake.scope)),
      (error) => error.pause_kind === "ENGINE_API_INCOMPATIBLE",
    );
  }

  for (const extraLayout of [
    { items: { tools: {}, keys: null } },
    { items: { tools: {} }, keys: {} },
  ]) {
    const fake = makePoisonCore({
      hero: Object.assign({
        hp: 10, atk: 1, def: 1, money: 0, exp: 0,
        loc: { x: 1, y: 1, direction: "up" },
      }, extraLayout),
    });
    assert.throws(
      () => lab.collectObservation(lab.createEngineAdapter(fake.scope)),
      (error) => error.pause_kind === "ENGINE_API_INCOMPATIBLE",
    );
  }
});

test("同步采集用运行态前后围栏重试瞬时变化并拒绝持续 torn snapshot", () => {
  const once = makePoisonCore({
    onBlocks(call, hero) { if (call === 1) hero.loc.x = 7; },
  });
  const recovered = lab.collectObservation(lab.createEngineAdapter(once.scope));
  assert.equal(recovered.hero.loc.x, 7);
  assert.equal(once.calls.blocks, 2);

  const unstable = makePoisonCore({
    onBlocks(_call, hero) { hero.loc.x = hero.loc.x === 8 ? 7 : 8; },
  });
  assert.throws(
    () => lab.collectObservation(lab.createEngineAdapter(unstable.scope)),
    (error) => error.pause_kind === "ENGINE_API_INCOMPATIBLE"
      && error.detail_code === "RUNTIME_SNAPSHOT_UNSTABLE"
      && error.details.attempts.length === 3,
  );
  assert.equal(unstable.calls.blocks, 3);
});

test("毒值运行时只读取当前层白名单并序列化 11x11 观察", () => {
  const enemy = {
    x: 9,
    y: 0,
    id: 123,
    event: { id: "greenSlime", cls: "enemy48", trigger: "battle", noPass: true },
  };
  const disabled = {
    x: 1,
    y: 1,
    id: 99,
    disable: true,
    event: { id: "gone", cls: "items", trigger: "getItem" },
  };
  const wall = {
    x: 2,
    y: 0,
    id: 1,
    event: { id: "yellowWall", cls: "terrains", noPass: true },
  };
  const fake = makePoisonCore({
    blocks: [wall, disabled, enemy],
    damage: { greenSlime: 24 },
  });
  const adapter = lab.createEngineAdapter(fake.scope);
  const observation = lab.collectObservation(adapter, () => 777);

  assert.equal(observation.floor_id, "synthetic-floor-4");
  assert.equal(observation.floor_name, "4F");
  assert.equal(observation.floor_number, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(observation.dimensions)), { width: 11, height: 11 });
  assert.deepEqual(JSON.parse(JSON.stringify(observation.hero)), {
    hp: 208,
    attack: 23,
    defense: 21,
    gold: 16,
    experience: 63,
    loc: { x: 8, y: 3, direction: "down" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(observation.keys)), { yellow: 4, blue: 1, red: 0 });
  assert.equal(observation.blocks.length, 2);
  assert.equal(observation.blocks[0].id, "yellowWall");
  const visibleEnemy = observation.blocks.find((block) => block.id === "greenSlime");
  assert.equal(visibleEnemy.x, 9);
  assert.equal(visibleEnemy.damage, 24);
  assert.equal(visibleEnemy.enemy.gold, 5);
  assert.deepEqual(fake.calls.mapKeys, ["synthetic-floor-4"]);
  assert.equal(fake.calls.enemyInfo.length, 1);
  assert.equal(fake.calls.enemyInfo[0].id, "greenSlime");
  assert.equal(fake.calls.damage.length, 1);
  assert.deepEqual(fake.calls.forbidden, []);
});

test("怪物未知、问号、负数和非有限战损均暂停", () => {
  for (const value of [null, "???", -1, Number.NaN]) {
    const fake = makePoisonCore({
      blocks: [{
        x: 0,
        y: 0,
        id: 2,
        event: { id: "monster", cls: "enemy48", trigger: "battle" },
      }],
      damage: { monster: value },
    });
    assert.throws(
      () => lab.collectObservation(lab.createEngineAdapter(fake.scope)),
      (error) => error.pause_kind === "UNKNOWN_DAMAGE",
    );
  }
});

test("采集期未知战损暂停保留本轮完整 observation 且零决策、零行动", async () => {
  const cases = [
    { damage: null, normalized: null, raw: null, code: "DAMAGE_NULL" },
    { damage: "???", normalized: "???", raw: "???", code: "DAMAGE_NULL" },
    {
      damage: Number.NaN,
      normalized: null,
      raw: { type: "number", value: "NaN" },
      code: "DAMAGE_UNEXPLAINED",
    },
  ];
  for (const sample of cases) {
    const fake = makePoisonCore({
      blocks: [
        {
          x: 0,
          y: 0,
          id: 1,
          event: { id: "syntheticWall", cls: "terrains", noPass: true },
        },
        {
          x: 1,
          y: 0,
          id: 2,
          event: { id: "syntheticEnemy", cls: "enemy48", trigger: "battle", noPass: true },
        },
      ],
      damage: { syntheticEnemy: sample.damage },
    });
    const adapter = lab.createEngineAdapter(fake.scope);
    const journal = lab.createJournal(lab.createMemoryStorage());
    let decisionCalls = 0;
    const controller = lab.createController({
      adapter,
      journal,
      registry: lab.createBlockRegistry(),
      client: {
        isConnected: () => false,
        postCycle: async () => { decisionCalls += 1; return { status: "idle", reason: "unexpected" }; },
      },
      panel: { update() {} },
      logger: { error() {} },
    });

    const result = await controller.initialize();
    const pause = journal.snapshot().last_pause;
    assert.equal(result.pause_kind, "UNKNOWN_DAMAGE");
    assert.equal(pause.detail_code, sample.code);
    assert.notEqual(pause.observation, null);
    assert.equal(pause.observation.floor_id, "synthetic-floor-4");
    assert.equal(pause.observation.blocks.length, 2);
    const abnormal = pause.observation.blocks.find((block) => block.id === "syntheticEnemy");
    assert.notEqual(abnormal, undefined);
    assert.deepEqual(abnormal.damage, sample.normalized);
    assert.deepEqual(
      JSON.parse(JSON.stringify(pause.block_evidence[0].raw_damage)),
      sample.raw,
    );
    assert.equal(pause.block_evidence[0].normalized_damage, sample.normalized);
    assert.equal(decisionCalls, 0);
    assert.equal(fake.calls.direct.length + fake.calls.route.length, 0);
    assert.deepEqual(fake.calls.mapKeys, ["synthetic-floor-4"]);
    assert.deepEqual(fake.calls.forbidden, []);
  }
});

test("仅当前可见且未 disable 的怪物调用敌人接口", () => {
  const fake = makePoisonCore({
    blocks: [
      { x: 0, y: 0, id: 1, disable: true, event: { id: "hidden", cls: "enemy48", trigger: "battle" } },
      { x: 1, y: 0, id: 2, event: { id: "visible", cls: "enemy48", trigger: "battle" } },
      { x: 2, y: 0, id: 3, event: { id: "potion", cls: "items", trigger: "getItem" } },
    ],
  });
  lab.collectObservation(lab.createEngineAdapter(fake.scope));
  assert.deepEqual(fake.calls.enemyInfo.map((call) => call.id), ["visible"]);
  assert.deepEqual(fake.calls.damage.map((call) => call.id), ["visible"]);
});

test("adapter 兼容显式 numeric_id/no_pass 的当前 block 形状", () => {
  const fake = makePoisonCore({
    blocks: [{
      x: 1,
      y: 2,
      numeric_id: 9001,
      id: "syntheticWall",
      cls: "terrains",
      trigger: null,
      no_pass: true,
    }],
  });
  const observation = lab.collectObservation(lab.createEngineAdapter(fake.scope));
  assert.equal(observation.blocks[0].numeric_id, 9001);
  assert.equal(observation.blocks[0].no_pass, true);
});

test("共享 synthetic current-floor fixture 完整采集且不把 disabled block 发出", () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(projectDir, "tests/fixtures/current-4f-synthetic-blocks.json"),
    "utf8",
  ));
  const runtime = fixture.fake_runtime;
  const enemyBlock = runtime.blocks.find((block) => block.id === "syntheticEnemy");
  const fake = makePoisonCore({
    floorId: runtime.floor_id,
    currentMap: { title: runtime.floor_name, width: runtime.width, height: runtime.height },
    hero: runtime.hero,
    blocks: runtime.blocks,
    damage: { syntheticEnemy: enemyBlock.damage },
    enemyInfo: { syntheticEnemy: enemyBlock.enemy },
  });
  const observation = lab.collectObservation(lab.createEngineAdapter(fake.scope));
  assert.equal(observation.floor_id, "synthetic-floor-4");
  assert.equal(observation.blocks.length, fixture.expected_visible_block_count);
  assert.equal(observation.blocks.some((block) => block.id === "syntheticDisabledObject"), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      observation.blocks.filter((block) => block.enemy).map(({ x, y }) => ({ x, y })),
    )),
    fixture.expected_enemy_coordinates,
  );
});

test("block 必填身份缺失时暂停并保留坐标证据", () => {
  for (const block of [
    { x: 3, y: 4, event: { id: "tile", cls: "terrains" } },
    { x: 3, y: 4, id: 1, event: { id: "", cls: "terrains" } },
    { x: 3, y: 4, id: 1, event: { id: "tile", cls: "" } },
  ]) {
    const fake = makePoisonCore({ blocks: [block] });
    assert.throws(
      () => lab.collectObservation(lab.createEngineAdapter(fake.scope)),
      (error) => error.pause_kind === "NEW_OBJECT_OR_MECHANISM"
        && error.detail_code === "INCOMPLETE_BLOCK_IDENTITY"
        && error.details.block.x === 3 && error.details.block.y === 4,
    );
  }
});

test("怪物 hp/gold/experience 必须是合法整数，攻防可为 null", () => {
  const block = {
    x: 0, y: 0, id: 2,
    event: { id: "syntheticEnemy", cls: "enemy48", trigger: "battle" },
  };
  const nullable = makePoisonCore({
    blocks: [block],
    enemyInfo: {
      syntheticEnemy: { hp: 10, atk: null, def: null, money: 0, experience: 0, special: [] },
    },
  });
  const observation = lab.collectObservation(lab.createEngineAdapter(nullable.scope));
  assert.equal(observation.blocks[0].enemy.attack, null);
  assert.equal(observation.blocks[0].enemy.defense, null);

  for (const info of [
    { hp: null, atk: 1, def: 1, money: 0, experience: 0 },
    { hp: 10, atk: 1, def: 1, money: -1, experience: 0 },
    { hp: 10, atk: 1, def: 1, money: 0, experience: null },
  ]) {
    const fake = makePoisonCore({ blocks: [block], enemyInfo: { syntheticEnemy: info } });
    assert.throws(
      () => lab.collectObservation(lab.createEngineAdapter(fake.scope)),
      (error) => error.pause_kind === "UNKNOWN_DAMAGE"
        && error.detail_code === "DAMAGE_UNEXPLAINED",
    );
  }
});

test("非法角色字段和重复 block 坐标不会发送给服务", () => {
  const invalidHero = makePoisonCore({
    hero: {
      hp: -1,
      atk: 23,
      def: 21,
      money: 16,
      experience: 63,
      loc: { x: 8, y: 3, direction: "down" },
      items: { keys: { yellowKey: 4, blueKey: 1, redKey: 0 } },
    },
  });
  assert.throws(
    () => lab.collectObservation(lab.createEngineAdapter(invalidHero.scope)),
    (error) => error.detail_code === "INVALID_HERO_FIELD",
  );

  const duplicate = makePoisonCore({
    blocks: [
      { x: 1, y: 2, id: 1, event: { id: "one", cls: "terrains" } },
      { x: 1, y: 2, id: 2, event: { id: "two", cls: "items", trigger: "getItem" } },
    ],
  });
  assert.throws(
    () => lab.collectObservation(lab.createEngineAdapter(duplicate.scope)),
    (error) => error.detail_code === "DUPLICATE_BLOCK_COORDINATE",
  );
});

test("fingerprint 是稳定 SHA-256 且忽略采集时间与 busy", () => {
  assert.equal(
    lab.sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const first = makeObservation({ captured_at: 1, busy: false });
  const second = makeObservation({ captured_at: 999, busy: true });
  assert.equal(lab.fingerprintObservation(first), lab.fingerprintObservation(second));
  second.hero.hp -= 1;
  assert.notEqual(lab.fingerprintObservation(first), lab.fingerprintObservation(second));
});

test("fingerprint 独立规范化等价 block 顺序", () => {
  const firstBlock = {
    x: 1, y: 2, numeric_id: 1, id: "first", cls: "terrains",
    trigger: null, no_pass: true, damage: null, enemy: null,
  };
  const secondBlock = {
    x: 2, y: 1, numeric_id: 2, id: "second", cls: "items",
    trigger: "getItem", no_pass: false, damage: null, enemy: null,
  };
  const ordered = makeObservation({ blocks: [secondBlock, firstBlock] });
  const reversed = makeObservation({ blocks: [firstBlock, secondBlock] });
  assert.equal(lab.fingerprintObservation(ordered), lab.fingerprintObservation(reversed));
});

test("fingerprint 与 localhost service 共享固定向量", () => {
  const observation = makeObservation({
    floor_id: "F1",
    floor_name: null,
    floor_number: null,
    hero: { loc: { x: 0, y: 0 } },
  });
  assert.equal(
    lab.canonicalize(lab.fingerprintProjection(observation)),
    "{\"blocks\":[],\"dimensions\":{\"height\":11,\"width\":11},\"floor_id\":\"F1\",\"hero\":{\"attack\":23,\"defense\":21,\"experience\":63,\"gold\":16,\"hp\":208,\"loc\":{\"direction\":\"down\",\"x\":0,\"y\":0}},\"keys\":{\"blue\":1,\"red\":0,\"yellow\":4},\"map_instance_id\":\"map:synthetic-floor-4:topology-a\",\"session_id\":\"SESSION-SYNTHETIC-0001\",\"topology\":{\"confidence\":\"confirmed\",\"kind\":\"rectangle\",\"source\":\"engine_current_map\"},\"topology_fingerprint\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}",
  );
  assert.equal(
    lab.fingerprintObservation(observation),
    "sha256:f7384ebc53ac8742a87f918317e868c53060601f4424867b551799002117ca54",
  );
});

test("观察 wire clone 只保留协议白名单", () => {
  const observation = makeObservation();
  observation.extra = { secret: true };
  observation.hero.extra = "no";
  const wire = lab.cloneObservationForWire(observation);
  assert.equal(wire.extra, undefined);
  assert.equal(wire.hero.extra, undefined);
  assert.deepEqual(Object.keys(wire).sort(), [
    "blocks", "busy", "captured_at", "dimensions", "floor_id", "floor_name",
    "floor_number", "hero", "keys", "map_instance_id", "page", "protocol", "session_id",
    "topology", "topology_fingerprint",
  ]);
});

test("静态禁区、唯一页面运行时入口与 metadata 均满足约束", () => {
  const srcDir = path.join(projectDir, "src");
  const files = fs.readdirSync(srcDir).filter((name) => name.endsWith(".js"));
  const forbidden = [
    /core\s*\.\s*floors/i,
    /floors\.min\.js/i,
    /\bmaterial\b/i,
    /\bscreenshot\b/i,
    /\bocr\b/i,
    /toDataURL/i,
    /getImageData/i,
  ];
  for (const name of files) {
    const source = fs.readFileSync(path.join(srcDir, name), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${name}: ${pattern}`);
    if (name !== "engine-adapter.js") {
      assert.doesNotMatch(source, /\bunsafeWindow\b/, `${name} accesses page scope`);
      assert.doesNotMatch(source, /\bcore\b/, `${name} accesses runtime directly`);
    }
  }
  const adapterSource = fs.readFileSync(path.join(srcDir, "engine-adapter.js"), "utf8");
  assert.match(adapterSource, /maps\[currentFloorId\]/);
  assert.doesNotMatch(adapterSource, /status\.maps\s*\[[^\]]+(?!currentFloorId)[^\]]*\]/);
  assert.doesNotMatch(adapterSource, /runtime\.status(?:\.[A-Za-z_$][\w$]*)*\s*=(?!=)/);

  const config = JSON.parse(fs.readFileSync(path.join(projectDir, "userscript.config.json"), "utf8"));
  assert.equal(config.rawBaseUrl, undefined);
  assert.equal(config.metadata.updateURL, undefined);
  assert.equal(config.metadata.downloadURL, undefined);
  assert.deepEqual(config.metadata.match, ["https://h5mota.com/games/24/*"]);
  assert.deepEqual(config.metadata.grant, [
    "unsafeWindow", "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues",
    "GM_registerMenuCommand", "GM_xmlhttpRequest",
  ]);
  assert.equal(config.metadata["run-at"], "document-idle");
  assert.equal(config.metadata.connect, "127.0.0.1");
});

test("双构建物均包含 A/B generation、canonical 写后验证与底层删除门禁", () => {
  const repoDir = path.resolve(projectDir, "../..");
  for (const name of [
    "mota-planning-lab.user.js",
    "mota-planning-lab.direct-mount.js",
  ]) {
    const artifact = fs.readFileSync(path.join(repoDir, "dist", name), "utf8");
    for (const marker of [
      "JOURNAL_STORAGE_UNSTABLE",
      "GM_setValue-readback-1",
      "GM_setValue-readback-2",
      "GM_deleteValue-readback",
      "localStorage.setItem-readback",
      "localStorage.removeItem-readback",
      "JOURNAL_SLOT_KEYS",
      "previous_commit_hash",
      "journal-generation-write",
      "candidate-readback-invalid",
      "complete_candidate_observed",
    ]) assert.match(artifact, new RegExp(marker.replaceAll(".", "\\."), "u"), `${name}: ${marker}`);
  }
});
