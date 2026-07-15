MotaLab.createEngineAdapter = function createEngineAdapter(pageScope) {
  const scope = pageScope || (typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis);
  const engineModelCache = { invalidated: true };

  function currentCore() {
    return scope && scope.core;
  }

  function requireRuntime() {
    const core = currentCore();
    if (!core || !core.status || typeof core.status !== "object") {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "MISSING_RUNTIME",
        { capability: "status" },
      );
    }
    return core;
  }

  function readNumber(value, field) {
    if (!MotaLab.isFiniteInteger(value)) {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "INVALID_RUNTIME_FIELD",
        { field, valueType: typeof value },
      );
    }
    return value;
  }

  function readKeyLayout(container, path, options = {}) {
    if (!container || typeof container !== "object" || Array.isArray(container)
      || Object.prototype.toString.call(container) !== "[object Object]") {
      if (options.declared === true) {
        throw MotaLab.createPauseError(
          "ENGINE_API_INCOMPATIBLE",
          "INVALID_KEY_LAYOUT",
          { layout: path, value_type: container === null ? "null" : typeof container },
        );
      }
      return null;
    }
    const aliases = {
      yellow: ["yellowKey", "yellow"],
      blue: ["blueKey", "blue"],
      red: ["redKey", "red"],
    };
    const present = Object.values(aliases).some((names) => (
      names.some((name) => Object.prototype.hasOwnProperty.call(container, name))
    ));
    if (!present && options.omittedZero !== true) {
      if (options.declared === true) {
        throw MotaLab.createPauseError(
          "ENGINE_API_INCOMPATIBLE",
          "INCOMPLETE_KEY_LAYOUT",
          { layout: path, missing_color: "yellow" },
        );
      }
      return null;
    }
    const values = {};
    for (const [color, names] of Object.entries(aliases)) {
      const available = names.filter((name) => (
        Object.prototype.hasOwnProperty.call(container, name)
      ));
      if (available.length === 0) {
        if (options.omittedZero === true) {
          values[color] = 0;
          continue;
        }
        throw MotaLab.createPauseError(
          "ENGINE_API_INCOMPATIBLE",
          "INCOMPLETE_KEY_LAYOUT",
          { layout: path, missing_color: color },
        );
      }
      const candidates = available.map((name) => {
        const value = readNumber(container[name], `${path}.${name}`);
        if (value < 0) {
          throw MotaLab.createPauseError(
            "ENGINE_API_INCOMPATIBLE",
            "INVALID_RUNTIME_FIELD",
            { field: `${path}.${name}`, valueType: typeof container[name] },
          );
        }
        return value;
      });
      if (candidates.some((value) => value !== candidates[0])) {
        throw MotaLab.createPauseError(
          "ENGINE_API_INCOMPATIBLE",
          "CONFLICTING_KEY_LAYOUT",
          { layout: path, color },
        );
      }
      values[color] = candidates[0];
    }
    const slotIds = {};
    for (const [color, names] of Object.entries(aliases)) {
      const actual = names.find((name) => Object.prototype.hasOwnProperty.call(container, name));
      slotIds[color] = actual || names[0];
    }
    return { path, values, slot_ids: slotIds };
  }

  function readKeys(hero) {
    const items = hero.items && typeof hero.items === "object" ? hero.items : null;
    const hasCanonicalTools = Boolean(items
      && Object.prototype.hasOwnProperty.call(items, "tools"));
    const hasItemsKeys = Boolean(items
      && Object.prototype.hasOwnProperty.call(items, "keys"));
    const hasHeroKeys = Object.prototype.hasOwnProperty.call(hero, "keys");
    const candidates = [
      hasCanonicalTools ? readKeyLayout(items.tools, "hero.items.tools", {
        declared: true,
        omittedZero: true,
      }) : null,
      hasItemsKeys ? readKeyLayout(items.keys, "hero.items.keys", { declared: true }) : null,
      hasHeroKeys ? readKeyLayout(hero.keys, "hero.keys", { declared: true }) : null,
    ].filter(Boolean);
    if (candidates.length === 0) {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "MISSING_KEY_LAYOUT",
        { supported_layouts: ["hero.items.tools", "hero.items.keys", "hero.keys"] },
      );
    }
    const selected = candidates[0];
    const conflict = candidates.find((candidate) => (
      ["yellow", "blue", "red"].some((color) => (
        candidate.values[color] !== selected.values[color]
      ))
    ));
    if (conflict) {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "CONFLICTING_KEY_LAYOUT",
        { layouts: candidates.map((candidate) => candidate.path) },
      );
    }
    return { values: selected.values, slot_ids: selected.slot_ids };
  }

  function readHero(runtime) {
    const hero = runtime.status.hero;
    if (!hero || typeof hero !== "object") {
      throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "MISSING_HERO");
    }
    const loc = hero.loc;
    if (!loc || typeof loc !== "object") {
      throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "MISSING_HERO_LOCATION");
    }
    const keys = readKeys(hero);

    return {
      hp: readNumber(hero.hp, "hero.hp"),
      attack: readNumber(hero.atk !== undefined ? hero.atk : hero.attack, "hero.attack"),
      defense: readNumber(hero.def !== undefined ? hero.def : hero.defense, "hero.defense"),
      gold: readNumber(hero.money !== undefined ? hero.money : hero.gold, "hero.gold"),
      experience: readNumber(
        hero.exp !== undefined ? hero.exp : hero.experience,
        "hero.experience",
      ),
      loc: {
        x: readNumber(loc.x, "hero.loc.x"),
        y: readNumber(loc.y, "hero.loc.y"),
        direction: typeof loc.direction === "string" ? loc.direction : null,
      },
      keys: {
        yellow: keys.values.yellow,
        blue: keys.values.blue,
        red: keys.values.red,
      },
      key_slot_ids: keys.slot_ids,
    };
  }

  function readMapMeta(runtime, currentFloorId) {
    const maps = runtime.status.maps;
    if (!maps || typeof maps !== "object") {
      throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "MISSING_CURRENT_MAPS");
    }
    const currentMap = maps[currentFloorId];
    if (!currentMap || typeof currentMap !== "object") {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "MISSING_CURRENT_MAP",
        { floor_id: currentFloorId },
      );
    }
    const title = typeof currentMap.title === "string" ? currentMap.title : null;
    const name = typeof currentMap.name === "string" ? currentMap.name : null;
    const declaredWidth = currentMap.width;
    const declaredHeight = currentMap.height;
    const dynamicGrid = Array.isArray(currentMap.map) ? currentMap.map : null;
    const declaredValidCells = Array.isArray(currentMap.valid_cells)
      ? currentMap.valid_cells.map((cell) => ({ x: cell.x, y: cell.y })) : null;
    let width = declaredWidth;
    let height = declaredHeight;
    let validCells = null;
    let topologySource = "engine_current_map";
    let topologyConfidence = "confirmed";
    if (dynamicGrid) {
      if (dynamicGrid.some((row) => !Array.isArray(row))) {
        throw MotaLab.createPauseError(
          "ENGINE_API_INCOMPATIBLE", "UNRELIABLE_TOPOLOGY",
          { reason: "dynamic grid contains a non-array row" },
        );
      }
      if (!MotaLab.isFiniteInteger(height)) height = dynamicGrid.length;
      if (!MotaLab.isFiniteInteger(width)) {
        width = dynamicGrid.reduce((maximum, row) => Math.max(maximum, row.length), 0);
      }
      if (dynamicGrid.length > height || dynamicGrid.some((row) => row.length > width)) {
        throw MotaLab.createPauseError(
          "ENGINE_API_INCOMPATIBLE", "TOPOLOGY_SOURCE_CONFLICT",
          { declared_width: width, declared_height: height },
        );
      }
      const gridCells = [];
      dynamicGrid.forEach((row, y) => {
        for (let x = 0; x < row.length; x += 1) {
          if (Object.prototype.hasOwnProperty.call(row, x)) gridCells.push({ x, y });
        }
      });
      if (declaredValidCells) {
        const key = (cell) => `${cell.x},${cell.y}`;
        const gridSet = new Set(gridCells.map(key));
        const declaredSet = new Set(declaredValidCells.map(key));
        if (gridSet.size !== declaredSet.size
          || [...gridSet].some((cell) => !declaredSet.has(cell))) {
          throw MotaLab.createPauseError(
            "ENGINE_API_INCOMPATIBLE", "TOPOLOGY_SOURCE_CONFLICT",
            { grid_cells: gridSet.size, declared_valid_cells: declaredSet.size },
          );
        }
        validCells = declaredValidCells;
        topologySource = "engine_current_map";
        topologyConfidence = "confirmed";
      } else if (gridCells.length === width * height
        && dynamicGrid.length === height
        && dynamicGrid.every((row) => row.length === width)) {
        validCells = null;
        topologySource = "engine_current_map";
        topologyConfidence = "confirmed";
      } else {
        validCells = gridCells;
        topologySource = "runtime_observed";
        topologyConfidence = "inferred";
      }
    } else if (declaredValidCells) {
      validCells = declaredValidCells;
      topologySource = "engine_current_map";
      topologyConfidence = "confirmed";
    }
    if (!MotaLab.isFiniteInteger(width) || !MotaLab.isFiniteInteger(height)) {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "MISSING_MAP_DIMENSIONS",
        { floor_id: String(currentFloorId) },
      );
    }
    return {
      floor_name: title || name,
      width,
      height,
      valid_cells: validCells,
      topology_source: topologySource,
      topology_confidence: topologyConfidence,
    };
  }

  function listRawBlocks(runtime, currentFloorId) {
    if (typeof runtime.getMapBlocksObj !== "function") {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "MISSING_API",
        { api: "getMapBlocksObj" },
      );
    }
    const value = runtime.getMapBlocksObj(currentFloorId, true);
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.keys(value).map((key) => value[key]);
    throw MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE",
      "INVALID_BLOCK_COLLECTION",
    );
  }

  function readBlock(block) {
    if (!block || typeof block !== "object") return null;
    const event = block.event && typeof block.event === "object" ? block.event : null;
    const id = event && event.id !== undefined ? event.id : block.id;
    const cls = event && event.cls !== undefined ? event.cls : block.cls;
    const trigger = event && event.trigger !== undefined ? event.trigger : block.trigger;
    const numericId = block.numeric_id !== undefined
      ? block.numeric_id
      : block.id !== undefined && typeof block.id === "number" ? block.id
      : block.number !== undefined ? block.number : event && event.number;
    const disabled = block.disable === true || (event && event.disable === true);
    const noPassValue = event && event.noPass !== undefined ? event.noPass
      : block.noPass !== undefined ? block.noPass : block.no_pass;
    return {
      x: block.x,
      y: block.y,
      numeric_id: numericId === undefined ? null : numericId,
      id: id === undefined || id === null ? null : String(id),
      cls: cls === undefined || cls === null ? null : String(cls),
      trigger: trigger === undefined || trigger === null ? null : String(trigger),
      no_pass: Boolean(noPassValue),
      disabled,
    };
  }

  function isEnemyBlock(block) {
    return block.trigger === "battle"
      || (typeof block.cls === "string" && /^enemy/i.test(block.cls));
  }

  function readEnemy(runtime, floorId, block) {
    if (typeof runtime.getEnemyInfo !== "function" || typeof runtime.getDamage !== "function") {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "MISSING_API",
        { api: typeof runtime.getEnemyInfo !== "function" ? "getEnemyInfo" : "getDamage" },
      );
    }
    const info = runtime.getEnemyInfo(block.id, null, block.x, block.y, floorId);
    const damage = runtime.getDamage(block.id, block.x, block.y, floorId);
    if (!info || typeof info !== "object" || Array.isArray(info)) {
      return { damage, enemy: null, enemy_issue: null, enemy_raw_evidence: null };
    }

    const scalarEvidence = (value) => {
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "string") return value.slice(0, 256);
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : { type: "number", value: String(value) };
      }
      if (value === undefined) return { type: "undefined", value: null };
      return { type: typeof value, value: Object.prototype.toString.call(value).slice(0, 128) };
    };
    let enemyIssue = null;
    function readAliases(names, field) {
      const present = names.filter((name) => Object.prototype.hasOwnProperty.call(info, name));
      if (present.length === 0) return null;
      const invalid = present.find((name) => (
        !MotaLab.isFiniteInteger(info[name]) || info[name] < 0
      ));
      if (invalid !== undefined) {
        throw MotaLab.createPauseError(
          "ENGINE_API_INCOMPATIBLE",
          "INVALID_RUNTIME_FIELD",
          {
            field,
            alias: invalid,
            valueType: typeof info[invalid],
            value: scalarEvidence(info[invalid]),
          },
        );
      }
      const first = info[present[0]];
      if (present.some((name) => !Object.is(info[name], first))) {
        enemyIssue = enemyIssue || {
          field,
          reason: "CONFLICTING_RUNTIME_ALIASES",
          aliases: Object.fromEntries(present.map((name) => [name, scalarEvidence(info[name])])),
        };
        return null;
      }
      return first;
    }
    function readSpecial() {
      if (!Object.prototype.hasOwnProperty.call(info, "special")
        || info.special === null || info.special === 0) return [];
      const values = Array.isArray(info.special) ? info.special : [info.special];
      if (values.length > 64 || values.some((value) => (
        typeof value !== "string" && !MotaLab.isFiniteInteger(value)
      ))) {
        enemyIssue = enemyIssue || {
          field: "enemy.special",
          reason: "INVALID_RUNTIME_FIELD",
          value: scalarEvidence(info.special),
        };
        return [];
      }
      return values.slice();
    }
    const attack = readAliases(["atk", "attack"], "enemy.attack");
    const defense = readAliases(["def", "defense"], "enemy.defense");
    const gold = readAliases(["money", "gold"], "enemy.gold");
    const experience = readAliases(["exp", "experience"], "enemy.experience");
    const special = readSpecial();
    return {
      damage,
      enemy: {
        hp: info.hp === undefined ? null : info.hp,
        attack,
        defense,
        gold,
        experience,
        special,
      },
      enemy_issue: enemyIssue,
      enemy_raw_evidence: {
        hp: scalarEvidence(info.hp),
        atk: scalarEvidence(info.atk),
        attack: scalarEvidence(info.attack),
        def: scalarEvidence(info.def),
        defense: scalarEvidence(info.defense),
        money: scalarEvidence(info.money),
        gold: scalarEvidence(info.gold),
        exp: scalarEvidence(info.exp),
        experience: scalarEvidence(info.experience),
        special: scalarEvidence(info.special),
      },
    };
  }

  function eventIsActive(runtime) {
    const eventState = runtime.status.event;
    if (!eventState || typeof eventState !== "object") return false;
    return eventState.id !== undefined && eventState.id !== null && eventState.id !== "";
  }

  function readBusy(runtime = requireRuntime()) {
    if (typeof runtime.isMoving !== "function") {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "MISSING_API",
        { api: "isMoving" },
      );
    }
    // H5 Mota's isMoving() only covers heroStop/heroMoving.  Between two
    // automatic-route grid steps heroMoving briefly returns to zero while
    // autoHeroMove remains active.  Treat that gap as busy too; otherwise a
    // route ending at a door/enemy/item can be mistaken for complete on the
    // adjacent cell before the final trigger step runs.
    return {
      moving: runtime.isMoving() === true
        || (runtime.status.automaticRoute || {}).autoHeroMove === true,
      lock_control: runtime.status.lockControl === true,
      event_active: eventIsActive(runtime),
    };
  }

  function readRuntimeFence(runtime) {
    const currentFloorId = runtime.status.floorId;
    if (typeof currentFloorId !== "string" && typeof currentFloorId !== "number") {
      throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "MISSING_FLOOR_ID");
    }
    return {
      runtime,
      current_floor_id: currentFloorId,
      floor_id: String(currentFloorId),
      hero: readHero(runtime),
      busy: readBusy(runtime),
    };
  }

  function fenceProjection(fence) {
    return {
      floor_id: fence.floor_id,
      hero: fence.hero,
      busy: fence.busy,
    };
  }

  function readRuntimeSnapshot(options = {}) {
    const includeEngineModel = options.includeEngineModel !== false;
    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const runtime = requireRuntime();
      const before = readRuntimeFence(runtime);
      const blocks = listRawBlocks(runtime, before.current_floor_id)
        .map(readBlock)
        .filter(Boolean)
        .map((block) => {
          if (!block.disabled && isEnemyBlock(block)) {
            const enemyResult = readEnemy(runtime, before.current_floor_id, block);
            return Object.assign(block, enemyResult);
          }
          return Object.assign(block, { damage: null, enemy: null });
        });
      const map = readMapMeta(runtime, before.current_floor_id);
      let engineModel;
      if (includeEngineModel) {
        try {
          engineModel = runtime.floors && typeof runtime.floors === "object"
            ? MotaLab.collectEngineModel(runtime, before.hero.key_slot_ids, {
              cache: engineModelCache,
              currentFloorId: before.current_floor_id,
            }) : undefined;
        } catch (error) {
          // Protocol v2 keeps engine_model optional for older or partial engine
          // embeddings.  A collector-authored pause remains authoritative; a
          // host getter that simply does not expose the model falls back to the
          // legacy current-observation path.
          if (error && error.pause_kind) throw error;
          engineModel = undefined;
        }
      }
      const after = readRuntimeFence(runtime);
      const sameRuntime = after.runtime === runtime && currentCore() === runtime;
      const beforeProjection = fenceProjection(before);
      const afterProjection = fenceProjection(after);
      if (sameRuntime
        && MotaLab.canonicalize(beforeProjection) === MotaLab.canonicalize(afterProjection)) {
        return {
          floor_id: before.floor_id,
          map,
          hero: before.hero,
          blocks,
          busy: before.busy,
          engine_model: engineModel,
        };
      }
      attempts.push({
        attempt,
        runtime_changed: !sameRuntime,
        before: beforeProjection,
        after: afterProjection,
      });
    }
    throw MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE",
      "RUNTIME_SNAPSHOT_UNSTABLE",
      { attempts },
    );
  }

  function readFastRuntimeSnapshot() {
    return readRuntimeSnapshot({ includeEngineModel: false });
  }

  function invalidateEngineModelCache() {
    engineModelCache.invalidated = true;
  }

  function capabilities() {
    const runtime = requireRuntime();
    return {
      get_current_blocks: typeof runtime.getMapBlocksObj === "function",
      enemy_info: typeof runtime.getEnemyInfo === "function",
      enemy_damage: typeof runtime.getDamage === "function",
      automatic_route: typeof runtime.setAutomaticRoute === "function",
      direct_move: typeof runtime.moveDirectly === "function",
      can_direct_move: typeof runtime.canMoveDirectly === "function",
      stop_route: typeof runtime.stopAutomaticRoute === "function",
      moving_state: typeof runtime.isMoving === "function",
      physical_save_load_present: typeof runtime.doSL === "function",
      physical_save_load_enabled: false,
    };
  }

  function assertRequiredCapabilities() {
    const report = capabilities();
    const missing = Object.entries(report)
      .filter(([key, value]) => !["physical_save_load_present", "physical_save_load_enabled"].includes(key) && value !== true)
      .map(([key]) => key);
    if (missing.length) {
      throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "MISSING_API", { missing });
    }
    return report;
  }

  function canMoveDirectly(x, y) {
    const runtime = requireRuntime();
    if (typeof runtime.canMoveDirectly !== "function") return false;
    const result = runtime.canMoveDirectly(x, y);
    return result === true || (MotaLab.isFiniteInteger(result) && result > 0);
  }

  function moveDirectly(x, y) {
    const runtime = requireRuntime();
    if (typeof runtime.moveDirectly !== "function") {
      throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "MISSING_API", { api: "moveDirectly" });
    }
    return runtime.moveDirectly(x, y);
  }

  function setAutomaticRoute(x, y) {
    const runtime = requireRuntime();
    if (typeof runtime.setAutomaticRoute !== "function") {
      throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "MISSING_API", { api: "setAutomaticRoute" });
    }
    return runtime.setAutomaticRoute(x, y, []);
  }

  function stopAutomaticRoute() {
    const runtime = currentCore();
    if (runtime && typeof runtime.stopAutomaticRoute === "function") runtime.stopAutomaticRoute();
  }

  function physicalSaveLoad() {
    return { executed: false, reason: "PHYSICAL_SAVE_LOAD_DISABLED" };
  }

  return Object.freeze({
    readRuntimeSnapshot,
    readFastRuntimeSnapshot,
    invalidateEngineModelCache,
    readBusy,
    capabilities,
    assertRequiredCapabilities,
    canMoveDirectly,
    moveDirectly,
    setAutomaticRoute,
    stopAutomaticRoute,
    physicalSaveLoad,
  });
};
