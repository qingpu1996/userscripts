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
  MotaLab.assertProtocolShape(value, ["mode", "reason", "cycle"], ["observation", "analysis"], "shadow");
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
  if (value.analysis !== undefined) {
    MotaLab.assertProtocolShape(value.analysis, [
      "scope", "reachable_cell_count", "candidate_limit", "total_candidate_count", "truncated", "candidates",
    ], ["global"], "shadow.analysis");
    if (value.analysis.scope !== "current_floor_immediate"
      || !MotaLab.isFiniteInteger(value.analysis.reachable_cell_count)
      || value.analysis.reachable_cell_count < 1
      || !MotaLab.isFiniteInteger(value.analysis.candidate_limit)
      || value.analysis.candidate_limit < 1 || value.analysis.candidate_limit > 256
      || !MotaLab.isFiniteInteger(value.analysis.total_candidate_count)
      || value.analysis.total_candidate_count < 0
      || typeof value.analysis.truncated !== "boolean"
      || !Array.isArray(value.analysis.candidates)
      || value.analysis.candidates.length > value.analysis.candidate_limit
      || value.analysis.total_candidate_count < value.analysis.candidates.length
      || value.analysis.truncated !== (value.analysis.total_candidate_count > value.analysis.candidate_limit)) {
      throw new TypeError("Invalid shadow analysis");
    }
    const candidateIds = new Set();
    const kinds = new Set(["enemy", "door", "resource", "stair"]);
    const feasibilities = new Set(["known_feasible", "known_lethal", "missing_key", "unknown_cost"]);
    for (const candidate of value.analysis.candidates) {
      MotaLab.assertProtocolShape(candidate, [
        "candidate_id", "kind", "block_id", "numeric_id", "x", "y", "distance",
        "feasibility", "hp_loss", "key_cost",
      ], [], "shadow candidate");
      MotaLab.validateProtocolString(candidate.candidate_id, "shadow candidate_id", 1, 768);
      MotaLab.validateProtocolString(candidate.block_id, "shadow candidate block_id", 1, 256);
      if (candidateIds.has(candidate.candidate_id)) throw new TypeError("Duplicate shadow candidate_id");
      candidateIds.add(candidate.candidate_id);
      if (!kinds.has(candidate.kind) || !feasibilities.has(candidate.feasibility)
        || !MotaLab.isFiniteInteger(candidate.numeric_id) || candidate.numeric_id < 0
        || !MotaLab.isFiniteInteger(candidate.x) || candidate.x < 0 || candidate.x > 255
        || !MotaLab.isFiniteInteger(candidate.y) || candidate.y < 0 || candidate.y > 255
        || !MotaLab.isFiniteInteger(candidate.distance) || candidate.distance < 1
        || !(candidate.hp_loss === null
          || (MotaLab.isFiniteInteger(candidate.hp_loss) && candidate.hp_loss >= 0))) {
        throw new TypeError("Invalid shadow candidate");
      }
      const keyCost = MotaLab.validateResponseKeys(candidate.key_cost, "shadow candidate key_cost");
      if ([keyCost.yellow, keyCost.blue, keyCost.red].some((cost) => cost > 1)) {
        throw new TypeError("Invalid shadow candidate key_cost");
      }
    }
    if (value.analysis.global !== undefined) {
      const global = value.analysis.global;
      MotaLab.assertProtocolShape(global, [
        "scope", "proof", "reason", "truncated", "explored_states", "blockers", "route", "first_suggestion",
      ], ["terminal_hp", "terminal_attack", "terminal_defense"], "shadow.analysis.global");
      if (global.scope !== "global_terminal_route"
        || !new Set(["proven", "unproven", "unsupported"]).has(global.proof)
        || typeof global.reason !== "string" || global.reason.length < 1 || global.reason.length > 512
        || typeof global.truncated !== "boolean"
        || !MotaLab.isFiniteInteger(global.explored_states) || global.explored_states < 0
        || !Array.isArray(global.blockers) || global.blockers.length > 65536
        || !(global.terminal_hp === undefined
          || (typeof global.terminal_hp === "number" && Number.isFinite(global.terminal_hp) && global.terminal_hp > 0))
        || !(global.terminal_attack === undefined
          || (typeof global.terminal_attack === "number" && Number.isFinite(global.terminal_attack) && global.terminal_attack >= 0))
        || !(global.terminal_defense === undefined
          || (typeof global.terminal_defense === "number" && Number.isFinite(global.terminal_defense) && global.terminal_defense >= 0))) {
        throw new TypeError("Invalid global shadow analysis");
      }
      for (const blocker of global.blockers) {
        MotaLab.assertProtocolShape(blocker, ["code", "detail"], [], "global shadow blocker");
        MotaLab.validateProtocolString(blocker.code, "global shadow blocker.code", 1, 256);
        MotaLab.validateProtocolString(blocker.detail, "global shadow blocker.detail", 1, 512);
      }
      const forbidden = new Set(["action", "action_id", "execute", "operation", "operations", "guard"]);
      const inspect = (item) => {
        if (!item || typeof item !== "object") return;
        for (const [key, child] of Object.entries(item)) {
          if (forbidden.has(key)) throw new TypeError("Executable field in global shadow analysis");
          inspect(child);
        }
      };
      inspect(global);
      const validateStep = (step) => {
        if (!MotaLab.isProtocolObject(step) || typeof step.step_kind !== "string"
          || typeof step.floor_id !== "string" || step.floor_id.length < 1) {
          throw new TypeError("Invalid global shadow step");
        }
        const positioned = ["door", "enemy", "resource", "transition", "event"].includes(step.step_kind);
        const required = positioned
          ? ["step_kind", "floor_id", "x", "y", "block_id", "details"]
          : step.step_kind === "shop"
            ? ["step_kind", "floor_id", "shop_id", "choice_id", "details"]
            : step.step_kind === "terminal"
              ? ["step_kind", "floor_id", "x", "y", "details"] : null;
        if (!required) throw new TypeError("Invalid global shadow step kind");
        MotaLab.assertProtocolShape(step, required, [], "global shadow step");
        if (positioned || step.step_kind === "terminal") {
          if (!MotaLab.isFiniteInteger(step.x) || step.x < 0 || step.x > 255
            || !MotaLab.isFiniteInteger(step.y) || step.y < 0 || step.y > 255
            || (positioned && (typeof step.block_id !== "string" || step.block_id.length < 1))) {
            throw new TypeError("Invalid global shadow step position");
          }
        }
        if (!MotaLab.isProtocolObject(step.details)) throw new TypeError("Invalid global step details");
        if (step.step_kind === "door") {
          MotaLab.assertProtocolShape(step.details, ["key_cost"], [], "door details");
          MotaLab.validateResponseKeys(step.details.key_cost, "door key_cost");
        } else if (step.step_kind === "enemy") {
          MotaLab.assertProtocolShape(step.details, ["hp_loss"], [], "enemy details");
          if (typeof step.details.hp_loss !== "number" || !Number.isFinite(step.details.hp_loss)
            || step.details.hp_loss < 0) throw new TypeError("Invalid enemy details");
        } else if (step.step_kind === "resource") {
          MotaLab.assertProtocolShape(step.details,
            ["hp", "attack", "defense", "gold", "experience", "level", "keys", "inventory"], ["multiply"], "resource details");
          for (const field of ["hp", "attack", "defense", "gold", "experience", "level"]) {
            if (!MotaLab.isFiniteInteger(step.details[field]) || step.details[field] < 0) throw new TypeError("Invalid resource details");
          }
          MotaLab.validateResponseKeys(step.details.keys, "resource keys");
          if (!MotaLab.isProtocolObject(step.details.inventory)
            || Object.values(step.details.inventory).some((count) => !MotaLab.isFiniteInteger(count) || count < 0)) {
            throw new TypeError("Invalid resource inventory");
          }
        } else if (step.step_kind === "shop") {
          MotaLab.assertProtocolShape(step.details,
            ["currency", "cost", "purchase_count_before", "effects"], [], "shop details");
          if (typeof step.shop_id !== "string" || typeof step.choice_id !== "string"
            || !MotaLab.isFiniteInteger(step.details.cost) || step.details.cost < 1
            || !MotaLab.isFiniteInteger(step.details.purchase_count_before)
            || step.details.purchase_count_before < 0
            || !new Set(["gold", "experience", "yellow", "blue", "red"]).has(step.details.currency)
            || !Array.isArray(step.details.effects) || step.details.effects.length < 1) {
            throw new TypeError("Invalid shop step");
          }
        } else if (step.step_kind === "event") {
          MotaLab.assertProtocolShape(step.details, ["event_id"], [], "event details");
          MotaLab.validateProtocolString(step.details.event_id, "event_id", 1, 128);
        } else if (Object.keys(step.details).length !== 0) {
          throw new TypeError("Invalid empty global step details");
        }
      };
      if ((global.proof === "proven") !== (global.route !== null)
        || (global.route === null) !== (global.first_suggestion === null)
        || (global.proof === "proven") !== (global.terminal_hp !== undefined)
        || (global.proof === "proven") !== (global.terminal_attack !== undefined)
        || (global.proof === "proven") !== (global.terminal_defense !== undefined)
        || global.truncated !== (global.proof === "unproven" && global.reason === "search_budget_exhausted")
        || (global.reason === "search_budget_exhausted")
          !== (global.proof === "unproven" && global.truncated)) {
        throw new TypeError("Invalid global proof contract");
      }
      if (global.route !== null) {
        MotaLab.assertProtocolShape(global.route, ["step_count", "steps"], [], "global route");
        if (!Array.isArray(global.route.steps) || global.route.steps.length < 1
          || global.route.step_count !== global.route.steps.length) throw new TypeError("Invalid global route");
        global.route.steps.forEach(validateStep);
        validateStep(global.first_suggestion);
        if (MotaLab.canonicalize(global.first_suggestion)
          !== MotaLab.canonicalize(global.route.steps[0])) throw new TypeError("Invalid first suggestion");
      }
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
