MotaLab.createEngineAdapter = function createEngineAdapter(pageScope) {
  const scope = pageScope || (typeof unsafeWindow !== "undefined" ? unsafeWindow : null);

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

  function readHero(runtime) {
    const hero = runtime.status.hero;
    if (!hero || typeof hero !== "object") {
      throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "MISSING_HERO");
    }
    const loc = hero.loc;
    if (!loc || typeof loc !== "object") {
      throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "MISSING_HERO_LOCATION");
    }
    const items = hero.items;
    const itemKeys = items && typeof items === "object" ? items.keys : null;
    const directKeys = hero.keys;
    const keys = itemKeys && typeof itemKeys === "object"
      ? itemKeys
      : directKeys && typeof directKeys === "object" ? directKeys : {};

    return {
      hp: readNumber(hero.hp, "hero.hp"),
      attack: readNumber(hero.atk !== undefined ? hero.atk : hero.attack, "hero.attack"),
      defense: readNumber(hero.def !== undefined ? hero.def : hero.defense, "hero.defense"),
      gold: readNumber(hero.money !== undefined ? hero.money : hero.gold, "hero.gold"),
      experience: readNumber(hero.experience, "hero.experience"),
      loc: {
        x: readNumber(loc.x, "hero.loc.x"),
        y: readNumber(loc.y, "hero.loc.y"),
        direction: typeof loc.direction === "string" ? loc.direction : null,
      },
      keys: {
        yellow: readNumber(
          keys.yellowKey !== undefined ? keys.yellowKey : keys.yellow,
          "hero.keys.yellow",
        ),
        blue: readNumber(
          keys.blueKey !== undefined ? keys.blueKey : keys.blue,
          "hero.keys.blue",
        ),
        red: readNumber(
          keys.redKey !== undefined ? keys.redKey : keys.red,
          "hero.keys.red",
        ),
      },
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
    return {
      floor_name: title || name,
      width: MotaLab.MAP_WIDTH,
      height: MotaLab.MAP_HEIGHT,
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
    const special = info && Array.isArray(info.special)
      ? info.special.filter((value) => ["string", "number"].includes(typeof value))
      : [];
    return {
      damage,
      enemy: info && typeof info === "object" ? {
        hp: info.hp === undefined ? null : info.hp,
        attack: info.atk !== undefined ? info.atk : info.attack === undefined ? null : info.attack,
        defense: info.def !== undefined ? info.def : info.defense === undefined ? null : info.defense,
        gold: info.money !== undefined ? info.money : info.gold === undefined ? null : info.gold,
        experience: info.experience === undefined ? null : info.experience,
        special,
      } : null,
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
    return {
      moving: runtime.isMoving() === true,
      lock_control: runtime.status.lockControl === true,
      event_active: eventIsActive(runtime),
    };
  }

  function readRuntimeSnapshot() {
    const runtime = requireRuntime();
    const currentFloorId = runtime.status.floorId;
    if (typeof currentFloorId !== "string" && typeof currentFloorId !== "number") {
      throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "MISSING_FLOOR_ID");
    }
    const floorId = String(currentFloorId);
    const blocks = listRawBlocks(runtime, currentFloorId)
      .map(readBlock)
      .filter(Boolean)
      .map((block) => {
        if (!block.disabled && isEnemyBlock(block)) {
          const enemyResult = readEnemy(runtime, currentFloorId, block);
          return Object.assign(block, enemyResult);
        }
        return Object.assign(block, { damage: null, enemy: null });
      });
    return {
      floor_id: floorId,
      map: readMapMeta(runtime, currentFloorId),
      hero: readHero(runtime),
      blocks,
      busy: readBusy(runtime),
    };
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
      protected_slot: MotaLab.PROTECTED_SAVE_SLOT,
    };
  }

  function assertRequiredCapabilities() {
    const report = capabilities();
    const missing = Object.entries(report)
      .filter(([key, value]) => !["physical_save_load_present", "physical_save_load_enabled", "protected_slot"].includes(key) && value !== true)
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
    return {
      executed: false,
      reason: "PHYSICAL_SAVE_LOAD_DISABLED",
      protected_slot: MotaLab.PROTECTED_SAVE_SLOT,
    };
  }

  return Object.freeze({
    readRuntimeSnapshot,
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
