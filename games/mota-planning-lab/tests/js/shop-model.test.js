const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRuntime } = require("./helpers/runtime");

const lab = loadRuntime();
const choice = (field, amount, flag, cost = 25) => ({
  text: `${field}+${amount}`, need: `status:money>=${cost}`,
  action: [
    { type: "setValue", name: "status:money", operator: "-=", value: String(cost) },
    { type: "setValue", name: `status:${field}`, operator: "+=", value: String(amount) },
    { type: "setValue", name: `flag:${flag}`, operator: "+=", value: "1" },
  ],
});

test("restricted shop parses the observed money shop without evaluation", () => {
  const shop = lab.parseRestrictedShop("moneyShop1", {
    choices: [choice("hp", 800, "shop_hp"), choice("atk", 4, "shop_atk"), choice("def", 4, "shop_def")],
  }, { shop_atk: 2 });
  assert.equal(shop.supported, true);
  assert.deepEqual(JSON.parse(JSON.stringify(shop.choices.map((item) => [item.effect, item.purchase_count]))), [
    [{ field: "hp", amount: 800 }, 0],
    [{ field: "attack", amount: 4 }, 2],
    [{ field: "defense", amount: 4 }, 0],
  ]);
  assert.equal(shop.choices[1].choice_id, "moneyShop1:1:attack:4:25");
  assert.deepEqual([shop.choices[1].base_cost, shop.choices[1].increment_per_purchase,
    shop.choices[1].cost], [25, 0, 25]);
});

test("restricted shop parses only the bounded linear counter price", () => {
  const dynamic = choice("atk", 4, "shop_atk", 10);
  dynamic.need = " status:money >= flag:shop_atk * 5 + 10 ";
  dynamic.action[0].value = "10 + 5 * flag:shop_atk";
  const shop = lab.parseRestrictedShop("moneyShop1", { choices: [dynamic] }, { shop_atk: 2 });
  assert.equal(shop.supported, true);
  assert.deepEqual([shop.choices[0].base_cost, shop.choices[0].increment_per_purchase,
    shop.choices[0].counter_flag, shop.choices[0].purchase_count, shop.choices[0].cost],
  [10, 5, "shop_atk", 2, 20]);
});

test("restricted shop fails closed for dynamic cost, unknown effects and missing counter", () => {
  const cases = [
    { choices: [{ ...choice("atk", 4, "n"), need: "status:money>=25+flag:x" }] },
    { choices: [{ ...choice("atk", 4, "n"), action: [{ type: "function", function: "evil()" }] }] },
    { choices: [{ ...choice("atk", 4, "n"), action: choice("atk", 4, "n").action.slice(0, 2) }] },
    { choices: [{ ...choice("atk", 4, "n"), action: [...choice("atk", 4, "n").action,
      { type: "setValue", name: "status:experience", operator: "+=", value: "1" }] }] },
  ];
  for (const item of cases) assert.equal(lab.parseRestrictedShop("s", item).supported, false);
  const rejected = lab.parseRestrictedShop("s", cases[0]);
  const solver = lab.buildSolverModel({
    floors: [{ floor_id: "F", width: 1, height: 1, topology: { kind: "rectangle" },
      terminal_goals: [{ kind: "location", floor_id: "F", x: 0, y: 0 }], blocks: [],
      opaque_events: [], change_floor: [] }],
    blocks: [], items: [], enemies: [], values: {}, inventory: { key_slots: {} },
  }, [rejected]);
  assert.deepEqual(JSON.parse(JSON.stringify(solver.blockers)), [{
    code: "SHOP_COST_EXPRESSION_UNSUPPORTED", detail: "s:0",
  }]);
});

test("restricted shop verifies exact debit and authoritative nonnegative count", () => {
  const wrongDebit = choice("atk", 4, "n");
  wrongDebit.action[0].value = "24";
  assert.equal(lab.parseRestrictedShop("s", { choices: [wrongDebit] }).reason, "SHOP_EFFECT_UNSUPPORTED");
  assert.equal(lab.parseRestrictedShop("s", { choices: [choice("atk", 4, "n")] }, { n: -1 }).reason,
    "SHOP_COUNTER_INVALID");
});

test("restricted shop requires one ordered debit, stat effect and bound counter", () => {
  const valid = choice("atk", 4, "n");
  const debit = structuredClone(valid.action[0]);
  const stat = structuredClone(valid.action[1]);
  const counter = structuredClone(valid.action[2]);
  const crafted = [
    [debit, { ...debit, value: "15" }, stat, counter],
    [{ ...debit, value: "10" }, { ...debit, value: "15" }, stat, counter],
    [debit, stat, { ...stat }, counter],
    [debit, stat, { ...stat, name: "status:def" }, counter],
    [debit, stat, counter, { ...counter }],
    [stat, debit, counter],
    [debit, counter, stat],
    [debit, stat, { type: "if", condition: "true", true: [counter] }],
    [debit, stat, { ...counter, value: "1+0" }],
    [debit, stat, { ...counter, name: "flag:n", operator: "=" }],
  ];
  for (const action of crafted) {
    const parsed = lab.parseRestrictedShop("s", { choices: [{ ...valid, action }] });
    assert.equal(parsed.supported, false, JSON.stringify(action));
  }
  assert.equal(lab.parseRestrictedShop("s", { choices: [valid] }).supported, true);
});

test("active menu is accepted only when authoritative current choices match the bound shop", () => {
  const raw = { choices: [choice("hp", 800, "shop_hp"), choice("atk", 4, "shop_atk")] };
  const shop = lab.parseRestrictedShop("moneyShop1", raw);
  const transformed = raw.choices.map((item) => ({ text: item.text,
    action: [{ type: "playSound", name: "商店" }, ...structuredClone(item.action)] }));
  transformed.push({ text: "离开", action: [{ type: "playSound", name: "取消" }, { type: "break" }] });
  const runtime = { status: { event: { id: "action", selection: 1,
    data: { type: "choices", current: { type: "choices", choices: transformed } } } } };
  const menu = lab.readRestrictedShopMenu(runtime, shop);
  assert.equal(menu.shop_id, "moneyShop1");
  assert.equal(menu.ready, true);
  assert.equal(menu.selection, 1);
  assert.match(menu.menu_id, /^sha256:[a-f0-9]{64}$/u);
  runtime.status.event.data.current.choices[1].action[1].value = "5";
  assert.equal(lab.readRestrictedShopMenu(runtime, shop), null);
  runtime.status.event.id = "book";
  assert.equal(lab.readRestrictedShopMenu(runtime, shop), null);
});

test("shop input uses the engine actions keyUp path and fails closed on a foreign menu", () => {
  const raw = { choices: [choice("hp", 800, "shop_hp"), choice("atk", 4, "shop_atk")] };
  const shop = lab.parseRestrictedShop("moneyShop1", raw);
  const transformed = raw.choices.map((item) => ({ text: item.text,
    action: [{ type: "playSound", name: "商店" }, ...structuredClone(item.action)] }));
  transformed.push({ text: "离开", action: [{ type: "playSound", name: "取消" }, { type: "break" }] });
  const keys = [];
  const core = { status: { event: { id: "action", selection: 0,
    data: { type: "choices", current: { type: "choices", choices: transformed } } } },
  actions: { keyUp(event) { keys.push(event.keyCode); } } };
  const adapter = lab.createEngineAdapter({ core });
  adapter.chooseShopChoice(shop, 1);
  adapter.closeShopMenu(shop);
  assert.deepEqual(keys, [50, 27]);
  core.status.event.id = "book";
  assert.throws(() => adapter.chooseShopChoice(shop, 1), (error) =>
    error.detail_code === "SHOP_MENU_IDENTITY_MISMATCH");
  assert.deepEqual(keys, [50, 27]);
});

test("audited experience and key shops expose currency plus deterministic effects", () => {
  const set = (name, operator, value) => ({ type: "setValue", name, operator, value: String(value) });
  const exp = lab.parseRestrictedShop("expShop1", { choices: [
    { text: "level", need: "status:exp>=100", action: [set("status:exp", "-=", 100),
      set("status:lv", "+=", 1), set("status:hp", "+=", 1000), set("status:atk", "+=", 7),
      set("status:def", "+=", 7), set("flag:n", "+=", 1)] },
    { text: "atk", need: "status:exp>=30", action: [set("status:exp", "-=", 30),
      set("status:atk", "+=", 5), set("flag:n", "+=", 1)] },
    { text: "def", need: "status:exp>=30", action: [set("status:exp", "-=", 30),
      set("status:def", "+=", 5), set("flag:n", "+=", 1)] },
  ] });
  assert.equal(exp.supported, true);
  assert.equal(exp.choices[0].currency, "experience");
  assert.deepEqual(JSON.parse(JSON.stringify(exp.choices[0].effects)), [
    { field: "level", amount: 1 }, { field: "hp", amount: 1000 },
    { field: "attack", amount: 7 }, { field: "defense", amount: 7 },
  ]);
  const buy = lab.parseRestrictedShop("keyShop1", { choices: [10, 50, 100].map((cost, index) => {
    const key = ["yellowKey", "blueKey", "redKey"][index];
    return { text: key, need: `status:money>=${cost}`, action: [set("status:money", "-=", cost),
      set(`item:${key}`, "+=", 1), set("flag:n", "+=", 1)] };
  }) });
  assert.deepEqual(JSON.parse(JSON.stringify([buy.choices[1].currency, buy.choices[1].cost, buy.choices[1].effects])),
    ["gold", 50, [{ field: "blue", amount: 1 }]]);
  const sell = lab.parseRestrictedShop("keyShop2", { choices: [
    ["yellowKey", 7], ["blueKey", 35], ["redKey", 70],
  ].map(([key, gold]) => ({ text: key, need: "true", action: [{ type: "if",
    condition: `(item:${key}>=1)`, true: [set(`item:${key}`, "-=", 1),
      set("status:money", "+=", gold), set("flag:n", "+=", 1)], false: ["none"] }] })) });
  assert.deepEqual(JSON.parse(JSON.stringify([sell.choices[2].currency, sell.choices[2].cost, sell.choices[2].effects])),
    ["red", 1, [{ field: "gold", amount: 70 }]]);
});
