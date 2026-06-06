const learnedAutomationActions = new Map();
let learnedAutomationCursor = 0;

function getButtonAutomationKind(button) {
  if (button.classList.contains("compost-button")) {
    return "compost";
  }

  return isUpgradeLike(button) ? "upgrade" : null;
}

function getButtonAutomationArea(button) {
  if (button.classList.contains("compost-button")) {
    return "compost";
  }

  if (isCellLabUpgradeButton(button)) {
    return "cellLab";
  }

  return "upgrade";
}

function normalizeActionLabel(text) {
  return normalizeText(text).replace(/\s+/g, " ").slice(0, 120);
}

function getButtonAutomationId(button) {
  const kind = getButtonAutomationKind(button);

  if (!kind) {
    return null;
  }

  if (kind === "compost") {
    const frames = Array.from(document.querySelectorAll(".composter-frame"));
    const frameIndex = frames.indexOf(button.closest(".composter-frame"));
    return `${kind}:${frameIndex}:${normalizeActionLabel(button.textContent)}`;
  }

  const text = normalizeText(button.textContent);
  const bracket = text.match(/^\s*\[([^\]]+)\]/);

  if (bracket) {
    return `${kind}:${normalizeActionLabel(bracket[1])}`;
  }

  const upgradeClass = Array.from(button.classList)
    .find((className) => /^upgrade-/.test(className));

  if (upgradeClass) {
    return `${kind}:${upgradeClass}`;
  }

  return `${kind}:${normalizeActionLabel(text)}`;
}

function createSyntheticClickEvent(button) {
  const view = button.ownerDocument?.defaultView || window;

  if (typeof view.MouseEvent === "function") {
    return new view.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view,
    });
  }

  return { type: "click", target: button, currentTarget: button };
}

function getVueClickInvoker(button) {
  for (const key of Reflect.ownKeys(button)) {
    const keyText = typeof key === "symbol" ? key.description || String(key) : String(key);

    if (!keyText || !keyText.includes("_vei")) {
      continue;
    }

    const store = button[key];

    if (!store || typeof store !== "object") {
      continue;
    }

    for (const [eventName, invoker] of Object.entries(store)) {
      if (!/click/i.test(eventName) || typeof invoker !== "function") {
        continue;
      }

      return invoker;
    }
  }

  return null;
}

function createButtonActionRunner(button) {
  const vueInvoker = getVueClickInvoker(button);

  if (vueInvoker) {
    return {
      source: "vue",
      run: () => vueInvoker.call(button, createSyntheticClickEvent(button)),
    };
  }

  if (typeof button.click === "function") {
    return {
      source: "dom",
      run: () => button.click(),
    };
  }

  return null;
}

function getVisibleAutomationButtons() {
  return [
    ...getVisibleUpgradeButtons(),
    ...getVisibleCompostButtons(),
  ].filter((button) => !isRiskyButton(button));
}

function learnAutomationAction(button) {
  const id = getButtonAutomationId(button);
  const kind = getButtonAutomationKind(button);

  if (!id || !kind) {
    return null;
  }

  const runner = createButtonActionRunner(button);

  if (!runner) {
    return null;
  }

  const existing = learnedAutomationActions.get(id) || {};
  const cost = parseButtonCost(button) || existing.cost || null;
  const action = Object.assign({}, existing, {
    id,
    kind,
    area: getButtonAutomationArea(button),
    label: normalizeActionLabel(button.textContent),
    cost,
    element: button,
    runner,
    source: runner.source,
    lastSeenAt: Date.now(),
  });

  learnedAutomationActions.set(id, action);
  return action;
}

function learnVisibleAutomationActions() {
  for (const button of getVisibleAutomationButtons()) {
    learnAutomationAction(button);
  }
}

function isLearnedActionVisible(action) {
  return action.element && document.contains(action.element) && isVisible(action.element);
}

function isLearnedActionAllowed(action, config = loadConfig()) {
  if (!action.cost) {
    return true;
  }

  return isSpendResourceAllowed(action.cost.resourceKey, config);
}

function getLearnedAutomationActions(config = loadConfig()) {
  return Array.from(learnedAutomationActions.values())
    .filter((action) => action.runner && typeof action.runner.run === "function")
    .filter((action) => !isLearnedActionVisible(action))
    .filter((action) => isLearnedActionAllowed(action, config))
    .filter((action) => (action.area === "upgrade" && config.autoUpgrades)
      || (action.area === "cellLab" && config.autoCellLab)
      || (action.area === "compost" && config.autoCompost));
}

function rotateActions(actions, limit) {
  if (actions.length === 0 || limit <= 0) {
    return [];
  }

  const start = learnedAutomationCursor % actions.length;
  const rotated = actions.slice(start).concat(actions.slice(0, start));
  learnedAutomationCursor += Math.min(limit, actions.length);
  return rotated.slice(0, limit);
}

function getLearnedAutomationSummary(config = loadConfig()) {
  const actions = getLearnedAutomationActions(config);
  const all = Array.from(learnedAutomationActions.values());

  return {
    total: all.length,
    ready: actions.length,
    upgrades: all.filter((action) => action.kind === "upgrade").length,
    compost: all.filter((action) => action.kind === "compost").length,
    sources: actions.reduce((counts, action) => {
      counts[action.source] = (counts[action.source] || 0) + 1;
      return counts;
    }, {}),
    actions: all.map((action) => ({
      id: action.id,
      kind: action.kind,
      area: action.area,
      label: action.label,
      source: action.source,
      visible: isLearnedActionVisible(action),
      cost: action.cost
        ? {
          amountText: action.cost.amountText,
          resourceKey: action.cost.resourceKey,
          resourceLabel: action.cost.resourceLabel,
        }
        : null,
    })),
  };
}

function isAutoSpendAllowed(button, config = loadConfig()) {
  const cost = parseButtonCost(button);
  return !cost || isSpendResourceAllowed(cost.resourceKey, config);
}

function filterAutoSpendAllowed(buttons, config = loadConfig()) {
  return buttons.filter((button) => isAutoSpendAllowed(button, config));
}

function scan(config = loadConfig()) {
  learnVisibleAutomationActions();

  const visibleUpgrades = getVisibleUpgradeButtons();
  const rawBuyableUpgrades = getBuyableNormalUpgradeButtons();
  const buyableUpgrades = filterAutoSpendAllowed(rawBuyableUpgrades, config);
  const rawBuyableCellLab = getBuyableCellLabUpgradeButtons();
  const buyableCellLab = filterAutoSpendAllowed(rawBuyableCellLab, config);
  const visibleCompost = getVisibleCompostButtons();
  const rawBuyableCompost = getBuyableCompostButtons();
  const buyableCompost = filterAutoSpendAllowed(rawBuyableCompost, config);
  const resetHints = getResetRatioHints();
  const leafTimeHint = getLeafTimeHint();

  return {
    upgrades: {
      visible: visibleUpgrades.map(describeButton),
      buyable: buyableUpgrades.map(describeButton),
      blockedByResource: rawBuyableUpgrades
        .filter((button) => !isAutoSpendAllowed(button, config))
        .map(describeButton),
    },
    compost: {
      visible: visibleCompost.map(describeButton),
      buyable: buyableCompost.map(describeButton),
      blockedByResource: rawBuyableCompost
        .filter((button) => !isAutoSpendAllowed(button, config))
        .map(describeButton),
    },
    cellLab: {
      visible: visibleUpgrades
        .filter(isCellLabUpgradeButton)
        .map(describeButton),
      buyable: buyableCellLab.map(describeButton),
      blockedByResource: rawBuyableCellLab
        .filter((button) => !isAutoSpendAllowed(button, config))
        .map(describeButton),
    },
    resetHints: resetHints.map(({ button, ...hint }) => hint),
    leafTimeHint: leafTimeHint
      ? (({ element, ...hint }) => hint)(leafTimeHint)
      : null,
    background: getLearnedAutomationSummary(config),
  };
}

function emptyClickSummary() {
  return {
    candidates: 0,
    clicked: 0,
    skipped: 0,
  };
}

function createClickSummary(upgrades, compost, cellLab, background, resetHints, reason) {
  return {
    candidates: upgrades.candidates + compost.candidates + cellLab.candidates + background.candidates,
    clicked: upgrades.clicked + compost.clicked + cellLab.clicked + background.clicked,
    skipped: upgrades.skipped + compost.skipped + cellLab.skipped + background.skipped,
    upgrades,
    compost,
    cellLab,
    background,
    resetHints,
    reason,
  };
}

function createIdleClickSummary(reason) {
  return createClickSummary(
    emptyClickSummary(),
    emptyClickSummary(),
    emptyClickSummary(),
    emptyClickSummary(),
    [],
    reason,
  );
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
  const candidates = filterAutoSpendAllowed(getBuyableNormalUpgradeButtons(), config);
  const legacyLimit = config.maxClicksPerTick;
  const configuredLimit = config.maxUpgradeClicksPerTick === undefined
    ? legacyLimit
    : config.maxUpgradeClicksPerTick;
  const limit = readLimit(configuredLimit, defaultConfig.maxUpgradeClicksPerTick);

  return clickButtons(candidates, limit, "upgrade", config);
}

function clickBuyableCellLab(config) {
  const candidates = filterAutoSpendAllowed(getBuyableCellLabUpgradeButtons(), config);
  const legacyLimit = config.maxClicksPerTick;
  const configuredLimit = config.maxCellLabClicksPerTick === undefined
    ? legacyLimit
    : config.maxCellLabClicksPerTick;
  const limit = readLimit(configuredLimit, defaultConfig.maxUpgradeClicksPerTick);

  return clickButtons(candidates, limit, "cellLab", config);
}

function clickBuyableCompost(config) {
  const candidates = filterAutoSpendAllowed(getBuyableCompostButtons(), config);
  const limit = readLimit(config.maxCompostClicksPerTick, defaultConfig.maxCompostClicksPerTick);

  return clickButtons(candidates, limit, "compost", config);
}

function clickBackgroundActions(config) {
  const candidates = getLearnedAutomationActions(config);
  const limit = readLimit(config.maxBackgroundClicksPerTick, defaultConfig.maxBackgroundClicksPerTick);
  const actions = rotateActions(candidates, limit);
  let clicked = 0;

  for (const action of actions) {
    if (config.logClicks) {
      log("background", action.kind, action.source, action.label);
    }

    action.runner.run();
    clicked += 1;
  }

  return {
    candidates: candidates.length,
    clicked,
    skipped: Math.max(0, candidates.length - clicked),
  };
}

function runPurchaseTick(config = loadConfig()) {
  if (!document.querySelector("#app")) {
    lastPurchaseSummary = createIdleClickSummary("Waiting for app");
    return lastPurchaseSummary;
  }

  if (!config.enabled) {
    lastPurchaseSummary = createIdleClickSummary("Paused");
    return lastPurchaseSummary;
  }

  if (config.scanOnly) {
    lastPurchaseSummary = createIdleClickSummary("Scan only");
    return lastPurchaseSummary;
  }

  learnVisibleAutomationActions();

  const upgrades = config.autoUpgrades ? clickBuyableUpgrades(config) : emptyClickSummary();
  const compost = config.autoCompost ? clickBuyableCompost(config) : emptyClickSummary();
  const cellLab = config.autoCellLab ? clickBuyableCellLab(config) : emptyClickSummary();
  const background = config.backgroundAutomation ? clickBackgroundActions(config) : emptyClickSummary();

  lastPurchaseSummary = createClickSummary(upgrades, compost, cellLab, background, [], "Buy mode");
  return lastPurchaseSummary;
}

function summarizeScanOnly(scanResult, reason) {
  const upgradeCandidates = scanResult.upgrades.buyable.length;
  const compostCandidates = scanResult.compost.buyable.length;
  const cellLabCandidates = scanResult.cellLab.buyable.length;

  return {
    candidates: upgradeCandidates + compostCandidates + cellLabCandidates,
    clicked: 0,
    skipped: upgradeCandidates + compostCandidates + cellLabCandidates,
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
    cellLab: {
      candidates: cellLabCandidates,
      clicked: 0,
      skipped: cellLabCandidates,
    },
    background: emptyClickSummary(),
    resetHints: scanResult.resetHints,
    reason,
  };
}

function summarizeBuyMode(scanResult) {
  return Object.assign({}, lastPurchaseSummary, {
    resetHints: scanResult.resetHints,
    reason: "Buy mode",
  });
}

function createWaitingSummary() {
  return createClickSummary(
    emptyClickSummary(),
    emptyClickSummary(),
    emptyClickSummary(),
    emptyClickSummary(),
    [],
    "Waiting for app",
  );
}

function runStatusTick(config = loadConfig()) {
  if (!document.querySelector("#app")) {
    lastSummary = createWaitingSummary();
    renderPanel(config);
    return lastSummary;
  }

  const scanResult = scan(config);
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

  lastSummary = summarizeBuyMode(scanResult);
  renderPanel(config);
  return lastSummary;
}

function runAutomation(config = loadConfig()) {
  if (!document.querySelector("#app")) {
    lastSummary = createWaitingSummary();
    renderPanel(config);
    return lastSummary;
  }

  const scanResult = scan(config);
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
  const cellLab = config.autoCellLab ? clickBuyableCellLab(config) : emptyClickSummary();
  const background = config.backgroundAutomation ? clickBackgroundActions(config) : emptyClickSummary();

  lastPurchaseSummary = createClickSummary(upgrades, compost, cellLab, background, [], "Buy mode");
  lastSummary = createClickSummary(upgrades, compost, cellLab, background, scanResult.resetHints, "Buy mode");
  renderPanel(config);
  return lastSummary;
}
