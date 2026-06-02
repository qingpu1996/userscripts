function scan() {
  const visibleUpgrades = getVisibleUpgradeButtons();
  const buyableUpgrades = getBuyableUpgradeButtons();
  const visibleCompost = getVisibleCompostButtons();
  const buyableCompost = getBuyableCompostButtons();
  const resetHints = getResetRatioHints();
  const leafTimeHint = getLeafTimeHint();

  return {
    upgrades: {
      visible: visibleUpgrades.map(describeButton),
      buyable: buyableUpgrades.map(describeButton),
    },
    compost: {
      visible: visibleCompost.map(describeButton),
      buyable: buyableCompost.map(describeButton),
    },
    resetHints: resetHints.map(({ button, ...hint }) => hint),
    leafTimeHint: leafTimeHint
      ? (({ element, ...hint }) => hint)(leafTimeHint)
      : null,
  };
}

function emptyClickSummary() {
  return {
    candidates: 0,
    clicked: 0,
    skipped: 0,
  };
}

function clickButtons(buttons, limit, label, config) {
  let clicked = 0;

  for (const button of buttons.slice(0, limit)) {
    if (!document.contains(button) || !isVisible(button)) {
      continue;
    }

    if (config.logClicks) {
      log("click", label, describeButton(button));
    }

    button.click();
    clicked += 1;
  }

  return {
    candidates: buttons.length,
    clicked,
    skipped: Math.max(0, buttons.length - clicked),
  };
}

function readLimit(value, fallback) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit >= 0 ? limit : fallback;
}

function clickBuyableUpgrades(config) {
  const candidates = getBuyableUpgradeButtons();
  const legacyLimit = config.maxClicksPerTick;
  const configuredLimit = config.maxUpgradeClicksPerTick === undefined
    ? legacyLimit
    : config.maxUpgradeClicksPerTick;
  const limit = readLimit(configuredLimit, defaultConfig.maxUpgradeClicksPerTick);

  return clickButtons(candidates, limit, "upgrade", config);
}

function clickBuyableCompost(config) {
  const candidates = getBuyableCompostButtons();
  const limit = readLimit(config.maxCompostClicksPerTick, defaultConfig.maxCompostClicksPerTick);

  return clickButtons(candidates, limit, "compost", config);
}

function summarizeScanOnly(scanResult, reason) {
  const upgradeCandidates = scanResult.upgrades.buyable.length;
  const compostCandidates = scanResult.compost.buyable.length;

  return {
    candidates: upgradeCandidates + compostCandidates,
    clicked: 0,
    skipped: upgradeCandidates + compostCandidates,
    upgrades: {
      candidates: upgradeCandidates,
      clicked: 0,
      skipped: upgradeCandidates,
    },
    compost: {
      candidates: compostCandidates,
      clicked: 0,
      skipped: compostCandidates,
    },
    resetHints: scanResult.resetHints,
    reason,
  };
}

function runAutomation(config = loadConfig()) {
  if (!document.querySelector("#app")) {
    lastSummary = {
      candidates: 0,
      clicked: 0,
      skipped: 0,
      upgrades: emptyClickSummary(),
      compost: emptyClickSummary(),
      resetHints: [],
      reason: "Waiting for app",
    };
    renderPanel(config);
    return lastSummary;
  }

  const scanResult = scan();
  updateInlineLeafHint();
  updateInlineResetHints();

  if (config.logScans) {
    log("scan", scanResult);
  }

  if (!config.enabled) {
    lastSummary = summarizeScanOnly(scanResult, "Paused");
    renderPanel(config);
    return lastSummary;
  }

  if (config.scanOnly) {
    lastSummary = summarizeScanOnly(scanResult, "Scan only");
    renderPanel(config);
    return lastSummary;
  }

  const upgrades = config.autoUpgrades ? clickBuyableUpgrades(config) : emptyClickSummary();
  const compost = config.autoCompost ? clickBuyableCompost(config) : emptyClickSummary();

  lastSummary = {
    candidates: upgrades.candidates + compost.candidates,
    clicked: upgrades.clicked + compost.clicked,
    skipped: upgrades.skipped + compost.skipped,
    upgrades,
    compost,
    resetHints: scanResult.resetHints,
    reason: "Buy mode",
  };
  renderPanel(config);
  return lastSummary;
}
