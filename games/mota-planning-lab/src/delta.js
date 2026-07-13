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
