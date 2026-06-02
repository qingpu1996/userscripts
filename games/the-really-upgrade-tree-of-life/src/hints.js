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
      let ratioHint;

      if (!current || current.amount.zero) {
        ratioHint = `当前为 0，重置后可获得 ${gain.amountText} ${gain.resourceLabel}`;
      } else {
        const ratio = formatRatio(gain.amount.log10 - current.amount.log10);
        ratioHint = `重置后可获得 ${ratio} 倍的${gain.resourceLabel}`;
      }

      const seedAffordabilityHint = getSeedResetAffordabilityHint(gain, current, resources);
      const hint = [ratioHint, seedAffordabilityHint].filter(Boolean).join("；");

      return {
        button,
        text: normalizeText(button.textContent),
        classes: Array.from(button.classList),
        resource: gain.resourceLabel,
        gained: gain.amountText,
        current: current?.display || "0",
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

function updateInlineResetHints() {
  const hints = getResetRatioHints();
  const activeHints = new Set();

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
  }

  removeInactiveHintNodes(RESET_HINT_CLASS, activeHints);

  return hints.map(({ button, ...hint }) => hint);
}
