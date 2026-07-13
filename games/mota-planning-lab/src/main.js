MotaLab.main = async function main() {
  const adapter = MotaLab.createEngineAdapter();
  const storage = {
    get: (key, fallback) => GM_getValue(key, fallback),
    set: (key, value) => GM_setValue(key, value),
  };
  const journal = MotaLab.createJournal(storage);
  const registry = MotaLab.createBlockRegistry();
  const client = MotaLab.createLocalhostClient(GM_xmlhttpRequest);
  const panel = MotaLab.createPanel(document);
  const controller = MotaLab.createController(
    { adapter, journal, registry, client, panel },
    { autoSchedule: true },
  );
  MotaLab.registerMenus({
    register: GM_registerMenuCommand,
    controller,
  });
  globalThis.__motaPlanningLab = Object.freeze({
    controller,
    capabilities: () => adapter.capabilities(),
    currentObservation: () => controller.getCurrentObservation(),
  });
  await controller.initialize();
};

MotaLab.main().catch((error) => {
  console.error("[Mota Planning Lab fatal]", {
    message: error && error.message ? error.message : String(error),
  });
});
