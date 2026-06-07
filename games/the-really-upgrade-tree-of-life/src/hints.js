function getLeafTimeHint() {
  const leaves = readVisibleLeafLayerResource();

  if (!leaves || !leaves.element || !leaves.rate || leaves.rate.amount.zero) {
    return null;
  }

  const targets = getVisibleCostTargets("leaves");

  if (targets.length === 0) {
    return null;
  }

  const nextTarget = targets.find((target) => target.cost.amount.log10 > leaves.amount.log10)
    || targets[0];

  let hint;

  if (nextTarget.cost.amount.log10 <= leaves.amount.log10) {
    hint = "下个树叶购买：现在可购买";
  } else {
    const missingLog10 = subtractLog10(nextTarget.cost.amount.log10, leaves.amount.log10);
    const secondsLog10 = missingLog10 - leaves.rate.amount.log10;
    hint = `下个树叶购买还需 ${formatDuration(secondsLog10)}`;
  }

  return {
    element: leaves.element,
    current: leaves.display,
    rate: leaves.rate.display,
    targetCost: nextTarget.cost.amountText,
    targetText: normalizeText(nextTarget.button.textContent),
    hint,
  };
}

function updateInlineLeafHint() {
  const hint = getLeafTimeHint();
  const activeHints = new Set();

  if (hint) {
    let hintNode = Array.from(hint.element.children)
      .find((child) => child.classList.contains(LEAF_HINT_CLASS));

    if (!hintNode) {
      hintNode = document.querySelector(`.${LEAF_HINT_CLASS}`);
    }

    if (!hintNode) {
      hintNode = document.createElement("div");
      hintNode.className = LEAF_HINT_CLASS;
    }

    if (hintNode.parentElement !== hint.element) {
      hint.element.appendChild(hintNode);
    }

    hint.element.style.position = "relative";
    hintNode.textContent = hint.hint;
    activeHints.add(hintNode);
  }

  removeInactiveHintNodes(LEAF_HINT_CLASS, activeHints);

  if (!hint) {
    return null;
  }

  const { element, ...serializableHint } = hint;
  return serializableHint;
}

function getUpgradeShortLabel(button) {
  const match = normalizeText(button.textContent).match(/^\[([^\]]+)\]/);
  return match ? `[${match[1]}]` : "下个升级";
}

function findVisibleUpgradeByLabel(resourcePattern, upgradeId) {
  const pattern = new RegExp(`^\\[(?:${resourcePattern})\\s*${upgradeId}\\]`, "i");
  return getVisibleUpgradeButtons()
    .find((button) => pattern.test(normalizeText(button.textContent)));
}

function parseVisibleUpgradeEffect(button) {
  const text = normalizeText(button.textContent);
  const match = text.match(/(?:效果|effect)[:：]\s*(.+)$/i);

  if (!match) {
    return null;
  }

  const effectText = match[1].replace(/\s*(?:成本|cost)[:：].*$/i, "");
  const parsed = splitLeadingAmount(effectText);
  return parsed?.amount || null;
}

function getSeedLeafBoostInnerLogValue(leafLog10) {
  return addLog10(leafLog10 - 13, 1);
}

function getSeedLeafBoostProjection(leaves) {
  const button = findVisibleUpgradeByLabel("树叶|leaf|leaves", 16);
  const effect = button ? parseVisibleUpgradeEffect(button) : null;

  if (!effect || effect.zero || !Number.isFinite(effect.log10) || effect.log10 <= 0) {
    return null;
  }

  const currentInner = getSeedLeafBoostInnerLogValue(leaves.amount.log10);
  const currentInnerLog10 = Math.log10(currentInner);

  if (!Number.isFinite(currentInnerLog10) || currentInnerLog10 <= 0) {
    return null;
  }

  const exponent = effect.log10 / currentInnerLog10;

  if (!Number.isFinite(exponent) || exponent <= 0) {
    return null;
  }

  return {
    currentInner,
    exponent,
  };
}

function getProjectedLeafLog10(leaves, seconds) {
  if (seconds <= 0) {
    return leaves.amount.log10;
  }

  const gainedLog10 = leaves.rate.amount.log10 + Math.log10(seconds);
  return addLog10(leaves.amount.log10, gainedLog10);
}

function getProjectedSeedGainLog10(gain, leaves, seconds, leafBoost) {
  const futureLeafLog10 = getProjectedLeafLog10(leaves, seconds);
  let projectedGainLog10 = gain.amount.log10
    + ((futureLeafLog10 - leaves.amount.log10) / 3);

  if (leafBoost) {
    const futureInner = getSeedLeafBoostInnerLogValue(futureLeafLog10);
    const currentInnerLog10 = Math.log10(leafBoost.currentInner);
    const futureInnerLog10 = Math.log10(futureInner);

    if (Number.isFinite(futureInnerLog10) && futureInnerLog10 > 0) {
      projectedGainLog10 += leafBoost.exponent * (futureInnerLog10 - currentInnerLog10);
    }
  }

  return projectedGainLog10;
}

function findSeedResetTargetSeconds(requiredGainLog10, gain, leaves, leafBoost) {
  if (getProjectedSeedGainLog10(gain, leaves, 0, leafBoost) >= requiredGainLog10) {
    return 0;
  }

  if (getProjectedSeedGainLog10(gain, leaves, oneWeekSeconds, leafBoost) < requiredGainLog10) {
    return null;
  }

  let low = 0;
  let high = oneWeekSeconds;

  for (let i = 0; i < 48; i += 1) {
    const middle = (low + high) / 2;

    if (getProjectedSeedGainLog10(gain, leaves, middle, leafBoost) >= requiredGainLog10) {
      high = middle;
    } else {
      low = middle;
    }
  }

  return high;
}

function formatFutureResetPrefix(seconds) {
  if (seconds === null) {
    return "大于一周后";
  }

  const duration = formatDuration(Math.log10(Math.max(seconds, 1e-9)));
  return duration === "大于一周" ? "大于一周后" : `约 ${duration}后`;
}

function getSeedResetAffordabilityHint(gain, current, resources) {
  if (gain.resourceKey !== "seeds") {
    return null;
  }

  const targets = getVisibleCostTargets("seeds");

  if (targets.length === 0) {
    return null;
  }

  const nextTarget = targets[0];
  const targetLabel = getUpgradeShortLabel(nextTarget.button);

  if (current && nextTarget.cost.amount.log10 <= current.amount.log10) {
    return `当前种子已够买 ${targetLabel}`;
  }

  const requiredGainLog10 = current
    ? subtractLog10(nextTarget.cost.amount.log10, current.amount.log10)
    : nextTarget.cost.amount.log10;

  if (gain.amount.log10 >= requiredGainLog10) {
    return `现在重置即可买 ${targetLabel}`;
  }

  const layerLeaves = readVisibleLeafLayerResource();
  const leaves = layerLeaves?.rate ? layerLeaves : resources.get("leaves");

  if (!leaves || !leaves.rate || leaves.rate.amount.zero) {
    return null;
  }

  const leafBoost = getSeedLeafBoostProjection(leaves);
  const seconds = findSeedResetTargetSeconds(requiredGainLog10, gain, leaves, leafBoost);
  return `${formatFutureResetPrefix(seconds)}重置可买 ${targetLabel}`;
}

function getResetRatioHints() {
  const resources = readVisibleResources();

  return getVisibleResetButtons()
    .map((button) => {
      const gain = parseResetGain(button);

      if (!gain) {
        return null;
      }

      const current = resources.get(gain.resourceKey);
      const currentMissing = !current;
      const currentWasZero = Boolean(current && current.amount.zero);
      const ratioLog10 = currentMissing
        ? null
        : currentWasZero
          ? gain.amount.log10
          : gain.amount.log10 - current.amount.log10;
      const ratio = ratioLog10 === null ? "无法计算" : formatRatio(ratioLog10);
      let ratioHint;

      if (currentMissing) {
        ratioHint = `未显示当前${gain.resourceLabel}，无法计算倍率`;
      } else if (currentWasZero) {
        ratioHint = `当前为 0，按 1 计算，重置后可获得 ${ratio} 倍的${gain.resourceLabel}`;
      } else {
        ratioHint = `重置后可获得 ${ratio} 倍的${gain.resourceLabel}`;
      }

      const seedAffordabilityHint = getSeedResetAffordabilityHint(gain, current, resources);
      const hint = [ratioHint, seedAffordabilityHint].filter(Boolean).join("；");

      return {
        button,
        text: normalizeText(button.textContent),
        classes: Array.from(button.classList),
        resourceKey: gain.resourceKey,
        resource: gain.resourceLabel,
        resourceLabel: gain.resourceLabel,
        gained: gain.amountText,
        gainedLog10: gain.amount.log10,
        current: current?.display || "0",
        currentLog10: currentMissing ? null : currentWasZero ? 0 : current.amount.log10,
        currentMissing,
        currentWasZero,
        ratio,
        ratioLog10,
        ratioHint,
        seedAffordabilityHint,
        hint,
      };
    })
    .filter(Boolean);
}

function findResetHintNode(button, type) {
  let node = button.nextElementSibling;

  while (node && node.classList.contains(RESET_HINT_CLASS)) {
    if (node.dataset.trutolResetHint === type
      || (type === "ratio" && !node.dataset.trutolResetHint)) {
      return node;
    }

    node = node.nextElementSibling;
  }

  return null;
}

function findAutoResetNode(button) {
  let node = button.nextElementSibling;

  while (node && (node.classList.contains(RESET_HINT_CLASS)
    || node.classList.contains(AUTO_RESET_HINT_CLASS))) {
    if (node.classList.contains(AUTO_RESET_HINT_CLASS)) {
      return node;
    }

    node = node.nextElementSibling;
  }

  return null;
}

function upsertResetHintNode(button, type, text, afterElement) {
  let hintNode = findResetHintNode(button, type);

  if (!hintNode) {
    hintNode = document.createElement("div");
    hintNode.className = RESET_HINT_CLASS;
  }

  hintNode.dataset.trutolResetHint = type;
  hintNode.textContent = text;

  if (hintNode.previousElementSibling !== afterElement) {
    afterElement.insertAdjacentElement("afterend", hintNode);
  }

  return hintNode;
}

function getTimeUnitMultiplier(unit) {
  if (unit === "hours") {
    return 3600;
  }

  if (unit === "seconds") {
    return 1;
  }

  return 60;
}

function formatSecondsForUnit(seconds, unit) {
  const multiplier = getTimeUnitMultiplier(unit);
  const value = Number(seconds) / multiplier;

  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }

  return String(Number.isInteger(value) ? value : Number(value.toFixed(2)));
}

function createAutoResetModeButton(node, mode, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "trutol-auto-reset-mode";
  button.textContent = label;
  button.addEventListener("click", () => {
    const resourceKey = node.dataset.resourceKey;
    updateAutoResetResourceConfig(resourceKey, { mode });
  });
  return button;
}

function normalizeAutoResetMode(mode) {
  return ["multiplier", "amount", "time", "hybrid"].includes(mode) ? mode : "multiplier";
}

function createAutoResetNode(resourceKey, options = {}) {
  const node = document.createElement("div");
  const inline = options.inline !== false;
  node.className = inline
    ? `${AUTO_RESET_HINT_CLASS} trutol-auto-reset-config`
    : "trutol-auto-reset-config";
  node.dataset.resourceKey = resourceKey;
  node.dataset.trutolAutoResetPanel = inline ? "false" : "true";

  const topRow = document.createElement("div");
  topRow.className = "trutol-auto-reset-row";

  const title = document.createElement("span");
  title.className = "trutol-auto-reset-title";
  title.textContent = "自动重置";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "trutol-auto-reset-toggle";
  toggle.addEventListener("click", () => {
    const config = getAutoResetResourceConfig(resourceKey);
    updateAutoResetResourceConfig(resourceKey, { enabled: !config.enabled });
  });

  topRow.appendChild(title);
  topRow.appendChild(toggle);

  const modeRow = document.createElement("div");
  modeRow.className = "trutol-auto-reset-row";
  const multiplierButton = createAutoResetModeButton(node, "multiplier", "倍率");
  const amountButton = createAutoResetModeButton(node, "amount", "定额");
  const timeButton = createAutoResetModeButton(node, "time", "时间");
  const hybridButton = createAutoResetModeButton(node, "hybrid", "混合");
  modeRow.appendChild(multiplierButton);
  modeRow.appendChild(amountButton);
  modeRow.appendChild(timeButton);
  modeRow.appendChild(hybridButton);

  const thresholdRow = document.createElement("div");
  thresholdRow.className = "trutol-auto-reset-row";

  const thresholdLabel = document.createElement("span");
  thresholdLabel.className = "trutol-auto-reset-field";

  const thresholdInput = document.createElement("input");
  thresholdInput.className = "trutol-auto-reset-input";
  thresholdInput.type = "text";
  thresholdInput.inputMode = "decimal";
  thresholdInput.addEventListener("change", () => {
    const config = getAutoResetResourceConfig(resourceKey);
    const mode = normalizeAutoResetMode(config.mode);

    if (mode === "amount") {
      updateAutoResetResourceConfig(resourceKey, {
        amountThreshold: thresholdInput.value.trim() || "1",
      });
      return;
    }

    updateAutoResetResourceConfig(resourceKey, {
      multiplierThreshold: thresholdInput.value.trim() || "1",
    });
  });

  const thresholdSuffix = document.createElement("span");
  thresholdSuffix.className = "trutol-auto-reset-suffix";

  thresholdRow.appendChild(thresholdLabel);
  thresholdRow.appendChild(thresholdInput);
  thresholdRow.appendChild(thresholdSuffix);

  const timeRow = document.createElement("div");
  timeRow.className = "trutol-auto-reset-row";

  const timeLabel = document.createElement("span");
  timeLabel.className = "trutol-auto-reset-field";
  timeLabel.textContent = "时间";

  const timeInput = document.createElement("input");
  timeInput.className = "trutol-auto-reset-input";
  timeInput.type = "text";
  timeInput.inputMode = "decimal";
  timeInput.addEventListener("change", () => {
    const config = getAutoResetResourceConfig(resourceKey);
    const seconds = Number(timeInput.value) * getTimeUnitMultiplier(config.timeThresholdUnit);

    if (Number.isFinite(seconds) && seconds > 0) {
      updateAutoResetResourceConfig(resourceKey, { timeThresholdSeconds: seconds });
    }
  });

  const unit = document.createElement("select");
  unit.className = "trutol-auto-reset-unit";
  [
    ["seconds", "秒"],
    ["minutes", "分"],
    ["hours", "时"],
  ].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    unit.appendChild(option);
  });
  unit.addEventListener("change", () => {
    const config = getAutoResetResourceConfig(resourceKey);
    const seconds = Number(timeInput.value) * getTimeUnitMultiplier(unit.value);
    updateAutoResetResourceConfig(resourceKey, {
      timeThresholdUnit: unit.value,
      timeThresholdSeconds: Number.isFinite(seconds) && seconds > 0
        ? seconds
        : config.timeThresholdSeconds,
    });
  });

  timeRow.appendChild(timeLabel);
  timeRow.appendChild(timeInput);
  timeRow.appendChild(unit);

  const timeMinRow = document.createElement("div");
  timeMinRow.className = "trutol-auto-reset-row";

  const timeMinLabel = document.createElement("span");
  timeMinLabel.className = "trutol-auto-reset-field";
  timeMinLabel.textContent = "保底";

  const timeMinInput = document.createElement("input");
  timeMinInput.className = "trutol-auto-reset-input";
  timeMinInput.type = "text";
  timeMinInput.inputMode = "decimal";
  timeMinInput.addEventListener("change", () => {
    updateAutoResetResourceConfig(resourceKey, {
      timeMinMultiplierThreshold: timeMinInput.value.trim() || "1",
    });
  });

  const timeMinSuffix = document.createElement("span");
  timeMinSuffix.className = "trutol-auto-reset-suffix";
  timeMinSuffix.textContent = "倍";

  timeMinRow.appendChild(timeMinLabel);
  timeMinRow.appendChild(timeMinInput);
  timeMinRow.appendChild(timeMinSuffix);

  const status = document.createElement("div");
  status.className = "trutol-auto-reset-status";

  node.appendChild(topRow);
  node.appendChild(modeRow);
  node.appendChild(thresholdRow);
  node.appendChild(timeRow);
  node.appendChild(timeMinRow);
  node.appendChild(status);

  node._trutolAutoReset = {
    title,
    toggle,
    multiplierButton,
    amountButton,
    timeButton,
    hybridButton,
    thresholdRow,
    thresholdLabel,
    thresholdInput,
    thresholdSuffix,
    timeRow,
    timeInput,
    unit,
    timeMinRow,
    timeMinInput,
    timeMinSuffix,
    status,
  };

  return node;
}

function updateAutoResetNode(node, hint = null) {
  const refs = node._trutolAutoReset;
  const resourceKey = hint?.resourceKey || node.dataset.resourceKey;
  const config = getAutoResetResourceConfig(resourceKey);
  const option = getAutoResetResourceOption(resourceKey);

  if (!refs || !config || !option) {
    return;
  }

  const mode = normalizeAutoResetMode(config.mode);
  const isTimeMode = mode === "time";
  const isAmountMode = mode === "amount";
  const isHybridMode = mode === "hybrid";
  refs.title.textContent = node.dataset.trutolAutoResetPanel === "true"
    ? `${option.label}重置`
    : "自动重置";
  refs.toggle.textContent = config.enabled ? "开" : "关";
  refs.toggle.classList.toggle("is-on", Boolean(config.enabled));
  refs.multiplierButton.classList.toggle("is-active", mode === "multiplier");
  refs.amountButton.classList.toggle("is-active", isAmountMode);
  refs.timeButton.classList.toggle("is-active", isTimeMode);
  refs.hybridButton.classList.toggle("is-active", isHybridMode);
  refs.thresholdRow.style.display = isTimeMode ? "none" : "";
  refs.timeRow.style.display = isTimeMode || isHybridMode ? "" : "none";
  refs.timeMinRow.style.display = isTimeMode || isHybridMode ? "" : "none";
  refs.thresholdLabel.textContent = isAmountMode ? "定额" : "倍率";
  refs.thresholdSuffix.textContent = isAmountMode ? option.label : "倍";

  if (document.activeElement !== refs.thresholdInput) {
    refs.thresholdInput.value = isAmountMode
        ? String(config.amountThreshold || "")
        : String(config.multiplierThreshold || "");
  }

  if (document.activeElement !== refs.timeInput) {
    refs.timeInput.value = formatSecondsForUnit(
      config.timeThresholdSeconds,
      config.timeThresholdUnit,
    );
  }

  if (refs.unit.value !== config.timeThresholdUnit) {
    refs.unit.value = config.timeThresholdUnit;
  }

  if (document.activeElement !== refs.timeMinInput) {
    refs.timeMinInput.value = String(config.timeMinMultiplierThreshold || "1");
  }

  const status = hint && typeof getAutoResetDecisionForHint === "function"
    ? getAutoResetDecisionForHint(hint, loadConfig())
    : typeof getAutoResetDecisionForResource === "function"
      ? getAutoResetDecisionForResource(resourceKey, loadConfig())
      : null;
  refs.status.textContent = status?.statusText || "状态：等待判断";
}

function upsertAutoResetNode(button, hint, afterElement) {
  if (!isAutoResetResourceSupported(hint.resourceKey)) {
    return null;
  }

  let node = findAutoResetNode(button);

  if (!node) {
    node = createAutoResetNode(hint.resourceKey, { inline: true });
  }

  node.dataset.resourceKey = hint.resourceKey;
  updateAutoResetNode(node, hint);

  if (node.previousElementSibling !== afterElement) {
    afterElement.insertAdjacentElement("afterend", node);
  }

  return node;
}

function updateInlineResetHints() {
  const hints = getResetRatioHints();
  const activeHints = new Set();
  const activeAutoResetNodes = new Set();

  for (const hint of hints) {
    let afterElement = hint.button;
    const rows = [
      { type: "ratio", text: hint.ratioHint },
      { type: "affordability", text: hint.seedAffordabilityHint },
    ].filter((row) => row.text);

    for (const row of rows) {
      const hintNode = upsertResetHintNode(hint.button, row.type, row.text, afterElement);
      activeHints.add(hintNode);
      afterElement = hintNode;
    }

    const autoResetNode = upsertAutoResetNode(hint.button, hint, afterElement);

    if (autoResetNode) {
      activeAutoResetNodes.add(autoResetNode);
      afterElement = autoResetNode;
    }
  }

  removeInactiveHintNodes(RESET_HINT_CLASS, activeHints);
  removeInactiveHintNodes(AUTO_RESET_HINT_CLASS, activeAutoResetNodes);

  return hints.map(({ button, ...hint }) => hint);
}
