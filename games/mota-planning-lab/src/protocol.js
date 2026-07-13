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
