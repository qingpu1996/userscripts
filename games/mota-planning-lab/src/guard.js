MotaLab.compareGuard = function compareGuard(observation, guard) {
  const differences = [];
  function compare(field, expected, actual, required = true) {
    if (!required) return;
    if (expected !== actual) differences.push({ field, expected, actual });
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

MotaLab.compareInitialBaseline = function compareInitialBaseline(observation) {
  const baseline = MotaLab.INITIAL_BASELINE;
  const guard = {
    floor: baseline.floor_number,
    position: baseline.hero.loc,
    hp: baseline.hero.hp,
    attack: baseline.hero.attack,
    defense: baseline.hero.defense,
    gold: baseline.hero.gold,
    experience: baseline.hero.experience,
    keys: baseline.keys,
  };
  return MotaLab.compareGuard(observation, guard);
};
