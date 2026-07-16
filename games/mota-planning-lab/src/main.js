if (!MotaLab.isFiniteInteger(MotaLab.RUNTIME_READY_TIMEOUT_MS)) {
  MotaLab.RUNTIME_READY_TIMEOUT_MS = 10000;
}
if (!MotaLab.isFiniteInteger(MotaLab.RUNTIME_READY_POLL_MS)) {
  MotaLab.RUNTIME_READY_POLL_MS = 50;
}

MotaLab.waitForRuntimeReady = function waitForRuntimeReady(scope = globalThis) {
  if (MotaLab.isEngineRuntimeReady(scope)) return Promise.resolve(true);

  const timeoutMs = MotaLab.isFiniteInteger(MotaLab.RUNTIME_READY_TIMEOUT_MS)
    ? MotaLab.RUNTIME_READY_TIMEOUT_MS : 10000;
  const pollMs = MotaLab.isFiniteInteger(MotaLab.RUNTIME_READY_POLL_MS)
    ? MotaLab.RUNTIME_READY_POLL_MS : 50;

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    let pollId = null;
    const removePageHide = typeof scope.removeEventListener === "function";
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) scope.clearTimeout(timeoutId);
      if (pollId !== null) scope.clearTimeout(pollId);
      if (removePageHide) scope.removeEventListener("pagehide", onPageHide);
      resolve(ready);
    };
    const onPageHide = () => finish(false);
    const poll = () => {
      if (MotaLab.isEngineRuntimeReady(scope)) return finish(true);
      pollId = scope.setTimeout(poll, pollMs);
      return undefined;
    };

    if (typeof scope.addEventListener === "function") scope.addEventListener("pagehide", onPageHide, { once: true });
    timeoutId = scope.setTimeout(() => finish(false), timeoutMs);
    pollId = scope.setTimeout(poll, pollMs);
  });
};

MotaLab.main = function main() {
  if (globalThis.__motaPlanningLabBoot) return globalThis.__motaPlanningLabBoot;
  const pageScope = MotaLab.getEnginePageScope();
  let environment;
  let panel;
  try {
    environment = MotaLab.createRuntimeEnvironment(globalThis);
    panel = MotaLab.createPanel(document);
  } catch (error) {
    const boot = Promise.reject(error);
    globalThis.__motaPlanningLabBoot = boot;
    return boot;
  }
  const installUnavailableRuntime = () => {
    panel.update({
      autopilot: false,
      action_id: null,
      location: null,
      reason: "MISSING_RUNTIME",
      connected: false,
      pause_kind: "ENGINE_API_INCOMPATIBLE",
    });
    console.error("[Mota Planning Lab pause]", {
      pause_kind: "ENGINE_API_INCOMPATIBLE",
      detail_code: "MISSING_RUNTIME",
      details: { timeout_ms: MotaLab.RUNTIME_READY_TIMEOUT_MS },
    });
    globalThis.__motaPlanningLab = Object.freeze({
      controller: null,
      capabilities: () => ({ runtime_environment: false }),
      currentObservation: () => null,
      mode: environment.mode,
      available: false,
    });
  };
  const installRuntime = () => {
    try {
      const adapter = MotaLab.createEngineAdapter(pageScope);
      const journal = MotaLab.createJournal();
      const registry = MotaLab.createBlockRegistry();
      const client = MotaLab.createLocalhostClient(environment.request);
      const controller = MotaLab.createController(
        { adapter, journal, registry, client, panel },
        { autoSchedule: true, shadowOnly: true },
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
      return Promise.resolve(controller.initialize());
    } catch (error) {
      return Promise.reject(error);
    }
  };
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
    const boot = Promise.resolve();
    globalThis.__motaPlanningLabBoot = boot;
    return boot;
  }
  if (MotaLab.isEngineRuntimeReady(pageScope)) {
    const boot = installRuntime();
    globalThis.__motaPlanningLabBoot = boot;
    return boot;
  }
  const boot = MotaLab.waitForRuntimeReady(pageScope).then((runtimeReady) => {
    if (runtimeReady) return installRuntime();
    installUnavailableRuntime();
    return undefined;
  });
  globalThis.__motaPlanningLabBoot = boot;
  return boot;
};

MotaLab.main().catch((error) => {
  console.error("[Mota Planning Lab fatal]", {
    message: error && error.message ? error.message : String(error),
  });
});
