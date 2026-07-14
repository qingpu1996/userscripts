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

MotaLab.collectEngineModel = function collectEngineModel(engine, keySlotIds = {}) {
  const fail = (code, details = {}) => {
    throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", code, details);
  };
  if (!engine || typeof engine !== "object" || !engine.floors
    || typeof engine.floors !== "object" || typeof engine.getMapBlocksObj !== "function") {
    fail("ENGINE_MODEL_SOURCE_MISSING");
  }
  const detach = (value) => JSON.parse(JSON.stringify(MotaLab.engineJsonLiteral(value).value));
  const floorDefinitions = detach(engine.floors);
  const statusMaps = engine.status && engine.status.maps && typeof engine.status.maps === "object"
    ? detach(engine.status.maps) : {};
  const floorIds = [...new Set([...Object.keys(floorDefinitions), ...Object.keys(statusMaps)])].sort();
  if (!floorIds.length || floorIds.length > MotaLab.MAX_ENGINE_FLOORS) {
    fail("ENGINE_MODEL_FLOOR_LIMIT_EXCEEDED", { count: floorIds.length });
  }
  const normalizeBlock = (raw) => {
    const event = raw && raw.event && typeof raw.event === "object" ? raw.event : {};
    if (!raw || raw.disable === true || event.disable === true) return null;
    const numericId = raw.numeric_id !== undefined ? raw.numeric_id
      : typeof raw.id === "number" ? raw.id : raw.number !== undefined ? raw.number : event.number;
    const id = event.id !== undefined ? event.id : raw.id;
    const cls = event.cls !== undefined ? event.cls : raw.cls;
    const trigger = event.trigger !== undefined ? event.trigger : raw.trigger;
    if (!MotaLab.isFiniteInteger(raw.x) || !MotaLab.isFiniteInteger(raw.y)
      || !MotaLab.isFiniteInteger(numericId) || numericId < 0 || id == null || cls == null) {
      fail("ENGINE_MODEL_BLOCK_INVALID", { x: raw && raw.x, y: raw && raw.y });
    }
    return {
      x: raw.x, y: raw.y, numeric_id: numericId, id: String(id), cls: String(cls),
      trigger: trigger == null ? null : String(trigger),
      no_pass: Boolean(event.noPass !== undefined ? event.noPass
        : raw.noPass !== undefined ? raw.noPass : raw.no_pass),
      disabled: false,
    };
  };
  function collectFloor(floorId) {
    const definition = floorDefinitions[floorId] || {};
    const dynamic = statusMaps[floorId] || {};
    const source = Array.isArray(dynamic.map) ? dynamic.map : definition.map;
    if (!Array.isArray(source) || source.some((row) => !Array.isArray(row))) {
      fail("ENGINE_MODEL_MAP_MISSING", { floor_id: floorId });
    }
    const inferredWidth = source.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    const width = MotaLab.isFiniteInteger(dynamic.width) ? dynamic.width
      : MotaLab.isFiniteInteger(definition.width) ? definition.width : inferredWidth;
    const height = MotaLab.isFiniteInteger(dynamic.height) ? dynamic.height
      : MotaLab.isFiniteInteger(definition.height) ? definition.height : source.length;
    if (width < 1 || height < 1 || width > MotaLab.MAX_MAP_AXIS
      || height > MotaLab.MAX_MAP_AXIS || width * height > MotaLab.MAX_MAP_CELLS
      || source.length > height || source.some((row) => row.length > width)) {
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
    const rawBlocks = detach(engine.getMapBlocksObj(floorId, true));
    const blockValues = Array.isArray(rawBlocks) ? rawBlocks
      : rawBlocks && typeof rawBlocks === "object" ? Object.values(rawBlocks) : [];
    if (blockValues.length > MotaLab.MAX_BLOCKS) {
      fail("ENGINE_MODEL_BLOCK_LIMIT_EXCEEDED", { floor_id: floorId });
    }
    const blocks = blockValues.map(normalizeBlock).filter(Boolean)
      .sort((left, right) => left.y - right.y || left.x - right.x);
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
    return {
      floor_id: floorId,
      title: String(dynamic.title || dynamic.name || definition.title || definition.name || floorId),
      width, height,
      topology: validCells.length === width * height
        ? { kind: "rectangle" } : { kind: "valid_cells", valid_cells: validCells },
      map, blocks, change_floor,
      ratio: Number.isFinite(dynamic.ratio) ? dynamic.ratio
        : Number.isFinite(definition.ratio) ? definition.ratio : 1,
    };
  }
  const floors = floorIds.map(collectFloor);

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
  const heroItems = detach(engine.status && engine.status.hero && engine.status.hero.items || {});
  function collectInventoryClass(pair) {
    const [className, source] = pair;
    return (
    source && typeof source === "object" && !Array.isArray(source)
      ? [[className, Object.fromEntries(Object.entries(source).filter(
        ([, count]) => MotaLab.isFiniteInteger(count) && count >= 0,
      ))]] : []
    );
  }
  const classes = Object.fromEntries(Object.entries(heroItems).flatMap(collectInventoryClass));
  const inventory = {
    classes,
    key_slots: Object.fromEntries(["yellow", "blue", "red"].map(
      (color) => [color, typeof keySlotIds[color] === "string" ? keySlotIds[color] : null],
    )),
  };
  const staticFloors = floors.map((floor) => ({
    floor_id: floor.floor_id, title: floor.title, width: floor.width, height: floor.height,
    topology: floor.topology, change_floor: floor.change_floor, ratio: floor.ratio,
  }));
  const catalog_hash = `sha256:${MotaLab.sha256(MotaLab.canonicalize({
    floors: staticFloors, blocks, items, enemies, values,
  }))}`;
  const model = {
    protocol: 1, catalog_hash, model_hash: "", floors, blocks, items, enemies, values, inventory,
  };
  model.model_hash = `sha256:${MotaLab.sha256(MotaLab.canonicalize({
    protocol: model.protocol, catalog_hash, floors, blocks, items, enemies, values, inventory,
  }))}`;
  if (unescape(encodeURIComponent(JSON.stringify(model))).length > MotaLab.MAX_ENGINE_MODEL_BYTES) {
    fail("ENGINE_MODEL_SIZE_LIMIT_EXCEEDED");
  }
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
