MotaLab.parseFloorNumber = function parseFloorNumber(floorName, floorId) {
  for (const candidate of [floorName, floorId]) {
    if (typeof candidate !== "string") continue;
    const match = candidate.trim().match(/(?:^|[^0-9])(\d{1,3})\s*F(?:$|[^A-Za-z])/i)
      || candidate.trim().match(/^MT(\d{1,3})$/i);
    if (match) return Number(match[1]);
  }
  return null;
};

MotaLab.normalizeEnemy = function normalizeEnemy(enemy, block) {
  if (!enemy || typeof enemy !== "object") {
    throw MotaLab.createPauseError(
      "UNKNOWN_DAMAGE",
      "DAMAGE_UNEXPLAINED",
      { block: MotaLab.blockEvidence(block) },
    );
  }
  function requiredInteger(value, field, minimum) {
    if (!MotaLab.isFiniteInteger(value) || value < minimum) {
      throw MotaLab.createPauseError(
        "UNKNOWN_DAMAGE",
        "DAMAGE_UNEXPLAINED",
        { field, block: MotaLab.blockEvidence(block) },
      );
    }
    return value;
  }
  function optionalInteger(value, field) {
    if (value === null || value === undefined) return null;
    return requiredInteger(value, field, 0);
  }
  return {
    hp: requiredInteger(enemy.hp, "enemy.hp", 1),
    attack: optionalInteger(enemy.attack, "enemy.attack"),
    defense: optionalInteger(enemy.defense, "enemy.defense"),
    gold: requiredInteger(enemy.gold, "enemy.gold", 0),
    experience: requiredInteger(enemy.experience, "enemy.experience", 0),
    special: Array.isArray(enemy.special)
      ? enemy.special.filter((value) => typeof value === "string" || MotaLab.isFiniteInteger(value)).slice(0, 64)
      : [],
  };
};

MotaLab.runtimeScalarEvidence = function runtimeScalarEvidence(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 256);
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : { type: "number", value: String(value) };
  }
  if (value === undefined) return { type: "undefined", value: null };
  return { type: typeof value, value: Object.prototype.toString.call(value).slice(0, 128) };
};

MotaLab.normalizeObservedDamage = function normalizeObservedDamage(value) {
  if (value === "???") return value;
  return MotaLab.isFiniteInteger(value) && value >= 0 ? value : null;
};

MotaLab.enemyEvidence = function enemyEvidence(enemy) {
  if (!enemy || typeof enemy !== "object") return MotaLab.runtimeScalarEvidence(enemy);
  return {
    hp: MotaLab.runtimeScalarEvidence(enemy.hp),
    attack: MotaLab.runtimeScalarEvidence(enemy.attack),
    defense: MotaLab.runtimeScalarEvidence(enemy.defense),
    gold: MotaLab.runtimeScalarEvidence(enemy.gold),
    experience: MotaLab.runtimeScalarEvidence(enemy.experience),
    special: Array.isArray(enemy.special)
      ? enemy.special.slice(0, 64).map(MotaLab.runtimeScalarEvidence)
      : MotaLab.runtimeScalarEvidence(enemy.special),
  };
};

MotaLab.blockEvidence = function blockEvidence(block, normalizedDamage = undefined) {
  const normalized = normalizedDamage === undefined
    ? MotaLab.normalizeObservedDamage(block.damage)
    : normalizedDamage;
  return {
    x: block.x,
    y: block.y,
    numeric_id: block.numeric_id,
    id: block.id,
    cls: block.cls,
    trigger: block.trigger,
    damage: normalized,
    raw_damage: MotaLab.runtimeScalarEvidence(block.damage),
    normalized_damage: normalized,
  };
};

MotaLab.engineJsonLiteral = function engineJsonLiteral(value, state = null, depth = 0) {
  const context = state || { seen: new WeakSet(), complex: false, nodes: 0 };
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return { value, complex: context.complex };
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return { value, complex: context.complex };
    context.complex = true;
    return { value: null, complex: true };
  }
  if (!value || typeof value !== "object" || depth >= MotaLab.MAX_ENGINE_LITERAL_DEPTH
    || context.seen.has(value)) {
    context.complex = true;
    return { value: null, complex: true };
  }
  context.nodes += 1;
  if (context.nodes > MotaLab.MAX_ENGINE_LITERAL_ARRAY * 4) {
    throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "ENGINE_MODEL_LITERAL_LIMIT_EXCEEDED");
  }
  context.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MotaLab.MAX_ENGINE_LITERAL_ARRAY) {
      throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "ENGINE_MODEL_LITERAL_LIMIT_EXCEEDED");
    }
    return {
      value: value.map((item) => MotaLab.engineJsonLiteral(item, context, depth + 1).value),
      complex: context.complex,
    };
  }
  const entries = [];
  for (const key of Object.keys(value).sort()) {
    const item = MotaLab.engineJsonLiteral(value[key], context, depth + 1);
    if (item.value !== null || value[key] === null) entries.push([key, item.value]);
  }
  return { value: Object.fromEntries(entries), complex: context.complex };
};

MotaLab.detachEngineData = function detachEngineData(value) {
  return JSON.parse(JSON.stringify(MotaLab.engineJsonLiteral(value).value));
};

MotaLab.decodeDetachedDynamicMap = function decodeDetachedDynamicMap(
  floorId, dynamicMap, definitionMap, width, height, fail,
) {
  if (!Array.isArray(dynamicMap)) {
    return Array.isArray(definitionMap)
      ? definitionMap.map((row) => Array.isArray(row) ? row.slice() : row)
      : definitionMap;
  }
  const compressed = dynamicMap.some((row) => !Array.isArray(row))
    || dynamicMap.some((row) => row.some((cell) => cell < 0));
  if (!compressed) return dynamicMap.map((row) => Array.isArray(row) ? row.slice() : row);

  const reject = (reason, details = {}) => fail("ENGINE_MODEL_MAP_COMPRESSION_INVALID", {
    floor_id: floorId, reason, ...details,
  });
  if (dynamicMap.length !== height) {
    reject("dynamic_height_mismatch", { expected: height, actual: dynamicMap.length });
  }
  let needsDefinition = false;
  for (let y = 0; y < height; y += 1) {
    const row = dynamicMap[y];
    if (row === 0) {
      needsDefinition = true;
      continue;
    }
    if (!Array.isArray(row)) {
      reject("dynamic_row_token_invalid", {
        y, token: MotaLab.runtimeScalarEvidence(row),
      });
    }
    if (row.length !== width) {
      reject("dynamic_width_mismatch", { y, expected: width, actual: row.length });
    }
    for (let x = 0; x < width; x += 1) {
      const cell = row[x];
      if (cell === -1) needsDefinition = true;
      else if (!MotaLab.isFiniteInteger(cell) || cell < 0) {
        reject("dynamic_cell_token_invalid", {
          x, y, token: MotaLab.runtimeScalarEvidence(cell),
        });
      }
    }
  }
  if (needsDefinition) {
    if (!Array.isArray(definitionMap) || definitionMap.length !== height) {
      reject("definition_height_mismatch", {
        expected: height, actual: Array.isArray(definitionMap) ? definitionMap.length : null,
      });
    }
    for (let y = 0; y < height; y += 1) {
      const definitionRow = definitionMap[y];
      if (!Array.isArray(definitionRow) || definitionRow.length !== width) {
        reject("definition_width_mismatch", {
          y, expected: width, actual: Array.isArray(definitionRow) ? definitionRow.length : null,
        });
      }
      for (let x = 0; x < width; x += 1) {
        const inherited = dynamicMap[y] === 0 || dynamicMap[y][x] === -1;
        const value = definitionRow[x];
        if (inherited && (!MotaLab.isFiniteInteger(value) || value < 0)) {
          reject("definition_cell_invalid", {
            x, y, token: MotaLab.runtimeScalarEvidence(value),
          });
        }
      }
    }
  }
  const decoded = Array.from({ length: height }, () => Array(width));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      decoded[y][x] = dynamicMap[y] === 0 || dynamicMap[y][x] === -1
        ? definitionMap[y][x] : dynamicMap[y][x];
    }
  }
  return decoded;
};

MotaLab.collectEngineFloor = function collectEngineFloor(
  engine, floorId, definition, dynamic, fail,
) {
  const selected = Array.isArray(dynamic.map) ? dynamic.map : definition.map;
  if (!Array.isArray(selected)) fail("ENGINE_MODEL_MAP_MISSING", { floor_id: floorId });
  const inferredWidth = selected.reduce(
    (maximum, row) => Math.max(maximum, Array.isArray(row) ? row.length : 0), 0,
  );
  const width = MotaLab.isFiniteInteger(dynamic.width) ? dynamic.width
    : MotaLab.isFiniteInteger(definition.width) ? definition.width : inferredWidth;
  const height = MotaLab.isFiniteInteger(dynamic.height) ? dynamic.height
    : MotaLab.isFiniteInteger(definition.height) ? definition.height : selected.length;
  if (width < 1 || height < 1 || width > MotaLab.MAX_MAP_AXIS
    || height > MotaLab.MAX_MAP_AXIS || width * height > MotaLab.MAX_MAP_CELLS) {
    fail("ENGINE_MODEL_DIMENSIONS_EXCEEDED", { floor_id: floorId, width, height });
  }
  const source = MotaLab.decodeDetachedDynamicMap(
    floorId, dynamic.map, definition.map, width, height, fail,
  );
  if (!Array.isArray(source) || source.some((row) => !Array.isArray(row))) {
    fail("ENGINE_MODEL_MAP_MISSING", { floor_id: floorId });
  }
  if (source.length > height || source.some((row) => row.length > width)) {
    fail("ENGINE_MODEL_DIMENSIONS_EXCEEDED", { floor_id: floorId, width, height });
  }
  const validCells = [];
  const map = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
    if (!source[y] || !Object.prototype.hasOwnProperty.call(source[y], x)) return null;
    validCells.push({ x, y });
    const value = source[y][x];
    if (value !== null && (!MotaLab.isFiniteInteger(value) || value < 0)) {
      fail("ENGINE_MODEL_MAP_CELL_INVALID", { floor_id: floorId, x, y });
    }
    return value;
  }));
  const rawBlocks = engine.getMapBlocksObj(floorId, true);
  const blockValues = Array.isArray(rawBlocks) ? rawBlocks
    : rawBlocks && typeof rawBlocks === "object" ? Object.values(rawBlocks) : [];
  if (blockValues.length > MotaLab.MAX_BLOCKS) {
    fail("ENGINE_MODEL_BLOCK_LIMIT_EXCEEDED", { floor_id: floorId });
  }
  const blocks = blockValues.map((raw) => {
    const event = raw && raw.event && typeof raw.event === "object" ? raw.event : {};
    if (!raw || raw.disable === true || event.disable === true) return null;
    const numericId = raw.numeric_id !== undefined ? raw.numeric_id
      : typeof raw.id === "number" ? raw.id : raw.number !== undefined ? raw.number : event.number;
    const id = event.id !== undefined ? event.id : raw.id;
    const cls = event.cls !== undefined ? event.cls : raw.cls;
    const trigger = event.trigger !== undefined ? event.trigger : raw.trigger;
    const eventActions = Array.isArray(event.data) ? event.data : [];
    const shopActions = eventActions.filter((action) => action && typeof action === "object"
      && action.type === "openShop" && typeof action.id === "string" && action.open === true);
    if (!MotaLab.isFiniteInteger(raw.x) || !MotaLab.isFiniteInteger(raw.y)
      || !MotaLab.isFiniteInteger(numericId) || numericId < 0 || id == null || cls == null) {
      fail("ENGINE_MODEL_BLOCK_INVALID", { x: raw && raw.x, y: raw && raw.y });
    }
    return {
      x: raw.x, y: raw.y, numeric_id: numericId, id: String(id), cls: String(cls),
      trigger: trigger == null ? null : String(trigger),
      ...(shopActions.length === 1 ? {
        shop_id: shopActions[0].id,
      } : {}),
      no_pass: Boolean(event.noPass !== undefined ? event.noPass
        : raw.noPass !== undefined ? raw.noPass : raw.no_pass),
      disabled: false,
    };
  }).filter(Boolean).sort((left, right) => left.y - right.y || left.x - right.x);
  const changeSource = definition.changeFloor || dynamic.changeFloor || {};
  const change_floor = Object.entries(changeSource).map(([coordinate, rawValue]) => {
    const match = coordinate.match(/^(\d+)\s*,\s*(\d+)$/u);
    const body = typeof rawValue === "string" ? { floorId: rawValue } : rawValue || {};
    const x = match ? Number(match[1]) : body.x;
    const y = match ? Number(match[2]) : body.y;
    if (!MotaLab.isFiniteInteger(x) || !MotaLab.isFiniteInteger(y)) {
      fail("ENGINE_MODEL_CHANGE_FLOOR_INVALID", { floor_id: floorId, coordinate });
    }
    const rawLoc = body.loc;
    const loc = Array.isArray(rawLoc) ? { x: rawLoc[0], y: rawLoc[1] }
      : rawLoc && typeof rawLoc === "object" ? { x: rawLoc.x, y: rawLoc.y } : null;
    const target = body.floorId !== undefined ? body.floorId : body.floor_id;
    return {
      x, y, floor_id: target == null ? null : String(target),
      loc: loc && MotaLab.isFiniteInteger(loc.x) && MotaLab.isFiniteInteger(loc.y) ? loc : null,
      direction: ["up", "down", "left", "right"].includes(body.direction) ? body.direction : null,
      stair: typeof body.stair === "string" ? body.stair : null,
      time: MotaLab.isFiniteInteger(body.time) && body.time >= 0 ? body.time : null,
      ignore_change_floor: body.ignoreChangeFloor === true || body.ignore_change_floor === true,
      opaque: target == null,
    };
  });
  const terminal_goals = [];
  const opaque_events = [];
  const staticEvents = definition.events && typeof definition.events === "object"
    ? definition.events : {};
  const runtimeEvents = dynamic.events && typeof dynamic.events === "object"
    ? dynamic.events : {};
  const eventActions = (rawEvent) => (Array.isArray(rawEvent) ? rawEvent
    : rawEvent && Array.isArray(rawEvent.data) ? rawEvent.data : [rawEvent])
    .filter((action) => action && typeof action === "object");
  const containsWin = (action, seen = new Set()) => {
    if (Array.isArray(action)) return action.some((child) => containsWin(child, seen));
    if (!action || typeof action !== "object" || seen.has(action)) return false;
    seen.add(action);
    if (action.type === "win") return true;
    if (action.type === "if") {
      return containsWin(action.true, seen) || containsWin(action.false, seen);
    }
    if (["while", "dowhile", "for", "forEach"].includes(action.type)) {
      return containsWin(action.data, seen);
    }
    if (action.type === "choices") {
      return Array.isArray(action.choices)
        && action.choices.some((choice) => containsWin(choice && choice.action, seen));
    }
    if (action.type === "confirm") {
      return containsWin(action.yes, seen) || containsWin(action.no, seen);
    }
    if (action.type === "switch") {
      return Array.isArray(action.caseList)
        && action.caseList.some((item) => containsWin(item && item.action, seen));
    }
    if (action.type === "wait") {
      return Array.isArray(action.data)
        && action.data.some((item) => containsWin(item && item.action, seen));
    }
    return false;
  };
  const goalCoordinates = new Set();
  for (const [coordinate, rawEvent] of Object.entries({ ...staticEvents, ...runtimeEvents })) {
    const match = coordinate.match(/^(\d+)\s*,\s*(\d+)$/u);
    if (!match) continue;
    if (eventActions(rawEvent).some((action) => action.type === "win")) {
      goalCoordinates.add(coordinate);
      terminal_goals.push({
        kind: "location", floor_id: floorId, x: Number(match[1]), y: Number(match[2]),
      });
    }
  }
  for (const source of [definition.afterBattle, definition.afterGetItem,
    definition.afterOpenDoor, dynamic.afterBattle, dynamic.afterGetItem, dynamic.afterOpenDoor]) {
    if (!source || typeof source !== "object") continue;
    for (const [coordinate, rawEvent] of Object.entries(source)) {
      const match = coordinate.match(/^(\d+)\s*,\s*(\d+)$/u);
      if (!match || goalCoordinates.has(coordinate)
        || !eventActions(rawEvent).some((action) => containsWin(action))) continue;
      goalCoordinates.add(coordinate);
      terminal_goals.push({
        kind: "location", floor_id: floorId, x: Number(match[1]), y: Number(match[2]),
      });
    }
  }
  // Ordinary events are authoritative only while present in the detached runtime map.
  // Static definitions are consulted above solely for the explicit win terminal.
  for (const [coordinate, rawEvent] of Object.entries(runtimeEvents)) {
    const match = coordinate.match(/^(\d+)\s*,\s*(\d+)$/u);
    if (!match || goalCoordinates.has(coordinate)) continue;
    if (eventActions(rawEvent).some((action) => typeof action.type === "string")) {
      opaque_events.push({ x: Number(match[1]), y: Number(match[2]), reason: "event_script" });
    }
  }
  return {
    floor_id: floorId,
    title: String(dynamic.title || dynamic.name || definition.title || definition.name || floorId),
    width,
    height,
    topology: validCells.length === width * height
      ? { kind: "rectangle" } : { kind: "valid_cells", valid_cells: validCells },
    map,
    blocks,
    change_floor, terminal_goals, opaque_events,
    ratio: Number.isFinite(dynamic.ratio) ? dynamic.ratio
      : Number.isFinite(definition.ratio) ? definition.ratio : 1,
  };
};

MotaLab.parseSolverItemDelta = function parseSolverItemDelta(item, values, keySlots) {
  const zero = { hp: 0, attack: 0, defense: 0, gold: 0, experience: 0,
    keys: { yellow: 0, blue: 0, red: 0 }, inventory: {} };
  if (!item) {
    return { supported: false, reason: "resource_effect_opaque" };
  }
  const keyColor = Object.entries(keySlots || {}).find(([, id]) => id === item.id)?.[0];
  if (keyColor && Object.hasOwn(zero.keys, keyColor)) {
    const result = MotaLab.cloneJsonValue(zero);
    result.keys[keyColor] = 1;
    return { supported: true, delta: result };
  }
  if (typeof item.item_effect !== "string" || item.complex === true) {
    return { supported: false, reason: "resource_effect_opaque" };
  }
  const statements = item.item_effect.split(";").map((value) => value.trim()).filter(Boolean);
  if (!statements.length) return { supported: false, reason: "resource_effect_empty" };
  const result = MotaLab.cloneJsonValue(zero);
  const heroFields = { hp: "hp", atk: "attack", attack: "attack", def: "defense",
    defense: "defense", money: "gold", gold: "gold", exp: "experience", experience: "experience" };
  const slotColors = Object.fromEntries(Object.entries(keySlots || {})
    .filter(([, id]) => typeof id === "string").map(([color, id]) => [id, color]));
  function amount(raw) {
    if (/^\d+$/u.test(raw)) return Number(raw);
    const match = raw.match(/^[c]ore\.values\.([A-Za-z_$][\w$]*)$/u);
    return match && Number.isFinite(values[match[1]]) ? values[match[1]] : null;
  }
  for (const statement of statements) {
    let match = statement.match(/^[c]ore\.status\.hero\.(hp|atk|attack|def|defense|money|gold|exp|experience)\s*\+=\s*(.+)$/u);
    if (match) {
      const value = amount(match[2].trim());
      if (!Number.isInteger(value) || value < 0) return { supported: false, reason: "resource_effect_opaque" };
      result[heroFields[match[1]]] += value;
      continue;
    }
    match = statement.match(/^[c]ore\.status\.hero\.items\.[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)(\+\+|\s*\+=\s*(\d+))$/u);
    if (match) {
      const value = match[2] === "++" ? 1 : Number(match[3]);
      const color = slotColors[match[1]];
      if (color) result.keys[color] += value;
      else result.inventory[match[1]] = (result.inventory[match[1]] || 0) + value;
      continue;
    }
    return { supported: false, reason: "resource_effect_opaque" };
  }
  return { supported: true, delta: result };
};

MotaLab.buildSolverModel = function buildSolverModel(engineModel, shops = []) {
  if (!engineModel || typeof engineModel !== "object") return null;
  const blockCatalog = new Map((engineModel.blocks || []).map((block) => [block.numeric_id, block]));
  const items = new Map((engineModel.items || []).map((item) => [item.id, item]));
  const enemies = new Map((engineModel.enemies || []).map((enemy) => [enemy.id, enemy]));
  const blockers = [];
  for (const shop of shops.filter((item) => item && item.supported !== true)) {
    blockers.push({ code: shop.reason || "SHOP_UNSUPPORTED",
      detail: `${shop.shop_id || "unknown"}:${shop.details && shop.details.index !== undefined ? shop.details.index : "shop"}` });
  }
  const goals = (engineModel.floors || []).flatMap((floor) => floor.terminal_goals || []);
  const floorById = new Map((engineModel.floors || []).map((floor) => [floor.floor_id, floor]));
  if (!goals.length || goals.length > 32) blockers.push({
    code: "TERMINAL_UNSUPPORTED", detail: `expected_1_to_32_goals:${goals.length}`,
  });
  const floors = (engineModel.floors || []).map((floor) => {
    const transitions = new Map((floor.change_floor || []).map((item) => [`${item.x},${item.y}`, item]));
    const blocks = (floor.blocks || []).map((block) => {
      const catalog = blockCatalog.get(block.numeric_id) || {};
      const trigger = block.trigger || catalog.trigger;
      const base = { floor_id: floor.floor_id, x: block.x, y: block.y,
        block_id: block.id, numeric_id: block.numeric_id };
      if (trigger === "changeFloor") {
        const transition = transitions.get(`${block.x},${block.y}`);
        let landing = transition && transition.loc;
        if (!landing && transition && transition.floor_id && transition.stair) {
          const targetFloor = floorById.get(transition.floor_id);
          const targetBlocks = targetFloor && (targetFloor.blocks || []).filter(
            (candidate) => candidate.id === transition.stair,
          );
          if (targetBlocks && targetBlocks.length === 1) {
            landing = { x: targetBlocks[0].x, y: targetBlocks[0].y };
          }
        }
        if (!transition || transition.opaque || !transition.floor_id || !landing) {
          blockers.push({ code: "TRANSITION_UNSUPPORTED", detail: `${floor.floor_id}:${block.x},${block.y}` });
          return { ...base, kind: "opaque", reason: "transition_target_unknown" };
        }
        return { ...base, kind: "transition", target: {
          floor_id: transition.floor_id, x: landing.x, y: landing.y,
        } };
      }
      if (trigger === "openDoor") {
        const costs = { yellow: 0, blue: 0, red: 0 };
        for (const [slot, count] of Object.entries(catalog.door_info && catalog.door_info.keys || {})) {
          const color = Object.entries(engineModel.inventory.key_slots || {})
            .find(([, id]) => id === slot)?.[0];
          if (!color || !Object.hasOwn(costs, color)) {
            blockers.push({ code: "DOOR_UNSUPPORTED", detail: block.id });
            return { ...base, kind: "opaque", reason: "door_key_unknown" };
          }
          costs[color] += count;
        }
        return { ...base, kind: "door", key_cost: costs };
      }
      if (trigger === "battle") {
        const enemy = enemies.get(block.id);
        if (!enemy || enemy.attack === null || enemy.defense === null || (enemy.special || []).length) {
          blockers.push({ code: "ENEMY_UNSUPPORTED", detail: block.id });
          return { ...base, kind: "opaque", reason: "enemy_special_or_stats_unknown" };
        }
        return { ...base, kind: "enemy", enemy: MotaLab.cloneJsonValue(enemy) };
      }
      if (trigger === "getItem") {
        const effect = MotaLab.parseSolverItemDelta(
          items.get(block.id), engineModel.values || {}, engineModel.inventory.key_slots || {},
        );
        if (!effect.supported) {
          blockers.push({ code: "RESOURCE_UNSUPPORTED", detail: block.id });
          return { ...base, kind: "opaque", reason: effect.reason };
        }
        return { ...base, kind: "resource", delta: effect.delta };
      }
      if (typeof block.shop_id === "string") return { ...base, kind: "shop", shop_id: block.shop_id };
      if (block.no_pass && !trigger) {
        return { ...base, kind: "opaque", reason: "wall" };
      }
      if (trigger) {
        blockers.push({ code: "EVENT_UNSUPPORTED", detail: `${floor.floor_id}:${block.x},${block.y}` });
        return { ...base, kind: "opaque", reason: "event_unsupported" };
      }
      return { ...base, kind: "terrain" };
    });
    for (const event of floor.opaque_events || []) {
      blockers.push({ code: "EVENT_UNSUPPORTED", detail: `${floor.floor_id}:${event.x},${event.y}` });
      blocks.push({ floor_id: floor.floor_id, x: event.x, y: event.y, block_id: "opaqueEvent",
        numeric_id: 0, kind: "opaque", reason: event.reason });
    }
    return { floor_id: floor.floor_id, width: floor.width, height: floor.height,
      topology: MotaLab.cloneJsonValue(floor.topology), blocks };
  });
  const terminal = goals.length === 1 ? goals[0]
    : goals.length > 1 && goals.length <= 32
      ? { kind: "any_location", locations: MotaLab.cloneJsonValue(goals) } : null;
  return { protocol: 1, terminal, floors,
    shops: MotaLab.cloneJsonValue(shops.filter((shop) => shop && shop.supported === true)), blockers };
};

MotaLab.collectEngineInventory = function collectEngineInventory(engine, keySlotIds) {
  const heroItems = MotaLab.engineJsonLiteral(
    engine.status && engine.status.hero && engine.status.hero.items || {},
  ).value;
  function collectInventoryClass(pair) {
    const [className, source] = pair;
    return source && typeof source === "object" && !Array.isArray(source)
      ? [[className, Object.fromEntries(Object.entries(source).filter(
        ([, count]) => MotaLab.isFiniteInteger(count) && count >= 0,
      ))]] : [];
  }
  return {
    classes: Object.fromEntries(Object.entries(heroItems).flatMap(collectInventoryClass)),
    key_slots: Object.fromEntries(["yellow", "blue", "red"].map(
      (color) => [color, typeof keySlotIds[color] === "string" ? keySlotIds[color] : null],
    )),
  };
};

MotaLab.collectEngineModel = function collectEngineModel(engine, keySlotIds = {}, options = {}) {
  const fail = (code, details = {}) => {
    throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", code, details);
  };
  if (!engine || typeof engine !== "object" || !engine.floors
    || typeof engine.floors !== "object" || typeof engine.getMapBlocksObj !== "function") {
    fail("ENGINE_MODEL_SOURCE_MISSING");
  }
  const cache = options && options.cache;
  const currentFloorId = options && options.currentFloorId;
  if (cache && currentFloorId != null
    && MotaLab.engineModelCacheMatches(cache, engine)) {
    return MotaLab.refreshEngineModel(
      engine, keySlotIds, cache, String(currentFloorId),
    );
  }
  const detach = MotaLab.detachEngineData;
  const floorDefinitions = detach(engine.floors);
  const statusMaps = engine.status && engine.status.maps && typeof engine.status.maps === "object"
    ? detach(engine.status.maps) : {};
  const availableFloorIds = new Set([...Object.keys(floorDefinitions), ...Object.keys(statusMaps)]);
  const runtimeFloorIds = Array.isArray(engine.floorIds)
    ? engine.floorIds.filter((id) => typeof id === "string") : [];
  const hasAuthoritativeOrder = runtimeFloorIds.length === availableFloorIds.size
    && new Set(runtimeFloorIds).size === runtimeFloorIds.length
    && runtimeFloorIds.every((id) => availableFloorIds.has(id));
  const floorIds = hasAuthoritativeOrder ? runtimeFloorIds.slice() : [...availableFloorIds].sort();
  if (!floorIds.length || floorIds.length > MotaLab.MAX_ENGINE_FLOORS) {
    fail("ENGINE_MODEL_FLOOR_LIMIT_EXCEEDED", { count: floorIds.length });
  }
  let floors = floorIds.map((floorId) => MotaLab.collectEngineFloor(
    engine, floorId, floorDefinitions[floorId] || {}, statusMaps[floorId] || {}, fail,
  ));
  const floorIndex = new Map(floorIds.map((id, index) => [id, index]));
  const collectedFloorById = new Map(floors.map((floor) => [floor.floor_id, floor]));
  floors = floors.map((floor) => ({ ...floor, change_floor: floor.change_floor.map((change) => {
    let targetId = change.floor_id;
    const index = floorIndex.get(floor.floor_id);
    if (targetId === ":next") targetId = index === undefined ? null : floorIds[index + 1] || null;
    if (targetId === ":before") targetId = index === undefined ? null : floorIds[index - 1] || null;
    const targetDefinition = targetId && floorDefinitions[targetId];
    const rawLanding = targetDefinition && change.stair && targetDefinition[change.stair];
    const definedLanding = Array.isArray(rawLanding) && rawLanding.length >= 2
      && MotaLab.isFiniteInteger(rawLanding[0]) && MotaLab.isFiniteInteger(rawLanding[1])
      ? { x: rawLanding[0], y: rawLanding[1] } : null;
    const targetFloor = targetId && collectedFloorById.get(targetId);
    const stairMatches = targetFloor && change.stair
      ? (targetFloor.blocks || []).filter((block) => block.id === change.stair) : [];
    const inferredLanding = stairMatches.length === 1
      ? { x: stairMatches[0].x, y: stairMatches[0].y } : null;
    const landing = change.loc || definedLanding || inferredLanding;
    return { ...change, floor_id: targetId, loc: landing,
      opaque: !targetId || !landing };
  }) }));

  const blockSource = detach(engine.maps && engine.maps.blocksInfo || {});
  const blockPairs = Array.isArray(blockSource)
    ? blockSource.map((value, index) => [String(index), value]) : Object.entries(blockSource);
  function collectBlock(pair) {
    const [key, raw] = pair;
    if (!raw || typeof raw !== "object" || raw.id == null || raw.cls == null) return [];
    const numericId = MotaLab.isFiniteInteger(raw.numeric_id) ? raw.numeric_id
      : /^\d+$/u.test(key) ? Number(key) : raw.number;
    if (!MotaLab.isFiniteInteger(numericId) || numericId < 0) return [];
    const keySource = raw.doorInfo && raw.doorInfo.keys || raw.door_info && raw.door_info.keys;
    const keys = keySource && typeof keySource === "object" ? Object.fromEntries(
      Object.entries(keySource).filter(([, amount]) => (
        MotaLab.isFiniteInteger(amount) && amount > 0
      )),
    ) : {};
    return [{
      numeric_id: numericId, id: String(raw.id), cls: String(raw.cls),
      trigger: raw.trigger == null ? null : String(raw.trigger),
      no_pass: raw.noPass === true || raw.no_pass === true,
      door_info: Object.keys(keys).length ? { keys } : null,
    }];
  }
  const blocks = blockPairs.flatMap(collectBlock)
    .sort((left, right) => left.numeric_id - right.numeric_id || left.id.localeCompare(right.id));

  const itemSource = detach(engine.material && engine.material.items || {});
  const items = Object.entries(itemSource).flatMap(([id, raw]) => {
    if (!raw || typeof raw !== "object" || raw.cls == null) return [];
    const event = MotaLab.engineJsonLiteral(
      raw.useItemEvent === undefined ? null : raw.useItemEvent,
    );
    return [{
      id, cls: String(raw.cls), name: typeof raw.name === "string" ? raw.name : null,
      text: typeof raw.text === "string" ? raw.text : null,
      item_effect: typeof raw.itemEffect === "string" ? raw.itemEffect : null,
      item_effect_tip: typeof raw.itemEffectTip === "string" ? raw.itemEffectTip : null,
      use_item_event: event.value,
      complex: event.complex || event.value !== null
        || (raw.itemEffect !== undefined && typeof raw.itemEffect !== "string"),
    }];
  }).sort((left, right) => left.id.localeCompare(right.id));

  const enemySource = detach(
    engine.material && (engine.material.enemys || engine.material.enemies) || {},
  );
  function collectEnemy(pair) {
    const [id, raw] = pair;
    if (!raw || typeof raw !== "object" || !MotaLab.isFiniteInteger(raw.hp)) return [];
    const value = (...names) => {
      const name = names.find((candidate) => Object.prototype.hasOwnProperty.call(raw, candidate));
      return name && MotaLab.isFiniteInteger(raw[name]) && raw[name] >= 0 ? raw[name] : null;
    };
    const special = raw.special === 0 || raw.special == null ? [] : raw.special;
    return [{
      id, hp: raw.hp, attack: value("atk", "attack"), defense: value("def", "defense"),
      gold: value("money", "gold") || 0, experience: value("exp", "experience") || 0,
      special: Array.isArray(special)
        ? special.filter((item) => typeof item === "string" || MotaLab.isFiniteInteger(item)) : [],
    }];
  }
  const enemies = Object.entries(enemySource).flatMap(collectEnemy)
    .sort((left, right) => left.id.localeCompare(right.id));
  const values = Object.fromEntries(Object.entries(detach(engine.values || {})).filter(
    ([, value]) => typeof value === "number" && Number.isFinite(value),
  ));
  const inventory = MotaLab.collectEngineInventory(engine, keySlotIds);
  const staticFloors = floors.map((floor) => ({
    floor_id: floor.floor_id, title: floor.title, width: floor.width, height: floor.height,
    topology: floor.topology, change_floor: floor.change_floor, ratio: floor.ratio,
  }));
  const catalog_hash = `sha256:${MotaLab.sha256(MotaLab.canonicalize({
    floors: staticFloors, blocks, items, enemies, values,
  }))}`;
  const floorHashes = Object.fromEntries(floors.map((floor) => [
    floor.floor_id,
    `sha256:${MotaLab.sha256(MotaLab.canonicalize(floor))}`,
  ]));
  const model = {
    protocol: 1, catalog_hash, model_hash: "", floors, blocks, items, enemies, values, inventory,
  };
  model.model_hash = `sha256:${MotaLab.sha256(MotaLab.canonicalize({
    protocol: model.protocol, catalog_hash, floor_hashes: floorHashes, inventory,
  }))}`;
  if (unescape(encodeURIComponent(JSON.stringify(model))).length > MotaLab.MAX_ENGINE_MODEL_BYTES) {
    fail("ENGINE_MODEL_SIZE_LIMIT_EXCEEDED");
  }
  if (cache) MotaLab.storeEngineModelCache(cache, engine, model, floorHashes);
  return model;
};

MotaLab.engineModelSourceEntries = function engineModelSourceEntries(source) {
  if (!source || typeof source !== "object") return [];
  return Object.keys(source).sort().map((key) => [key, source[key]]);
};

MotaLab.engineModelSources = function engineModelSources(engine) {
  return {
    runtime: engine,
    floors: engine.floors,
    status_maps: engine.status && engine.status.maps,
    blocks: engine.maps && engine.maps.blocksInfo,
    items: engine.material && engine.material.items,
    enemies: engine.material && (engine.material.enemys || engine.material.enemies),
    values: engine.values,
  };
};

MotaLab.engineModelCacheMatches = function engineModelCacheMatches(cache, engine) {
  if (!cache || cache.invalidated || !cache.model || !cache.sources) return false;
  const sources = MotaLab.engineModelSources(engine);
  if (Object.keys(sources).some((name) => cache.sources[name] !== sources[name])) return false;
  const collections = {
    floors: sources.floors,
    status_maps: sources.status_maps,
    blocks: sources.blocks,
    items: sources.items,
    enemies: sources.enemies,
    values: sources.values,
  };
  return Object.entries(collections).every(([name, source]) => {
    const before = cache.entries[name] || [];
    const after = MotaLab.engineModelSourceEntries(source);
    return before.length === after.length && before.every(
      (pair, index) => pair[0] === after[index][0] && Object.is(pair[1], after[index][1]),
    );
  });
};

MotaLab.storeEngineModelCache = function storeEngineModelCache(cache, engine, model, floorHashes) {
  const sources = MotaLab.engineModelSources(engine);
  cache.invalidated = false;
  cache.sources = sources;
  cache.entries = Object.fromEntries(
    Object.entries(sources)
      .filter(([name]) => name !== "runtime")
      .map(([name, source]) => [name, MotaLab.engineModelSourceEntries(source)]),
  );
  cache.model = model;
  cache.floor_hashes = Object.assign({}, floorHashes);
};

MotaLab.refreshEngineModel = function refreshEngineModel(
  engine, keySlotIds, cache, currentFloorId,
) {
  const fail = (code, details = {}) => {
    throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", code, details);
  };
  const definition = MotaLab.detachEngineData(engine.floors[currentFloorId] || {});
  const dynamic = MotaLab.detachEngineData(
    engine.status && engine.status.maps && engine.status.maps[currentFloorId] || {},
  );
  const previous = cache.model.floors.find((floor) => floor.floor_id === currentFloorId);
  if (!previous) {
    cache.invalidated = true;
    return MotaLab.collectEngineModel(engine, keySlotIds, { cache, currentFloorId });
  }
  const floor = MotaLab.collectEngineFloor(
    engine, currentFloorId, definition, dynamic, fail,
  );
  const inventory = MotaLab.collectEngineInventory(engine, keySlotIds);
  const floorHashes = Object.assign({}, cache.floor_hashes, {
    [currentFloorId]: `sha256:${MotaLab.sha256(MotaLab.canonicalize(floor))}`,
  });
  const floors = cache.model.floors.map((item) => (
    item.floor_id === currentFloorId ? floor : item
  ));
  const model = Object.assign({}, cache.model, { floors, inventory });
  model.model_hash = `sha256:${MotaLab.sha256(MotaLab.canonicalize({
    protocol: model.protocol,
    catalog_hash: model.catalog_hash,
    floor_hashes: floorHashes,
    inventory,
  }))}`;
  cache.model = model;
  cache.floor_hashes = floorHashes;
  return model;
};
MotaLab.collectObservation = function collectObservation(adapter, now = Date.now) {
  const snapshot = adapter.readRuntimeSnapshot();
  const width = snapshot.map && snapshot.map.width;
  const height = snapshot.map && snapshot.map.height;
  if (!MotaLab.isFiniteInteger(width) || !MotaLab.isFiniteInteger(height)
    || width < 1 || height < 1 || width > MotaLab.MAX_MAP_AXIS
    || height > MotaLab.MAX_MAP_AXIS || width * height > MotaLab.MAX_MAP_CELLS) {
    throw MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE",
      "UNSUPPORTED_MAP_DIMENSIONS",
      { width, height },
    );
  }
  let validCells = null;
  if (snapshot.map.valid_cells !== null) {
    if (!Array.isArray(snapshot.map.valid_cells) || snapshot.map.valid_cells.length < 1
      || snapshot.map.valid_cells.length > width * height) {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "UNRELIABLE_TOPOLOGY",
        { source: snapshot.map.topology_source },
      );
    }
    const unique = new Set();
    validCells = snapshot.map.valid_cells.map((cell) => {
      if (!cell || !MotaLab.isFiniteInteger(cell.x) || !MotaLab.isFiniteInteger(cell.y)
        || cell.x < 0 || cell.x >= width || cell.y < 0 || cell.y >= height) {
        throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "UNRELIABLE_TOPOLOGY");
      }
      const key = `${cell.x},${cell.y}`;
      if (unique.has(key)) {
        throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "UNRELIABLE_TOPOLOGY");
      }
      unique.add(key);
      return { x: cell.x, y: cell.y };
    }).sort((a, b) => a.y - b.y || a.x - b.x);
  }
  const topologyProjection = {
    dimensions: { width, height },
    valid_cells: validCells,
  };
  const topologyFingerprint = `sha256:${MotaLab.sha256(MotaLab.canonicalize(topologyProjection))}`;
  const validCellSet = validCells && new Set(validCells.map((cell) => `${cell.x},${cell.y}`));
  const isValidCell = (x, y) => x >= 0 && x < width && y >= 0 && y < height
    && (!validCellSet || validCellSet.has(`${x},${y}`));

  const hero = snapshot.hero;
  const validDirection = new Set(["up", "down", "left", "right"]);
  const invalidHeroField = [
    ["hero.hp", hero.hp],
    ["hero.attack", hero.attack],
    ["hero.defense", hero.defense],
    ["hero.gold", hero.gold],
    ["hero.experience", hero.experience],
    ["keys.yellow", hero.keys.yellow],
    ["keys.blue", hero.keys.blue],
    ["keys.red", hero.keys.red],
  ].find(([, value]) => !MotaLab.isFiniteInteger(value) || value < 0);
  if (invalidHeroField
    || !isValidCell(hero.loc.x, hero.loc.y)
    || !validDirection.has(hero.loc.direction)) {
    throw MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE",
      "INVALID_HERO_FIELD",
      { field: invalidHeroField ? invalidHeroField[0] : "hero.loc" },
    );
  }
  if (typeof snapshot.floor_id !== "string" || snapshot.floor_id.length < 1
    || snapshot.floor_id.length > 256
    || (snapshot.map.floor_name !== null && snapshot.map.floor_name !== undefined
      && (typeof snapshot.map.floor_name !== "string" || snapshot.map.floor_name.length > 128))) {
    throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "INVALID_FLOOR_IDENTITY");
  }

  const blocks = [];
  if (!Array.isArray(snapshot.blocks) || snapshot.blocks.length > MotaLab.MAX_BLOCKS) {
    throw MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE", "INVALID_BLOCK_COLLECTION_SIZE",
      { count: Array.isArray(snapshot.blocks) ? snapshot.blocks.length : null },
    );
  }
  const collectionIssues = [];
  const occupied = new Set();
  for (const raw of snapshot.blocks) {
    if (raw.disabled) continue;
    if (!MotaLab.isFiniteInteger(raw.x) || !MotaLab.isFiniteInteger(raw.y)
      || !isValidCell(raw.x, raw.y)) {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "BLOCK_OUT_OF_BOUNDS",
        MotaLab.blockEvidence(raw),
      );
    }
    if (!MotaLab.isFiniteInteger(raw.numeric_id) || raw.numeric_id < 0
      || typeof raw.id !== "string" || raw.id.length === 0
      || raw.id.length > 256
      || typeof raw.cls !== "string" || raw.cls.length === 0 || raw.cls.length > 256
      || (raw.trigger !== null && (typeof raw.trigger !== "string" || raw.trigger.length > 128))) {
      throw MotaLab.createPauseError(
        "NEW_OBJECT_OR_MECHANISM",
        "INCOMPLETE_BLOCK_IDENTITY",
        { block: MotaLab.blockEvidence(raw) },
      );
    }
    const coordinate = `${raw.x},${raw.y}`;
    if (occupied.has(coordinate)) {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "DUPLICATE_BLOCK_COORDINATE",
        { block: MotaLab.blockEvidence(raw) },
      );
    }
    occupied.add(coordinate);
    const isEnemy = raw.trigger === "battle"
      || (typeof raw.cls === "string" && /^enemy/i.test(raw.cls));
    const normalizedDamage = isEnemy ? MotaLab.normalizeObservedDamage(raw.damage) : null;
    let normalizedEnemy = null;
    let issue = null;
    if (isEnemy) {
      try {
        normalizedEnemy = MotaLab.normalizeEnemy(raw.enemy, raw);
      } catch (error) {
        if (!MotaLab.isPauseError(error)) throw error;
        issue = issue || {
          pause_kind: error.pause_kind,
          detail_code: error.detail_code,
          field: error.details && error.details.field,
        };
      }
      if (raw.enemy_issue) {
        issue = {
          pause_kind: "UNKNOWN_DAMAGE",
          detail_code: "DAMAGE_UNEXPLAINED",
          field: raw.enemy_issue.field || null,
          runtime_issue: raw.enemy_issue,
        };
      }
      if (!MotaLab.isFiniteInteger(raw.damage) || raw.damage < 0) {
        // Only the engine's two documented unknown-damage sentinels may be
        // explained by an impenetrable defense.  In particular, JavaScript
        // undefined means the runtime API did not produce a protocol value;
        // treating it as null would silently turn an API failure into a safe
        // planning fact.
        const engineReportedUnknown = raw.damage === null || raw.damage === "???";
        const knownUnfightable = engineReportedUnknown
          && normalizedEnemy !== null
          && MotaLab.isFiniteInteger(normalizedEnemy.defense)
          && hero.attack <= normalizedEnemy.defense
          && !raw.enemy_issue;
        if (!knownUnfightable) {
          issue = issue || {
            pause_kind: "UNKNOWN_DAMAGE",
            detail_code: "DAMAGE_UNEXPLAINED",
            hero_attack: hero.attack,
            enemy_defense: normalizedEnemy === null ? null : normalizedEnemy.defense,
          };
        }
      }
    }
    const normalizedBlock = {
      x: raw.x,
      y: raw.y,
      numeric_id: raw.numeric_id,
      id: raw.id,
      cls: raw.cls,
      trigger: typeof raw.trigger === "string" ? raw.trigger : null,
      no_pass: raw.no_pass === true,
      damage: normalizedDamage,
      enemy: isEnemy ? normalizedEnemy : null,
    };
    if (typeof raw.shop_id === "string") normalizedBlock.shop_id = raw.shop_id;
    blocks.push(normalizedBlock);
    if (issue) {
      collectionIssues.push(Object.assign(issue, {
        block: MotaLab.blockEvidence(raw, normalizedDamage),
        raw_enemy: MotaLab.enemyEvidence(raw.enemy),
        raw_enemy_aliases: raw.enemy_raw_evidence || null,
        runtime_issue: issue.runtime_issue || null,
        hero_attack: issue.hero_attack === undefined ? hero.attack : issue.hero_attack,
        enemy_defense: issue.enemy_defense === undefined
          ? normalizedEnemy === null ? null : normalizedEnemy.defense
          : issue.enemy_defense,
        normalized: {
          damage: normalizedBlock.damage,
          enemy: normalizedBlock.enemy,
        },
      }));
    }
  }
  blocks.sort((a, b) => a.y - b.y || a.x - b.x
    || (a.numeric_id || 0) - (b.numeric_id || 0)
    || String(a.id).localeCompare(String(b.id)));

  const busyState = snapshot.busy;
  const observation = {
    protocol: MotaLab.PROTOCOL_VERSION,
    page: MotaLab.PAGE,
    floor_id: snapshot.floor_id,
    floor_name: snapshot.map.floor_name || null,
    floor_number: MotaLab.parseFloorNumber(snapshot.map.floor_name, snapshot.floor_id),
    dimensions: { width, height },
    topology: validCells ? {
      kind: "valid_cells",
      valid_cells: validCells,
      source: snapshot.map.topology_source,
      confidence: snapshot.map.topology_confidence,
    } : {
      kind: "rectangle",
      source: snapshot.map.topology_source,
      confidence: snapshot.map.topology_confidence,
    },
    topology_fingerprint: topologyFingerprint,
    map_instance_id: `map:${MotaLab.sha256(MotaLab.canonicalize({
      floor_id: snapshot.floor_id,
      topology_fingerprint: topologyFingerprint,
    }))}`,
    hero: {
      hp: hero.hp,
      attack: hero.attack,
      defense: hero.defense,
      gold: hero.gold,
      experience: hero.experience,
      loc: {
        x: hero.loc.x,
        y: hero.loc.y,
        direction: hero.loc.direction,
      },
    },
    keys: {
      yellow: hero.keys.yellow,
      blue: hero.keys.blue,
      red: hero.keys.red,
    },
    busy: busyState.moving || busyState.lock_control || busyState.event_active,
    blocks,
    captured_at: now(),
  };
  if (snapshot.engine_model) observation.engine_model = snapshot.engine_model;
  if (Array.isArray(snapshot.shops)) observation.shops = snapshot.shops;
  if (snapshot.active_menu) observation.active_menu = snapshot.active_menu;
  if (collectionIssues.length) {
    const primary = collectionIssues[0];
    const error = MotaLab.createPauseError(
      primary.pause_kind,
      primary.detail_code,
      {
        block: primary.block,
        field: primary.field || null,
        hero_attack: primary.hero_attack,
        enemy_defense: primary.enemy_defense,
        collection_issues: collectionIssues,
      },
    );
    error.observation = observation;
    throw error;
  }
  return observation;
};
