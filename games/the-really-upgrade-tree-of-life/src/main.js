function clearLoops() {
  if (buyIntervalId) {
    window.clearInterval(buyIntervalId);
    buyIntervalId = null;
  }

  if (statusIntervalId) {
    window.clearInterval(statusIntervalId);
    statusIntervalId = null;
  }
}

function startLoops(config = loadConfig()) {
  const timings = getAutomationTimings(config);

  clearLoops();

  buyIntervalId = window.setInterval(() => {
    runPurchaseTick(loadConfig());
  }, timings.buyTickMs);

  statusIntervalId = window.setInterval(() => {
    runStatusTick(loadConfig());
  }, timings.statusTickMs);

  log("started", Object.assign({}, config, { timings }));
}

function restartLoops(config = loadConfig()) {
  startLoops(config);
}

function main() {
  window.__trutolHelper = {
    getConfig: loadConfig,
    setConfig: updateConfig,
    timings: () => getAutomationTimings(loadConfig()),
    scan,
    leafTimeHint: () => scan().leafTimeHint,
    resetHints: () => scan().resetHints,
    purchaseTick: () => runPurchaseTick(loadConfig()),
    statusTick: () => runStatusTick(loadConfig()),
    tick: () => runAutomation(loadConfig()),
  };

  const config = loadConfig();
  startLoops(config);
  runStatusTick(config);
}

main();
