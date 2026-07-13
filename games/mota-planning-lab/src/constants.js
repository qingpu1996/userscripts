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
