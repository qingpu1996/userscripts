MotaLab.parseFloorNumber = function parseFloorNumber(floorName, floorId) {
  for (const candidate of [floorName, floorId]) {
    if (typeof candidate !== "string") continue;
    const match = candidate.trim().match(/(?:^|[^0-9])(\d{1,3})\s*F(?:$|[^A-Za-z])/i)
      || candidate.trim().match(/^MT(\d{1,3})$/i);
    if (match) return Number(match[1]);
  }
  return null;
};

MotaLab.normalizeEnemy = function normalizeEnemy(enemy, block) {
  if (!enemy || typeof enemy !== "object") {
    throw MotaLab.createPauseError(
      "UNKNOWN_DAMAGE",
      "DAMAGE_UNEXPLAINED",
      { block: MotaLab.blockEvidence(block) },
    );
  }
  function requiredInteger(value, field, minimum) {
    if (!MotaLab.isFiniteInteger(value) || value < minimum) {
      throw MotaLab.createPauseError(
        "UNKNOWN_DAMAGE",
        "DAMAGE_UNEXPLAINED",
        { field, block: MotaLab.blockEvidence(block) },
      );
    }
    return value;
  }
  function optionalInteger(value, field) {
    if (value === null || value === undefined) return null;
    return requiredInteger(value, field, 0);
  }
  return {
    hp: requiredInteger(enemy.hp, "enemy.hp", 1),
    attack: optionalInteger(enemy.attack, "enemy.attack"),
    defense: optionalInteger(enemy.defense, "enemy.defense"),
    gold: requiredInteger(enemy.gold, "enemy.gold", 0),
    experience: requiredInteger(enemy.experience, "enemy.experience", 0),
    special: Array.isArray(enemy.special)
      ? enemy.special.filter((value) => typeof value === "string" || MotaLab.isFiniteInteger(value)).slice(0, 64)
      : [],
  };
};

MotaLab.runtimeScalarEvidence = function runtimeScalarEvidence(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 256);
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : { type: "number", value: String(value) };
  }
  if (value === undefined) return { type: "undefined", value: null };
  return { type: typeof value, value: Object.prototype.toString.call(value).slice(0, 128) };
};

MotaLab.normalizeObservedDamage = function normalizeObservedDamage(value) {
  if (value === "???") return value;
  return MotaLab.isFiniteInteger(value) ? value : null;
};

MotaLab.enemyEvidence = function enemyEvidence(enemy) {
  if (!enemy || typeof enemy !== "object") return MotaLab.runtimeScalarEvidence(enemy);
  return {
    hp: MotaLab.runtimeScalarEvidence(enemy.hp),
    attack: MotaLab.runtimeScalarEvidence(enemy.attack),
    defense: MotaLab.runtimeScalarEvidence(enemy.defense),
    gold: MotaLab.runtimeScalarEvidence(enemy.gold),
    experience: MotaLab.runtimeScalarEvidence(enemy.experience),
    special: Array.isArray(enemy.special)
      ? enemy.special.slice(0, 64).map(MotaLab.runtimeScalarEvidence)
      : MotaLab.runtimeScalarEvidence(enemy.special),
  };
};

MotaLab.blockEvidence = function blockEvidence(block, normalizedDamage = undefined) {
  const normalized = normalizedDamage === undefined
    ? MotaLab.normalizeObservedDamage(block.damage)
    : normalizedDamage;
  return {
    x: block.x,
    y: block.y,
    numeric_id: block.numeric_id,
    id: block.id,
    cls: block.cls,
    trigger: block.trigger,
    damage: normalized,
    raw_damage: MotaLab.runtimeScalarEvidence(block.damage),
    normalized_damage: normalized,
  };
};

MotaLab.collectObservation = function collectObservation(adapter, now = Date.now) {
  const snapshot = adapter.readRuntimeSnapshot();
  if (!snapshot.map || snapshot.map.width !== MotaLab.MAP_WIDTH
    || snapshot.map.height !== MotaLab.MAP_HEIGHT) {
    throw MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE",
      "UNSUPPORTED_MAP_DIMENSIONS",
      { width: snapshot.map && snapshot.map.width, height: snapshot.map && snapshot.map.height },
    );
  }

  const hero = snapshot.hero;
  const validDirection = new Set(["up", "down", "left", "right"]);
  const invalidHeroField = [
    ["hero.hp", hero.hp],
    ["hero.attack", hero.attack],
    ["hero.defense", hero.defense],
    ["hero.gold", hero.gold],
    ["hero.experience", hero.experience],
    ["keys.yellow", hero.keys.yellow],
    ["keys.blue", hero.keys.blue],
    ["keys.red", hero.keys.red],
  ].find(([, value]) => !MotaLab.isFiniteInteger(value) || value < 0);
  if (invalidHeroField
    || hero.loc.x < 0 || hero.loc.x >= MotaLab.MAP_WIDTH
    || hero.loc.y < 0 || hero.loc.y >= MotaLab.MAP_HEIGHT
    || !validDirection.has(hero.loc.direction)) {
    throw MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE",
      "INVALID_HERO_FIELD",
      { field: invalidHeroField ? invalidHeroField[0] : "hero.loc" },
    );
  }
  if (typeof snapshot.floor_id !== "string" || snapshot.floor_id.length < 1
    || snapshot.floor_id.length > 256
    || (snapshot.map.floor_name !== null && snapshot.map.floor_name !== undefined
      && (typeof snapshot.map.floor_name !== "string" || snapshot.map.floor_name.length > 128))) {
    throw MotaLab.createPauseError("ENGINE_API_INCOMPATIBLE", "INVALID_FLOOR_IDENTITY");
  }

  const blocks = [];
  const collectionIssues = [];
  const occupied = new Set();
  for (const raw of snapshot.blocks) {
    if (raw.disabled) continue;
    if (!MotaLab.isFiniteInteger(raw.x) || !MotaLab.isFiniteInteger(raw.y)
      || raw.x < 0 || raw.x >= MotaLab.MAP_WIDTH
      || raw.y < 0 || raw.y >= MotaLab.MAP_HEIGHT) {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "BLOCK_OUT_OF_BOUNDS",
        MotaLab.blockEvidence(raw),
      );
    }
    if (!MotaLab.isFiniteInteger(raw.numeric_id) || raw.numeric_id < 0
      || typeof raw.id !== "string" || raw.id.length === 0
      || raw.id.length > 256
      || typeof raw.cls !== "string" || raw.cls.length === 0 || raw.cls.length > 256
      || (raw.trigger !== null && (typeof raw.trigger !== "string" || raw.trigger.length > 128))) {
      throw MotaLab.createPauseError(
        "NEW_OBJECT_OR_MECHANISM",
        "INCOMPLETE_BLOCK_IDENTITY",
        { block: MotaLab.blockEvidence(raw) },
      );
    }
    const coordinate = `${raw.x},${raw.y}`;
    if (occupied.has(coordinate)) {
      throw MotaLab.createPauseError(
        "ENGINE_API_INCOMPATIBLE",
        "DUPLICATE_BLOCK_COORDINATE",
        { block: MotaLab.blockEvidence(raw) },
      );
    }
    occupied.add(coordinate);
    const isEnemy = raw.trigger === "battle"
      || (typeof raw.cls === "string" && /^enemy/i.test(raw.cls));
    const normalizedDamage = isEnemy ? MotaLab.normalizeObservedDamage(raw.damage) : null;
    let normalizedEnemy = null;
    let issue = null;
    if (isEnemy && (!MotaLab.isFiniteInteger(raw.damage) || raw.damage < 0)) {
      issue = {
        pause_kind: "UNKNOWN_DAMAGE",
        detail_code: raw.damage === null || raw.damage === undefined || raw.damage === "???"
          ? "DAMAGE_NULL" : "DAMAGE_UNEXPLAINED",
      };
    }
    if (isEnemy) {
      try {
        normalizedEnemy = MotaLab.normalizeEnemy(raw.enemy, raw);
      } catch (error) {
        if (!MotaLab.isPauseError(error)) throw error;
        issue = issue || {
          pause_kind: error.pause_kind,
          detail_code: error.detail_code,
          field: error.details && error.details.field,
        };
      }
    }
    const normalizedBlock = {
      x: raw.x,
      y: raw.y,
      numeric_id: raw.numeric_id,
      id: raw.id,
      cls: raw.cls,
      trigger: typeof raw.trigger === "string" ? raw.trigger : null,
      no_pass: raw.no_pass === true,
      damage: normalizedDamage,
      enemy: isEnemy ? normalizedEnemy : null,
    };
    blocks.push(normalizedBlock);
    if (issue) {
      collectionIssues.push(Object.assign(issue, {
        block: MotaLab.blockEvidence(raw, normalizedDamage),
        raw_enemy: MotaLab.enemyEvidence(raw.enemy),
        normalized: {
          damage: normalizedBlock.damage,
          enemy: normalizedBlock.enemy,
        },
      }));
    }
  }
  blocks.sort((a, b) => a.y - b.y || a.x - b.x
    || (a.numeric_id || 0) - (b.numeric_id || 0)
    || String(a.id).localeCompare(String(b.id)));

  const busyState = snapshot.busy;
  const observation = {
    protocol: MotaLab.PROTOCOL_VERSION,
    page: MotaLab.PAGE,
    floor_id: snapshot.floor_id,
    floor_name: snapshot.map.floor_name || null,
    floor_number: MotaLab.parseFloorNumber(snapshot.map.floor_name, snapshot.floor_id),
    dimensions: { width: MotaLab.MAP_WIDTH, height: MotaLab.MAP_HEIGHT },
    hero: {
      hp: hero.hp,
      attack: hero.attack,
      defense: hero.defense,
      gold: hero.gold,
      experience: hero.experience,
      loc: {
        x: hero.loc.x,
        y: hero.loc.y,
        direction: hero.loc.direction,
      },
    },
    keys: {
      yellow: hero.keys.yellow,
      blue: hero.keys.blue,
      red: hero.keys.red,
    },
    busy: busyState.moving || busyState.lock_control || busyState.event_active,
    blocks,
    captured_at: now(),
  };
  if (collectionIssues.length) {
    const primary = collectionIssues[0];
    const error = MotaLab.createPauseError(
      primary.pause_kind,
      primary.detail_code,
      {
        block: primary.block,
        field: primary.field || null,
        collection_issues: collectionIssues,
      },
    );
    error.observation = observation;
    throw error;
  }
  return observation;
};
