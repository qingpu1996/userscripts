const learnedAutomationActions = new Map();
const learnedResetActions = new Map();
const learnedAutomationCursors = {
  upgrade: 0,
  compost: 0,
  cellLab: 0,
};

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

function getCompostAutomationId(button) {
  const cost = typeof parseButtonCost === "function" ? parseButtonCost(button) : null;

  if (cost?.resourceKey) {
    return `compost:${cost.resourceKey}`;
  }

  const headingText = getCompostFrame(button)?.querySelector("h3")?.textContent;
  const resource = headingText && typeof normalizeResourceName === "function"
    ? normalizeResourceName(headingText)
    : null;

  if (resource?.key) {
    return `compost:${resource.key}`;
  }

  const frames = Array.from(document.querySelectorAll(compostFrameSelector));
  const frameIndex = frames.indexOf(getCompostFrame(button));
  return `compost:${frameIndex}`;
}

function getButtonAutomationId(button) {
  const kind = getButtonAutomationKind(button);

  if (!kind) {
    return null;
  }

  if (kind === "compost") {
    return getCompostAutomationId(button);
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

function getVueClickHandlerSnapshot(invoker) {
  const handler = invoker?.value || invoker;

  if (Array.isArray(handler)) {
    const handlers = handler.filter((item) => typeof item === "function");
    return handlers.length > 0 ? handlers.slice() : null;
  }

  return typeof handler === "function" ? handler : null;
}

function runVueClickHandlerSnapshot(button, handler) {
  const event = createSyntheticClickEvent(button);

  if (Array.isArray(handler)) {
    for (const item of handler) {
      item.call(button, event);
    }
    return;
  }

  handler.call(button, event);
}

function createButtonActionRunner(button) {
  const vueInvoker = getVueClickInvoker(button);
  const vueHandler = vueInvoker ? getVueClickHandlerSnapshot(vueInvoker) : null;

  if (vueHandler) {
    return {
      source: "vue",
      run: () => runVueClickHandlerSnapshot(button, vueHandler),
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

function serializeResetHint(hint) {
  return {
    text: hint.text,
    classes: hint.classes,
    resourceKey: hint.resourceKey,
    resourceLabel: hint.resourceLabel,
    gained: hint.gained,
    gainedLog10: hint.gainedLog10,
    current: hint.current,
    currentLog10: hint.currentLog10,
    currentMissing: hint.currentMissing,
    currentWasZero: hint.currentWasZero,
    ratio: hint.ratio,
    ratioLog10: hint.ratioLog10,
    ratioHint: hint.ratioHint,
    seedAffordabilityHint: hint.seedAffordabilityHint,
    hint: hint.hint,
  };
}

function getResetAutomationId(hint) {
  if (!hint || !isAutoResetResourceSupported(hint.resourceKey)) {
    return null;
  }

  return `reset:${hint.resourceKey}`;
}

function learnResetAction(hint) {
  const id = getResetAutomationId(hint);

  if (!id || !hint.button) {
    return null;
  }

  const runner = createButtonActionRunner(hint.button);

  if (!runner) {
    return null;
  }

  const existing = learnedResetActions.get(id) || {};
  const action = Object.assign({}, existing, {
    id,
    kind: "reset",
    resourceKey: hint.resourceKey,
    resourceLabel: hint.resourceLabel,
    label: normalizeActionLabel(hint.text),
    hint: serializeResetHint(hint),
    element: hint.button,
    runner,
    source: runner.source,
    lastSeenAt: Date.now(),
  });

  learnedResetActions.set(id, action);
  return action;
}

function learnResetActions(hints) {
  for (const hint of hints) {
    learnResetAction(hint);
  }
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

  const existing = learnedAutomationActions.get(id) || {};
  const freshRunner = isClickablePrimary(button) ? createButtonActionRunner(button) : null;
  const runner = freshRunner || existing.runner;

  if (!runner) {
    return null;
  }

  const cost = parseButtonCost(button) || existing.cost || null;
  const action = Object.assign({}, existing, {
    id,
    kind,
    area: getButtonAutomationArea(button),
    label: normalizeActionLabel(button.textContent),
    cost,
    element: button,
    runner,
    source: freshRunner ? freshRunner.source : existing.source || runner.source,
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

function getLearnedAutomationActions(config = loadConfig(), area = null) {
  return Array.from(learnedAutomationActions.values())
    .filter((action) => action.runner && typeof action.runner.run === "function")
    .filter((action) => !isLearnedActionVisible(action))
    .filter((action) => !area || action.area === area)
    .filter((action) => isLearnedActionAllowed(action, config))
    .filter((action) => (action.area === "upgrade" && config.autoUpgrades)
      || (action.area === "cellLab" && config.autoCellLab)
      || (action.area === "compost" && config.autoCompost));
}

function rotateActions(actions, limit, cursorKey = "upgrade") {
  if (actions.length === 0 || limit <= 0) {
    return [];
  }

  const start = (learnedAutomationCursors[cursorKey] || 0) % actions.length;
  const rotated = actions.slice(start).concat(actions.slice(0, start));
  learnedAutomationCursors[cursorKey] = (learnedAutomationCursors[cursorKey] || 0)
    + Math.min(limit, actions.length);
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

function isLearnedResetActionVisible(action) {
  return action.element && document.contains(action.element) && isVisible(action.element);
}

function getAutoResetThresholdLog10(value) {
  const parsed = parseDisplayedNumber(value);

  if (!parsed || parsed.zero || !Number.isFinite(parsed.log10)) {
    return null;
  }

  return parsed.log10;
}

function getAutoResetTimeThresholdSeconds(config) {
  const seconds = Number(config.timeThresholdSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function getAutoResetTriggerValue(resourceConfig) {
  if (resourceConfig.mode === "time") {
    return `${resourceConfig.timeThresholdSeconds}s / >= ${resourceConfig.timeMinMultiplierThreshold}x`;
  }

  if (resourceConfig.mode === "amount") {
    return String(resourceConfig.amountThreshold);
  }

  if (resourceConfig.mode === "hybrid") {
    return `${resourceConfig.multiplierThreshold}x / ${resourceConfig.timeThresholdSeconds}s >= ${resourceConfig.timeMinMultiplierThreshold}x`;
  }

  return String(resourceConfig.multiplierThreshold);
}

function removeStatusPrefix(statusText) {
  return String(statusText || "").replace(/^状态：/, "");
}

function getAutoResetTimeMinMultiplierDecision(hint, resourceConfig) {
  const thresholdLog10 = getAutoResetThresholdLog10(resourceConfig.timeMinMultiplierThreshold);

  if (thresholdLog10 === null) {
    return { ready: false, reason: "invalid-time-min-multiplier", statusText: "状态：时间保底倍率无效" };
  }

  if (!Number.isFinite(hint.ratioLog10)) {
    return { ready: false, reason: "invalid-ratio", statusText: "状态：倍率无法计算" };
  }

  if (hint.ratioLog10 >= thresholdLog10) {
    return {
      ready: true,
      reason: "time-min-multiplier",
      statusText: `状态：当前 ${hint.ratio} 倍，满足保底 ${resourceConfig.timeMinMultiplierThreshold} 倍`,
    };
  }

  return {
    ready: false,
    reason: "time-min-multiplier-wait",
    statusText: `状态：时间已到，当前 ${hint.ratio} 倍 / 保底 ${resourceConfig.timeMinMultiplierThreshold} 倍`,
  };
}

function getAutoResetTimeDecision(hint, resourceConfig, now) {
  const thresholdSeconds = getAutoResetTimeThresholdSeconds(resourceConfig);
  const lastResetAt = Number(resourceConfig.lastResetAt);

  if (!thresholdSeconds) {
    return { ready: false, reason: "invalid-time", statusText: "状态：时间阈值无效" };
  }

  if (!Number.isFinite(lastResetAt)) {
    return { ready: false, reason: "missing-time-base", statusText: "状态：等待计时基准" };
  }

  const elapsedSeconds = Math.max(0, (now - lastResetAt) / 1000);
  const remainingSeconds = thresholdSeconds - elapsedSeconds;

  if (remainingSeconds <= 0) {
    const minDecision = getAutoResetTimeMinMultiplierDecision(hint, resourceConfig);

    if (!minDecision.ready) {
      return minDecision;
    }

    return {
      ready: true,
      reason: "time",
      statusText: `状态：已满 ${formatDuration(Math.log10(Math.max(thresholdSeconds, 1e-9)))}，${removeStatusPrefix(minDecision.statusText)}`,
    };
  }

  return {
    ready: false,
    reason: "time-wait",
    statusText: `状态：还需 ${formatDuration(Math.log10(Math.max(remainingSeconds, 1e-9)))}`,
  };
}

function getAutoResetAmountDecision(hint, resourceConfig, resourceLabel) {
  const thresholdLog10 = getAutoResetThresholdLog10(resourceConfig.amountThreshold);

  if (thresholdLog10 === null) {
    return { ready: false, reason: "invalid-amount", statusText: "状态：定额阈值无效" };
  }

  if (hint.gainedLog10 >= thresholdLog10) {
    return {
      ready: true,
      reason: "amount",
      statusText: `状态：可获 ${hint.gained} ${resourceLabel}，已达标`,
    };
  }

  return {
    ready: false,
    reason: "amount-wait",
    statusText: `状态：可获 ${hint.gained} ${resourceLabel} / 目标 ${resourceConfig.amountThreshold} ${resourceLabel}`,
  };
}

function getAutoResetMultiplierDecision(hint, resourceConfig) {
  const thresholdLog10 = getAutoResetThresholdLog10(resourceConfig.multiplierThreshold);

  if (thresholdLog10 === null) {
    return { ready: false, reason: "invalid-threshold", statusText: "状态：倍率阈值无效" };
  }

  if (!Number.isFinite(hint.ratioLog10)) {
    return { ready: false, reason: "invalid-ratio", statusText: "状态：倍率无法计算" };
  }

  if (hint.ratioLog10 >= thresholdLog10) {
    return {
      ready: true,
      reason: "multiplier",
      statusText: `状态：当前 ${hint.ratio} 倍，已达标`,
    };
  }

  return {
    ready: false,
    reason: "multiplier-wait",
    statusText: `状态：当前 ${hint.ratio} 倍 / 目标 ${resourceConfig.multiplierThreshold} 倍`,
  };
}

function getAutoResetHybridDecision(hint, resourceConfig, now) {
  const multiplierDecision = getAutoResetMultiplierDecision(hint, resourceConfig);
  const timeDecision = getAutoResetTimeDecision(hint, resourceConfig, now);

  if (multiplierDecision.ready) {
    return {
      ready: true,
      reason: "hybrid-multiplier",
      statusText: `状态：混合触发，${removeStatusPrefix(multiplierDecision.statusText)}`,
    };
  }

  if (timeDecision.ready) {
    return {
      ready: true,
      reason: "hybrid-time",
      statusText: `状态：混合触发，${removeStatusPrefix(timeDecision.statusText)}`,
    };
  }

  if (multiplierDecision.reason === "invalid-threshold"
    && (timeDecision.reason === "invalid-time"
      || timeDecision.reason === "invalid-time-min-multiplier")) {
    return { ready: false, reason: "invalid-hybrid", statusText: "状态：倍率或时间条件无效" };
  }

  return {
    ready: false,
    reason: "hybrid-wait",
    statusText: `状态：${removeStatusPrefix(multiplierDecision.statusText)}；${removeStatusPrefix(timeDecision.statusText)}`,
  };
}

function getAutoResetDecision(action, config = loadConfig(), now = Date.now()) {
  const resourceConfig = getAutoResetResourceConfig(action.resourceKey, config);
  const hint = action.hint;
  const resourceLabel = action.resourceLabel || hint?.resourceLabel || action.resourceKey;

  if (!resourceConfig) {
    return { ready: false, reason: "unsupported", statusText: "状态：不支持该资源" };
  }

  if (!config.autoResetEnabled) {
    return { ready: false, reason: "global-disabled", statusText: "状态：总开关关闭" };
  }

  if (!resourceConfig.enabled) {
    return { ready: false, reason: "disabled", statusText: "状态：未开启" };
  }

  if (!hint || !Number.isFinite(hint.gainedLog10)) {
    return { ready: false, reason: "missing-gain", statusText: "状态：无法判断收益" };
  }

  if (hint.gainedLog10 === Number.NEGATIVE_INFINITY) {
    return { ready: false, reason: "zero-gain", statusText: "状态：收益为 0" };
  }

  const autoResetConfig = getAutoResetConfig(config);
  const lastAutoResetAt = Math.max(
    ...Object.values(autoResetConfig)
      .map((resource) => Number(resource.lastAutoResetAt))
      .filter((value) => Number.isFinite(value)),
    Number.NEGATIVE_INFINITY,
  );
  const configuredCooldownMs = Number(config.autoResetCooldownMs);
  const cooldownMs = Number.isFinite(configuredCooldownMs) && configuredCooldownMs >= 0
    ? configuredCooldownMs
    : defaultConfig.autoResetCooldownMs;

  if (cooldownMs > 0 && Number.isFinite(lastAutoResetAt) && now - lastAutoResetAt < cooldownMs) {
    const remainingSeconds = Math.max((cooldownMs - (now - lastAutoResetAt)) / 1000, 1e-9);
    return {
      ready: false,
      reason: "cooldown",
      statusText: `状态：防重复冷却 ${formatDuration(Math.log10(remainingSeconds))}`,
    };
  }

  if (isLearnedResetActionVisible(action) && action.element && !isClickablePrimary(action.element)) {
    return { ready: false, reason: "disabled-button", statusText: "状态：按钮不可用" };
  }

  if (resourceConfig.mode === "time") {
    return getAutoResetTimeDecision(hint, resourceConfig, now);
  }

  if (resourceConfig.mode === "amount") {
    return getAutoResetAmountDecision(hint, resourceConfig, resourceLabel);
  }

  if (resourceConfig.mode === "hybrid") {
    return getAutoResetHybridDecision(hint, resourceConfig, now);
  }

  return getAutoResetMultiplierDecision(hint, resourceConfig);
}

function getAutoResetDecisionForHint(hint, config = loadConfig()) {
  return getAutoResetDecision({
    resourceKey: hint.resourceKey,
    resourceLabel: hint.resourceLabel,
    hint: serializeResetHint(hint),
    element: hint.button,
  }, config);
}

function getAutoResetDecisionForResource(resourceKey, config = loadConfig()) {
  const resourceConfig = getAutoResetResourceConfig(resourceKey, config);
  const option = getAutoResetResourceOption(resourceKey);

  if (!resourceConfig || !option) {
    return { ready: false, reason: "unsupported", statusText: "状态：不支持该资源" };
  }

  if (!config.autoResetEnabled) {
    return { ready: false, reason: "global-disabled", statusText: "状态：总开关关闭" };
  }

  const action = learnedResetActions.get(`reset:${resourceKey}`);

  if (action) {
    return getAutoResetDecision(action, config);
  }

  if (!resourceConfig.enabled) {
    return { ready: false, reason: "disabled", statusText: "状态：未开启" };
  }

  return { ready: false, reason: "missing-action", statusText: "状态：等待识别重置按钮" };
}

function getAutoResetActions(config = loadConfig()) {
  if (!config.autoResetEnabled) {
    return [];
  }

  return Array.from(learnedResetActions.values())
    .filter((action) => action.runner && typeof action.runner.run === "function")
    .filter((action) => isAutoResetResourceSupported(action.resourceKey))
    .map((action) => ({
      action,
      decision: getAutoResetDecision(action, config),
    }))
    .filter((entry) => entry.decision.ready);
}

function getAutoResetSummary(config = loadConfig()) {
  const all = Array.from(learnedResetActions.values());
  const ready = getAutoResetActions(config);
  const autoResetConfig = getAutoResetConfig(config);

  return {
    total: all.length,
    ready: ready.length,
    enabled: Object.values(autoResetConfig).filter((resource) => resource.enabled).length,
    actions: all.map((action) => {
      const decision = getAutoResetDecision(action, config);
      return {
        id: action.id,
        resourceKey: action.resourceKey,
        resourceLabel: action.resourceLabel,
        source: action.source,
        visible: isLearnedResetActionVisible(action),
        ready: decision.ready,
        reason: decision.reason,
        statusText: decision.statusText,
        hint: action.hint,
      };
    }),
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
  learnResetActions(resetHints);
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
    autoReset: getAutoResetSummary(config),
  };
}

function emptyClickSummary() {
  return {
    candidates: 0,
    clicked: 0,
    skipped: 0,
  };
}

function createClickSummary(upgrades, compost, cellLab, background, autoReset, resetHints, reason) {
  return {
    candidates: upgrades.candidates + compost.candidates + cellLab.candidates
      + background.candidates + autoReset.candidates,
    clicked: upgrades.clicked + compost.clicked + cellLab.clicked + background.clicked
      + autoReset.clicked,
    skipped: upgrades.skipped + compost.skipped + cellLab.skipped + background.skipped
      + autoReset.skipped,
    upgrades,
    compost,
    cellLab,
    background,
    autoReset,
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
  const groups = [
    {
      area: "compost",
      limitKey: "maxBackgroundCompostClicksPerTick",
      fallback: defaultConfig.maxBackgroundCompostClicksPerTick,
    },
    {
      area: "upgrade",
      limitKey: "maxBackgroundUpgradeClicksPerTick",
      fallback: defaultConfig.maxBackgroundUpgradeClicksPerTick,
    },
    {
      area: "cellLab",
      limitKey: "maxBackgroundCellLabClicksPerTick",
      fallback: defaultConfig.maxBackgroundCellLabClicksPerTick,
    },
  ];
  let candidateCount = 0;
  let clicked = 0;

  for (const group of groups) {
    const candidates = getLearnedAutomationActions(config, group.area);
    const legacyLimit = config.maxBackgroundClicksPerTick;
    const configuredLimit = config[group.limitKey] === undefined
      ? legacyLimit
      : config[group.limitKey];
    const limit = readLimit(configuredLimit, group.fallback);
    const actions = rotateActions(candidates, limit, group.area);
    candidateCount += candidates.length;

    for (const action of actions) {
      if (config.logClicks) {
        log("background", action.kind, action.source, action.label);
      }

      action.runner.run();
      clicked += 1;
    }
  }

  return {
    candidates: candidateCount,
    clicked,
    skipped: Math.max(0, candidateCount - clicked),
  };
}

function markAutoResetTriggered(action, decision) {
  const config = loadConfig();
  const autoReset = getAutoResetConfig(config);
  const resource = autoReset[action.resourceKey];

  if (!resource) {
    return;
  }

  const now = Date.now();
  autoReset[action.resourceKey] = Object.assign({}, autoReset[action.resourceKey], {
    lastResetAt: now,
    lastAutoResetAt: now,
    lastTrigger: {
      at: now,
      mode: resource.mode,
      reason: decision.reason,
      value: getAutoResetTriggerValue(resource),
      ratio: action.hint?.ratio || null,
      gained: action.hint?.gained || null,
    },
  });
  updateConfig({ autoReset });
}

function clickAutoResetActions(config) {
  const initialCandidates = getAutoResetActions(config);
  const limit = readLimit(config.maxAutoResetsPerTick, defaultConfig.maxAutoResetsPerTick);
  const clickedIds = new Set();
  let clicked = 0;

  for (let i = 0; i < limit; i += 1) {
    const candidates = getAutoResetActions(loadConfig())
      .filter(({ action }) => !clickedIds.has(action.id));
    const entry = candidates[0];

    if (!entry) {
      break;
    }

    const { action, decision } = entry;

    if (config.logClicks) {
      log("auto-reset", action.resourceKey, decision.reason, action.hint);
    }

    action.runner.run();
    markAutoResetTriggered(action, decision);
    clickedIds.add(action.id);
    clicked += 1;
  }

  return {
    candidates: initialCandidates.length,
    clicked,
    skipped: Math.max(0, initialCandidates.length - clicked),
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
  const resetHints = getResetRatioHints();
  learnResetActions(resetHints);

  const upgrades = config.autoUpgrades ? clickBuyableUpgrades(config) : emptyClickSummary();
  const compost = config.autoCompost ? clickBuyableCompost(config) : emptyClickSummary();
  const cellLab = config.autoCellLab ? clickBuyableCellLab(config) : emptyClickSummary();
  const background = config.backgroundAutomation ? clickBackgroundActions(config) : emptyClickSummary();
  const autoReset = clickAutoResetActions(config);

  lastPurchaseSummary = createClickSummary(upgrades, compost, cellLab, background, autoReset, [], "Buy mode");
  return lastPurchaseSummary;
}

function summarizeScanOnly(scanResult, reason) {
  const upgradeCandidates = scanResult.upgrades.buyable.length;
  const compostCandidates = scanResult.compost.buyable.length;
  const cellLabCandidates = scanResult.cellLab.buyable.length;
  const autoResetCandidates = scanResult.autoReset.ready;

  return {
    candidates: upgradeCandidates + compostCandidates + cellLabCandidates + autoResetCandidates,
    clicked: 0,
    skipped: upgradeCandidates + compostCandidates + cellLabCandidates + autoResetCandidates,
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
    autoReset: {
      candidates: autoResetCandidates,
      clicked: 0,
      skipped: autoResetCandidates,
    },
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
  const autoReset = clickAutoResetActions(config);

  lastPurchaseSummary = createClickSummary(upgrades, compost, cellLab, background, autoReset, [], "Buy mode");
  lastSummary = createClickSummary(upgrades, compost, cellLab, background, autoReset, scanResult.resetHints, "Buy mode");
  renderPanel(config);
  return lastSummary;
}
