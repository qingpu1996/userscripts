/* Mota Planning Lab v2 direct mount; local audited artifact. */
(() => {
const MotaLab = Object.create(null);

MotaLab.PROTOCOL_VERSION = 2;
MotaLab.SOURCE = "mota-planning-lab-userscript";
MotaLab.PAGE = "/games/24/";
MotaLab.CYCLE_ENDPOINT = "http://127.0.0.1:18724/cycle";
MotaLab.MAX_MAP_AXIS = 256;
MotaLab.MAX_MAP_CELLS = 65536;
MotaLab.MAX_BLOCKS = 8192;
MotaLab.MAX_ENGINE_FLOORS = 1024;
MotaLab.MAX_ENGINE_CATALOG_ENTRIES = 32768;
MotaLab.MAX_ENGINE_MODEL_BYTES = 8 * 1024 * 1024;
MotaLab.MAX_ENGINE_LITERAL_DEPTH = 24;
MotaLab.MAX_ENGINE_LITERAL_ARRAY = 65536;
MotaLab.MAX_ENGINE_STRING = 65536;
MotaLab.SESSION_MODES = Object.freeze([
  "new_game",
  "handoff_expected_guard",
  "resume_existing_ledger",
]);

MotaLab.PAUSE_KINDS = Object.freeze([
  "NEW_OBJECT_OR_MECHANISM",
  "UNKNOWN_DAMAGE",
  "UNKNOWN_FLOOR",
  "EXPECTED_DELTA_MISMATCH",
  "GUARD_MISMATCH",
  "UNSUPPORTED_INTERACTION",
  "DECISION_SERVICE_UNAVAILABLE",
  "ENGINE_API_INCOMPATIBLE",
  "SESSION_CONFIRMATION_REQUIRED",
  "PLANNING_BUDGET_EXHAUSTED",
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

MotaLab.JOURNAL_KEY = "mota-planning-lab:journal:v2";
MotaLab.JOURNAL_SLOT_KEYS = Object.freeze([
  "mota-planning-lab:journal:v2:slot:a",
  "mota-planning-lab:journal:v2:slot:b",
]);
MotaLab.LEGACY_JOURNAL_KEYS = Object.freeze(["mota-planning-lab:journal:v1"]);
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

// This source is the audited build marker for the Tampermonkey artifact.
// build-direct-mount.mjs replaces this exact assignment in the direct artifact.
MotaLab.RUNTIME_MODE = "direct-mount";

MotaLab.createRuntimeEnvironment = function createRuntimeEnvironment(
  scope = globalThis,
  explicitMode = MotaLab.RUNTIME_MODE,
) {
  const unavailable = (missing) => {
    const error = () => MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE", "USERSCRIPT_API_UNAVAILABLE", { missing: missing.slice() },
    );
    return Object.freeze({
      mode: "userscript", available: false, detail_code: "USERSCRIPT_API_UNAVAILABLE",
      missing: Object.freeze(missing.slice()), storage: MotaLab.createMemoryStorage(),
      request() { throw error(); }, registerMenu: null, assertAvailable() { throw error(); },
    });
  };
  if (!["userscript", "direct-mount"].includes(explicitMode)) {
    throw new TypeError(`Invalid explicit runtime mode: ${String(explicitMode)}`);
  }
  if (explicitMode === "userscript") {
    const required = ["GM_xmlhttpRequest"];
    const missing = required.filter((name) => typeof scope[name] !== "function");
    if (missing.length) return unavailable(missing);
    return Object.freeze({
      mode: "userscript", available: true, detail_code: null,
      storage: MotaLab.createMemoryStorage(),
      request(options) { return scope.GM_xmlhttpRequest(options); },
      registerMenu: typeof scope.GM_registerMenuCommand === "function"
        ? scope.GM_registerMenuCommand : null,
      assertAvailable() { return true; },
    });
  }
  const directRequest = (options) => {
    const controller = new AbortController();
    const timer = scope.setTimeout(() => controller.abort(), options.timeout);
    scope.fetch(options.url, {
      method: options.method, headers: options.headers, body: options.data,
      signal: controller.signal, credentials: "omit", mode: "cors",
    }).then(async (response) => {
      scope.clearTimeout(timer);
      options.onload({ status: response.status, responseText: await response.text() });
    }).catch((error) => {
      scope.clearTimeout(timer);
      if (error && error.name === "AbortError") options.ontimeout();
      else options.onerror(error);
    });
    return { abort: () => { controller.abort(); options.onabort(); } };
  };
  return Object.freeze({
    mode: "direct-mount", available: true, detail_code: null,
    storage: MotaLab.createMemoryStorage(),
    request: directRequest,
    registerMenu: null, assertAvailable() { return true; },
  });
};

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
    const actions = event && Array.isArray(event.data) ? event.data : [];
    const shopActions = actions.filter((item) => item && item.type === "openShop"
      && typeof item.id === "string" && item.open === true);
    return {
      x: block.x,
      y: block.y,
      numeric_id: numericId === undefined ? null : numericId,
      id: id === undefined || id === null ? null : String(id),
      cls: cls === undefined || cls === null ? null : String(cls),
      trigger: trigger === undefined || trigger === null ? null : String(trigger),
      no_pass: Boolean(noPassValue),
      disabled,
      shop_id: shopActions.length === 1 ? shopActions[0].id : null,
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
        let shopSource = {};
        try {
          shopSource = runtime.status.shops || {};
        } catch (_error) {
          shopSource = {};
        }
        const flagValues = runtime.status.hero && runtime.status.hero.flags
          && typeof runtime.status.hero.flags === "object" ? runtime.status.hero.flags : {};
        const shops = Object.entries(shopSource).map(([id, raw]) => (
          MotaLab.parseRestrictedShop(id, raw, flagValues)
        )).filter((shop) => shop.supported);
        const activeMenus = shops.map((shop) => MotaLab.readRestrictedShopMenu(runtime, shop))
          .filter(Boolean);
        return {
          floor_id: before.floor_id,
          map,
          hero: before.hero,
          blocks,
          busy: before.busy,
          engine_model: engineModel,
          shops,
          active_menu: activeMenus.length === 1 ? activeMenus[0] : null,
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

  function chooseShopChoice(expectedShop, choiceIndex) {
    const runtime = requireRuntime();
    const menu = MotaLab.readRestrictedShopMenu(runtime, expectedShop);
    if (!menu || menu.ready !== true || menu.choices[choiceIndex] !== expectedShop.choices[choiceIndex].choice_id
      || choiceIndex < 0 || choiceIndex > 8 || !runtime.actions
      || typeof runtime.actions.keyUp !== "function") {
      throw MotaLab.createPauseError("UNSUPPORTED_INTERACTION", "SHOP_MENU_IDENTITY_MISMATCH");
    }
    return runtime.actions.keyUp({ keyCode: 49 + choiceIndex });
  }

  function closeShopMenu(expectedShop) {
    const runtime = requireRuntime();
    if (!MotaLab.readRestrictedShopMenu(runtime, expectedShop) || !runtime.actions
      || typeof runtime.actions.keyUp !== "function") {
      throw MotaLab.createPauseError("UNSUPPORTED_INTERACTION", "SHOP_MENU_IDENTITY_MISMATCH");
    }
    return runtime.actions.keyUp({ keyCode: 27 });
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
    chooseShopChoice,
    closeShopMenu,
    physicalSaveLoad,
  });
};

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
  return {
    floor_id: floorId,
    title: String(dynamic.title || dynamic.name || definition.title || definition.name || floorId),
    width,
    height,
    topology: validCells.length === width * height
      ? { kind: "rectangle" } : { kind: "valid_cells", valid_cells: validCells },
    map,
    blocks,
    change_floor,
    ratio: Number.isFinite(dynamic.ratio) ? dynamic.ratio
      : Number.isFinite(definition.ratio) ? definition.ratio : 1,
  };
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
  const floorIds = [...new Set([...Object.keys(floorDefinitions), ...Object.keys(statusMaps)])].sort();
  if (!floorIds.length || floorIds.length > MotaLab.MAX_ENGINE_FLOORS) {
    fail("ENGINE_MODEL_FLOOR_LIMIT_EXCEEDED", { count: floorIds.length });
  }
  const floors = floorIds.map((floorId) => MotaLab.collectEngineFloor(
    engine, floorId, floorDefinitions[floorId] || {}, statusMaps[floorId] || {}, fail,
  ));

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

MotaLab.cloneObservationForWire = function cloneObservationForWire(observation) {
  const wire = {
    protocol: observation.protocol,
    page: observation.page,
    session_id: observation.session_id,
    floor_id: observation.floor_id,
    floor_name: observation.floor_name,
    floor_number: observation.floor_number,
    dimensions: {
      width: observation.dimensions.width,
      height: observation.dimensions.height,
    },
    topology: Object.assign({
      kind: observation.topology.kind,
      source: observation.topology.source,
      confidence: observation.topology.confidence,
    }, observation.topology.valid_cells ? {
      valid_cells: observation.topology.valid_cells.map((cell) => ({ x: cell.x, y: cell.y })),
    } : {}),
    topology_fingerprint: observation.topology_fingerprint,
    map_instance_id: observation.map_instance_id,
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
    blocks: observation.blocks.map((block) => Object.assign({
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
    }, typeof block.shop_id === "string" ? { shop_id: block.shop_id } : {})),
    captured_at: observation.captured_at,
  };
  if (observation.engine_model !== undefined) {
    wire.engine_model = MotaLab.cloneJsonValue(observation.engine_model);
  }
  if (Array.isArray(observation.shops)) wire.shops = MotaLab.cloneJsonValue(observation.shops);
  if (observation.active_menu !== undefined) {
    wire.active_menu = observation.active_menu === null
      ? null : MotaLab.cloneJsonValue(observation.active_menu);
  }
  return wire;
};

MotaLab.createCycleRequest = function createCycleRequest({
  observation,
  completedActionId = null,
  recovery = null,
  session,
  intent = "cycle",
}) {
  if (!["cycle", "reconnect_only"].includes(intent)) {
    throw new TypeError("Invalid cycle request intent");
  }
  MotaLab.assertProtocolShape(session, ["mode"], ["command", "expected_guard"], "session");
  if (!MotaLab.SESSION_MODES.includes(session.mode)
    || (session.command !== undefined && !["observe", "confirm"].includes(session.command))) {
    throw new TypeError("Invalid session control");
  }
  const hasExpectedGuard = Object.prototype.hasOwnProperty.call(session, "expected_guard");
  if ((session.mode === "handoff_expected_guard") !== hasExpectedGuard) {
    throw new TypeError("Invalid session expected_guard contract");
  }
  if (hasExpectedGuard) MotaLab.validateResponseGuard(session.expected_guard);
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
    intent,
    completed_action_id: completedActionId,
    session: Object.assign({ mode: session.mode }, session.command ? {
      command: session.command,
    } : {}, hasExpectedGuard ? {
      expected_guard: MotaLab.cloneJsonValue(session.expected_guard),
    } : {}),
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

MotaLab.validateDimensions = function validateDimensions(value, label = "dimensions") {
  MotaLab.assertProtocolShape(value, ["width", "height"], [], label);
  if (!MotaLab.isFiniteInteger(value.width) || !MotaLab.isFiniteInteger(value.height)
    || value.width < 1 || value.height < 1 || value.width > MotaLab.MAX_MAP_AXIS
    || value.height > MotaLab.MAX_MAP_AXIS
    || value.width * value.height > MotaLab.MAX_MAP_CELLS) {
    throw new TypeError(`Invalid ${label}`);
  }
  return { width: value.width, height: value.height };
};

MotaLab.validCellSet = function validCellSet(topology) {
  return topology && Array.isArray(topology.valid_cells)
    ? new Set(topology.valid_cells.map((cell) => `${cell.x},${cell.y}`)) : null;
};

MotaLab.validateResponsePosition = function validateResponsePosition(
  value, label, withDirection, dimensions, topology = null,
) {
  MotaLab.assertProtocolShape(
    value,
    withDirection ? ["x", "y", "direction"] : ["x", "y"],
    [],
    label,
  );
  if (!MotaLab.isFiniteInteger(value.x) || !MotaLab.isFiniteInteger(value.y)
    || !dimensions || value.x < 0 || value.x >= dimensions.width
    || value.y < 0 || value.y >= dimensions.height
    || (MotaLab.validCellSet(topology)
      && !MotaLab.validCellSet(topology).has(`${value.x},${value.y}`))) {
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
    "session_id", "floor_id", "floor", "map_instance_id", "dimensions",
    "topology_fingerprint", "position", "hp", "attack", "defense", "gold", "experience", "keys",
  ], [], "guard");
  MotaLab.validateProtocolString(value.session_id, "guard.session_id", 1, 128);
  MotaLab.validateProtocolString(value.floor_id, "guard.floor_id", 1, 256);
  MotaLab.validateProtocolString(value.map_instance_id, "guard.map_instance_id", 1, 256);
  if (typeof value.topology_fingerprint !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(value.topology_fingerprint)) {
    throw new TypeError("Invalid guard.topology_fingerprint");
  }
  const dimensions = MotaLab.validateDimensions(value.dimensions, "guard.dimensions");
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
    session_id: value.session_id,
    map_instance_id: value.map_instance_id,
    dimensions,
    topology_fingerprint: value.topology_fingerprint,
    position: MotaLab.validateResponsePosition(value.position, "guard.position", true, dimensions),
    hp: value.hp,
    attack: value.attack,
    defense: value.defense,
    gold: value.gold,
    experience: value.experience,
    keys: MotaLab.validateResponseKeys(value.keys, "guard.keys"),
  };
};

MotaLab.validateOperation = function validateOperation(operation, dimensions) {
  if (operation && operation.type === "menu_choice") {
    MotaLab.assertProtocolShape(operation, [
      "type", "shop_id", "menu_id", "choice_id", "choice_index", "expected_cost",
      "expected_effect", "expected_purchase_count",
    ], [], "menu choice operation");
    if (typeof operation.shop_id !== "string" || operation.shop_id.length < 1
      || typeof operation.choice_id !== "string" || operation.choice_id.length < 1
      || typeof operation.menu_id !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(operation.menu_id)
      || !MotaLab.isFiniteInteger(operation.choice_index) || operation.choice_index < 0
      || operation.choice_index > 8 || !MotaLab.isFiniteInteger(operation.expected_cost)
      || operation.expected_cost < 1 || !MotaLab.isFiniteInteger(operation.expected_purchase_count)
      || operation.expected_purchase_count < 0 || !MotaLab.isProtocolObject(operation.expected_effect)
      || !["hp", "attack", "defense"].includes(operation.expected_effect.field)
      || !MotaLab.isFiniteInteger(operation.expected_effect.amount)
      || operation.expected_effect.amount < 1) throw new TypeError("Invalid menu choice operation");
    MotaLab.assertProtocolShape(operation.expected_effect, ["field", "amount"], [], "shop effect");
    return MotaLab.cloneJsonValue(operation);
  }
  MotaLab.assertProtocolShape(operation, ["type", "x", "y"], [], "operation");
  if (operation.type !== "grid") throw new TypeError("Unsupported operation type");
  if (!MotaLab.isFiniteInteger(operation.x) || !MotaLab.isFiniteInteger(operation.y)
    || operation.x < 0 || operation.x >= dimensions.width
    || operation.y < 0 || operation.y >= dimensions.height) {
    throw new TypeError("Grid target is out of bounds");
  }
  return { type: "grid", x: operation.x, y: operation.y };
};

MotaLab.validateRegistryEntries = function validateRegistryEntries(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MotaLab.MAX_BLOCKS) {
    throw new TypeError("Invalid registry entries");
  }
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

MotaLab.validateScanState = function validateScanState(value) {
  if (value === undefined) return undefined;
  MotaLab.assertProtocolShape(value, [
    "phase", "anchor_map_instance_id", "current_map_instance_id",
    "scanned_map_instance_ids", "pending_transition_count",
    "traversed_transition_count", "frontier_count", "reason",
  ], [], "scan_state");
  if (!["anchor", "discover", "sweep", "complete", "paused"].includes(value.phase)) {
    throw new TypeError("Invalid scan_state.phase");
  }
  for (const field of ["anchor_map_instance_id", "current_map_instance_id"]) {
    MotaLab.validateProtocolString(value[field], `scan_state.${field}`, 1, 256);
  }
  if (!Array.isArray(value.scanned_map_instance_ids)
    || value.scanned_map_instance_ids.length > MotaLab.MAX_MAP_CELLS) {
    throw new TypeError("Invalid scan_state.scanned_map_instance_ids");
  }
  const scanned = new Set();
  for (const item of value.scanned_map_instance_ids) {
    MotaLab.validateProtocolString(item, "scan_state map instance", 1, 256);
    if (scanned.has(item)) throw new TypeError("Duplicate scan_state map instance");
    scanned.add(item);
  }
  if (!scanned.has(value.current_map_instance_id)) {
    throw new TypeError("scan_state current map is not scanned");
  }
  for (const field of ["pending_transition_count", "traversed_transition_count", "frontier_count"]) {
    if (!MotaLab.isFiniteInteger(value[field]) || value[field] < 0) {
      throw new TypeError(`Invalid scan_state.${field}`);
    }
  }
  MotaLab.validateProtocolString(value.reason, "scan_state.reason", 1, 512);
  return MotaLab.cloneJsonValue(value);
};

MotaLab.validateShadowAdvice = function validateShadowAdvice(value) {
  MotaLab.assertProtocolShape(value, ["mode", "reason", "cycle"], ["observation"], "shadow");
  if (value.mode !== "read_only"
    || typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 512
    || !MotaLab.isFiniteInteger(value.cycle) || value.cycle < 1
    || value.cycle > Number.MAX_SAFE_INTEGER) {
    throw new TypeError("Invalid shadow advice");
  }
  if (value.observation !== undefined) {
    MotaLab.assertProtocolShape(value.observation, ["session_id", "floor_id", "map_instance_id"], [], "shadow.observation");
    for (const field of ["session_id", "floor_id", "map_instance_id"]) {
      MotaLab.validateProtocolString(value.observation[field], `shadow.observation.${field}`, 1, 256);
    }
  }
  return MotaLab.cloneJsonValue(value);
};

MotaLab.validateCycleResponse = function validateCycleResponse(value) {
  if (!MotaLab.isProtocolObject(value)) {
    throw new TypeError("Response must be an object");
  }
  if (!new Set(["execute", "pause", "idle", "error"]).has(value.status)) {
    throw new TypeError("Unsupported response status");
  }
  const acknowledgment = () => {
    if (value.acknowledged_action_id === undefined) return {};
    if (!MotaLab.validateActionId(value.acknowledged_action_id)) {
      throw new TypeError("Invalid acknowledged_action_id");
    }
    return { acknowledged_action_id: value.acknowledged_action_id };
  };
  if (value.status === "pause") {
    MotaLab.assertProtocolShape(value,
      ["status", "pause_kind", "detail_code", "reason", "details"],
      ["evidence_path", "registry_entries", "scan_state", "acknowledged_action_id"], "pause response");
    if (!MotaLab.PAUSE_KIND_SET.has(value.pause_kind)) throw new TypeError("Invalid pause_kind");
    if (typeof value.detail_code !== "string" || !/^[A-Z][A-Z0-9_]{2,95}$/.test(value.detail_code)
      || typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 512
      || !MotaLab.isProtocolObject(value.details)
      || (value.evidence_path !== undefined && typeof value.evidence_path !== "string")) {
      throw new TypeError("Invalid pause response");
    }
    return Object.assign({
      status: "pause",
      pause_kind: value.pause_kind,
      detail_code: value.detail_code,
      reason: value.reason,
      details: MotaLab.cloneJsonValue(value.details),
      evidence_path: value.evidence_path,
      registry_entries: MotaLab.validateRegistryEntries(value.registry_entries),
      scan_state: MotaLab.validateScanState(value.scan_state),
    }, acknowledgment());
  }
  if (value.status === "idle") {
    MotaLab.assertProtocolShape(value, ["status", "reason"],
      ["registry_entries", "scan_state", "acknowledged_action_id", "shadow"], "idle response");
    if (typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 512) {
      throw new TypeError("Invalid idle response");
    }
    return Object.assign({
      status: "idle",
      reason: value.reason,
      registry_entries: MotaLab.validateRegistryEntries(value.registry_entries),
      scan_state: MotaLab.validateScanState(value.scan_state),
      shadow: value.shadow === undefined ? undefined : MotaLab.validateShadowAdvice(value.shadow),
    }, acknowledgment());
  }
  if (value.status === "error") {
    MotaLab.assertProtocolShape(value, ["status", "error_code", "reason"],
      ["errors", "acknowledged_action_id"], "error response");
    MotaLab.validateProtocolString(value.error_code, "error_code", 1, 128);
    if (typeof value.reason !== "string" || value.reason.length > 1000) {
      throw new TypeError("Invalid error reason");
    }
    if (value.errors !== undefined && (!Array.isArray(value.errors)
      || value.errors.some((entry) => !MotaLab.isProtocolObject(entry)))) {
      throw new TypeError("Invalid error details");
    }
    return Object.assign({
      status: "error",
      error_code: value.error_code,
      reason: value.reason,
      errors: (value.errors || []).map(MotaLab.cloneJsonValue),
    }, acknowledgment());
  }

  MotaLab.assertProtocolShape(value, [
    "status", "action_id", "action_kind", "reason", "operations", "guard", "expected_delta",
  ], ["supersedes_action_id", "registry_entries", "scan_state", "acknowledged_action_id"], "execute response");
  if (!MotaLab.validateActionId(value.action_id)) throw new TypeError("Invalid action_id");
  if (typeof value.action_kind !== "string"
    || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value.action_kind)) {
    throw new TypeError("Invalid action_kind");
  }
  if (typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 512) {
    throw new TypeError("Invalid action reason");
  }
  if (!Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 3) {
    throw new TypeError("Invalid operations");
  }
  if (!MotaLab.isProtocolObject(value.expected_delta)
    || Object.keys(value.expected_delta).length < 1) {
    throw new TypeError("Missing expected_delta");
  }
  const guard = MotaLab.validateResponseGuard(value.guard);
  MotaLab.validateExpectedDelta(value.expected_delta, {
    allowUnknownFloor: true,
    allowUnknownMapInstance: true,
    dimensions: guard.dimensions,
  });
  if (value.supersedes_action_id !== undefined && value.supersedes_action_id !== null
    && !MotaLab.validateActionId(value.supersedes_action_id)) {
    throw new TypeError("Invalid supersedes_action_id");
  }
  return Object.assign({
    status: "execute",
    action_id: value.action_id,
    action_kind: value.action_kind,
    operations: value.operations.map((operation) => MotaLab.validateOperation(operation, guard.dimensions)),
    guard,
    expected_delta: MotaLab.cloneJsonValue(value.expected_delta),
    reason: value.reason,
    supersedes_action_id: MotaLab.validateActionId(value.supersedes_action_id)
      ? value.supersedes_action_id : null,
    registry_entries: MotaLab.validateRegistryEntries(value.registry_entries),
    scan_state: MotaLab.validateScanState(value.scan_state),
  }, acknowledgment());
};

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
  const projection = {
    floor_id: observation.floor_id,
    session_id: observation.session_id,
    dimensions: {
      width: observation.dimensions.width,
      height: observation.dimensions.height,
    },
    topology: Object.assign({
      kind: observation.topology.kind,
      source: observation.topology.source,
      confidence: observation.topology.confidence,
    }, Array.isArray(observation.topology.valid_cells) ? {
      valid_cells: observation.topology.valid_cells,
    } : {}),
    topology_fingerprint: observation.topology_fingerprint,
    map_instance_id: observation.map_instance_id,
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
      shop_id: block.shop_id || null,
    })).sort((a, b) => a.y - b.y || a.x - b.x
      || a.numeric_id - b.numeric_id || a.id.localeCompare(b.id)),
  };
  if (observation.engine_model && typeof observation.engine_model.catalog_hash === "string") {
    projection.catalog_hash = observation.engine_model.catalog_hash;
    projection.engine_model_hash = observation.engine_model.model_hash;
  }
  if (Array.isArray(observation.shops)) projection.shops = observation.shops;
  return projection;
};

MotaLab.fingerprintObservation = function fingerprintObservation(observation) {
  return `sha256:${MotaLab.sha256(MotaLab.canonicalize(MotaLab.fingerprintProjection(observation)))}`;
};

MotaLab.fingerprintRuntimeObservation = function fingerprintRuntimeObservation(observation) {
  const projection = MotaLab.fingerprintProjection(observation);
  delete projection.catalog_hash;
  delete projection.engine_model_hash;
  return `sha256:${MotaLab.sha256(MotaLab.canonicalize(projection))}`;
};

// A fast snapshot intentionally omits the cross-floor engine catalog.  Safety
// checks performed between a complete observation and a fast snapshot must
// therefore compare only the runtime facts represented by both shapes.  Keep
// this projection separate from fingerprintProjection: the latter must still
// notice catalog/model changes when both complete observations are compared.
MotaLab.runtimeStateProjectionIgnoringPosition = function runtimeStateProjectionIgnoringPosition(
  observation,
) {
  const projection = MotaLab.fingerprintProjection(observation);
  delete projection.catalog_hash;
  delete projection.engine_model_hash;
  projection.hero.loc = { x: 0, y: 0, direction: null };
  return projection;
};

MotaLab.runtimeStateChangedBeyondPosition = function runtimeStateChangedBeyondPosition(
  before,
  after,
) {
  const project = (observation) => MotaLab.canonicalize(
    MotaLab.runtimeStateProjectionIgnoringPosition(observation),
  );
  return project(before) !== project(after);
};

// Durable recovery needs the current runtime facts that participate in guard
// and delta checks, not the (potentially megabyte-sized) cross-floor engine
// catalog.  Inventory is the only engine_model field used by delta recovery.
MotaLab.recoveryObservationProjection = function recoveryObservationProjection(observation) {
  if (!observation) return null;
  const projected = {
    protocol: observation.protocol,
    page: observation.page,
    session_id: observation.session_id,
    floor_id: observation.floor_id,
    floor_name: observation.floor_name,
    floor_number: observation.floor_number,
    dimensions: MotaLab.cloneJsonValue(observation.dimensions),
    topology: MotaLab.cloneJsonValue(observation.topology),
    topology_fingerprint: observation.topology_fingerprint,
    map_instance_id: observation.map_instance_id,
    hero: MotaLab.cloneJsonValue(observation.hero),
    keys: MotaLab.cloneJsonValue(observation.keys),
    busy: observation.busy === true,
    blocks: MotaLab.cloneJsonValue(observation.blocks || []),
    captured_at: observation.captured_at,
  };
  const inventory = observation.engine_model && observation.engine_model.inventory;
  if (inventory) projected.recovery_inventory = MotaLab.cloneJsonValue(inventory);
  return projected;
};

MotaLab.compactJournalDetails = function compactJournalDetails(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 256).map((item) => MotaLab.compactJournalDetails(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["engine_model", "catalog", "floors"].includes(key)) continue;
    if (key === "observation") {
      result.observation = MotaLab.recoveryObservationProjection(item);
    } else {
      result[key] = MotaLab.compactJournalDetails(item, depth + 1);
    }
  }
  return result;
};

MotaLab.compareGuard = function compareGuard(observation, guard) {
  const differences = [];
  function compare(field, expected, actual, required = true) {
    if (!required) return;
    if (expected !== actual) differences.push({ field, expected, actual });
  }

  if (guard.session_id !== undefined) {
    compare("session_id", guard.session_id, observation.session_id || guard.session_id);
  }
  compare("map_instance_id", guard.map_instance_id, observation.map_instance_id,
    guard.map_instance_id !== undefined);
  compare("topology_fingerprint", guard.topology_fingerprint, observation.topology_fingerprint,
    guard.topology_fingerprint !== undefined);
  if (guard.dimensions) {
    compare("dimensions.width", guard.dimensions.width, observation.dimensions.width);
    compare("dimensions.height", guard.dimensions.height, observation.dimensions.height);
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

MotaLab.baselineSummary = function baselineSummary(observation) {
  return {
    fingerprint: MotaLab.fingerprintObservation(observation),
    floor_id: observation.floor_id,
    map_instance_id: observation.map_instance_id,
    dimensions: Object.assign({}, observation.dimensions),
    topology_fingerprint: observation.topology_fingerprint,
    hero: MotaLab.cloneJsonValue(observation.hero),
    keys: MotaLab.cloneJsonValue(observation.keys),
  };
};

MotaLab.validateExpectedDelta = function validateExpectedDelta(expected, options = {}) {
  if (!MotaLab.isProtocolObject(expected)) {
    throw new TypeError("expected_delta must be an object");
  }
  const allowed = new Set([
    "hp", "attack", "defense", "gold", "experience", "keys",
    "inventory", "position", "floor_id", "map_instance_id", "removed_blocks", "added_blocks",
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
  if (expected.inventory !== undefined) {
    if (!MotaLab.isProtocolObject(expected.inventory)
      || Object.keys(expected.inventory).length > MotaLab.MAX_ENGINE_CATALOG_ENTRIES) {
      throw new TypeError("Invalid inventory deltas");
    }
    for (const [itemId, delta] of Object.entries(expected.inventory)) {
      if (itemId.length < 1 || itemId.length > 256 || !MotaLab.isFiniteInteger(delta)) {
        throw new TypeError(`Invalid inventory delta: ${itemId}`);
      }
    }
  }
  if (expected.position !== undefined) {
    if (!options.dimensions) throw new TypeError("dimensions required for expected position");
    MotaLab.validateResponsePosition(
      expected.position, "expected_delta.position", false, options.dimensions, options.topology,
    );
  }
  if (expected.floor_id !== undefined) {
    if (expected.floor_id === null) {
      if (options.allowUnknownFloor !== true) throw new TypeError("Unknown floor_id is only allowed for stairs");
    } else if (typeof expected.floor_id !== "string"
      || expected.floor_id.length < 1 || expected.floor_id.length > 256) {
      throw new TypeError("Invalid expected floor_id");
    }
  }
  if (expected.map_instance_id !== undefined) {
    if (expected.map_instance_id === null) {
      if (options.allowUnknownMapInstance !== true) {
        throw new TypeError("Unknown map_instance_id is only allowed for map transitions");
      }
    } else if (typeof expected.map_instance_id !== "string"
      || expected.map_instance_id.length < 1 || expected.map_instance_id.length > 256) {
      throw new TypeError("Invalid expected map_instance_id");
    }
    if (expected.removed_blocks !== undefined || expected.added_blocks !== undefined) {
      throw new TypeError("Map transition cannot compare blocks from different instances");
    }
  }
  for (const field of ["removed_blocks", "added_blocks"]) {
    if (expected[field] !== undefined && !Array.isArray(expected[field])) {
      throw new TypeError(`Invalid ${field}`);
    }
    const dimensions = options.dimensions;
    if (expected[field] !== undefined && !dimensions) {
      throw new TypeError("dimensions required for block references");
    }
    if (!dimensions) continue;
    if ((expected[field] || []).length > dimensions.width * dimensions.height) {
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
        || block.x < 0 || block.x >= dimensions.width
        || block.y < 0 || block.y >= dimensions.height
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

MotaLab.blockDeltaProjection = function blockDeltaProjection(block) {
  if (!MotaLab.isProtocolObject(block)) throw new TypeError("Invalid observed block");
  const isEnemy = block.trigger === "battle"
    || (typeof block.cls === "string" && /^enemy/i.test(block.cls));
  if (isEnemy && block.damage !== null && block.damage !== "???"
    && (!MotaLab.isFiniteInteger(block.damage) || block.damage < 0)) {
    throw new TypeError("Invalid observed enemy damage");
  }
  const projection = {};
  for (const [field, value] of Object.entries(block)) {
    // `damage` is calculated against the current hero.  It is planning data,
    // not part of a monster's stable map identity, so an attribute pickup can
    // legitimately change it for every visible monster at once.  Keep every
    // other observed (including unknown future) field in the projection so a
    // real block semantic change still fails closed.
    if (isEnemy && field === "damage") continue;
    projection[field] = value;
  }
  return projection;
};

MotaLab.compareExpectedDelta = function compareExpectedDelta(before, after, expected, options = {}) {
  MotaLab.validateExpectedDelta(expected, Object.assign({
    dimensions: before.dimensions,
    topology: before.topology,
  }, options));
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
  if (expected.inventory) {
    const flatten = (observation) => {
      const result = {};
      const inventory = observation.recovery_inventory
        || (observation.engine_model && observation.engine_model.inventory);
      const classes = inventory && inventory.classes;
      if (!classes || typeof classes !== "object") return result;
      for (const items of Object.values(classes)) {
        if (!items || typeof items !== "object") continue;
        for (const [itemId, count] of Object.entries(items)) {
          if (MotaLab.isFiniteInteger(count)) result[itemId] = (result[itemId] || 0) + count;
        }
      }
      return result;
    };
    const beforeInventory = flatten(before);
    const afterInventory = flatten(after);
    for (const [itemId, delta] of Object.entries(expected.inventory)) {
      compare(`inventory.${itemId}`, (beforeInventory[itemId] || 0) + delta,
        afterInventory[itemId] || 0);
    }
  }

  const mapInstanceChanged = before.map_instance_id !== after.map_instance_id;
  if (expected.map_instance_id === null && options.allowUnknownMapInstance === true) {
    if (!mapInstanceChanged) {
      differences.push({ field: "map_instance_id", expected: `different from ${before.map_instance_id}`, actual: after.map_instance_id });
    }
  } else if (expected.map_instance_id !== undefined) {
    compare("map_instance_id", expected.map_instance_id, after.map_instance_id);
  } else if (expected.floor_id === undefined) {
    compare("map_instance_id", before.map_instance_id, after.map_instance_id);
  }

  if (expected.floor_id === null && options.allowUnknownFloor === true) {
    if (!mapInstanceChanged) {
      differences.push({ field: "map_instance_id", expected: "a different map instance", actual: after.map_instance_id });
    }
  } else if (expected.floor_id !== undefined) compare("floor_id", String(expected.floor_id), after.floor_id);
  else if (!mapInstanceChanged) compare("floor_id", before.floor_id, after.floor_id);

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

  if (mapInstanceChanged) {
    return {
      ok: differences.length === 0,
      differences,
      actual: { map_instance_changed: true, removed: [], added: [] },
    };
  }
  // Validate the complete compared block sets, including blocks that were
  // actually removed or added and therefore have no same-coordinate peer.
  before.blocks.forEach(MotaLab.blockDeltaProjection);
  after.blocks.forEach(MotaLab.blockDeltaProjection);
  const beforeByCoordinate = new Map(before.blocks.map((block) => [`${block.x},${block.y}`, block]));
  const afterByCoordinate = new Map(after.blocks.map((block) => [`${block.x},${block.y}`, block]));
  const coordinates = new Set([...beforeByCoordinate.keys(), ...afterByCoordinate.keys()]);
  const removed = [];
  const added = [];
  for (const coordinate of coordinates) {
    const beforeBlock = beforeByCoordinate.get(coordinate);
    const afterBlock = afterByCoordinate.get(coordinate);
    if (beforeBlock && afterBlock
      && MotaLab.canonicalize(MotaLab.blockDeltaProjection(beforeBlock))
        === MotaLab.canonicalize(MotaLab.blockDeltaProjection(afterBlock))) continue;
    if (beforeBlock) removed.push(beforeBlock);
    if (afterBlock) added.push(afterBlock);
  }
  const expectedRemoved = expected.removed_blocks || [];
  const expectedAdded = expected.added_blocks || [];
  if (!MotaLab.compareBlockRefs(expectedRemoved, removed)) {
    differences.push({ field: "removed_blocks", expected: expectedRemoved, actual: removed });
  }
  if (!MotaLab.compareBlockRefs(expectedAdded, added)) {
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
  if (expected.inventory && typeof expected.inventory === "object"
    && !Array.isArray(expected.inventory)) {
    if (Object.values(expected.inventory).some(
      (value) => MotaLab.isFiniteInteger(value) && value !== 0,
    )) return true;
  }
  if (Object.prototype.hasOwnProperty.call(expected, "floor_id")) return true;
  if (Object.prototype.hasOwnProperty.call(expected, "map_instance_id")) return true;
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
      && !Object.prototype.hasOwnProperty.call(expected, "floor_id")
      && !Object.prototype.hasOwnProperty.call(expected, "map_instance_id")) {
      throw new TypeError("Stair boundary must declare a map transition");
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

MotaLab.waitForStability = async function waitForStability({
  adapter,
  observe,
  finalizeObservation = observe,
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
    const fingerprint = MotaLab.fingerprintRuntimeObservation(latestObservation);
    if (!latestObservation.busy && fingerprint !== preFingerprint) {
      consecutive = fingerprint === lastFingerprint ? consecutive + 1 : 1;
      lastFingerprint = fingerprint;
      if (consecutive >= stablePolls) {
        const finalObservation = finalizeObservation === observe
          ? latestObservation : finalizeObservation();
        const finalRuntimeFingerprint = MotaLab.fingerprintRuntimeObservation(finalObservation);
        if (!finalObservation.busy && finalRuntimeFingerprint === fingerprint) {
          return {
            observation: finalObservation,
            fingerprint: MotaLab.fingerprintObservation(finalObservation),
            runtime_fingerprint: finalRuntimeFingerprint,
            polls: consecutive,
          };
        }
        latestObservation = finalObservation;
        consecutive = 0;
        lastFingerprint = finalRuntimeFingerprint;
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
      const validCells = MotaLab.validCellSet(observation.topology);
      if (x < 0 || y < 0 || x >= observation.dimensions.width || y >= observation.dimensions.height
        || (validCells && !validCells.has(key))
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
  observeFast = observe,
  stabilityOptions = {},
}) {
  // The observation used to request the decision is evidence, not a lease on
  // mutable game state.  Re-read the complete current runtime immediately
  // before the first engine API call and require it to be byte-equivalent under
  // the protocol fingerprint.  This closes the in-memory scheduling window
  // between the controller guard check and actual execution.
  const executionObservation = observeFast();
  const guardResult = MotaLab.compareGuard(executionObservation, action.guard);
  if (!guardResult.ok) {
    throw MotaLab.createPauseError(
      "GUARD_MISMATCH",
      "PRE_ACTION_GUARD_MISMATCH",
      { differences: guardResult.differences, observation: executionObservation },
    );
  }
  const expectedFingerprint = MotaLab.fingerprintRuntimeObservation(initialObservation);
  const executionFingerprint = MotaLab.fingerprintRuntimeObservation(executionObservation);
  if (executionFingerprint !== expectedFingerprint) {
    throw MotaLab.createPauseError(
      "GUARD_MISMATCH",
      "PRE_ACTION_RUNTIME_CHANGED",
      {
        expected_fingerprint: expectedFingerprint,
        actual_fingerprint: executionFingerprint,
        observation: executionObservation,
      },
    );
  }
  const menuOperation = action.operations[action.operations.length - 1];
  if (menuOperation && menuOperation.type === "menu_choice") {
    if (action.action_kind !== "PURCHASE_UPGRADE") {
      throw MotaLab.createPauseError("UNSUPPORTED_INTERACTION", "SHOP_ACTION_KIND_INVALID");
    }
    const shop = (executionObservation.shops || []).find((item) => item.shop_id === menuOperation.shop_id);
    const choice = shop && shop.choices[menuOperation.choice_index];
    if (!shop || !choice || choice.choice_id !== menuOperation.choice_id
      || choice.cost !== menuOperation.expected_cost
      || choice.purchase_count !== menuOperation.expected_purchase_count
      || choice.effect.field !== menuOperation.expected_effect.field
      || choice.effect.amount !== menuOperation.expected_effect.amount) {
      throw MotaLab.createPauseError("GUARD_MISMATCH", "SHOP_PRESTATE_MISMATCH");
    }
    const gridAction = Object.assign({}, action, { operations: action.operations.slice(0, -1) });
    const gridPlan = MotaLab.planOperations(gridAction, executionObservation, registry, adapter);
    let before = executionObservation;
    for (let index = 0; index < gridPlan.length; index += 1) {
      const step = gridPlan[index];
      const isTrigger = index === gridPlan.length - 1;
      if (!isTrigger) {
        adapter.setAutomaticRoute(step.operation.x, step.operation.y);
        const settled = await MotaLab.waitForStability({ adapter, observe: observeFast,
          finalizeObservation: observeFast,
          preFingerprint: MotaLab.fingerprintRuntimeObservation(before), ...stabilityOptions });
        before = settled.observation;
        continue;
      }
      adapter.setAutomaticRoute(step.operation.x, step.operation.y);
      const deadline = Date.now() + (stabilityOptions.timeoutMs || 5000);
      let menuObservation = null;
      while (Date.now() < deadline) {
        const sampled = observeFast();
        if (sampled.active_menu && sampled.active_menu.shop_id === shop.shop_id
          && sampled.active_menu.menu_id === menuOperation.menu_id
          && sampled.active_menu.ready === true) {
          menuObservation = sampled;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, stabilityOptions.sampleMs || 25));
      }
      if (!menuObservation) {
        adapter.stopAutomaticRoute();
        throw MotaLab.createPauseError("UNSUPPORTED_INTERACTION", "SHOP_MENU_NOT_READY");
      }
      adapter.chooseShopChoice(shop, menuOperation.choice_index);
      let purchasedObservation = null;
      const purchaseDeadline = Date.now() + (stabilityOptions.timeoutMs || 5000);
      while (Date.now() < purchaseDeadline) {
        const sampled = observeFast();
        const updatedShop = (sampled.shops || []).find((item) => item.shop_id === shop.shop_id);
        const updatedChoice = updatedShop && updatedShop.choices[menuOperation.choice_index];
        if (sampled.hero.gold === executionObservation.hero.gold - menuOperation.expected_cost
          && sampled.hero[menuOperation.expected_effect.field]
            === executionObservation.hero[menuOperation.expected_effect.field]
              + menuOperation.expected_effect.amount
          && updatedChoice && updatedChoice.purchase_count === menuOperation.expected_purchase_count + 1
          && sampled.active_menu && sampled.active_menu.menu_id === menuOperation.menu_id) {
          purchasedObservation = sampled;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, stabilityOptions.sampleMs || 25));
      }
      if (!purchasedObservation) {
        throw MotaLab.createPauseError("EXPECTED_DELTA_MISMATCH", "SHOP_PURCHASE_NOT_CONFIRMED");
      }
      adapter.closeShopMenu(shop);
      const settled = await MotaLab.waitForStability({ adapter, observe: observeFast,
        finalizeObservation: observe,
        preFingerprint: MotaLab.fingerprintRuntimeObservation(menuObservation), ...stabilityOptions });
      return { observation: settled.observation, fingerprint: settled.fingerprint,
        plan: [...gridPlan, { operation: menuOperation, category: "shop" }],
        completed_operations: action.operations.length, boundary_reached: true,
        engine_timings: [] };
    }
  }
  const plan = MotaLab.planOperations(action, executionObservation, registry, adapter);
  const allowUnknownFloor = action.expected_delta.floor_id === null
    && plan.length > 0 && plan[plan.length - 1].category === "stair";
  const allowUnknownMapInstance = action.expected_delta.map_instance_id === null
    && plan.length > 0 && plan[plan.length - 1].category === "stair";
  MotaLab.validateExpectedDelta(action.expected_delta, {
    allowUnknownFloor,
    allowUnknownMapInstance,
    dimensions: executionObservation.dimensions,
    topology: executionObservation.topology,
  });
  let beforeStep = executionObservation;
  let beforeFingerprint = executionFingerprint;
  const timingNow = () => (globalThis.performance && typeof globalThis.performance.now === "function"
    ? globalThis.performance.now() : Date.now());
  const engineTimings = [];

  async function moveAndSettle(method, target, final, preFingerprint) {
    const started = timingNow();
    adapter[method](target.x, target.y);
    const settled = await MotaLab.waitForStability(Object.assign({
      adapter,
      observe: observeFast,
      finalizeObservation: final ? observe : observeFast,
      preFingerprint,
    }, stabilityOptions));
    engineTimings.push({ method, target: MotaLab.cloneJsonValue(target),
      final, settle_ms: timingNow() - started });
    return settled;
  }

  for (let index = 0; index < plan.length; index += 1) {
    const step = plan[index];
    // A boundary remains one logical action.  We only accelerate its proven
    // empty prefix and let the engine's normal route trigger the final cell.
    // No intermediate full engine catalog is rebuilt.
    if (step.boundary && step.path.length > 2) {
      const prefixPath = step.path.slice(0, -1);
      const approach = prefixPath[prefixPath.length - 1];
      if (MotaLab.isPureCorridorPath(prefixPath, executionObservation, registry)
        && adapter.canMoveDirectly(approach.x, approach.y)) {
        const prefixSettled = await moveAndSettle(
          "moveDirectly", approach, false, beforeFingerprint,
        );
        const prefixObservation = prefixSettled.observation;
        if (prefixObservation.hero.loc.x !== approach.x
          || prefixObservation.hero.loc.y !== approach.y
          || MotaLab.runtimeStateChangedBeyondPosition(beforeStep, prefixObservation)) {
          adapter.stopAutomaticRoute();
          throw MotaLab.createPauseError(
            "EXPECTED_DELTA_MISMATCH",
            "FAST_PREFIX_STATE_CHANGED",
            { operation_index: index, target: approach,
              actual: prefixObservation.hero.loc },
          );
        }
        beforeStep = prefixObservation;
        beforeFingerprint = prefixSettled.runtime_fingerprint;
      }
    }
    const useDirect = step.pure && !step.boundary
      && adapter.canMoveDirectly(step.operation.x, step.operation.y);
    const settled = await moveAndSettle(
      useDirect ? "moveDirectly" : "setAutomaticRoute",
      step.operation,
      true,
      beforeFingerprint,
    );
    const afterStep = settled.observation;
    const reachedTarget = afterStep.hero.loc.x === step.operation.x
      && afterStep.hero.loc.y === step.operation.y;
    // beforeStep can be the fast snapshot produced by an accelerated prefix,
    // while afterStep is the final complete observation.  Catalog presence is
    // an observation-shape difference, not an in-game boundary transition.
    const changedBoundary = MotaLab.runtimeStateChangedBeyondPosition(beforeStep, afterStep);

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
        engine_timings: engineTimings,
      };
    }
    if (index < plan.length - 1) {
      beforeStep = afterStep;
      beforeFingerprint = settled.runtime_fingerprint;
      continue;
    }
    return {
      observation: afterStep,
      fingerprint: settled.fingerprint,
      plan,
      completed_operations: index + 1,
      boundary_reached: step.boundary,
      engine_timings: engineTimings,
    };
  }
  throw new Error("Unreachable empty execution plan");
};

/* Ephemeral controller state.  The game runtime is authoritative; this object
 * deliberately never reads or writes GM storage/localStorage. */
MotaLab.createMemoryStorage = function createMemoryStorage() {
  return Object.freeze({
    inspect(key) { return { status: "absent", key }; },
    get(_key, fallback) { return fallback; },
    set() { throw new TypeError("Runtime persistence is disabled"); },
    delete() { return Object.freeze({ verified: true, absent: true }); },
  });
};

MotaLab.createJournal = function createJournal(_ignoredStorage) {
  const defaults = () => ({
    protocol: MotaLab.PROTOCOL_VERSION,
    autopilot_enabled: false,
    session_id: null,
    session_mode: null,
    expected_guard: null,
    baseline: null,
    service_session_confirmed: false,
    migration_required: false,
    corruption_required: false,
    legacy_archive: null,
    legacy_disposition: null,
    corrupt_archive: null,
    corrupt_disposition: null,
    corrupt_evidence: [],
    scan_state: null,
    pending_action: null,
    last_completed_action: null,
    last_acknowledged_action_id: null,
    seen_action_ids: {},
    last_pause: null,
    registry_entries: [],
  });
  let state = defaults();
  let mutations = 0;
  const clone = (value) => MotaLab.cloneJsonValue(value);
  const result = () => Object.freeze({ verified: true, memory_only: true });
  function update(mutator) { mutator(state); mutations += 1; return result(); }
  return Object.freeze({
    snapshot() { return clone(state); },
    getDiagnostics() { return { memory_only: true, mutations, persistent_writes: 0 }; },
    setAutopilot(enabled) { return update((s) => { s.autopilot_enabled = enabled === true; }); },
    establishSession({ session_id, mode, baseline, expected_guard = null }) {
      if (typeof session_id !== "string" || !session_id || !MotaLab.SESSION_MODES.includes(mode)) {
        throw new TypeError("Invalid session baseline");
      }
      return update((s) => {
        s.session_id = session_id; s.session_mode = mode; s.baseline = clone(baseline);
        s.expected_guard = expected_guard ? clone(expected_guard) : null;
        s.service_session_confirmed = false; s.pending_action = null;
        s.last_completed_action = null; s.last_acknowledged_action_id = null;
        s.seen_action_ids = {}; s.scan_state = null;
      });
    },
    markServiceSessionConfirmed() { return update((s) => { s.service_session_confirmed = true; }); },
    setPending(pending) { return update((s) => {
      s.pending_action = clone(pending); s.seen_action_ids[pending.action_id] = "pending";
    }); },
    updatePending(fields) { return update((s) => { if (s.pending_action) Object.assign(s.pending_action, clone(fields)); }); },
    abandonPending() { return update((s) => {
      if (s.pending_action) s.seen_action_ids[s.pending_action.action_id] = "abandoned";
      s.pending_action = null;
    }); },
    clearPending() { return update((s) => {
      if (s.pending_action) s.seen_action_ids[s.pending_action.action_id] = "cleared";
      s.pending_action = null;
    }); },
    markCompleted(record) { return update((s) => {
      s.last_completed_action = clone(record); delete s.last_completed_action.observation;
      s.pending_action = null; s.seen_action_ids[record.action_id] = "completed";
    }); },
    markCompletedAndAcknowledge(record, actionId) { return update((s) => {
      s.last_completed_action = clone(record); delete s.last_completed_action.observation;
      s.pending_action = null; s.seen_action_ids[record.action_id] = "completed";
      s.last_acknowledged_action_id = actionId;
    }); },
    acknowledge(actionId) { return update((s) => { s.last_acknowledged_action_id = actionId; }); },
    actionState(actionId) { return state.seen_action_ids[actionId] || null; },
    setPause(pause) { return update((s) => { s.last_pause = clone(pause); s.autopilot_enabled = false; }); },
    setRegistryEntries(entries) { return update((s) => { s.registry_entries = clone(entries); }); },
    setScanState(scanState) { return update((s) => { s.scan_state = scanState ? clone(scanState) : null; }); },
    archiveLegacyJournal() { throw new TypeError("Persistent journal is disabled"); },
    authorizeV2AfterLegacyArchive() { throw new TypeError("Persistent journal is disabled"); },
    archiveCorruptJournal() { throw new TypeError("Persistent journal is disabled"); },
    authorizeV2AfterCorruptArchive() { throw new TypeError("Persistent journal is disabled"); },
  });
};

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
  const menuOperation = Array.isArray(pending.operations)
    ? pending.operations.find((item) => item.type === "menu_choice") : null;
  if (menuOperation && observation.active_menu
    && observation.active_menu.shop_id === menuOperation.shop_id
    && observation.active_menu.menu_id === menuOperation.menu_id) {
    const before = pending.pre_observation;
    const unchanged = ["hp", "attack", "defense", "gold", "experience"].every(
      (field) => before.hero[field] === observation.hero[field],
    ) && ["yellow", "blue", "red"].every(
      (color) => before.keys[color] === observation.keys[color],
    ) && before.map_instance_id === observation.map_instance_id;
    if (unchanged) return {
      phase: "not_executed", pending_action_id: pending.action_id,
      pre_fingerprint: pending.pre_fingerprint, current_fingerprint: fingerprint,
      detail_code: "SHOP_MENU_OPEN_NOT_EXECUTED",
    };
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
        allowUnknownMapInstance: pending.allow_unknown_map_instance === true,
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
    if (menuOperation) {
      const shop = (observation.shops || []).find((item) => item.shop_id === menuOperation.shop_id);
      const choice = shop && shop.choices[menuOperation.choice_index];
      if (!choice || choice.choice_id !== menuOperation.choice_id
        || choice.purchase_count !== menuOperation.expected_purchase_count + 1) {
        return { phase: "mismatch", detail_code: "SHOP_COUNTER_MISMATCH",
          pending_action_id: pending.action_id,
          pre_fingerprint: pending.pre_fingerprint, current_fingerprint: fingerprint };
      }
    }
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

MotaLab.createLocalhostClient = function createLocalhostClient(requestImplementation, options = {}) {
  if (typeof requestImplementation !== "function") {
    throw new TypeError("A request implementation is required");
  }
  const timeout = MotaLab.isFiniteInteger(options.timeoutMs) ? options.timeoutMs : 10000;
  const endpoint = options.cycleEndpoint || MotaLab.CYCLE_ENDPOINT;
  const endpointMatch = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/cycle$/u.exec(endpoint);
  if (!endpointMatch) {
    throw new TypeError("cycleEndpoint must be an explicit 127.0.0.1 HTTP /cycle URL");
  }
  const endpointPort = Number(endpointMatch[1]);
  if (endpointPort < 1 || endpointPort > 65535) {
    throw new TypeError("cycleEndpoint port must be between 1 and 65535");
  }
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
          url: endpoint,
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

MotaLab.createPanel = function createPanel(documentObject) {
  const doc = documentObject;
  if (!doc || !doc.body) {
    return Object.freeze({ update() {}, setCollapsed() {}, bindControls() {} });
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
      #${MotaLab.PANEL_ID} .ml-controls{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:3px;margin-top:4px}
      #${MotaLab.PANEL_ID} .ml-controls button{border:1px solid #52606d;border-radius:3px;padding:2px 4px}
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
  const controls = doc.createElement("div");
  controls.className = "ml-controls";
  const controlHandlers = Object.create(null);
  for (const [key, label] of [
    ["confirm", "确认基线"], ["start", "启动"], ["pause", "暂停"],
    ["reconnect", "重连"], ["export", "导出"],
  ]) {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      if (typeof controlHandlers[key] === "function") controlHandlers[key]();
    });
    controls.appendChild(button);
  }
  body.appendChild(controls);
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
  function bindControls(handlers) {
    Object.assign(controlHandlers, handlers || {});
  }
  return Object.freeze({ update, setCollapsed, bindControls, element: root });
};

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
    ["确认新会话基线", () => controller.confirmBaseline({ mode: "new_game" })],
    ["启动自动驾驶", () => controller.start()],
    ["暂停自动驾驶", () => controller.manualPause()],
    ["导出当前层运行态", () => {
      const observation = controller.getCurrentObservation();
      if (observation) exporter(observation);
    }],
    ["清除当前内存待执行行动", () => {
      if (confirmAction("只清除本页面内存中的待执行行动，不会改变游戏现场。确定继续？")) {
        controller.clearPending();
      }
    }],
    ["仅重新连接本地决策器", () => controller.reconnectOnly()],
  ];
  for (const [label, handler] of registrations) register(label, handler);
  return registrations.map(([label]) => label);
};

MotaLab.createController = function createController(dependencies, options = {}) {
  const { adapter, journal, registry, client, panel } = dependencies;
  const observeRaw = dependencies.observe || (() => MotaLab.collectObservation(adapter));
  const observeFastRaw = dependencies.observeFast || (dependencies.observe
    ? observeRaw
    : () => MotaLab.collectObservation({
      readRuntimeSnapshot: () => adapter.readFastRuntimeSnapshot(),
    }));
  const attachSession = (observation) => {
    observation.session_id = journal.snapshot().session_id || "UNCONFIRMED";
    return observation;
  };
  const observe = () => attachSession(observeRaw());
  const observeFast = () => attachSession(observeFastRaw());
  const logger = dependencies.logger || console;
  const autoSchedule = options.autoSchedule === true;
  const shadowOnly = options.shadowOnly === true;
  const cycleDelayMs = MotaLab.isFiniteInteger(options.cycleDelayMs) ? options.cycleDelayMs : 300;
  const idleMaxDelayMs = MotaLab.isFiniteInteger(options.idleMaxDelayMs)
    ? Math.max(cycleDelayMs, options.idleMaxDelayMs) : 5000;
  const busySampleMs = MotaLab.isFiniteInteger(options.busySampleMs) ? options.busySampleMs : 100;
  const busyTimeoutMs = MotaLab.isFiniteInteger(options.busyTimeoutMs) ? options.busyTimeoutMs : 1500;
  const schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
  const sleep = dependencies.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  let state = "STOPPED";
  let currentObservation = null;
  let currentActionId = null;
  let lastReason = "等待显式确认会话基线";
  let cyclePromise = null;
  let unsafeResponseCount = 0;
  let duplicatePendingCount = 0;
  const timingNow = () => (globalThis.performance && typeof globalThis.performance.now === "function"
    ? globalThis.performance.now() : Date.now());
  const timingHistory = [];
  let activeTiming = null;
  let idleFingerprint = null;
  let idleDelayMs = cycleDelayMs;
  let loopEpoch = 0;
  const loopDiagnostics = {
    idle_probes: 0, idle_service_skips: 0, idle_wakeups: 0,
    idle_last_delay_ms: 0, busy_samples: 0, busy_waits: 0,
    busy_transient_recoveries: 0, busy_timeouts: 0,
  };

  function locationText(observation) {
    return observation
      ? `${observation.floor_name || observation.floor_id} (${observation.hero.loc.x},${observation.hero.loc.y})`
      : "—";
  }

  function refreshPanel(extra = {}) {
    let snapshot;
    try { snapshot = journal.snapshot(); }
    catch (_) {
      snapshot = { autopilot_enabled: false, last_pause: null };
    }
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
    const started = timingNow();
    try {
      currentObservation = observe();
      refreshPanel();
      if (activeTiming) activeTiming.capture_ms += timingNow() - started;
      return currentObservation;
    } catch (error) {
      if (error && error.observation) {
        currentObservation = error.observation;
        currentObservation.session_id = journal.snapshot().session_id || "UNCONFIRMED";
        refreshPanel();
      }
      throw error;
    }
  }

  function pause(
    pauseKind,
    detailCode,
    details = {},
    observation = currentObservation,
    pauseOptions = {},
  ) {
    if (!pauseOptions.skipAdapterStop) {
      try { adapter.stopAutomaticRoute(); } catch (_) { /* best-effort stop while the runtime is unavailable */ }
    }
    const evidenceBlocks = [];
    if (details.block) evidenceBlocks.push(details.block);
    if (Array.isArray(details.blocks)) evidenceBlocks.push(...details.blocks);
    const record = {
      pause_kind: pauseKind,
      detail_code: detailCode || null,
      action_id: currentActionId,
      captured_at: Date.now(),
      observation: observation ? MotaLab.recoveryObservationProjection(observation) : null,
      block_evidence: evidenceBlocks,
      details: MotaLab.compactJournalDetails(details),
    };
    try { journal.setPause(record); } catch (journalError) {
      record.journal_write_blocked = true;
      record.journal_error = journalError && journalError.message
        ? journalError.message : String(journalError);
    }
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

  function resetIdleBackoff() {
    loopEpoch += 1;
    idleFingerprint = null;
    idleDelayMs = cycleDelayMs;
    loopDiagnostics.idle_last_delay_ms = 0;
  }

  function scheduleIdleProbe(fingerprint) {
    if (!autoSchedule || !journal.snapshot().autopilot_enabled) return;
    idleFingerprint = fingerprint;
    const delay = idleDelayMs;
    loopDiagnostics.idle_last_delay_ms = delay;
    idleDelayMs = Math.min(idleMaxDelayMs, Math.max(cycleDelayMs, delay * 2));
    const scheduledEpoch = loopEpoch;
    schedule(() => {
      if (scheduledEpoch !== loopEpoch || !journal.snapshot().autopilot_enabled || cyclePromise) return;
      loopDiagnostics.idle_probes += 1;
      let observation;
      try { observation = capture(); }
      catch (error) { handleError(error); return; }
      const nextFingerprint = MotaLab.fingerprintObservation(observation);
      const snapshot = journal.snapshot();
      if (!observation.busy && !snapshot.pending_action && nextFingerprint === idleFingerprint) {
        loopDiagnostics.idle_service_skips += 1;
        scheduleIdleProbe(idleFingerprint);
        return;
      }
      loopDiagnostics.idle_wakeups += 1;
      resetIdleBackoff();
      runSingleCycle();
    }, delay);
  }

  async function waitForStableNotBusy(initialObservation) {
    let observation = initialObservation;
    let elapsed = 0;
    let clearSamples = 0;
    while (observation.busy && elapsed < busyTimeoutMs || clearSamples === 1) {
      loopDiagnostics.busy_waits += 1;
      await sleep(busySampleMs);
      elapsed += busySampleMs;
      observation = capture();
      loopDiagnostics.busy_samples += 1;
      if (observation.busy) clearSamples = 0;
      else clearSamples += 1;
      if (clearSamples >= 2) {
        loopDiagnostics.busy_transient_recoveries += 1;
        return observation;
      }
      if (elapsed >= busyTimeoutMs && observation.busy) break;
    }
    if (!observation.busy) return observation;
    loopDiagnostics.busy_timeouts += 1;
    return null;
  }

  async function initialize() {
    try {
      state = "PREFLIGHT";
      const observation = capture();
      const fingerprint = MotaLab.fingerprintObservation(observation);
      const snapshot = journal.snapshot();
      if (snapshot.corruption_required) {
        const storageUnstable = snapshot.corrupt_evidence.some(
          (item) => item.status === "storage_unstable",
        );
        return pause(
          storageUnstable ? "ENGINE_API_INCOMPATIBLE" : "GUARD_MISMATCH",
          storageUnstable ? "JOURNAL_STORAGE_UNSTABLE" : "JOURNAL_CORRUPT",
          storageUnstable
            ? { evidence: snapshot.corrupt_evidence, retry_only: true }
            : { evidence: snapshot.corrupt_evidence, required_command: "archiveCorruptJournal" },
          observation,
        );
      }
      if (snapshot.migration_required) {
        return pause(
          "GUARD_MISMATCH",
          "JOURNAL_V1_MIGRATION_REQUIRED",
          { legacy_protocol: 1, required_protocol: 2 },
          observation,
        );
      }
      if (!snapshot.baseline || !snapshot.session_id) {
        journal.setAutopilot(false);
        state = "AWAITING_BASELINE_CONFIRMATION";
        lastReason = "已读取首次稳定现场；请显式确认会话基线";
        refreshPanel({ autopilot: false, pause_kind: null });
        return {
          verified: false,
          requires_confirmation: true,
          fingerprint,
          baseline: MotaLab.baselineSummary(observation),
          auto_started: false,
        };
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

  function confirmBaseline({
    mode = "new_game",
    expected_guard = null,
    session_id = null,
  } = {}) {
    try {
      if (journal.snapshot().corruption_required) {
        const corruptSnapshot = journal.snapshot();
        const storageUnstable = corruptSnapshot.corrupt_evidence.some(
          (item) => item.status === "storage_unstable",
        );
        return pause(
          storageUnstable ? "ENGINE_API_INCOMPATIBLE" : "GUARD_MISMATCH",
          storageUnstable ? "JOURNAL_STORAGE_UNSTABLE" : "JOURNAL_CORRUPT",
          storageUnstable
            ? { evidence: corruptSnapshot.corrupt_evidence, retry_only: true }
            : { required_command: "archiveCorruptJournal + beginV2AfterCorruptArchive" },
        );
      }
      if (journal.snapshot().migration_required) {
        return pause(
          "GUARD_MISMATCH",
          "JOURNAL_V1_MIGRATION_REQUIRED",
          { required_command: "archiveLegacyJournal + beginV2AfterLegacyArchive" },
        );
      }
      if (!MotaLab.SESSION_MODES.includes(mode)) throw new TypeError("Invalid session mode");
      const observation = capture();
      const provisionalFingerprint = MotaLab.fingerprintObservation(observation);
      const id = session_id || `SESSION-${MotaLab.sha256(`${provisionalFingerprint}:${Date.now()}`).slice(0, 24)}`;
      observation.session_id = id;
      if (mode === "handoff_expected_guard") {
        if (!expected_guard) throw new TypeError("handoff_expected_guard requires expected_guard");
        const matched = MotaLab.compareGuard(observation, expected_guard);
        if (!matched.ok) {
          return pause(
            "GUARD_MISMATCH",
            "SESSION_BASELINE_MISMATCH",
            { differences: matched.differences },
            observation,
          );
        }
      }
      if (mode === "resume_existing_ledger" && !session_id) {
        throw new TypeError("resume_existing_ledger requires session_id");
      }
      const fingerprint = MotaLab.fingerprintObservation(observation);
      journal.establishSession({
        session_id: id,
        mode,
        baseline: MotaLab.baselineSummary(observation),
        expected_guard,
      });
      journal.setAutopilot(false);
      state = "BASELINE_VERIFIED";
      lastReason = `会话基线已显式确认（${mode}），等待启动`;
      refreshPanel({ autopilot: false, pause_kind: null });
      return { verified: true, session_id: id, mode, fingerprint };
    } catch (error) {
      return handleError(error, "GUARD_MISMATCH", "INVALID_SESSION_BASELINE");
    }
  }

  function archiveLegacyJournal() {
    try {
      const archive = journal.archiveLegacyJournal();
      lastReason = `v1 journal 已本地归档（${archive.archive_id.slice(0, 24)}…），仍禁止行动`;
      refreshPanel({ autopilot: false, pause_kind: "GUARD_MISMATCH" });
      return archive;
    } catch (error) {
      handleError(error, "GUARD_MISMATCH", "LEGACY_ARCHIVE_FAILED");
      return { archived: false, error: error.message };
    }
  }

  function beginV2AfterLegacyArchive({
    archive_id,
    confirmation,
    mode = "new_game",
    expected_guard = null,
    session_id = null,
  } = {}) {
    try {
      journal.authorizeV2AfterLegacyArchive({ archive_id, confirmation });
    } catch (error) {
      return pause(
        "GUARD_MISMATCH",
        "LEGACY_DISPOSITION_NOT_CONFIRMED",
        { message: error.message, archive_id: archive_id || null },
      );
    }
    return confirmBaseline({ mode, expected_guard, session_id });
  }

  function archiveCorruptJournal() {
    try {
      const archive = journal.archiveCorruptJournal();
      lastReason = `损坏 journal 摘要已归档（${archive.archive_id.slice(0, 25)}…），仍禁止行动`;
      refreshPanel({ autopilot: false, pause_kind: "GUARD_MISMATCH" });
      return archive;
    } catch (error) {
      handleError(error, "GUARD_MISMATCH", "CORRUPT_JOURNAL_ARCHIVE_FAILED");
      return { archived: false, error: error.message };
    }
  }

  function beginV2AfterCorruptArchive({
    archive_id, confirmation, mode = "new_game", expected_guard = null, session_id = null,
  } = {}) {
    try {
      journal.authorizeV2AfterCorruptArchive({ archive_id, confirmation });
    } catch (error) {
      return pause(
        "GUARD_MISMATCH", "CORRUPT_JOURNAL_DISPOSITION_NOT_CONFIRMED",
        { message: error.message, archive_id: archive_id || null },
      );
    }
    return confirmBaseline({ mode, expected_guard, session_id });
  }

  async function start() {
    try {
      const snapshot = journal.snapshot();
      if (!snapshot.baseline || !snapshot.session_id
        || snapshot.migration_required || snapshot.corruption_required) {
        const result = await initialize();
        if (!result || !result.verified) return result;
      }
      journal.setAutopilot(true);
      resetIdleBackoff();
      state = "OBSERVING";
      lastReason = "用户已启动自动驾驶";
      refreshPanel({ autopilot: true, pause_kind: null });
      return runSingleCycle();
    } catch (error) {
      return handleError(error);
    }
  }

  function manualPause() {
    try { adapter.stopAutomaticRoute(); } catch (_) { /* best-effort stop */ }
    try {
      resetIdleBackoff();
      journal.setAutopilot(false);
      state = "STOPPED";
      lastReason = "用户手动暂停";
      refreshPanel({ autopilot: false, pause_kind: null });
      return { stopped: true };
    } catch (error) {
      return handleError(error);
    }
  }

  function clearPending() {
    if (journal.snapshot().autopilot_enabled || cyclePromise || state === "EXECUTING") {
      lastReason = "请先暂停自动驾驶，待当前执行结算后再清除 pending";
      refreshPanel();
      return { cleared: false, reason: "AUTOPILOT_ACTIVE" };
    }
    try {
      journal.clearPending();
      currentActionId = null;
      lastReason = "待执行行动已清除；游戏现场未改变";
      refreshPanel();
      return { cleared: true };
    } catch (error) {
      const record = handleError(error);
      return Object.assign(record, { cleared: false });
    }
  }

  function prepareRecovery(snapshot, fingerprint) {
    const pending = snapshot.pending_action;
    if (!pending) {
      return { recovery: {
          phase: "none",
          pending_action_id: null,
          pre_fingerprint: null,
          current_fingerprint: fingerprint,
        }, completionRecord: null,
      };
    }
    const recovery = MotaLab.classifyPendingRecovery(pending, currentObservation, fingerprint);
    if (recovery.phase === "mismatch") {
      pause("EXPECTED_DELTA_MISMATCH", recovery.detail_code, recovery, currentObservation);
      return null;
    }
    const completionRecord = recovery.phase === "completed" ? {
        action_id: pending.action_id,
        fingerprint,
        completed_at: Date.now(),
        recovered: true,
      } : null;
    return { recovery, completionRecord };
  }

  async function cycleBody() {
    if (!journal.snapshot().autopilot_enabled) return { skipped: "disabled" };
    state = "OBSERVING";
    let observation = capture();
    const pendingAtCapture = journal.snapshot().pending_action;
    const pendingMenu = pendingAtCapture && Array.isArray(pendingAtCapture.operations)
      ? pendingAtCapture.operations.find((item) => item.type === "menu_choice") : null;
    const recoverableShopMenu = pendingMenu && observation.active_menu
      && observation.active_menu.shop_id === pendingMenu.shop_id
      && observation.active_menu.menu_id === pendingMenu.menu_id;
    if (observation.busy && !recoverableShopMenu) {
      const settled = await waitForStableNotBusy(observation);
      if (!settled) {
        return pause("UNSUPPORTED_INTERACTION", "GAME_BUSY_BEFORE_DECISION", {
          busy_timeout_ms: busyTimeoutMs,
          busy_sample_ms: busySampleMs,
        }, currentObservation);
      }
      observation = settled;
    }
    const fingerprint = MotaLab.fingerprintObservation(observation);
    let snapshot = journal.snapshot();
    const preparedRecovery = prepareRecovery(snapshot, fingerprint);
    if (!preparedRecovery) return { paused: true };
    const { recovery, completionRecord } = preparedRecovery;
    snapshot = journal.snapshot();
    const completedActionId = completionRecord ? completionRecord.action_id
      : snapshot.last_completed_action
      && snapshot.last_acknowledged_action_id !== snapshot.last_completed_action.action_id
      ? snapshot.last_completed_action.action_id : null;
    if (activeTiming) activeTiming.mode = completedActionId ? "ack_and_decide" : "decide";
    const request = MotaLab.createCycleRequest({
      observation,
      completedActionId,
      recovery,
      session: Object.assign({
        mode: snapshot.session_mode,
        command: snapshot.service_session_confirmed ? "observe" : "confirm",
      }, snapshot.session_mode === "handoff_expected_guard" ? {
        expected_guard: snapshot.expected_guard,
      } : {}),
    });

    state = "REQUESTING";
    let response;
    try {
      const requestStarted = timingNow();
      response = await client.postCycle(request);
      if (activeTiming) activeTiming.http_ms += timingNow() - requestStarted;
    } catch (error) {
      return pause(
        "DECISION_SERVICE_UNAVAILABLE",
        error.detail_code || "CONNECTION_FAILED",
        { message: error.message },
        observation,
      );
    }
    if (shadowOnly && response.status === "execute") {
      return pause(
        "UNSUPPORTED_INTERACTION",
        "SHADOW_EXECUTION_FORBIDDEN",
        {
          response_status: response.status,
          action_id: response.action_id,
          reason: "Stage1 shadowOnly explicitly rejects executable service responses.",
        },
        observation,
        { skipAdapterStop: true },
      );
    }
    if (completedActionId) {
      if (response.acknowledged_action_id !== completedActionId) {
        return pause(
          "DECISION_SERVICE_UNAVAILABLE", "RECOVERY_ACK_MISSING",
          { completed_action_id: completedActionId, response_status: response.status,
            acknowledged_action_id: response.acknowledged_action_id || null }, observation,
        );
      }
      if (completionRecord) journal.markCompletedAndAcknowledge(completionRecord, completedActionId);
      else journal.acknowledge(completedActionId);
    } else if (response.acknowledged_action_id) {
      return pause(
        "DECISION_SERVICE_UNAVAILABLE", "RECOVERY_ACK_IDENTITY_MISMATCH",
        { acknowledged_action_id: response.acknowledged_action_id }, observation,
      );
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
    if (!snapshot.service_session_confirmed) journal.markServiceSessionConfirmed();
    try {
      validateAndReplaceRegistry(response.registry_entries || [], observation);
      if (response.scan_state) journal.setScanState(response.scan_state);
    } catch (error) {
      return handleError(error, "DECISION_SERVICE_UNAVAILABLE", "INVALID_RESPONSE");
    }

    if (response.status === "idle") {
      state = "OBSERVING";
      lastReason = response.shadow
        ? `Shadow（只读）：${response.shadow.reason}` : response.reason;
      refreshPanel({ connected: true });
      if (journal.snapshot().pending_action || completedActionId) {
        resetIdleBackoff();
        scheduleNext();
      } else {
        scheduleIdleProbe(fingerprint);
      }
      return { idle: true };
    }

    currentActionId = response.action_id;
    lastReason = response.reason;
    refreshPanel({ connected: true, action_id: currentActionId });
    const pending = journal.snapshot().pending_action;
    let retryingSameAction = false;
    if (pending) {
      if (response.action_id === pending.action_id) {
        if (recovery.phase === "not_executed") {
          if (response.supersedes_action_id) {
            return pause(
              "DECISION_SERVICE_UNAVAILABLE",
              "INVALID_RECOVERY_REISSUE",
              {
                pending_action_id: pending.action_id,
                action_id: response.action_id,
                supersedes_action_id: response.supersedes_action_id,
              },
              observation,
            );
          }
          if (pending.rejection_detail_code) {
            unsafeResponseCount = Math.max(
              unsafeResponseCount,
              MotaLab.isFiniteInteger(pending.rejection_count) ? pending.rejection_count : 1,
            );
          }
          duplicatePendingCount = 0;
          retryingSameAction = true;
        } else {
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
      } else {
        return pause(
          "DECISION_SERVICE_UNAVAILABLE",
          "INVALID_RECOVERY_REISSUE",
          {
            pending_action_id: pending.action_id,
            action_id: response.action_id,
            supersedes_action_id: response.supersedes_action_id || null,
          },
          observation,
        );
      }
      if (!retryingSameAction) {
        journal.abandonPending();
        duplicatePendingCount = 0;
      }
    } else if (response.supersedes_action_id) {
      return pause(
        "DECISION_SERVICE_UNAVAILABLE",
        "INVALID_RECOVERY_REISSUE",
        { supersedes_action_id: response.supersedes_action_id },
        observation,
      );
    }

    const actionState = journal.actionState(response.action_id);
    if (!retryingSameAction && actionState === "completed") {
      scheduleNext();
      return { duplicate_completed: true, executed: false };
    }
    if (!retryingSameAction && actionState) {
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
    // The decision observation is the complete runtime snapshot.  Execution
    // performs a fresh lightweight guard read immediately before the engine
    // API call, so rebuilding the complete cross-floor model here is both
    // redundant and a visible main-thread stall.
    const freshObservation = observation;
    const freshFingerprint = fingerprint;
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
      const responseMenu = response.operations.find((item) => item.type === "menu_choice");
      planned = MotaLab.planOperations(responseMenu
        ? Object.assign({}, response, { operations: response.operations.filter((item) => item.type === "grid") })
        : response, freshObservation, registry, adapter);
      const allowUnknownFloor = response.expected_delta.floor_id === null
        && planned.length > 0 && planned[planned.length - 1].category === "stair";
      const allowUnknownMapInstance = response.expected_delta.map_instance_id === null
        && planned.length > 0 && planned[planned.length - 1].category === "stair";
      MotaLab.validateExpectedDelta(response.expected_delta, {
        allowUnknownFloor,
        allowUnknownMapInstance,
        dimensions: freshObservation.dimensions,
        topology: freshObservation.topology,
      });
      actionConstraints = responseMenu ? { requires_non_position_change: true }
        : MotaLab.validateActionPostconditions(planned, response.expected_delta);
    } catch (error) {
      if (MotaLab.isPauseError(error)
        && ["UNSAFE_MULTI_BOUNDARY_RESPONSE", "UNSAFE_ROUTE_RESPONSE"].includes(error.detail_code)) {
        unsafeResponseCount += 1;
        if (unsafeResponseCount < 2) {
          journal.setPending({
            action_id: response.action_id,
            pre_fingerprint: freshFingerprint,
            pre_observation: MotaLab.recoveryObservationProjection(freshObservation),
            guard: response.guard,
            expected_delta: response.expected_delta,
            allow_unknown_floor: response.expected_delta.floor_id === null,
            allow_unknown_map_instance: response.expected_delta.map_instance_id === null,
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
      pre_observation: MotaLab.recoveryObservationProjection(freshObservation),
      guard: response.guard,
      expected_delta: response.expected_delta,
      requires_non_position_change: actionConstraints.requires_non_position_change,
      allow_unknown_floor: response.expected_delta.floor_id === null,
      allow_unknown_map_instance: response.expected_delta.map_instance_id === null,
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
        observeFast,
        stabilityOptions: options.stabilityOptions || {},
      });
      if (activeTiming) activeTiming.engine = result.engine_timings || [];
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
        allowUnknownMapInstance: pendingRecord.allow_unknown_map_instance,
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
      completed_at: Date.now(),
      recovered: false,
    });
    resetIdleBackoff();
    state = "REPORTING";
    lastReason = `行动 ${response.action_id} 已完成并通过差分校验`;
    refreshPanel();
    scheduleNext(0);
    return { completed: true, action_id: response.action_id, result };
  }

  function runSingleCycle() {
    if (cyclePromise) return cyclePromise;
    activeTiming = { started_at: Date.now(), started_ms: timingNow(), mode: "unknown",
      capture_ms: 0, http_ms: 0, engine: [] };
    cyclePromise = cycleBody().catch((error) => handleError(error))
      .finally(() => {
        activeTiming.total_ms = timingNow() - activeTiming.started_ms;
        delete activeTiming.started_ms;
        activeTiming.journal = typeof journal.getDiagnostics === "function"
          ? journal.getDiagnostics() : null;
        timingHistory.push(activeTiming);
        if (timingHistory.length > 32) timingHistory.shift();
        activeTiming = null;
        cyclePromise = null;
      });
    return cyclePromise;
  }

  async function reconnectOnly() {
    try {
      if (journal.snapshot().corruption_required) {
        return pause(
          "GUARD_MISMATCH",
          "JOURNAL_CORRUPT",
          { reconnect_blocked: true },
        );
      }
      if (journal.snapshot().migration_required) {
        return pause(
          "GUARD_MISMATCH",
          "JOURNAL_V1_MIGRATION_REQUIRED",
          { reconnect_blocked: true },
        );
      }
      const observation = capture();
      const fingerprint = MotaLab.fingerprintObservation(observation);
      let snapshot = journal.snapshot();
      const preparedRecovery = prepareRecovery(snapshot, fingerprint);
      if (!preparedRecovery) return { connected: false, paused: true, executed: false };
      const { recovery, completionRecord } = preparedRecovery;
      snapshot = journal.snapshot();
      const completedActionId = completionRecord ? completionRecord.action_id
        : snapshot.last_completed_action
        && snapshot.last_acknowledged_action_id !== snapshot.last_completed_action.action_id
        ? snapshot.last_completed_action.action_id : null;
      const request = MotaLab.createCycleRequest({
        observation,
        completedActionId,
        recovery,
        intent: "reconnect_only",
        session: snapshot.session_id ? Object.assign({
          mode: snapshot.session_mode,
          command: "observe",
        }, snapshot.session_mode === "handoff_expected_guard" ? {
          expected_guard: snapshot.expected_guard,
        } : {}) : { mode: "new_game", command: "observe" },
      });
      const response = await client.postCycle(request);
      if (response.status === "execute") {
        const record = pause(
          shadowOnly ? "UNSUPPORTED_INTERACTION" : "DECISION_SERVICE_UNAVAILABLE",
          shadowOnly ? "SHADOW_EXECUTION_FORBIDDEN" : "RECONNECT_UNEXPECTED_EXECUTE",
          {
            response_status: response.status,
            action_id: response.action_id,
            response_fingerprint: `sha256:${MotaLab.sha256(MotaLab.canonicalize(response))}`,
            guard: MotaLab.cloneJsonValue(response.guard),
          },
          observation,
          shadowOnly ? { skipAdapterStop: true } : {},
        );
        return Object.assign(record, {
          connected: false, response_status: "execute", executed: false,
        });
      }
      if (response.status === "pause") {
        const record = pause(
          response.pause_kind, response.detail_code, response.details || {}, observation,
        );
        return Object.assign(record, { connected: false, response_status: "pause", executed: false });
      }
      if (response.status === "error") {
        const record = pause(
          "DECISION_SERVICE_UNAVAILABLE", response.error_code,
          { reason: response.reason, errors: response.errors || [] }, observation,
        );
        return Object.assign(record, { connected: false, response_status: "error", executed: false });
      }
      if (completedActionId) {
        if (response.status !== "idle" || response.acknowledged_action_id !== completedActionId) {
          const record = pause(
            "DECISION_SERVICE_UNAVAILABLE", "RECOVERY_ACK_MISSING",
            { completed_action_id: completedActionId, response_status: response.status,
              acknowledged_action_id: response.acknowledged_action_id || null }, observation,
          );
          return Object.assign(record, { connected: false, response_status: response.status, executed: false });
        }
        if (completionRecord) journal.markCompleted(completionRecord);
        journal.acknowledge(completedActionId);
      } else if (response.acknowledged_action_id) {
        const record = pause(
          "DECISION_SERVICE_UNAVAILABLE", "RECOVERY_ACK_IDENTITY_MISMATCH",
          { acknowledged_action_id: response.acknowledged_action_id }, observation,
        );
        return Object.assign(record, { connected: false, response_status: response.status, executed: false });
      }
      validateAndReplaceRegistry(response.registry_entries || [], observation);
      if (response.scan_state) journal.setScanState(response.scan_state);
      lastReason = "localhost 重新连接成功；未执行返回行动";
      refreshPanel({ connected: true });
      return { connected: true, response_status: response.status, executed: false };
    } catch (error) {
      const record = MotaLab.isPauseError(error)
        ? handleError(error)
        : pause(
          "DECISION_SERVICE_UNAVAILABLE",
          error.detail_code || "CONNECTION_FAILED",
          { message: error.message },
        );
      return Object.assign(record, { connected: false, executed: false });
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

  function getLegacyArchive() {
    const archive = journal.snapshot().legacy_archive;
    return archive ? MotaLab.cloneJsonValue(archive) : null;
  }

  function getCorruptArchive() {
    const archive = journal.snapshot().corrupt_archive;
    return archive ? MotaLab.cloneJsonValue(archive) : null;
  }

  return Object.freeze({
    initialize,
    confirmBaseline,
    archiveLegacyJournal,
    beginV2AfterLegacyArchive,
    archiveCorruptJournal,
    beginV2AfterCorruptArchive,
    start,
    manualPause,
    clearPending,
    reconnectOnly,
    runSingleCycle,
    getCurrentObservation,
    getLegacyArchive,
    getCorruptArchive,
    getDiagnostics() {
      return {
        cycles: MotaLab.cloneJsonValue(timingHistory),
        active: activeTiming ? MotaLab.cloneJsonValue(activeTiming) : null,
        journal: typeof journal.getDiagnostics === "function" ? journal.getDiagnostics() : null,
        loop: MotaLab.cloneJsonValue(loopDiagnostics),
      };
    },
    getState: () => state,
  });
};

MotaLab.main = async function main() {
  const environment = MotaLab.createRuntimeEnvironment(globalThis);
  const panel = MotaLab.createPanel(document);
  try {
    environment.assertAvailable();
  } catch (error) {
    const detailCode = error && error.detail_code
      ? error.detail_code : "USERSCRIPT_API_UNAVAILABLE";
    panel.update({
      autopilot: false,
      action_id: null,
      location: null,
      reason: detailCode,
      connected: false,
      pause_kind: "ENGINE_API_INCOMPATIBLE",
    });
    console.error("[Mota Planning Lab pause]", {
      pause_kind: "ENGINE_API_INCOMPATIBLE",
      detail_code: detailCode,
      details: error && error.details ? error.details : {},
    });
    globalThis.__motaPlanningLab = Object.freeze({
      controller: null,
      capabilities: () => ({ runtime_environment: false }),
      currentObservation: () => null,
      mode: environment.mode,
      available: false,
    });
    return;
  }
  const adapter = MotaLab.createEngineAdapter();
  const journal = MotaLab.createJournal();
  const registry = MotaLab.createBlockRegistry();
  const client = MotaLab.createLocalhostClient(environment.request);
  const controller = MotaLab.createController(
    { adapter, journal, registry, client, panel },
    { autoSchedule: true, shadowOnly: true },
  );
  const exportCurrent = () => {
    const observation = controller.getCurrentObservation();
    if (observation) MotaLab.downloadObservation(observation);
  };
  panel.bindControls({
    confirm: () => controller.confirmBaseline({ mode: "new_game" }),
    start: () => controller.start(),
    pause: () => controller.manualPause(),
    reconnect: () => controller.reconnectOnly(),
    export: exportCurrent,
  });
  if (environment.registerMenu) {
    MotaLab.registerMenus({ register: environment.registerMenu, controller });
  }
  globalThis.__motaPlanningLab = Object.freeze({
    controller,
    capabilities: () => adapter.capabilities(),
    currentObservation: () => controller.getCurrentObservation(),
    mode: environment.mode,
  });
  await controller.initialize();
};

MotaLab.main().catch((error) => {
  console.error("[Mota Planning Lab fatal]", {
    message: error && error.message ? error.message : String(error),
  });
});
})();
