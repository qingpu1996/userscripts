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
  // the protocol fingerprint.  This closes the journal-persistence window
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
