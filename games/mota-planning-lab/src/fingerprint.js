MotaLab.canonicalize = function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot hash non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(MotaLab.canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${MotaLab.canonicalize(value[key])}`
    )).join(",")}}`;
  }
  throw new TypeError("Cannot hash unsupported value");
};

MotaLab.sha256 = function sha256(input) {
  const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
  const maxWord = 2 ** 32;
  const words = [];
  const hash = [];
  const constants = [];
  const isComposite = {};
  let primeCounter = 0;

  for (let candidate = 2; primeCounter < 64; candidate += 1) {
    if (isComposite[candidate]) continue;
    for (let multiple = candidate * candidate; multiple < 313; multiple += candidate) {
      isComposite[multiple] = true;
    }
    hash[primeCounter] = (Math.sqrt(candidate) * maxWord) | 0;
    constants[primeCounter] = (candidate ** (1 / 3) * maxWord) | 0;
    primeCounter += 1;
  }

  const bytes = unescape(encodeURIComponent(input));
  const bitLength = bytes.length * 8;
  let message = `${bytes}\x80`;
  while ((message.length % 64) !== 56) message += "\x00";
  for (let i = 0; i < message.length; i += 1) {
    words[i >> 2] |= message.charCodeAt(i) << ((3 - (i % 4)) * 8);
  }
  words.push((bitLength / maxWord) | 0);
  words.push(bitLength | 0);

  for (let blockStart = 0; blockStart < words.length; blockStart += 16) {
    const schedule = words.slice(blockStart, blockStart + 16);
    const oldHash = hash.slice(0, 8);
    let working = oldHash.slice();
    for (let i = 0; i < 64; i += 1) {
      const w15 = schedule[i - 15];
      const w2 = schedule[i - 2];
      const scheduleWord = i < 16 ? schedule[i] : (
        schedule[i - 16]
        + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
        + schedule[i - 7]
        + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
      ) | 0;
      schedule[i] = scheduleWord;
      const e = working[4];
      const a = working[0];
      const temp1 = (working[7]
        + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
        + ((e & working[5]) ^ ((~e) & working[6]))
        + constants[i] + scheduleWord) | 0;
      const temp2 = ((rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
        + ((a & working[1]) ^ (a & working[2]) ^ (working[1] & working[2]))) | 0;
      working = [(temp1 + temp2) | 0, working[0], working[1], working[2],
        (working[3] + temp1) | 0, working[4], working[5], working[6]];
    }
    for (let i = 0; i < 8; i += 1) hash[i] = (oldHash[i] + working[i]) | 0;
  }
  return hash.slice(0, 8).map((value) => (`00000000${(value >>> 0).toString(16)}`).slice(-8)).join("");
};

MotaLab.fingerprintProjection = function fingerprintProjection(observation) {
  const projection = {
    floor_id: observation.floor_id,
    session_id: observation.session_id,
    dimensions: {
      width: observation.dimensions.width,
      height: observation.dimensions.height,
    },
    topology: Object.assign({
      kind: observation.topology.kind,
      source: observation.topology.source,
      confidence: observation.topology.confidence,
    }, Array.isArray(observation.topology.valid_cells) ? {
      valid_cells: observation.topology.valid_cells,
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
    blocks: observation.blocks.map((block) => ({
      x: block.x,
      y: block.y,
      numeric_id: block.numeric_id,
      id: block.id,
      cls: block.cls,
      trigger: block.trigger,
      no_pass: block.no_pass,
      damage: block.damage,
      enemy: block.enemy,
    })).sort((a, b) => a.y - b.y || a.x - b.x
      || a.numeric_id - b.numeric_id || a.id.localeCompare(b.id)),
  };
  if (observation.engine_model && typeof observation.engine_model.catalog_hash === "string") {
    projection.catalog_hash = observation.engine_model.catalog_hash;
    projection.engine_model_hash = observation.engine_model.model_hash;
  }
  return projection;
};

MotaLab.fingerprintObservation = function fingerprintObservation(observation) {
  return `sha256:${MotaLab.sha256(MotaLab.canonicalize(MotaLab.fingerprintProjection(observation)))}`;
};
