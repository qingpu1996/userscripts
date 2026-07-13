// ==UserScript==
// @name         魔塔规划实验室运行态代理
// @namespace    local.mota-planning-lab.userscripts
// @version      0.1.0
// @description  严格盲玩边界内的 H5 魔塔当前运行态代理。
// @match        https://h5mota.com/games/24/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @connect      127.0.0.1
// ==/UserScript==

// This file is generated. Edit shared/ or games/*/src/ and rebuild it.
(function () {
  "use strict";

  // Source: games/mota-planning-lab/src/constants.js

  const MotaLab = Object.create(null);

  MotaLab.PROTOCOL_VERSION = 1;
  MotaLab.SOURCE = "mota-planning-lab-userscript";
  MotaLab.PAGE = "/games/24/";
  MotaLab.CYCLE_ENDPOINT = "http://127.0.0.1:18724/cycle";
  MotaLab.MAP_WIDTH = 11;
  MotaLab.MAP_HEIGHT = 11;
  MotaLab.PROTECTED_SAVE_SLOT = 8;

  MotaLab.PAUSE_KINDS = Object.freeze([
    "NEW_OBJECT_OR_MECHANISM",
    "UNKNOWN_DAMAGE",
    "UNKNOWN_FLOOR",
    "EXPECTED_DELTA_MISMATCH",
    "GUARD_MISMATCH",
    "UNSUPPORTED_INTERACTION",
    "DECISION_SERVICE_UNAVAILABLE",
    "ENGINE_API_INCOMPATIBLE",
  ]);

  MotaLab.PAUSE_KIND_SET = new Set(MotaLab.PAUSE_KINDS);

  MotaLab.BLOCK_CATEGORIES = Object.freeze([
    "terrain",
    "wall",
    "door",
    "resource",
    "enemy",
    "npc",
    "mechanism",
    "stair",
    "other",
  ]);

  MotaLab.BOUNDARY_CATEGORIES = new Set([
    "door",
    "resource",
    "enemy",
    "npc",
    "mechanism",
    "stair",
  ]);

  MotaLab.INITIAL_BASELINE = Object.freeze({
    floor_number: 4,
    hero: Object.freeze({
      hp: 208,
      attack: 23,
      defense: 21,
      gold: 16,
      experience: 63,
      loc: Object.freeze({ x: 8, y: 3 }),
    }),
    keys: Object.freeze({ yellow: 4, blue: 1, red: 0 }),
  });

  MotaLab.JOURNAL_KEY = "mota-planning-lab:journal:v1";
  MotaLab.PANEL_ID = "mota-planning-lab-panel";
  MotaLab.STYLE_ID = "mota-planning-lab-style";

  MotaLab.createPauseError = function createPauseError(pauseKind, detailCode, details = {}) {
    if (!MotaLab.PAUSE_KIND_SET.has(pauseKind)) {
      throw new TypeError(`Illegal pause_kind: ${String(pauseKind)}`);
    }
    const error = new Error(detailCode || pauseKind);
    error.name = "MotaLabPauseError";
    error.pause_kind = pauseKind;
    error.detail_code = detailCode || null;
    error.details = details;
    return error;
  };

  MotaLab.isPauseError = function isPauseError(error) {
    return Boolean(error && error.name === "MotaLabPauseError"
      && MotaLab.PAUSE_KIND_SET.has(error.pause_kind));
  };

  MotaLab.isFiniteInteger = function isFiniteInteger(value) {
    return Number.isFinite(value) && Number.isInteger(value);
  };

  MotaLab.cloneJsonValue = function cloneJsonValue(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("Non-finite number");
      return value;
    }
    if (Array.isArray(value)) return value.map(MotaLab.cloneJsonValue);
    if (value && Object.prototype.toString.call(value) === "[object Object]") {
      const copy = {};
      for (const key of Object.keys(value)) copy[key] = MotaLab.cloneJsonValue(value[key]);
      return copy;
    }
    throw new TypeError("Value is not plain JSON data");
  };

  // Source: games/mota-planning-lab/src/engine-adapter.js

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

  // Source: games/mota-planning-lab/src/observer.js

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
    return MotaLab.isFiniteInteger(value) ? value : null;
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

  MotaLab.collectObservation = function collectObservation(adapter, now = Date.now) {
    const snapshot = adapter.readRuntimeSnapshot();
    if (!snapshot.map || snapshot.map.width !== MotaLab.MAP_WIDTH
      || snapshot.map.height !== MotaLab.MAP_HEIGHT) {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "UNSUPPORTED_MAP_DIMENSIONS",
        { width: snapshot.map && snapshot.map.width, height: snapshot.map && snapshot.map.height },
      );
    }

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
      || hero.loc.x < 0 || hero.loc.x >= MotaLab.MAP_WIDTH
      || hero.loc.y < 0 || hero.loc.y >= MotaLab.MAP_HEIGHT
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
    const collectionIssues = [];
    const occupied = new Set();
    for (const raw of snapshot.blocks) {
      if (raw.disabled) continue;
      if (!MotaLab.isFiniteInteger(raw.x) || !MotaLab.isFiniteInteger(raw.y)
        || raw.x < 0 || raw.x >= MotaLab.MAP_WIDTH
        || raw.y < 0 || raw.y >= MotaLab.MAP_HEIGHT) {
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
      if (isEnemy && (!MotaLab.isFiniteInteger(raw.damage) || raw.damage < 0)) {
        issue = {
          pause_kind: "UNKNOWN_DAMAGE",
          detail_code: raw.damage === null || raw.damage === undefined || raw.damage === "???"
            ? "DAMAGE_NULL" : "DAMAGE_UNEXPLAINED",
        };
      }
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
      dimensions: { width: MotaLab.MAP_WIDTH, height: MotaLab.MAP_HEIGHT },
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
    if (collectionIssues.length) {
      const primary = collectionIssues[0];
      const error = MotaLab.createPauseError(
        primary.pause_kind,
        primary.detail_code,
        {
          block: primary.block,
          field: primary.field || null,
          collection_issues: collectionIssues,
        },
      );
      error.observation = observation;
      throw error;
    }
    return observation;
  };

  // Source: games/mota-planning-lab/src/block-registry.js

  MotaLab.blockSignature = function blockSignature(block) {
    return `${block.id || ""}|${block.cls || ""}|${block.trigger || ""}`;
  };

  MotaLab.createBlockRegistry = function createBlockRegistry(initialEntries = []) {
    const entries = new Map();

    function normalizeEntry(entry) {
      if (!entry || typeof entry !== "object") throw new TypeError("Invalid registry entry");
      if (typeof entry.id !== "string" || entry.id.length === 0) throw new TypeError("Invalid block id");
      if (typeof entry.cls !== "string" || entry.cls.length === 0) throw new TypeError("Invalid block cls");
      if (typeof entry.trigger !== "string" && entry.trigger !== null) throw new TypeError("Invalid trigger");
      if (!MotaLab.BLOCK_CATEGORIES.includes(entry.category)) throw new TypeError("Invalid block category");
      const boundary = MotaLab.BOUNDARY_CATEGORIES.has(entry.category) || entry.boundary === true;
      const passable = entry.category === "wall" ? false : entry.passable === true;
      return {
        id: entry.id,
        cls: entry.cls,
        trigger: entry.trigger,
        category: entry.category,
        passable,
        boundary,
        fast_path: entry.fast_path === true && !boundary,
        version: MotaLab.isFiniteInteger(entry.version) ? entry.version : 1,
      };
    }

    function merge(newEntries) {
      if (!Array.isArray(newEntries)) return;
      for (const raw of newEntries) {
        const entry = normalizeEntry(raw);
        entries.set(MotaLab.blockSignature(entry), entry);
      }
    }

    function replace(newEntries) {
      entries.clear();
      merge(newEntries);
    }

    function get(block) {
      return entries.get(MotaLab.blockSignature(block)) || null;
    }

    function unknownBlocks(observation) {
      return observation.blocks.filter((block) => !get(block));
    }

    function exportEntries() {
      return Array.from(entries.values()).map((entry) => Object.assign({}, entry));
    }

    merge(initialEntries);
    return Object.freeze({ merge, replace, get, unknownBlocks, exportEntries });
  };

  // Source: games/mota-planning-lab/src/protocol.js

  MotaLab.cloneObservationForWire = function cloneObservationForWire(observation) {
    return {
      protocol: observation.protocol,
      page: observation.page,
      floor_id: observation.floor_id,
      floor_name: observation.floor_name,
      floor_number: observation.floor_number,
      dimensions: {
        width: observation.dimensions.width,
        height: observation.dimensions.height,
      },
      hero: {
        hp: observation.hero.hp,
        attack: observation.hero.attack,
        defense: observation.hero.defense,
        gold: observation.hero.gold,
        experience: observation.hero.experience,
        loc: {
          x: observation.hero.loc.x,
          y: observation.hero.loc.y,
          direction: observation.hero.loc.direction,
        },
      },
      keys: {
        yellow: observation.keys.yellow,
        blue: observation.keys.blue,
        red: observation.keys.red,
      },
      busy: observation.busy,
      blocks: observation.blocks.map((block) => ({
        x: block.x,
        y: block.y,
        numeric_id: block.numeric_id,
        id: block.id,
        cls: block.cls,
        trigger: block.trigger,
        no_pass: block.no_pass,
        damage: block.damage,
        enemy: block.enemy ? {
          hp: block.enemy.hp,
          attack: block.enemy.attack,
          defense: block.enemy.defense,
          gold: block.enemy.gold,
          experience: block.enemy.experience,
          special: block.enemy.special.slice(),
        } : null,
      })),
      captured_at: observation.captured_at,
    };
  };

  MotaLab.createCycleRequest = function createCycleRequest({
    observation,
    completedActionId = null,
    recovery = null,
  }) {
    const recoveryValue = recovery || {
      phase: "none",
      pending_action_id: null,
      pre_fingerprint: null,
      current_fingerprint: null,
    };
    const allowedPhases = new Set(["none", "pending", "not_executed", "completed", "mismatch"]);
    if (!allowedPhases.has(recoveryValue.phase)) throw new TypeError("Invalid recovery phase");
    return {
      source: MotaLab.SOURCE,
      completed_action_id: completedActionId,
      observation: MotaLab.cloneObservationForWire(observation),
      recovery: {
        phase: recoveryValue.phase,
        pending_action_id: recoveryValue.pending_action_id || null,
        pre_fingerprint: recoveryValue.pre_fingerprint || null,
        current_fingerprint: recoveryValue.current_fingerprint || null,
        detail_code: recoveryValue.detail_code || null,
      },
    };
  };

  MotaLab.validateActionId = function validateActionId(value) {
    return typeof value === "string" && /^AUTO-[A-F0-9]{16}$/.test(value);
  };

  MotaLab.isProtocolObject = function isProtocolObject(value) {
    return Boolean(value && Object.prototype.toString.call(value) === "[object Object]");
  };

  MotaLab.assertProtocolShape = function assertProtocolShape(value, required, optional, label) {
    if (!MotaLab.isProtocolObject(value)) throw new TypeError(`${label} must be an object`);
    const allowed = new Set(required.concat(optional));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new TypeError(`${label} has extra field: ${key}`);
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new TypeError(`${label} is missing field: ${key}`);
      }
    }
  };

  MotaLab.validateProtocolString = function validateProtocolString(value, label, minimum, maximum) {
    if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
      throw new TypeError(`Invalid ${label}`);
    }
    return value;
  };

  MotaLab.validateResponseKeys = function validateResponseKeys(value, label, allowDeltas = false) {
    MotaLab.assertProtocolShape(value, allowDeltas ? [] : ["yellow", "blue", "red"],
      allowDeltas ? ["yellow", "blue", "red"] : [], label);
    for (const color of ["yellow", "blue", "red"]) {
      if (allowDeltas && value[color] === undefined) continue;
      if (!MotaLab.isFiniteInteger(value[color]) || (!allowDeltas && value[color] < 0)) {
        throw new TypeError(`Invalid ${label}.${color}`);
      }
    }
    return {
      yellow: value.yellow,
      blue: value.blue,
      red: value.red,
    };
  };

  MotaLab.validateResponsePosition = function validateResponsePosition(value, label, withDirection) {
    MotaLab.assertProtocolShape(
      value,
      withDirection ? ["x", "y", "direction"] : ["x", "y"],
      [],
      label,
    );
    if (!MotaLab.isFiniteInteger(value.x) || !MotaLab.isFiniteInteger(value.y)
      || value.x < 0 || value.x >= MotaLab.MAP_WIDTH
      || value.y < 0 || value.y >= MotaLab.MAP_HEIGHT) {
      throw new TypeError(`Invalid ${label}`);
    }
    if (withDirection && !["up", "down", "left", "right"].includes(value.direction)) {
      throw new TypeError(`Invalid ${label}.direction`);
    }
    const result = { x: value.x, y: value.y };
    if (withDirection) result.direction = value.direction;
    return result;
  };

  MotaLab.validateResponseGuard = function validateResponseGuard(value) {
    MotaLab.assertProtocolShape(value, [
      "floor_id", "floor", "position", "hp", "attack", "defense", "gold", "experience", "keys",
    ], [], "guard");
    MotaLab.validateProtocolString(value.floor_id, "guard.floor_id", 1, 256);
    if (value.floor !== null && !MotaLab.isFiniteInteger(value.floor)) {
      throw new TypeError("Invalid guard.floor");
    }
    for (const field of ["hp", "attack", "defense", "gold", "experience"]) {
      if (!MotaLab.isFiniteInteger(value[field]) || value[field] < 0) {
        throw new TypeError(`Invalid guard.${field}`);
      }
    }
    return {
      floor_id: value.floor_id,
      floor: value.floor,
      position: MotaLab.validateResponsePosition(value.position, "guard.position", true),
      hp: value.hp,
      attack: value.attack,
      defense: value.defense,
      gold: value.gold,
      experience: value.experience,
      keys: MotaLab.validateResponseKeys(value.keys, "guard.keys"),
    };
  };

  MotaLab.validateOperation = function validateOperation(operation) {
    MotaLab.assertProtocolShape(operation, ["type", "x", "y"], [], "operation");
    if (operation.type !== "grid") {
      throw new TypeError("Only grid operations are supported");
    }
    if (!MotaLab.isFiniteInteger(operation.x) || !MotaLab.isFiniteInteger(operation.y)
      || operation.x < 0 || operation.x >= MotaLab.MAP_WIDTH
      || operation.y < 0 || operation.y >= MotaLab.MAP_HEIGHT) {
      throw new TypeError("Grid target is out of bounds");
    }
    return { type: "grid", x: operation.x, y: operation.y };
  };

  MotaLab.validateRegistryEntries = function validateRegistryEntries(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 121) throw new TypeError("Invalid registry entries");
    return value.map((entry) => {
      MotaLab.assertProtocolShape(entry, [
        "id", "cls", "trigger", "category", "passable", "boundary", "fast_path", "version",
      ], [], "registry entry");
      MotaLab.validateProtocolString(entry.id, "registry entry id", 1, 256);
      MotaLab.validateProtocolString(entry.cls, "registry entry cls", 1, 256);
      if (entry.trigger !== null
        && (typeof entry.trigger !== "string" || entry.trigger.length > 128)) {
        throw new TypeError("Invalid registry entry trigger");
      }
      if (!MotaLab.BLOCK_CATEGORIES.includes(entry.category)) {
        throw new TypeError("Invalid block category");
      }
      for (const field of ["passable", "boundary", "fast_path"]) {
        if (typeof entry[field] !== "boolean") throw new TypeError(`Invalid registry entry ${field}`);
      }
      if (!MotaLab.isFiniteInteger(entry.version) || entry.version < 1) {
        throw new TypeError("Invalid registry entry version");
      }
      return {
        id: entry.id,
        cls: entry.cls,
        trigger: entry.trigger,
        category: entry.category,
        passable: entry.passable,
        boundary: entry.boundary,
        fast_path: entry.fast_path,
        version: entry.version,
      };
    });
  };

  MotaLab.validateCycleResponse = function validateCycleResponse(value) {
    if (!MotaLab.isProtocolObject(value)) {
      throw new TypeError("Response must be an object");
    }
    if (!new Set(["execute", "pause", "idle", "error"]).has(value.status)) {
      throw new TypeError("Unsupported response status");
    }
    if (value.status === "pause") {
      MotaLab.assertProtocolShape(value,
        ["status", "pause_kind", "detail_code", "reason", "details"],
        ["evidence_path", "registry_entries"], "pause response");
      if (!MotaLab.PAUSE_KIND_SET.has(value.pause_kind)) throw new TypeError("Invalid pause_kind");
      if (typeof value.detail_code !== "string" || !/^[A-Z][A-Z0-9_]{2,95}$/.test(value.detail_code)
        || typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 512
        || !MotaLab.isProtocolObject(value.details)
        || (value.evidence_path !== undefined && typeof value.evidence_path !== "string")) {
        throw new TypeError("Invalid pause response");
      }
      return {
        status: "pause",
        pause_kind: value.pause_kind,
        detail_code: value.detail_code,
        reason: value.reason,
        details: MotaLab.cloneJsonValue(value.details),
        evidence_path: value.evidence_path,
        registry_entries: MotaLab.validateRegistryEntries(value.registry_entries),
      };
    }
    if (value.status === "idle") {
      MotaLab.assertProtocolShape(value, ["status", "reason"], ["registry_entries"], "idle response");
      if (typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 512) {
        throw new TypeError("Invalid idle response");
      }
      return {
        status: "idle",
        reason: value.reason,
        registry_entries: MotaLab.validateRegistryEntries(value.registry_entries),
      };
    }
    if (value.status === "error") {
      MotaLab.assertProtocolShape(value, ["status", "error_code", "reason"], ["errors"], "error response");
      MotaLab.validateProtocolString(value.error_code, "error_code", 1, 128);
      if (typeof value.reason !== "string" || value.reason.length > 1000) {
        throw new TypeError("Invalid error reason");
      }
      if (value.errors !== undefined && (!Array.isArray(value.errors)
        || value.errors.some((entry) => !MotaLab.isProtocolObject(entry)))) {
        throw new TypeError("Invalid error details");
      }
      return {
        status: "error",
        error_code: value.error_code,
        reason: value.reason,
        errors: (value.errors || []).map(MotaLab.cloneJsonValue),
      };
    }

    MotaLab.assertProtocolShape(value, [
      "status", "action_id", "action_kind", "reason", "operations", "guard", "expected_delta",
    ], ["supersedes_action_id", "registry_entries"], "execute response");
    if (!MotaLab.validateActionId(value.action_id)) throw new TypeError("Invalid action_id");
    if (typeof value.action_kind !== "string"
      || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value.action_kind)) {
      throw new TypeError("Invalid action_kind");
    }
    if (typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 512) {
      throw new TypeError("Invalid action reason");
    }
    if (!Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 2) {
      throw new TypeError("Invalid operations");
    }
    if (!MotaLab.isProtocolObject(value.expected_delta)
      || Object.keys(value.expected_delta).length < 1) {
      throw new TypeError("Missing expected_delta");
    }
    MotaLab.validateExpectedDelta(value.expected_delta, { allowUnknownFloor: true });
    if (value.supersedes_action_id !== undefined && value.supersedes_action_id !== null
      && !MotaLab.validateActionId(value.supersedes_action_id)) {
      throw new TypeError("Invalid supersedes_action_id");
    }
    return {
      status: "execute",
      action_id: value.action_id,
      action_kind: value.action_kind,
      operations: value.operations.map(MotaLab.validateOperation),
      guard: MotaLab.validateResponseGuard(value.guard),
      expected_delta: MotaLab.cloneJsonValue(value.expected_delta),
      reason: value.reason,
      supersedes_action_id: MotaLab.validateActionId(value.supersedes_action_id)
        ? value.supersedes_action_id : null,
      registry_entries: MotaLab.validateRegistryEntries(value.registry_entries),
    };
  };

  // Source: games/mota-planning-lab/src/fingerprint.js

  MotaLab.canonicalize = function canonicalize(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
      return JSON.stringify(value);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("Cannot hash non-finite number");
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(MotaLab.canonicalize).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => (
        `${JSON.stringify(key)}:${MotaLab.canonicalize(value[key])}`
      )).join(",")}}`;
    }
    throw new TypeError("Cannot hash unsupported value");
  };

  MotaLab.sha256 = function sha256(input) {
    const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
    const maxWord = 2 ** 32;
    const words = [];
    const hash = [];
    const constants = [];
    const isComposite = {};
    let primeCounter = 0;

    for (let candidate = 2; primeCounter < 64; candidate += 1) {
      if (isComposite[candidate]) continue;
      for (let multiple = candidate * candidate; multiple < 313; multiple += candidate) {
        isComposite[multiple] = true;
      }
      hash[primeCounter] = (Math.sqrt(candidate) * maxWord) | 0;
      constants[primeCounter] = (candidate ** (1 / 3) * maxWord) | 0;
      primeCounter += 1;
    }

    const bytes = unescape(encodeURIComponent(input));
    const bitLength = bytes.length * 8;
    let message = `${bytes}\x80`;
    while ((message.length % 64) !== 56) message += "\x00";
    for (let i = 0; i < message.length; i += 1) {
      words[i >> 2] |= message.charCodeAt(i) << ((3 - (i % 4)) * 8);
    }
    words.push((bitLength / maxWord) | 0);
    words.push(bitLength | 0);

    for (let blockStart = 0; blockStart < words.length; blockStart += 16) {
      const schedule = words.slice(blockStart, blockStart + 16);
      const oldHash = hash.slice(0, 8);
      let working = oldHash.slice();
      for (let i = 0; i < 64; i += 1) {
        const w15 = schedule[i - 15];
        const w2 = schedule[i - 2];
        const scheduleWord = i < 16 ? schedule[i] : (
          schedule[i - 16]
          + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
          + schedule[i - 7]
          + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
        ) | 0;
        schedule[i] = scheduleWord;
        const e = working[4];
        const a = working[0];
        const temp1 = (working[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & working[5]) ^ ((~e) & working[6]))
          + constants[i] + scheduleWord) | 0;
        const temp2 = ((rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & working[1]) ^ (a & working[2]) ^ (working[1] & working[2]))) | 0;
        working = [(temp1 + temp2) | 0, working[0], working[1], working[2],
          (working[3] + temp1) | 0, working[4], working[5], working[6]];
      }
      for (let i = 0; i < 8; i += 1) hash[i] = (oldHash[i] + working[i]) | 0;
    }
    return hash.slice(0, 8).map((value) => (`00000000${(value >>> 0).toString(16)}`).slice(-8)).join("");
  };

  MotaLab.fingerprintProjection = function fingerprintProjection(observation) {
    return {
      floor_id: observation.floor_id,
      hero: {
        hp: observation.hero.hp,
        attack: observation.hero.attack,
        defense: observation.hero.defense,
        gold: observation.hero.gold,
        experience: observation.hero.experience,
        loc: {
          x: observation.hero.loc.x,
          y: observation.hero.loc.y,
          direction: observation.hero.loc.direction,
        },
      },
      keys: {
        yellow: observation.keys.yellow,
        blue: observation.keys.blue,
        red: observation.keys.red,
      },
      blocks: observation.blocks.map((block) => ({
        x: block.x,
        y: block.y,
        numeric_id: block.numeric_id,
        id: block.id,
        cls: block.cls,
        trigger: block.trigger,
        no_pass: block.no_pass,
        damage: block.damage,
        enemy: block.enemy,
      })).sort((a, b) => a.y - b.y || a.x - b.x
        || a.numeric_id - b.numeric_id || a.id.localeCompare(b.id)),
    };
  };

  MotaLab.fingerprintObservation = function fingerprintObservation(observation) {
    return `sha256:${MotaLab.sha256(MotaLab.canonicalize(MotaLab.fingerprintProjection(observation)))}`;
  };

  // Source: games/mota-planning-lab/src/guard.js

  MotaLab.compareGuard = function compareGuard(observation, guard) {
    const differences = [];
    function compare(field, expected, actual, required = true) {
      if (!required) return;
      if (expected !== actual) differences.push({ field, expected, actual });
    }

    if (guard.floor_id !== undefined) compare("floor_id", String(guard.floor_id), observation.floor_id);
    else if (guard.floor !== undefined) {
      if (typeof guard.floor === "number") compare("floor", guard.floor, observation.floor_number);
      else compare("floor", String(guard.floor), observation.floor_id);
    } else differences.push({ field: "floor_id", expected: "required", actual: null });

    const position = guard.position || guard.loc;
    if (!position || typeof position !== "object") {
      differences.push({ field: "position", expected: "required", actual: null });
    } else {
      compare("position.x", position.x, observation.hero.loc.x);
      compare("position.y", position.y, observation.hero.loc.y);
      compare("position.direction", position.direction, observation.hero.loc.direction,
        position.direction !== undefined);
    }

    for (const field of ["hp", "attack", "defense", "gold", "experience"]) {
      compare(field, guard[field], observation.hero[field], guard[field] !== undefined);
      if (guard[field] === undefined) differences.push({ field, expected: "required", actual: observation.hero[field] });
    }

    if (!guard.keys || typeof guard.keys !== "object") {
      differences.push({ field: "keys", expected: "required", actual: null });
    } else {
      for (const color of ["yellow", "blue", "red"]) {
        compare(`keys.${color}`, guard.keys[color], observation.keys[color], guard.keys[color] !== undefined);
        if (guard.keys[color] === undefined) {
          differences.push({ field: `keys.${color}`, expected: "required", actual: observation.keys[color] });
        }
      }
    }
    return { ok: differences.length === 0, differences };
  };

  MotaLab.compareInitialBaseline = function compareInitialBaseline(observation) {
    const baseline = MotaLab.INITIAL_BASELINE;
    const guard = {
      floor: baseline.floor_number,
      position: baseline.hero.loc,
      hp: baseline.hero.hp,
      attack: baseline.hero.attack,
      defense: baseline.hero.defense,
      gold: baseline.hero.gold,
      experience: baseline.hero.experience,
      keys: baseline.keys,
    };
    return MotaLab.compareGuard(observation, guard);
  };

  // Source: games/mota-planning-lab/src/delta.js

  MotaLab.validateExpectedDelta = function validateExpectedDelta(expected, options = {}) {
    if (!MotaLab.isProtocolObject(expected)) {
      throw new TypeError("expected_delta must be an object");
    }
    const allowed = new Set([
      "hp", "attack", "defense", "gold", "experience", "keys",
      "position", "floor_id", "removed_blocks", "added_blocks",
    ]);
    for (const key of Object.keys(expected)) {
      if (!allowed.has(key)) throw new TypeError(`Unsupported expected_delta field: ${key}`);
    }
    for (const field of ["hp", "attack", "defense", "gold", "experience"]) {
      if (expected[field] !== undefined && !MotaLab.isFiniteInteger(expected[field])) {
        throw new TypeError(`Invalid expected delta: ${field}`);
      }
    }
    if (expected.keys !== undefined) {
      if (!MotaLab.isProtocolObject(expected.keys)) throw new TypeError("Invalid key deltas");
      for (const key of Object.keys(expected.keys)) {
        if (!["yellow", "blue", "red"].includes(key)) throw new TypeError(`Invalid key delta: ${key}`);
      }
      for (const color of ["yellow", "blue", "red"]) {
        if (expected.keys[color] !== undefined && !MotaLab.isFiniteInteger(expected.keys[color])) {
          throw new TypeError(`Invalid key delta: ${color}`);
        }
      }
    }
    if (expected.position !== undefined) {
      MotaLab.validateResponsePosition(expected.position, "expected_delta.position", false);
    }
    if (expected.floor_id !== undefined) {
      if (expected.floor_id === null) {
        if (options.allowUnknownFloor !== true) throw new TypeError("Unknown floor_id is only allowed for stairs");
      } else if (typeof expected.floor_id !== "string"
        || expected.floor_id.length < 1 || expected.floor_id.length > 256) {
        throw new TypeError("Invalid expected floor_id");
      }
    }
    for (const field of ["removed_blocks", "added_blocks"]) {
      if (expected[field] !== undefined && !Array.isArray(expected[field])) {
        throw new TypeError(`Invalid ${field}`);
      }
      if ((expected[field] || []).length > MotaLab.MAP_WIDTH * MotaLab.MAP_HEIGHT) {
        throw new TypeError(`Invalid ${field}`);
      }
      for (const block of expected[field] || []) {
        MotaLab.assertProtocolShape(
          block,
          ["x", "y", "id"],
          ["cls", "trigger", "numeric_id"],
          `${field} block reference`,
        );
        if (!MotaLab.isFiniteInteger(block.x) || !MotaLab.isFiniteInteger(block.y)
          || block.x < 0 || block.x >= MotaLab.MAP_WIDTH
          || block.y < 0 || block.y >= MotaLab.MAP_HEIGHT
          || typeof block.id !== "string" || block.id.length === 0 || block.id.length > 256
          || (block.cls !== undefined
            && (typeof block.cls !== "string" || block.cls.length === 0 || block.cls.length > 256))
          || (block.trigger !== undefined && block.trigger !== null
            && (typeof block.trigger !== "string" || block.trigger.length > 128))
          || (block.numeric_id !== undefined
            && (!MotaLab.isFiniteInteger(block.numeric_id) || block.numeric_id < 0))) {
          throw new TypeError(`Invalid ${field} block reference`);
        }
      }
    }
    return expected;
  };

  MotaLab.blockRefMatches = function blockRefMatches(reference, actual) {
    for (const field of ["x", "y", "id", "cls", "trigger", "numeric_id"]) {
      if (Object.prototype.hasOwnProperty.call(reference, field) && reference[field] !== actual[field]) {
        return false;
      }
    }
    return true;
  };

  MotaLab.compareBlockRefs = function compareBlockRefs(references, actualBlocks) {
    if (references.length !== actualBlocks.length) return false;
    const remaining = actualBlocks.slice();
    for (const reference of references) {
      const index = remaining.findIndex((block) => MotaLab.blockRefMatches(reference, block));
      if (index < 0) return false;
      remaining.splice(index, 1);
    }
    return remaining.length === 0;
  };

  MotaLab.compareExpectedDelta = function compareExpectedDelta(before, after, expected, options = {}) {
    MotaLab.validateExpectedDelta(expected, options);
    const differences = [];
    function compare(field, expectedValue, actualValue) {
      if (expectedValue !== actualValue) differences.push({ field, expected: expectedValue, actual: actualValue });
    }

    for (const field of ["hp", "attack", "defense", "gold", "experience"]) {
      const delta = expected[field] === undefined ? 0 : expected[field];
      compare(field, before.hero[field] + delta, after.hero[field]);
    }
    for (const color of ["yellow", "blue", "red"]) {
      const delta = expected.keys && expected.keys[color] !== undefined ? expected.keys[color] : 0;
      compare(`keys.${color}`, before.keys[color] + delta, after.keys[color]);
    }

    if (expected.floor_id === null && options.allowUnknownFloor === true) {
      if (after.floor_id === before.floor_id) {
        differences.push({ field: "floor_id", expected: `different from ${before.floor_id}`, actual: after.floor_id });
      }
    } else if (expected.floor_id !== undefined) compare("floor_id", String(expected.floor_id), after.floor_id);
    else compare("floor_id", before.floor_id, after.floor_id);

    if (expected.position !== undefined) {
      compare("position.x", expected.position.x, after.hero.loc.x);
      compare("position.y", expected.position.y, after.hero.loc.y);
      if (expected.position.direction !== undefined) {
        compare("position.direction", expected.position.direction, after.hero.loc.direction);
      }
    } else if (!options.allowPositionChange) {
      compare("position.x", before.hero.loc.x, after.hero.loc.x);
      compare("position.y", before.hero.loc.y, after.hero.loc.y);
    }

    const floorChanged = before.floor_id !== after.floor_id;
    const beforeByCoordinate = new Map(before.blocks.map((block) => [`${block.x},${block.y}`, block]));
    const afterByCoordinate = new Map(after.blocks.map((block) => [`${block.x},${block.y}`, block]));
    const coordinates = new Set([...beforeByCoordinate.keys(), ...afterByCoordinate.keys()]);
    const removed = [];
    const added = [];
    for (const coordinate of coordinates) {
      const beforeBlock = beforeByCoordinate.get(coordinate);
      const afterBlock = afterByCoordinate.get(coordinate);
      if (beforeBlock && afterBlock
        && MotaLab.canonicalize(beforeBlock) === MotaLab.canonicalize(afterBlock)) continue;
      if (beforeBlock) removed.push(beforeBlock);
      if (afterBlock) added.push(afterBlock);
    }
    const expectedRemoved = expected.removed_blocks || [];
    const expectedAdded = expected.added_blocks || [];
    if ((!floorChanged || expected.removed_blocks !== undefined)
      && !MotaLab.compareBlockRefs(expectedRemoved, removed)) {
      differences.push({ field: "removed_blocks", expected: expectedRemoved, actual: removed });
    }
    if ((!floorChanged || expected.added_blocks !== undefined)
      && !MotaLab.compareBlockRefs(expectedAdded, added)) {
      differences.push({ field: "added_blocks", expected: expectedAdded, actual: added });
    }

    return { ok: differences.length === 0, differences, actual: { removed, added } };
  };

  MotaLab.stateChangedBeyondPosition = function stateChangedBeyondPosition(before, after) {
    const copy = (observation) => {
      const projected = MotaLab.fingerprintProjection(observation);
      projected.hero.loc = { x: 0, y: 0, direction: null };
      return MotaLab.canonicalize(projected);
    };
    return copy(before) !== copy(after);
  };

  MotaLab.hasVerifiableNonPositionPostcondition = function hasVerifiableNonPositionPostcondition(
    expected,
  ) {
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
    for (const field of ["hp", "attack", "defense", "gold", "experience"]) {
      if (MotaLab.isFiniteInteger(expected[field]) && expected[field] !== 0) return true;
    }
    if (expected.keys && typeof expected.keys === "object" && !Array.isArray(expected.keys)) {
      for (const color of ["yellow", "blue", "red"]) {
        if (MotaLab.isFiniteInteger(expected.keys[color]) && expected.keys[color] !== 0) return true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(expected, "floor_id")) return true;
    return ["removed_blocks", "added_blocks"].some(
      (field) => Array.isArray(expected[field]) && expected[field].length > 0,
    );
  };

  MotaLab.validateActionPostconditions = function validateActionPostconditions(plan, expected) {
    if (!Array.isArray(plan) || plan.length === 0) throw new TypeError("Action plan is empty");
    const finalStep = plan[plan.length - 1];
    if (finalStep.boundary) {
      if (!MotaLab.hasVerifiableNonPositionPostcondition(expected)) {
        throw new TypeError("Boundary action requires a verifiable non-position postcondition");
      }
      if (["enemy", "door", "resource"].includes(finalStep.category)) {
        const target = finalStep.target_block;
        const targetRemovalDeclared = Boolean(target && Array.isArray(expected.removed_blocks)
          && expected.removed_blocks.some((reference) => (
            reference.x === target.x && reference.y === target.y && reference.id === target.id
          )));
        if (!targetRemovalDeclared) {
          throw new TypeError(`${finalStep.category} boundary must declare target block removal`);
        }
      }
      if (finalStep.category === "stair"
        && !Object.prototype.hasOwnProperty.call(expected, "floor_id")) {
        throw new TypeError("Stair boundary must declare floor_id");
      }
      return { requires_non_position_change: true };
    }
    const finalTarget = finalStep.operation;
    if (!expected.position
      || expected.position.x !== finalTarget.x || expected.position.y !== finalTarget.y) {
      throw new TypeError("Pure corridor action must declare its final position");
    }
    if (MotaLab.hasVerifiableNonPositionPostcondition(expected)) {
      throw new TypeError("Pure corridor action cannot declare a state-changing postcondition");
    }
    return { requires_non_position_change: false };
  };

  // Source: games/mota-planning-lab/src/stability.js

  MotaLab.waitForStability = async function waitForStability({
    adapter,
    observe,
    preFingerprint,
    pollMs = 100,
    stablePolls = 2,
    timeoutMs = 30000,
    now = Date.now,
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  }) {
    const startedAt = now();
    let lastFingerprint = null;
    let consecutive = 0;
    let latestObservation = null;

    while (now() - startedAt <= timeoutMs) {
      latestObservation = observe();
      const fingerprint = MotaLab.fingerprintObservation(latestObservation);
      if (!latestObservation.busy && fingerprint !== preFingerprint) {
        consecutive = fingerprint === lastFingerprint ? consecutive + 1 : 1;
        lastFingerprint = fingerprint;
        if (consecutive >= stablePolls) {
          return { observation: latestObservation, fingerprint, polls: consecutive };
        }
      } else {
        consecutive = 0;
        lastFingerprint = fingerprint;
      }
      await sleep(pollMs);
    }

    const busy = adapter.readBusy();
    if (busy.event_active || busy.lock_control) {
      throw MotaLab.createPauseError(
        "UNSUPPORTED_INTERACTION",
        "INTERACTION_STABILITY_TIMEOUT",
        { busy, observation: latestObservation },
      );
    }
    throw MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE",
      "STABILITY_TIMEOUT",
      { busy, observation: latestObservation },
    );
  };

  // Source: games/mota-planning-lab/src/executor.js

  MotaLab.coordinateKey = function coordinateKey(x, y) {
    return `${x},${y}`;
  };

  MotaLab.buildBlockIndex = function buildBlockIndex(observation) {
    return new Map(observation.blocks.map((block) => [MotaLab.coordinateKey(block.x, block.y), block]));
  };

  MotaLab.findSafePath = function findSafePath(observation, registry, start, target, allowBoundaryTarget) {
    const blockIndex = MotaLab.buildBlockIndex(observation);
    const startKey = MotaLab.coordinateKey(start.x, start.y);
    const targetKey = MotaLab.coordinateKey(target.x, target.y);
    const queue = [{ x: start.x, y: start.y }];
    const previous = new Map([[startKey, null]]);

    function cellAllowed(x, y) {
      const block = blockIndex.get(MotaLab.coordinateKey(x, y));
      if (!block) return true;
      const entry = registry.get(block);
      if (!entry) return false;
      const isTarget = x === target.x && y === target.y;
      if (entry.boundary) return isTarget && allowBoundaryTarget;
      if (block.no_pass) return false;
      return entry.passable;
    }

    while (queue.length) {
      const current = queue.shift();
      const currentKey = MotaLab.coordinateKey(current.x, current.y);
      if (currentKey === targetKey) break;
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const x = current.x + dx;
        const y = current.y + dy;
        const key = MotaLab.coordinateKey(x, y);
        if (x < 0 || y < 0 || x >= MotaLab.MAP_WIDTH || y >= MotaLab.MAP_HEIGHT
          || previous.has(key) || !cellAllowed(x, y)) continue;
        previous.set(key, currentKey);
        queue.push({ x, y });
      }
    }
    if (!previous.has(targetKey)) return null;
    const path = [];
    let cursor = targetKey;
    while (cursor !== null) {
      const [x, y] = cursor.split(",").map(Number);
      path.push({ x, y });
      cursor = previous.get(cursor);
    }
    path.reverse();
    return path;
  };

  MotaLab.isPureCorridorPath = function isPureCorridorPath(path, observation, registry) {
    if (!path) return false;
    const blockIndex = MotaLab.buildBlockIndex(observation);
    return path.slice(1).every(({ x, y }) => {
      const block = blockIndex.get(MotaLab.coordinateKey(x, y));
      if (!block) return true;
      const entry = registry.get(block);
      return Boolean(entry && entry.passable && entry.fast_path && !entry.boundary && !block.no_pass);
    });
  };

  MotaLab.planOperations = function planOperations(action, observation, registry, adapter) {
    if (!action || !Array.isArray(action.operations) || action.operations.length === 0) {
      throw new TypeError("Action has no operations");
    }
    const blockIndex = MotaLab.buildBlockIndex(observation);
    let start = { x: observation.hero.loc.x, y: observation.hero.loc.y };
    const plan = [];
    let totalBoundaries = 0;

    action.operations.forEach((operation, index) => {
      const isLast = index === action.operations.length - 1;
      if (operation.x === start.x && operation.y === start.y) {
        throw MotaLab.createPauseError(
          "DECISION_SERVICE_UNAVAILABLE",
          "UNSAFE_ROUTE_RESPONSE",
          { operation_index: index, target: operation, reason: "NO_OP_GRID" },
        );
      }
      const targetBlock = blockIndex.get(MotaLab.coordinateKey(operation.x, operation.y));
      const targetEntry = targetBlock ? registry.get(targetBlock) : null;
      if (targetBlock && !targetEntry) {
        throw MotaLab.createPauseError(
          "NEW_OBJECT_OR_MECHANISM",
          "UNKNOWN_BLOCK",
          { block: MotaLab.blockEvidence(targetBlock) },
        );
      }
      const boundary = Boolean(targetEntry && targetEntry.boundary);
      if (boundary && !isLast) {
        throw MotaLab.createPauseError(
          "DECISION_SERVICE_UNAVAILABLE",
          "UNSAFE_MULTI_BOUNDARY_RESPONSE",
          { operation_index: index, target: operation },
        );
      }
      if (boundary) totalBoundaries += 1;
      const path = MotaLab.findSafePath(observation, registry, start, operation, boundary && isLast);
      if (!path) {
        throw MotaLab.createPauseError(
          "DECISION_SERVICE_UNAVAILABLE",
          "UNSAFE_ROUTE_RESPONSE",
          { operation_index: index, target: operation },
        );
      }
      const pure = MotaLab.isPureCorridorPath(path, observation, registry);
      if (!isLast && !pure) {
        throw MotaLab.createPauseError(
          "DECISION_SERVICE_UNAVAILABLE",
          "UNSAFE_MULTI_BOUNDARY_RESPONSE",
          { operation_index: index, target: operation },
        );
      }
      plan.push({
        operation,
        path,
        boundary,
        pure,
        category: targetEntry ? targetEntry.category : null,
        target_block: targetBlock || null,
      });
      start = { x: operation.x, y: operation.y };
    });

    if (totalBoundaries > 1) {
      throw MotaLab.createPauseError(
        "DECISION_SERVICE_UNAVAILABLE",
        "UNSAFE_MULTI_BOUNDARY_RESPONSE",
        { boundary_count: totalBoundaries },
      );
    }
    return plan;
  };

  MotaLab.executeAction = async function executeAction({
    action,
    initialObservation,
    registry,
    adapter,
    observe,
    stabilityOptions = {},
  }) {
    const guardResult = MotaLab.compareGuard(initialObservation, action.guard);
    if (!guardResult.ok) {
      throw MotaLab.createPauseError(
        "GUARD_MISMATCH",
        "PRE_ACTION_GUARD_MISMATCH",
        { differences: guardResult.differences },
      );
    }
    const plan = MotaLab.planOperations(action, initialObservation, registry, adapter);
    const allowUnknownFloor = action.expected_delta.floor_id === null
      && plan.length > 0 && plan[plan.length - 1].category === "stair";
    MotaLab.validateExpectedDelta(action.expected_delta, { allowUnknownFloor });
    let beforeStep = initialObservation;
    let beforeFingerprint = MotaLab.fingerprintObservation(beforeStep);

    for (let index = 0; index < plan.length; index += 1) {
      const step = plan[index];
      const useDirect = step.pure && !step.boundary
        && adapter.canMoveDirectly(step.operation.x, step.operation.y);
      if (useDirect) adapter.moveDirectly(step.operation.x, step.operation.y);
      else adapter.setAutomaticRoute(step.operation.x, step.operation.y);

      const settled = await MotaLab.waitForStability(Object.assign({
        adapter,
        observe,
        preFingerprint: beforeFingerprint,
      }, stabilityOptions));
      const afterStep = settled.observation;
      const reachedTarget = afterStep.hero.loc.x === step.operation.x
        && afterStep.hero.loc.y === step.operation.y;
      const changedBoundary = MotaLab.stateChangedBeyondPosition(beforeStep, afterStep);

      if (!reachedTarget && !changedBoundary) {
        adapter.stopAutomaticRoute();
        throw MotaLab.createPauseError(
          "EXPECTED_DELTA_MISMATCH",
          "ROUTE_TARGET_NOT_REACHED",
          { operation_index: index, target: step.operation, actual: afterStep.hero.loc },
        );
      }
      if (changedBoundary) {
        adapter.stopAutomaticRoute();
        return {
          observation: afterStep,
          fingerprint: settled.fingerprint,
          plan,
          completed_operations: index + 1,
          boundary_reached: true,
        };
      }
      if (index < plan.length - 1) {
        beforeStep = afterStep;
        beforeFingerprint = settled.fingerprint;
        continue;
      }
      return {
        observation: afterStep,
        fingerprint: settled.fingerprint,
        plan,
        completed_operations: index + 1,
        boundary_reached: step.boundary,
      };
    }
    throw new Error("Unreachable empty execution plan");
  };

  // Source: games/mota-planning-lab/src/journal.js

  MotaLab.createMemoryStorage = function createMemoryStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    return {
      get(key, fallback) {
        return values.has(key) ? values.get(key) : fallback;
      },
      set(key, value) {
        values.set(key, value);
      },
    };
  };

  MotaLab.createJournal = function createJournal(storage) {
    const defaults = () => ({
      protocol: MotaLab.PROTOCOL_VERSION,
      autopilot_enabled: false,
      initial_baseline_verified_fingerprint: null,
      pending_action: null,
      last_completed_action: null,
      last_acknowledged_action_id: null,
      seen_action_ids: {},
      last_pause: null,
      registry_entries: [],
    });

    function read() {
      const stored = storage.get(MotaLab.JOURNAL_KEY, null);
      if (!stored || typeof stored !== "object" || stored.protocol !== MotaLab.PROTOCOL_VERSION) {
        return defaults();
      }
      return Object.assign(defaults(), stored, {
        seen_action_ids: stored.seen_action_ids && typeof stored.seen_action_ids === "object"
          ? Object.assign({}, stored.seen_action_ids) : {},
        registry_entries: Array.isArray(stored.registry_entries) ? stored.registry_entries : [],
      });
    }

    function write(next) {
      storage.set(MotaLab.JOURNAL_KEY, next);
      return next;
    }

    function update(mutator) {
      const state = read();
      mutator(state);
      return write(state);
    }

    return Object.freeze({
      snapshot: read,
      setAutopilot(enabled) {
        return update((state) => { state.autopilot_enabled = enabled === true; });
      },
      verifyBaseline(fingerprint) {
        return update((state) => { state.initial_baseline_verified_fingerprint = fingerprint; });
      },
      setPending(pending) {
        return update((state) => {
          state.pending_action = pending;
          state.seen_action_ids[pending.action_id] = "pending";
        });
      },
      updatePending(fields) {
        return update((state) => {
          if (state.pending_action) Object.assign(state.pending_action, fields);
        });
      },
      abandonPending() {
        return update((state) => {
          if (state.pending_action) state.seen_action_ids[state.pending_action.action_id] = "abandoned";
          state.pending_action = null;
        });
      },
      clearPending() {
        return update((state) => {
          if (state.pending_action) state.seen_action_ids[state.pending_action.action_id] = "cleared";
          state.pending_action = null;
        });
      },
      markCompleted(record) {
        return update((state) => {
          state.last_completed_action = record;
          state.pending_action = null;
          state.seen_action_ids[record.action_id] = "completed";
        });
      },
      acknowledge(actionId) {
        return update((state) => { state.last_acknowledged_action_id = actionId; });
      },
      actionState(actionId) {
        return read().seen_action_ids[actionId] || null;
      },
      setPause(pause) {
        return update((state) => {
          state.last_pause = pause;
          state.autopilot_enabled = false;
        });
      },
      setRegistryEntries(entries) {
        return update((state) => { state.registry_entries = entries; });
      },
    });
  };

  // Source: games/mota-planning-lab/src/recovery.js

  MotaLab.classifyPendingRecovery = function classifyPendingRecovery(pending, observation, fingerprint) {
    if (!pending || !MotaLab.validateActionId(pending.action_id)
      || typeof pending.pre_fingerprint !== "string") {
      return { phase: "mismatch", detail_code: "INVALID_PENDING_JOURNAL" };
    }
    if (fingerprint === pending.pre_fingerprint) {
      return {
        phase: "not_executed",
        pending_action_id: pending.action_id,
        pre_fingerprint: pending.pre_fingerprint,
        current_fingerprint: fingerprint,
        detail_code: pending.rejection_detail_code || null,
      };
    }
    if (!pending.pre_observation || !pending.expected_delta) {
      return { phase: "mismatch", detail_code: "RECOVERY_STATE_AMBIGUOUS" };
    }
    const declaredFields = pending.expected_delta
      && typeof pending.expected_delta === "object" && !Array.isArray(pending.expected_delta)
      ? Object.keys(pending.expected_delta) : [];
    if (declaredFields.length === 0) {
      return { phase: "mismatch", detail_code: "RECOVERY_STATE_AMBIGUOUS" };
    }
    let requiresNonPositionChange = pending.requires_non_position_change === true;
    if (pending.requires_non_position_change === undefined
      && Array.isArray(pending.operations) && pending.operations.length > 0) {
      const target = pending.operations[pending.operations.length - 1];
      const targetBlock = pending.pre_observation.blocks.find(
        (block) => block.x === target.x && block.y === target.y,
      );
      requiresNonPositionChange = Boolean(targetBlock
        && (targetBlock.trigger !== null || targetBlock.enemy !== null || targetBlock.damage !== null));
    }
    if (requiresNonPositionChange
      && !MotaLab.hasVerifiableNonPositionPostcondition(pending.expected_delta)) {
      return { phase: "mismatch", detail_code: "RECOVERY_STATE_AMBIGUOUS" };
    }
    let delta;
    try {
      delta = MotaLab.compareExpectedDelta(
        pending.pre_observation,
        observation,
        pending.expected_delta,
        {
          allowPositionChange: true,
          allowUnknownFloor: pending.allow_unknown_floor === true,
        },
      );
    } catch (error) {
      return { phase: "mismatch", detail_code: "RECOVERY_STATE_AMBIGUOUS", error: error.message };
    }
    if (delta.ok && requiresNonPositionChange
      && !MotaLab.stateChangedBeyondPosition(pending.pre_observation, observation)) {
      return {
        phase: "mismatch",
        detail_code: "RECOVERY_STATE_AMBIGUOUS",
        pending_action_id: pending.action_id,
        pre_fingerprint: pending.pre_fingerprint,
        current_fingerprint: fingerprint,
        differences: [{
          field: "boundary_state_change",
          expected: "non-position state change",
          actual: "position-only change",
        }],
      };
    }
    if (delta.ok) {
      return {
        phase: "completed",
        pending_action_id: pending.action_id,
        pre_fingerprint: pending.pre_fingerprint,
        current_fingerprint: fingerprint,
        delta,
      };
    }
    return {
      phase: "mismatch",
      detail_code: "RECOVERY_STATE_AMBIGUOUS",
      pending_action_id: pending.action_id,
      pre_fingerprint: pending.pre_fingerprint,
      current_fingerprint: fingerprint,
      differences: delta.differences,
    };
  };

  // Source: games/mota-planning-lab/src/localhost-client.js

  MotaLab.createLocalhostClient = function createLocalhostClient(requestImplementation, options = {}) {
    if (typeof requestImplementation !== "function") {
      throw new TypeError("A request implementation is required");
    }
    const timeout = MotaLab.isFiniteInteger(options.timeoutMs) ? options.timeoutMs : 10000;
    let connected = false;

    function serviceError(detailCode, cause) {
      const error = new Error(detailCode);
      error.name = "MotaLabServiceError";
      error.detail_code = detailCode;
      error.cause = cause || null;
      return error;
    }

    function postCycle(payload) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          callback(value);
        };
        try {
          requestImplementation({
            method: "POST",
            url: MotaLab.CYCLE_ENDPOINT,
            headers: {
              "Content-Type": "application/json",
              "X-Mota-Lab": "1",
            },
            data: JSON.stringify(payload),
            timeout,
            onload(response) {
              if (settled) return;
              if (!response || response.status !== 200) {
                connected = false;
                try {
                  const parsedError = MotaLab.validateCycleResponse(JSON.parse(response.responseText));
                  if (parsedError.status !== "error") throw new TypeError("Non-2xx response is not an error envelope");
                  finish(reject, serviceError(parsedError.error_code, parsedError.reason));
                } catch (error) {
                  finish(reject, serviceError("INVALID_RESPONSE", error.message));
                }
                return;
              }
              try {
                const parsed = JSON.parse(response.responseText);
                const validated = MotaLab.validateCycleResponse(parsed);
                connected = true;
                finish(resolve, validated);
              } catch (error) {
                connected = false;
                finish(reject, serviceError("INVALID_RESPONSE", error.message));
              }
            },
            onerror(error) {
              if (settled) return;
              connected = false;
              finish(reject, serviceError("CONNECTION_FAILED", error));
            },
            ontimeout() {
              if (settled) return;
              connected = false;
              finish(reject, serviceError("CONNECTION_TIMEOUT"));
            },
            onabort() {
              if (settled) return;
              connected = false;
              finish(reject, serviceError("CONNECTION_ABORTED"));
            },
          });
        } catch (error) {
          connected = false;
          finish(reject, serviceError("CONNECTION_FAILED", error.message));
        }
      });
    }

    return Object.freeze({ postCycle, isConnected: () => connected });
  };

  // Source: games/mota-planning-lab/src/panel.js

  MotaLab.createPanel = function createPanel(documentObject) {
    const doc = documentObject;
    if (!doc || !doc.body) {
      return Object.freeze({ update() {}, setCollapsed() {} });
    }
    if (!doc.getElementById(MotaLab.STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = MotaLab.STYLE_ID;
      style.textContent = `
        #${MotaLab.PANEL_ID}{position:fixed;right:6px;bottom:6px;z-index:2147483646;width:196px;
        box-sizing:border-box;padding:7px 8px;border:1px solid #52606d;border-radius:7px;
        background:rgba(17,24,39,.94);color:#f3f4f6;font:11px/1.35 system-ui,sans-serif;
        box-shadow:0 4px 16px rgba(0,0,0,.32)}
        #${MotaLab.PANEL_ID}.collapsed{width:auto;max-width:196px}
        #${MotaLab.PANEL_ID} button{border:0;background:transparent;color:#d1d5db;cursor:pointer;padding:0 2px}
        #${MotaLab.PANEL_ID} .ml-head{display:flex;justify-content:space-between;gap:6px;font-weight:700}
        #${MotaLab.PANEL_ID} .ml-body{margin-top:5px;display:grid;grid-template-columns:56px 1fr;gap:2px 5px}
        #${MotaLab.PANEL_ID}.collapsed .ml-body{display:none}
        #${MotaLab.PANEL_ID} .ml-label{color:#9ca3af}
        #${MotaLab.PANEL_ID} .ml-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #${MotaLab.PANEL_ID} .ml-bad{color:#fca5a5}.ml-good{color:#86efac}
      `;
      doc.head.appendChild(style);
    }

    const root = doc.createElement("section");
    root.id = MotaLab.PANEL_ID;
    const head = doc.createElement("div");
    head.className = "ml-head";
    const title = doc.createElement("span");
    title.textContent = "魔塔规划实验室";
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.textContent = "折叠";
    head.append(title, toggle);
    const body = doc.createElement("div");
    body.className = "ml-body";
    const fields = {};
    for (const [key, label] of [
      ["autopilot", "自动驾驶"],
      ["action", "action_id"],
      ["location", "现场"],
      ["reason", "最近决策"],
      ["service", "localhost"],
      ["pause", "暂停原因"],
    ]) {
      const labelNode = doc.createElement("span");
      labelNode.className = "ml-label";
      labelNode.textContent = label;
      const valueNode = doc.createElement("span");
      valueNode.className = "ml-value";
      valueNode.textContent = "—";
      valueNode.title = "";
      fields[key] = valueNode;
      body.append(labelNode, valueNode);
    }
    root.append(head, body);
    doc.body.appendChild(root);

    function setCollapsed(collapsed) {
      root.classList.toggle("collapsed", collapsed === true);
      toggle.textContent = collapsed ? "展开" : "折叠";
    }
    toggle.addEventListener("click", () => setCollapsed(!root.classList.contains("collapsed")));

    function setField(key, value, className) {
      if (value === undefined) return;
      const text = value === null || value === "" ? "—" : String(value);
      fields[key].textContent = text;
      fields[key].title = text;
      fields[key].className = `ml-value${className ? ` ${className}` : ""}`;
    }

    function update(state) {
      setField("autopilot", state.autopilot ? "运行" : "暂停", state.autopilot ? "ml-good" : "");
      setField("action", state.action_id);
      setField("location", state.location);
      setField("reason", state.reason);
      setField("service", state.connected ? "已连接" : "断开", state.connected ? "ml-good" : "ml-bad");
      setField("pause", state.pause_kind, state.pause_kind ? "ml-bad" : "");
    }
    return Object.freeze({ update, setCollapsed, element: root });
  };

  // Source: games/mota-planning-lab/src/menus.js

  MotaLab.downloadObservation = function downloadObservation(observation, environment = {}) {
    const doc = environment.documentObject || document;
    const BlobType = environment.BlobType || Blob;
    const urlApi = environment.urlApi || URL;
    const blob = new BlobType([JSON.stringify(observation, null, 2)], { type: "application/json" });
    const url = urlApi.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = url;
    link.download = `mota-current-floor-${Date.now()}.json`;
    link.style.display = "none";
    doc.body.appendChild(link);
    link.click();
    link.remove();
    urlApi.revokeObjectURL(url);
  };

  MotaLab.registerMenus = function registerMenus({
    register,
    controller,
    confirmAction = (message) => confirm(message),
    exporter = MotaLab.downloadObservation,
  }) {
    const registrations = [
      ["启动自动驾驶", () => controller.start()],
      ["暂停自动驾驶", () => controller.manualPause()],
      ["导出当前层运行态", () => {
        const observation = controller.getCurrentObservation();
        if (observation) exporter(observation);
      }],
      ["清除待执行行动", () => {
        if (confirmAction("只清除浏览器待执行账本，不会改变游戏现场。确定继续？")) {
          controller.clearPending();
        }
      }],
      ["仅重新连接本地决策器", () => controller.reconnectOnly()],
    ];
    for (const [label, handler] of registrations) register(label, handler);
    return registrations.map(([label]) => label);
  };

  // Source: games/mota-planning-lab/src/controller.js

  MotaLab.createController = function createController(dependencies, options = {}) {
    const { adapter, journal, registry, client, panel } = dependencies;
    const observe = dependencies.observe || (() => MotaLab.collectObservation(adapter));
    const logger = dependencies.logger || console;
    const autoSchedule = options.autoSchedule === true;
    const cycleDelayMs = MotaLab.isFiniteInteger(options.cycleDelayMs) ? options.cycleDelayMs : 300;
    const schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
    let state = "STOPPED";
    let currentObservation = null;
    let currentActionId = null;
    let lastReason = "等待首次现场核对";
    let cyclePromise = null;
    let unsafeResponseCount = 0;
    let duplicatePendingCount = 0;

    function locationText(observation) {
      return observation
        ? `${observation.floor_name || observation.floor_id} (${observation.hero.loc.x},${observation.hero.loc.y})`
        : "—";
    }

    function refreshPanel(extra = {}) {
      const snapshot = journal.snapshot();
      panel.update(Object.assign({
        autopilot: snapshot.autopilot_enabled,
        action_id: currentActionId,
        location: locationText(currentObservation),
        reason: lastReason,
        connected: client.isConnected(),
        pause_kind: snapshot.last_pause && !snapshot.autopilot_enabled
          ? snapshot.last_pause.pause_kind : null,
      }, extra));
    }

    function capture() {
      try {
        currentObservation = observe();
        refreshPanel();
        return currentObservation;
      } catch (error) {
        if (error && error.observation) {
          currentObservation = error.observation;
          refreshPanel();
        }
        throw error;
      }
    }

    function pause(pauseKind, detailCode, details = {}, observation = currentObservation) {
      try { adapter.stopAutomaticRoute(); } catch (_) { /* best-effort stop while the runtime is unavailable */ }
      const evidenceBlocks = [];
      if (details.block) evidenceBlocks.push(details.block);
      if (Array.isArray(details.blocks)) evidenceBlocks.push(...details.blocks);
      const record = {
        pause_kind: pauseKind,
        detail_code: detailCode || null,
        action_id: currentActionId,
        captured_at: Date.now(),
        observation: observation ? MotaLab.cloneObservationForWire(observation) : null,
        block_evidence: evidenceBlocks,
        details: MotaLab.cloneJsonValue(details),
      };
      journal.setPause(record);
      state = "PAUSED";
      lastReason = detailCode || pauseKind;
      refreshPanel({ autopilot: false, pause_kind: pauseKind });
      logger.error("[Mota Planning Lab pause]", record);
      return record;
    }

    function handleError(error, fallbackKind = "ENGINE_API_INCOMPATIBLE", fallbackCode = "UNEXPECTED_ERROR") {
      if (MotaLab.isPauseError(error)) {
        return pause(
          error.pause_kind,
          error.detail_code,
          error.details || {},
          error.observation || currentObservation,
        );
      }
      return pause(fallbackKind, fallbackCode, { message: error && error.message ? error.message : String(error) });
    }

    function validateAndReplaceRegistry(entries, observation) {
      const currentSignatures = new Set(observation.blocks.map(MotaLab.blockSignature));
      const unrelated = entries.filter((entry) => !currentSignatures.has(MotaLab.blockSignature(entry)));
      if (unrelated.length) {
        throw MotaLab.createPauseError(
          "DECISION_SERVICE_UNAVAILABLE",
          "REGISTRY_SCOPE_VIOLATION",
          { signatures: unrelated.map(MotaLab.blockSignature) },
        );
      }
      registry.replace(entries);
      journal.setRegistryEntries(registry.exportEntries());
    }

    function scheduleNext(delay = cycleDelayMs) {
      if (!autoSchedule || !journal.snapshot().autopilot_enabled) return;
      schedule(() => { runSingleCycle(); }, delay);
    }

    async function initialize() {
      try {
        state = "PREFLIGHT";
        const observation = capture();
        const fingerprint = MotaLab.fingerprintObservation(observation);
        const snapshot = journal.snapshot();
        if (!snapshot.initial_baseline_verified_fingerprint) {
          const baseline = MotaLab.compareInitialBaseline(observation);
          if (!baseline.ok) {
            return pause(
              "GUARD_MISMATCH",
              "INITIAL_BASELINE_MISMATCH",
              { differences: baseline.differences },
              observation,
            );
          }
          adapter.assertRequiredCapabilities();
          journal.verifyBaseline(fingerprint);
          journal.setAutopilot(false);
          state = "BASELINE_VERIFIED";
          lastReason = "现场核对通过，等待手动启动";
          refreshPanel({ autopilot: false, pause_kind: null });
          return { verified: true, fingerprint, auto_started: false };
        }
        adapter.assertRequiredCapabilities();
        state = "STOPPED";
        lastReason = "已恢复现场，等待或恢复安全循环";
        refreshPanel();
        if (snapshot.autopilot_enabled) scheduleNext(0);
        return { verified: true, fingerprint, auto_started: snapshot.autopilot_enabled };
      } catch (error) {
        return handleError(error);
      }
    }

    async function start() {
      const snapshot = journal.snapshot();
      if (!snapshot.initial_baseline_verified_fingerprint) {
        const result = await initialize();
        if (!result || !result.verified) return result;
      }
      journal.setAutopilot(true);
      state = "OBSERVING";
      lastReason = "用户已启动自动驾驶";
      refreshPanel({ autopilot: true, pause_kind: null });
      return runSingleCycle();
    }

    function manualPause() {
      try { adapter.stopAutomaticRoute(); } catch (_) { /* best-effort stop */ }
      journal.setAutopilot(false);
      state = "STOPPED";
      lastReason = "用户手动暂停";
      refreshPanel({ autopilot: false, pause_kind: null });
      return { stopped: true };
    }

    function clearPending() {
      if (journal.snapshot().autopilot_enabled || cyclePromise || state === "EXECUTING") {
        lastReason = "请先暂停自动驾驶，待当前执行结算后再清除 pending";
        refreshPanel();
        return { cleared: false, reason: "AUTOPILOT_ACTIVE" };
      }
      journal.clearPending();
      currentActionId = null;
      lastReason = "待执行行动已清除；游戏现场未改变";
      refreshPanel();
      return { cleared: true };
    }

    function requestRecovery(snapshot, fingerprint) {
      const pending = snapshot.pending_action;
      if (!pending) {
        return {
          phase: "none",
          pending_action_id: null,
          pre_fingerprint: null,
          current_fingerprint: fingerprint,
        };
      }
      const recovery = MotaLab.classifyPendingRecovery(pending, currentObservation, fingerprint);
      if (recovery.phase === "mismatch") {
        pause("EXPECTED_DELTA_MISMATCH", recovery.detail_code, recovery, currentObservation);
        return null;
      }
      if (recovery.phase === "completed") {
        journal.markCompleted({
          action_id: pending.action_id,
          fingerprint,
          observation: MotaLab.cloneObservationForWire(currentObservation),
          completed_at: Date.now(),
          recovered: true,
        });
      } else {
        journal.updatePending({ phase: "not_executed" });
      }
      return recovery;
    }

    async function cycleBody() {
      if (!journal.snapshot().autopilot_enabled) return { skipped: "disabled" };
      state = "OBSERVING";
      const observation = capture();
      if (observation.busy) {
        return pause("UNSUPPORTED_INTERACTION", "GAME_BUSY_BEFORE_DECISION", {}, observation);
      }
      const fingerprint = MotaLab.fingerprintObservation(observation);
      let snapshot = journal.snapshot();
      const recovery = requestRecovery(snapshot, fingerprint);
      if (!recovery) return { paused: true };
      snapshot = journal.snapshot();
      const completedActionId = snapshot.last_completed_action
        && snapshot.last_acknowledged_action_id !== snapshot.last_completed_action.action_id
        ? snapshot.last_completed_action.action_id : null;
      const request = MotaLab.createCycleRequest({
        observation,
        completedActionId,
        recovery,
      });

      state = "REQUESTING";
      let response;
      try {
        response = await client.postCycle(request);
      } catch (error) {
        return pause(
          "DECISION_SERVICE_UNAVAILABLE",
          error.detail_code || "CONNECTION_FAILED",
          { message: error.message },
          observation,
        );
      }
      if (completedActionId) journal.acknowledge(completedActionId);
      try {
        validateAndReplaceRegistry(response.registry_entries || [], observation);
      } catch (error) {
        return handleError(error, "DECISION_SERVICE_UNAVAILABLE", "INVALID_RESPONSE");
      }

      if (response.status === "pause") {
        lastReason = response.reason;
        return pause(response.pause_kind, response.detail_code, response.details, observation);
      }
      if (response.status === "error") {
        return pause(
          "DECISION_SERVICE_UNAVAILABLE",
          response.error_code,
          { reason: response.reason, errors: response.errors },
          observation,
        );
      }
      if (response.status === "idle") {
        state = "OBSERVING";
        lastReason = response.reason;
        refreshPanel({ connected: true });
        scheduleNext();
        return { idle: true };
      }

      currentActionId = response.action_id;
      lastReason = response.reason;
      refreshPanel({ connected: true, action_id: currentActionId });
      const pending = journal.snapshot().pending_action;
      if (pending) {
        if (response.action_id === pending.action_id) {
          duplicatePendingCount += 1;
          if (duplicatePendingCount >= 2) {
            return pause(
              "DECISION_SERVICE_UNAVAILABLE",
              "DUPLICATE_PENDING_RESPONSE",
              { action_id: response.action_id },
              observation,
            );
          }
          scheduleNext();
          return { duplicate_pending: true, executed: false };
        }
        if (recovery.phase !== "not_executed"
          || response.supersedes_action_id !== pending.action_id) {
          return pause(
            "DECISION_SERVICE_UNAVAILABLE",
            "INVALID_RECOVERY_REISSUE",
            { pending_action_id: pending.action_id, action_id: response.action_id },
            observation,
          );
        }
        if (pending.rejection_detail_code) {
          unsafeResponseCount = Math.max(
            unsafeResponseCount,
            MotaLab.isFiniteInteger(pending.rejection_count) ? pending.rejection_count : 1,
          );
        }
        journal.abandonPending();
        duplicatePendingCount = 0;
      } else if (response.supersedes_action_id) {
        return pause(
          "DECISION_SERVICE_UNAVAILABLE",
          "INVALID_RECOVERY_REISSUE",
          { supersedes_action_id: response.supersedes_action_id },
          observation,
        );
      }

      const actionState = journal.actionState(response.action_id);
      if (actionState === "completed") {
        scheduleNext();
        return { duplicate_completed: true, executed: false };
      }
      if (actionState) {
        return pause(
          "DECISION_SERVICE_UNAVAILABLE",
          "STALE_ACTION_ID",
          { action_id: response.action_id, action_state: actionState },
          observation,
        );
      }

      const unknown = registry.unknownBlocks(observation);
      if (unknown.length) {
        return pause(
          "NEW_OBJECT_OR_MECHANISM",
          "UNKNOWN_BLOCK",
          { blocks: unknown.map(MotaLab.blockEvidence) },
          observation,
        );
      }

      state = "GUARD_CHECK";
      const freshObservation = capture();
      const freshFingerprint = MotaLab.fingerprintObservation(freshObservation);
      const guard = MotaLab.compareGuard(freshObservation, response.guard);
      if (!guard.ok) {
        return pause(
          "GUARD_MISMATCH",
          "PRE_ACTION_GUARD_MISMATCH",
          { differences: guard.differences },
          freshObservation,
        );
      }

      let planned;
      let actionConstraints;
      try {
        planned = MotaLab.planOperations(response, freshObservation, registry, adapter);
        const allowUnknownFloor = response.expected_delta.floor_id === null
          && planned.length > 0 && planned[planned.length - 1].category === "stair";
        MotaLab.validateExpectedDelta(response.expected_delta, { allowUnknownFloor });
        actionConstraints = MotaLab.validateActionPostconditions(planned, response.expected_delta);
      } catch (error) {
        if (MotaLab.isPauseError(error)
          && ["UNSAFE_MULTI_BOUNDARY_RESPONSE", "UNSAFE_ROUTE_RESPONSE"].includes(error.detail_code)) {
          unsafeResponseCount += 1;
          if (unsafeResponseCount < 2) {
            journal.setPending({
              action_id: response.action_id,
              pre_fingerprint: freshFingerprint,
              pre_observation: MotaLab.cloneObservationForWire(freshObservation),
              guard: response.guard,
              expected_delta: response.expected_delta,
              requires_non_position_change: Boolean(
                planned && planned.length > 0 && planned[planned.length - 1].boundary,
              ),
              operations: response.operations,
              operation_index: 0,
              phase: "not_executed",
              rejection_detail_code: error.detail_code,
              rejection_count: unsafeResponseCount,
              started_at: Date.now(),
            });
            lastReason = `${error.detail_code}，已要求重新决策`;
            scheduleNext(0);
            return { rejected: true, executed: false };
          }
        }
        return handleError(error, "DECISION_SERVICE_UNAVAILABLE", "INVALID_RESPONSE");
      }
      unsafeResponseCount = 0;

      const pendingRecord = {
        action_id: response.action_id,
        pre_fingerprint: freshFingerprint,
        pre_observation: MotaLab.cloneObservationForWire(freshObservation),
        guard: response.guard,
        expected_delta: response.expected_delta,
        requires_non_position_change: actionConstraints.requires_non_position_change,
        allow_unknown_floor: response.expected_delta.floor_id === null,
        operations: response.operations,
        operation_index: 0,
        phase: "prepared",
        started_at: Date.now(),
      };
      journal.setPending(pendingRecord);
      state = "EXECUTING";
      let result;
      try {
        result = await MotaLab.executeAction({
          action: response,
          initialObservation: freshObservation,
          registry,
          adapter,
          observe,
          stabilityOptions: options.stabilityOptions || {},
        });
      } catch (error) {
        if (error && error.observation) currentObservation = error.observation;
        else {
          try { currentObservation = observe(); } catch (_) { currentObservation = freshObservation; }
        }
        return handleError(error);
      }

      currentObservation = result.observation;
      state = "VERIFYING_DELTA";
      if (pendingRecord.requires_non_position_change
        && !MotaLab.stateChangedBeyondPosition(freshObservation, result.observation)) {
        return pause(
          "EXPECTED_DELTA_MISMATCH",
          "RESOURCE_DELTA_MISMATCH",
          {
            differences: [{
              field: "boundary_state_change",
              expected: "non-position state change",
              actual: "position-only change",
            }],
            actual: { removed: [], added: [] },
          },
          result.observation,
        );
      }
      const delta = MotaLab.compareExpectedDelta(
        freshObservation,
        result.observation,
        response.expected_delta,
        {
          allowPositionChange: true,
          allowUnknownFloor: pendingRecord.allow_unknown_floor,
        },
      );
      if (!delta.ok) {
        return pause(
          "EXPECTED_DELTA_MISMATCH",
          "RESOURCE_DELTA_MISMATCH",
          { differences: delta.differences, actual: delta.actual },
          result.observation,
        );
      }
      journal.markCompleted({
        action_id: response.action_id,
        fingerprint: result.fingerprint,
        observation: MotaLab.cloneObservationForWire(result.observation),
        completed_at: Date.now(),
        recovered: false,
      });
      state = "REPORTING";
      lastReason = `行动 ${response.action_id} 已完成并通过差分校验`;
      refreshPanel();
      scheduleNext(0);
      return { completed: true, action_id: response.action_id, result };
    }

    function runSingleCycle() {
      if (cyclePromise) return cyclePromise;
      cyclePromise = cycleBody().catch((error) => handleError(error))
        .finally(() => { cyclePromise = null; });
      return cyclePromise;
    }

    async function reconnectOnly() {
      try {
        const observation = capture();
        const fingerprint = MotaLab.fingerprintObservation(observation);
        const request = MotaLab.createCycleRequest({
          observation,
          completedActionId: null,
          recovery: {
            phase: "none",
            pending_action_id: null,
            pre_fingerprint: null,
            current_fingerprint: fingerprint,
          },
        });
        const response = await client.postCycle(request);
        validateAndReplaceRegistry(response.registry_entries || [], observation);
        lastReason = "localhost 重新连接成功；未执行返回行动";
        refreshPanel({ connected: true });
        return { connected: true, response_status: response.status, executed: false };
      } catch (error) {
        return pause(
          "DECISION_SERVICE_UNAVAILABLE",
          error.detail_code || "CONNECTION_FAILED",
          { message: error.message },
        );
      }
    }

    function getCurrentObservation() {
      try {
        return MotaLab.cloneObservationForWire(currentObservation || capture());
      } catch (error) {
        handleError(error);
        return null;
      }
    }

    return Object.freeze({
      initialize,
      start,
      manualPause,
      clearPending,
      reconnectOnly,
      runSingleCycle,
      getCurrentObservation,
      getState: () => state,
    });
  };

  // Source: games/mota-planning-lab/src/main.js

  MotaLab.main = async function main() {
    const adapter = MotaLab.createEngineAdapter();
    const storage = {
      get: (key, fallback) => GM_getValue(key, fallback),
      set: (key, value) => GM_setValue(key, value),
    };
    const journal = MotaLab.createJournal(storage);
    const registry = MotaLab.createBlockRegistry();
    const client = MotaLab.createLocalhostClient(GM_xmlhttpRequest);
    const panel = MotaLab.createPanel(document);
    const controller = MotaLab.createController(
      { adapter, journal, registry, client, panel },
      { autoSchedule: true },
    );
    MotaLab.registerMenus({
      register: GM_registerMenuCommand,
      controller,
    });
    globalThis.__motaPlanningLab = Object.freeze({
      controller,
      capabilities: () => adapter.capabilities(),
      currentObservation: () => controller.getCurrentObservation(),
    });
    await controller.initialize();
  };

  MotaLab.main().catch((error) => {
    console.error("[Mota Planning Lab fatal]", {
      message: error && error.message ? error.message : String(error),
    });
  });
})();
