const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectDir = path.resolve(__dirname, "../../..");
const repoDir = path.resolve(projectDir, "../..");

function loadRuntime() {
  const config = JSON.parse(fs.readFileSync(path.join(projectDir, "userscript.config.json"), "utf8"));
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Math,
    Map,
    Set,
    Object,
    Array,
    Number,
    String,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Promise,
    encodeURIComponent,
    unescape,
  });
  for (const source of config.sources.filter((file) => !file.endsWith("/main.js"))) {
    vm.runInContext(fs.readFileSync(path.join(repoDir, source), "utf8"), context, { filename: source });
  }
  return vm.runInContext("MotaLab", context);
}

function makeObservation(overrides = {}) {
  const base = {
    protocol: 2,
    page: "/games/24/",
    session_id: "SESSION-SYNTHETIC-0001",
    floor_id: "synthetic-floor-4",
    floor_name: "4F",
    floor_number: 4,
    dimensions: { width: 11, height: 11 },
    topology: {
      kind: "rectangle",
      source: "engine_current_map",
      confidence: "confirmed",
    },
    topology_fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    map_instance_id: "map:synthetic-floor-4:topology-a",
    hero: {
      hp: 208,
      attack: 23,
      defense: 21,
      gold: 16,
      experience: 63,
      loc: { x: 8, y: 3, direction: "down" },
    },
    keys: { yellow: 4, blue: 1, red: 0 },
    busy: false,
    blocks: [],
    captured_at: 1234567890,
  };
  const value = JSON.parse(JSON.stringify(base));
  if (overrides.hero) {
    if (overrides.hero.loc) Object.assign(value.hero.loc, overrides.hero.loc);
    Object.assign(value.hero, overrides.hero);
    if (overrides.hero.loc) value.hero.loc = Object.assign({}, base.hero.loc, overrides.hero.loc);
  }
  if (overrides.keys) Object.assign(value.keys, overrides.keys);
  for (const [key, item] of Object.entries(overrides)) {
    if (!["hero", "keys"].includes(key)) value[key] = item;
  }
  return value;
}

function makeGuard(observation = makeObservation()) {
  return {
    session_id: "SESSION-SYNTHETIC-0001",
    floor_id: observation.floor_id,
    floor: observation.floor_number,
    map_instance_id: observation.map_instance_id,
    dimensions: Object.assign({}, observation.dimensions),
    topology_fingerprint: observation.topology_fingerprint,
    position: {
      x: observation.hero.loc.x,
      y: observation.hero.loc.y,
      direction: observation.hero.loc.direction,
    },
    hp: observation.hero.hp,
    attack: observation.hero.attack,
    defense: observation.hero.defense,
    gold: observation.hero.gold,
    experience: observation.hero.experience,
    keys: Object.assign({}, observation.keys),
  };
}

function makePoisonCore(options = {}) {
  const calls = {
    mapKeys: [],
    blocks: 0,
    enemyInfo: [],
    damage: [],
    direct: [],
    route: [],
    stop: 0,
    saveLoad: 0,
    forbidden: [],
    authoritativeWrites: [],
    illegalWrites: [],
  };
  const instrumentAuthority = options.instrumentAuthority === true;
  let activeActionApi = null;
  const proxyCache = new WeakMap();
  function authorityWrite(pathLabel, operation, callback, legacyMessage) {
    if (!instrumentAuthority) throw new Error(legacyMessage);
    const evidence = { api: activeActionApi, path: pathLabel, operation };
    if (!activeActionApi) {
      calls.illegalWrites.push(evidence);
      throw new Error(`authoritative state ${operation} outside public action API: ${pathLabel}`);
    }
    calls.authoritativeWrites.push(evidence);
    return callback();
  }
  function authorityProxy(value, pathLabel) {
    if (!instrumentAuthority || !value || typeof value !== "object") return value;
    if (proxyCache.has(value)) return proxyCache.get(value);
    const proxy = new Proxy(value, {
      get(target, key) {
        return authorityProxy(Reflect.get(target, key), `${pathLabel}.${String(key)}`);
      },
      set(target, key, next) {
        const path = `${pathLabel}.${String(key)}`;
        return authorityWrite(path, "set", () => Reflect.set(target, key, next), "runtime write");
      },
      deleteProperty(target, key) {
        const path = `${pathLabel}.${String(key)}`;
        return authorityWrite(path, "delete", () => Reflect.deleteProperty(target, key), "runtime delete");
      },
      defineProperty(target, key, descriptor) {
        const path = `${pathLabel}.${String(key)}`;
        return authorityWrite(path, "define", () => Reflect.defineProperty(target, key, descriptor), "runtime define");
      },
    });
    proxyCache.set(value, proxy);
    return proxy;
  }
  function withActionApi(api, callback) {
    assertNoNestedAction();
    activeActionApi = api;
    try { return callback(); } finally { activeActionApi = null; }
  }
  function assertNoNestedAction() {
    if (activeActionApi) throw new Error(`nested public action API: ${activeActionApi}`);
  }
  const currentFloorId = options.floorId || "synthetic-floor-4";
  const heroSeed = options.hero || {
    hp: 208,
    atk: 23,
    def: 21,
    money: 16,
    experience: 63,
    loc: { x: 8, y: 3, direction: "down" },
    items: { keys: { yellowKey: 4, blueKey: 1, redKey: 0 } },
  };
  const hero = authorityProxy(instrumentAuthority
    ? JSON.parse(JSON.stringify(heroSeed)) : heroSeed, "hero");
  const currentMapSeed = Object.assign({ title: "4F", width: 11, height: 11 }, options.currentMap || {});
  const currentMap = authorityProxy(instrumentAuthority
    ? JSON.parse(JSON.stringify(currentMapSeed)) : currentMapSeed, "maps.current");
  const mapsTarget = {};
  const maps = new Proxy(mapsTarget, {
    get(target, key) {
      calls.mapKeys.push(String(key));
      if (String(key) !== String(currentFloorId)) throw new Error(`poison map read: ${String(key)}`);
      return currentMap;
    },
    set(target, key, next) {
      return authorityWrite(`maps.${String(key)}`, "set", () => Reflect.set(target, key, next), "runtime maps write");
    },
    deleteProperty(target, key) {
      return authorityWrite(`maps.${String(key)}`, "delete", () => Reflect.deleteProperty(target, key), "runtime maps delete");
    },
    defineProperty(target, key, descriptor) {
      return authorityWrite(`maps.${String(key)}`, "define", () => Reflect.defineProperty(target, key, descriptor), "runtime maps define");
    },
  });
  const statusTarget = {
    floorId: currentFloorId,
    hero,
    maps,
    lockControl: options.lockControl === true,
    event: options.event || null,
    automaticRoute: options.automaticRoute || { autoHeroMove: false },
  };
  const status = new Proxy(statusTarget, {
    get(target, key) {
      if (!Reflect.has(target, key)) throw new Error(`poison status read: ${String(key)}`);
      return target[key];
    },
    set(target, key, next) {
      return authorityWrite(`status.${String(key)}`, "set", () => Reflect.set(target, key, next), "runtime status write");
    },
    deleteProperty(target, key) {
      return authorityWrite(`status.${String(key)}`, "delete", () => Reflect.deleteProperty(target, key), "runtime status delete");
    },
    defineProperty(target, key, descriptor) {
      return authorityWrite(`status.${String(key)}`, "define", () => Reflect.defineProperty(target, key, descriptor), "runtime status define");
    },
  });
  const blocksSeed = options.blocks || [];
  const blocks = authorityProxy(instrumentAuthority
    ? JSON.parse(JSON.stringify(blocksSeed)) : blocksSeed, "blocks");
  const authority = Object.freeze({ hero, blocks, currentMap });
  const allowed = {
    status,
    floors: null,
    getMapBlocksObj(floorId, includeDisabled) {
      if (String(floorId) !== String(currentFloorId) || includeDisabled !== true) {
        throw new Error("wrong current block request");
      }
      calls.blocks += 1;
      if (options.onBlocks) options.onBlocks(calls.blocks, hero);
      return blocks;
    },
    getEnemyInfo(id, heroArgument, x, y, floorId) {
      calls.enemyInfo.push({ id, heroArgument, x, y, floorId });
      const info = (options.enemyInfo && options.enemyInfo[id])
        || { hp: 100, atk: 10, def: 5, money: 5, experience: 4, special: [] };
      return authorityProxy(instrumentAuthority
        ? JSON.parse(JSON.stringify(info)) : info, `enemies.${String(id)}`);
    },
    getDamage(id, x, y, floorId) {
      calls.damage.push({ id, x, y, floorId });
      return options.damage && Object.prototype.hasOwnProperty.call(options.damage, id)
        ? options.damage[id] : 0;
    },
    isMoving() { return options.moving === true; },
    canMoveDirectly(x, y) {
      return options.canDirect === undefined ? true : options.canDirect(x, y);
    },
    moveDirectly(x, y) {
      calls.direct.push({ x, y });
      if (options.onDirect) withActionApi("moveDirectly", () => options.onDirect(x, y, hero, authority));
      return true;
    },
    setAutomaticRoute(x, y, suffix) {
      calls.route.push({ x, y, suffix });
      if (options.onRoute) {
        withActionApi("setAutomaticRoute", () => options.onRoute(x, y, hero, authority));
      }
      return true;
    },
    stopAutomaticRoute() { calls.stop += 1; },
    doSL() { calls.saveLoad += 1; },
  };
  const core = new Proxy(allowed, {
    get(target, key) {
      if (!Reflect.has(target, key)) {
        calls.forbidden.push(String(key));
        throw new Error(`poison runtime read: ${String(key)}`);
      }
      return target[key];
    },
    set(target, key, next) {
      return authorityWrite(`core.${String(key)}`, "set", () => Reflect.set(target, key, next), "runtime write");
    },
    deleteProperty(target, key) {
      return authorityWrite(`core.${String(key)}`, "delete", () => Reflect.deleteProperty(target, key), "runtime delete");
    },
    defineProperty(target, key, descriptor) {
      return authorityWrite(`core.${String(key)}`, "define", () => Reflect.defineProperty(target, key, descriptor), "runtime define");
    },
  });
  return { scope: { core }, calls, hero, authority };
}

module.exports = {
  loadRuntime,
  makeObservation,
  makeGuard,
  makePoisonCore,
  projectDir,
  repoDir,
};
