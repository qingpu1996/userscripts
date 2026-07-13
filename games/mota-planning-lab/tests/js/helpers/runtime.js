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
    enemyInfo: [],
    damage: [],
    direct: [],
    route: [],
    stop: 0,
    saveLoad: 0,
    forbidden: [],
  };
  const currentFloorId = options.floorId || "synthetic-floor-4";
  const hero = options.hero || {
    hp: 208,
    atk: 23,
    def: 21,
    money: 16,
    experience: 63,
    loc: { x: 8, y: 3, direction: "down" },
    items: { keys: { yellowKey: 4, blueKey: 1, redKey: 0 } },
  };
  const currentMap = Object.assign({ title: "4F", width: 11, height: 11 }, options.currentMap || {});
  const maps = new Proxy({}, {
    get(_target, key) {
      calls.mapKeys.push(String(key));
      if (String(key) !== String(currentFloorId)) throw new Error(`poison map read: ${String(key)}`);
      return currentMap;
    },
  });
  const statusTarget = {
    floorId: currentFloorId,
    hero,
    maps,
    lockControl: options.lockControl === true,
    event: options.event || null,
  };
  const status = new Proxy(statusTarget, {
    get(target, key) {
      if (!Reflect.has(target, key)) throw new Error(`poison status read: ${String(key)}`);
      return target[key];
    },
    set() { throw new Error("runtime status write"); },
  });
  const blocks = options.blocks || [];
  const allowed = {
    status,
    getMapBlocksObj(floorId, includeDisabled) {
      if (String(floorId) !== String(currentFloorId) || includeDisabled !== true) {
        throw new Error("wrong current block request");
      }
      return blocks;
    },
    getEnemyInfo(id, heroArgument, x, y, floorId) {
      calls.enemyInfo.push({ id, heroArgument, x, y, floorId });
      return (options.enemyInfo && options.enemyInfo[id])
        || { hp: 100, atk: 10, def: 5, money: 5, experience: 4, special: [] };
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
      if (options.onDirect) options.onDirect(x, y, hero);
      return true;
    },
    setAutomaticRoute(x, y, suffix) {
      calls.route.push({ x, y, suffix });
      if (options.onRoute) options.onRoute(x, y, hero);
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
    set() { throw new Error("runtime write"); },
  });
  return { scope: { core }, calls, hero };
}

module.exports = {
  loadRuntime,
  makeObservation,
  makeGuard,
  makePoisonCore,
  projectDir,
  repoDir,
};
