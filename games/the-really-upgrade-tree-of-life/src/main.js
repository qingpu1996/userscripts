function startLoop() {
  const config = loadConfig();

  if (intervalId) {
    window.clearInterval(intervalId);
  }

  intervalId = window.setInterval(() => {
    runAutomation(loadConfig());
  }, Math.max(250, Number(config.tickMs) || defaultConfig.tickMs));

  renderPanel(config);
  log("started", config);
}

function main() {
  window.__trutolHelper = {
    getConfig: loadConfig,
    setConfig: updateConfig,
    scan,
    leafTimeHint: () => scan().leafTimeHint,
    resetHints: () => scan().resetHints,
    tick: () => runAutomation(loadConfig()),
  };

  startLoop();
}

main();
