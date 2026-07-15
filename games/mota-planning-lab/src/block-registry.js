MotaLab.blockSignature = function blockSignature(block) {
  return `${block.id || ""}|${block.cls || ""}|${block.trigger || ""}`;
};

MotaLab.createBlockRegistry = function createBlockRegistry(initialEntries = []) {
  const entries = new Map();

  function normalizeEntry(entry) {
    if (!entry || typeof entry !== "object") throw new TypeError("Invalid registry entry");
    if (typeof entry.id !== "string" || entry.id.length === 0) throw new TypeError("Invalid block id");
    if (typeof entry.cls !== "string" || entry.cls.length === 0) throw new TypeError("Invalid block cls");
    if (typeof entry.trigger !== "string" && entry.trigger !== null) throw new TypeError("Invalid trigger");
    if (!MotaLab.BLOCK_CATEGORIES.includes(entry.category)) throw new TypeError("Invalid block category");
    const boundary = MotaLab.BOUNDARY_CATEGORIES.has(entry.category) || entry.boundary === true;
    const passable = entry.category === "wall" ? false : entry.passable === true;
    return {
      id: entry.id,
      cls: entry.cls,
      trigger: entry.trigger,
      category: entry.category,
      passable,
      boundary,
      fast_path: entry.fast_path === true && !boundary,
      version: MotaLab.isFiniteInteger(entry.version) ? entry.version : 1,
    };
  }

  function merge(newEntries) {
    if (!Array.isArray(newEntries)) return;
    for (const raw of newEntries) {
      const entry = normalizeEntry(raw);
      entries.set(MotaLab.blockSignature(entry), entry);
    }
  }

  function replace(newEntries) {
    entries.clear();
    merge(newEntries);
  }

  function get(block) {
    return entries.get(MotaLab.blockSignature(block)) || null;
  }

  function unknownBlocks(observation) {
    return observation.blocks.filter((block) => !get(block));
  }

  function exportEntries() {
    return Array.from(entries.values()).map((entry) => Object.assign({}, entry));
  }

  merge(initialEntries);
  return Object.freeze({ merge, replace, get, unknownBlocks, exportEntries });
};
