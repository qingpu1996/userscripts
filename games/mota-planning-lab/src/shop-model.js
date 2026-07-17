MotaLab.parseRestrictedShop = function parseRestrictedShop(shopId, rawShop, flagValues = {}) {
  const reject = (reason, details = {}) => ({ supported: false, shop_id: shopId, reason, details });
  if (typeof shopId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(shopId)
    || !rawShop || typeof rawShop !== "object" || Array.isArray(rawShop)) {
    return reject("SHOP_IDENTITY_INVALID");
  }
  if (!Array.isArray(rawShop.choices) || rawShop.choices.length < 1 || rawShop.choices.length > 32) {
    return reject("SHOP_CHOICES_INVALID");
  }
  const choices = [];
  const parseCost = (expression) => {
    const source = expression.replace(/\s+/gu, "");
    if (/^\d{1,9}$/u.test(source)) {
      return { base_cost: Number(source), increment_per_purchase: 0, counter_flag: null };
    }
    const terms = source.split("+");
    if (terms.length !== 2) return null;
    const constant = terms.find((term) => /^\d{1,9}$/u.test(term));
    const product = terms.find((term) => term !== constant);
    if (!constant || !product) return null;
    const match = product.match(/^(?:flag:([A-Za-z0-9_.:-]{1,128})\*(\d{1,9})|(\d{1,9})\*flag:([A-Za-z0-9_.:-]{1,128}))$/u);
    if (!match) return null;
    return {
      base_cost: Number(constant),
      increment_per_purchase: Number(match[2] || match[3]),
      counter_flag: match[1] || match[4],
    };
  };
  for (let index = 0; index < rawShop.choices.length; index += 1) {
    const choice = rawShop.choices[index];
    if (!choice || typeof choice !== "object" || Array.isArray(choice)
      || typeof choice.text !== "string" || choice.text.length < 1 || choice.text.length > 256
      || typeof choice.need !== "string" || !Array.isArray(choice.action)) {
      return reject("SHOP_CHOICE_SHAPE_UNSUPPORTED", { index });
    }
    const need = choice.need.match(/^\s*status:money\s*>=\s*(.+?)\s*$/u);
    const price = need && parseCost(need[1]);
    if (!price || price.base_cost < 1 || price.increment_per_purchase < 0) {
      return reject("SHOP_COST_EXPRESSION_UNSUPPORTED", { index });
    }
    if (choice.action.length !== 3) {
      return reject("SHOP_EFFECT_UNSUPPORTED", { index });
    }
    const parsedActions = [];
    for (let actionIndex = 0; actionIndex < choice.action.length; actionIndex += 1) {
      const action = choice.action[actionIndex];
      if (!action || action.type !== "setValue" || typeof action.name !== "string"
        || typeof action.operator !== "string" || typeof action.value !== "string"
        || (actionIndex !== 0 && !/^\d{1,9}$/u.test(action.value))) {
        return reject("SHOP_EFFECT_UNSUPPORTED", { index });
      }
      parsedActions.push({ name: action.name, operator: action.operator,
        amount: actionIndex === 0 ? null : Number(action.value), value: action.value });
    }
    const [debitAction, effectAction, counterAction] = parsedActions;
    const effectFields = {
      "status:hp": "hp", "status:atk": "attack", "status:def": "defense",
    };
    const debitPrice = parseCost(debitAction.value);
    if (debitAction.name !== "status:money" || debitAction.operator !== "-="
      || !debitPrice || debitPrice.base_cost !== price.base_cost
      || debitPrice.increment_per_purchase !== price.increment_per_purchase
      || debitPrice.counter_flag !== price.counter_flag
      || !Object.prototype.hasOwnProperty.call(effectFields, effectAction.name)
      || effectAction.operator !== "+="
      || !/^flag:[A-Za-z0-9_.:-]{1,128}$/u.test(counterAction.name)
      || counterAction.operator !== "+=" || counterAction.amount !== 1) {
      return reject("SHOP_EFFECT_UNSUPPORTED", { index });
    }
    const effect = { field: effectFields[effectAction.name], amount: effectAction.amount };
    const counter = counterAction.name.slice(5);
    if ((price.counter_flag !== null && price.counter_flag !== counter) || effect.amount < 1) {
      return reject("SHOP_EFFECT_INCOMPLETE", { index });
    }
    const count = Object.prototype.hasOwnProperty.call(flagValues, counter) ? flagValues[counter] : 0;
    if (!MotaLab.isFiniteInteger(count) || count < 0) {
      return reject("SHOP_COUNTER_INVALID", { index, counter });
    }
    const cost = price.base_cost + count * price.increment_per_purchase;
    if (!Number.isSafeInteger(cost) || cost < 1) return reject("SHOP_COST_EXPRESSION_UNSUPPORTED", { index });
    choices.push({
      choice_id: price.increment_per_purchase === 0
        ? `${shopId}:${index}:${effect.field}:${effect.amount}:${price.base_cost}`
        : `${shopId}:${index}:${effect.field}:${effect.amount}:${price.base_cost}:${price.increment_per_purchase}`,
      index, text: choice.text, cost, base_cost: price.base_cost,
      increment_per_purchase: price.increment_per_purchase, effect, counter_flag: counter,
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
    const priceExpression = expected.increment_per_purchase === 0 ? String(expected.base_cost)
      : `${expected.base_cost}+flag:${expected.counter_flag}*${expected.increment_per_purchase}`;
    const normalized = { text: choice.text, need: `status:money>=${priceExpression}`,
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
