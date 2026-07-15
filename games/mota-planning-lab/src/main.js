MotaLab.main = async function main() {
  const environment = MotaLab.createRuntimeEnvironment(globalThis);
  const panel = MotaLab.createPanel(document);
  try {
    environment.assertAvailable();
  } catch (error) {
    const detailCode = error && error.detail_code
      ? error.detail_code : "USERSCRIPT_API_UNAVAILABLE";
    panel.update({
      autopilot: false,
      action_id: null,
      location: null,
      reason: detailCode,
      connected: false,
      pause_kind: "ENGINE_API_INCOMPATIBLE",
    });
    console.error("[Mota Planning Lab pause]", {
      pause_kind: "ENGINE_API_INCOMPATIBLE",
      detail_code: detailCode,
      details: error && error.details ? error.details : {},
    });
    globalThis.__motaPlanningLab = Object.freeze({
      controller: null,
      capabilities: () => ({ runtime_environment: false }),
      currentObservation: () => null,
      mode: environment.mode,
      available: false,
    });
    return;
  }
  const adapter = MotaLab.createEngineAdapter();
  const journal = MotaLab.createJournal();
  const registry = MotaLab.createBlockRegistry();
  const client = MotaLab.createLocalhostClient(environment.request);
  const controller = MotaLab.createController(
    { adapter, journal, registry, client, panel },
    { autoSchedule: true },
  );
  const exportCurrent = () => {
    const observation = controller.getCurrentObservation();
    if (observation) MotaLab.downloadObservation(observation);
  };
  panel.bindControls({
    confirm: () => controller.confirmBaseline({ mode: "new_game" }),
    start: () => controller.start(),
    pause: () => controller.manualPause(),
    reconnect: () => controller.reconnectOnly(),
    export: exportCurrent,
  });
  if (environment.registerMenu) {
    MotaLab.registerMenus({ register: environment.registerMenu, controller });
  }
  globalThis.__motaPlanningLab = Object.freeze({
    controller,
    capabilities: () => adapter.capabilities(),
    currentObservation: () => controller.getCurrentObservation(),
    mode: environment.mode,
  });
  await controller.initialize();
};

MotaLab.main().catch((error) => {
  console.error("[Mota Planning Lab fatal]", {
    message: error && error.message ? error.message : String(error),
  });
});
