MotaLab.parseRestrictedShop = function parseRestrictedShop(shopId, rawShop, flagValues = {}) {
  const reject = (reason, details = {}) => ({ supported: false, reason, details });
  if (typeof shopId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(shopId)
    || !rawShop || typeof rawShop !== "object" || Array.isArray(rawShop)) {
    return reject("SHOP_IDENTITY_INVALID");
  }
  if (!Array.isArray(rawShop.choices) || rawShop.choices.length < 1 || rawShop.choices.length > 32) {
    return reject("SHOP_CHOICES_INVALID");
  }
  const choices = [];
  for (let index = 0; index < rawShop.choices.length; index += 1) {
    const choice = rawShop.choices[index];
    if (!choice || typeof choice !== "object" || Array.isArray(choice)
      || typeof choice.text !== "string" || choice.text.length < 1 || choice.text.length > 256
      || typeof choice.need !== "string" || !Array.isArray(choice.action)) {
      return reject("SHOP_CHOICE_SHAPE_UNSUPPORTED", { index });
    }
    const need = choice.need.trim().match(/^status:money\s*>=\s*(\d{1,9})$/u);
    if (!need) return reject("SHOP_COST_EXPRESSION_UNSUPPORTED", { index });
    const cost = Number(need[1]);
    if (choice.action.length !== 3) {
      return reject("SHOP_EFFECT_UNSUPPORTED", { index });
    }
    const parsedActions = [];
    for (const action of choice.action) {
      if (!action || action.type !== "setValue" || typeof action.name !== "string"
        || typeof action.operator !== "string" || typeof action.value !== "string"
        || !/^\d{1,9}$/u.test(action.value)) {
        return reject("SHOP_EFFECT_UNSUPPORTED", { index });
      }
      parsedActions.push({ name: action.name, operator: action.operator, amount: Number(action.value) });
    }
    const [debitAction, effectAction, counterAction] = parsedActions;
    const effectFields = {
      "status:hp": "hp", "status:atk": "attack", "status:def": "defense",
    };
    if (debitAction.name !== "status:money" || debitAction.operator !== "-="
      || debitAction.amount !== cost
      || !Object.prototype.hasOwnProperty.call(effectFields, effectAction.name)
      || effectAction.operator !== "+="
      || !/^flag:[A-Za-z0-9_.:-]{1,128}$/u.test(counterAction.name)
      || counterAction.operator !== "+=" || counterAction.amount !== 1) {
      return reject("SHOP_EFFECT_UNSUPPORTED", { index });
    }
    const effect = { field: effectFields[effectAction.name], amount: effectAction.amount };
    const counter = counterAction.name.slice(5);
    if (cost < 1 || effect.amount < 1) {
      return reject("SHOP_EFFECT_INCOMPLETE", { index });
    }
    const count = Object.prototype.hasOwnProperty.call(flagValues, counter) ? flagValues[counter] : 0;
    if (!MotaLab.isFiniteInteger(count) || count < 0) {
      return reject("SHOP_COUNTER_INVALID", { index, counter });
    }
    choices.push({
      choice_id: `${shopId}:${index}:${effect.field}:${effect.amount}:${cost}`,
      index, text: choice.text, cost, effect, counter_flag: counter,
      purchase_count: count,
    });
  }
  return { supported: true, shop_id: shopId, repeatable: true, choices };
};

MotaLab.readRestrictedShopMenu = function readRestrictedShopMenu(runtime, expectedShop) {
  if (!expectedShop || expectedShop.supported !== true) return null;
  const event = runtime && runtime.status && runtime.status.event;
  const data = event && event.data;
  const current = data && data.current;
  if (event.id !== "action" || data.type !== "choices" || !current
    || current.type !== "choices" || !Array.isArray(current.choices)) return null;
  if (current.choices.length !== expectedShop.choices.length + 1) return null;
  const exit = current.choices[current.choices.length - 1];
  if (!exit || exit.text !== "离开" || !Array.isArray(exit.action)
    || exit.action.length !== 2 || exit.action[0].type !== "playSound"
    || exit.action[1].type !== "break") return null;
  const actual = current.choices.slice(0, -1).map((choice, index) => {
    if (!Array.isArray(choice.action) || choice.action[0] == null
      || choice.action[0].type !== "playSound" || choice.action[0].name !== "商店") return null;
    const expected = expectedShop.choices[index];
    const normalized = { text: choice.text, need: `status:money>=${expected.cost}`,
      action: choice.action.slice(1) };
    const parsed = MotaLab.parseRestrictedShop(expectedShop.shop_id, { choices: [normalized] }, {
      [expected.counter_flag]: expected.purchase_count,
    });
    return parsed.supported ? parsed.choices[0] : null;
  });
  if (actual.some((item, index) => !item
    || item.text !== expectedShop.choices[index].text
    || item.cost !== expectedShop.choices[index].cost
    || item.effect.field !== expectedShop.choices[index].effect.field
    || item.effect.amount !== expectedShop.choices[index].effect.amount
    || item.counter_flag !== expectedShop.choices[index].counter_flag)) return null;
  return {
    shop_id: expectedShop.shop_id,
    menu_id: `sha256:${MotaLab.sha256(MotaLab.canonicalize(actual.map((item) => ({
      text: item.text, cost: item.cost, effect: item.effect, counter_flag: item.counter_flag,
    }))))}`,
    ready: true,
    selection: MotaLab.isFiniteInteger(event.selection) ? event.selection : null,
    choices: expectedShop.choices.map((item) => item.choice_id),
  };
};
