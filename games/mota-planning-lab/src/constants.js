const MotaLab = Object.create(null);

MotaLab.PROTOCOL_VERSION = 2;
MotaLab.SOURCE = "mota-planning-lab-userscript";
MotaLab.PAGE = "/games/24/";
MotaLab.CYCLE_ENDPOINT = "http://127.0.0.1:18724/cycle";
MotaLab.MAX_MAP_AXIS = 256;
MotaLab.MAX_MAP_CELLS = 65536;
MotaLab.MAX_BLOCKS = 8192;
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
