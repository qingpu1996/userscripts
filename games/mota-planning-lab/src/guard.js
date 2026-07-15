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
