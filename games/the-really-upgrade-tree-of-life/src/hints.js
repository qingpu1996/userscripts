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

function getResetRatioHints() {
  const resources = readVisibleResources();

  return getVisibleResetButtons()
    .map((button) => {
      const gain = parseResetGain(button);

      if (!gain) {
        return null;
      }

      const current = resources.get(gain.resourceKey);
      let hint;

      if (!current || current.amount.zero) {
        hint = `当前为 0，重置后可获得 ${gain.amountText} ${gain.resourceLabel}`;
      } else {
        const ratio = formatRatio(gain.amount.log10 - current.amount.log10);
        hint = `重置后可获得 ${ratio} 倍的${gain.resourceLabel}`;
      }

      return {
        button,
        text: normalizeText(button.textContent),
        classes: Array.from(button.classList),
        resource: gain.resourceLabel,
        gained: gain.amountText,
        current: current?.display || "0",
        hint,
      };
    })
    .filter(Boolean);
}

function updateInlineResetHints() {
  const hints = getResetRatioHints();
  const activeHints = new Set();

  for (const hint of hints) {
    let hintNode = hint.button.nextElementSibling;

    if (!hintNode || !hintNode.classList.contains(RESET_HINT_CLASS)) {
      hintNode = document.createElement("div");
      hintNode.className = RESET_HINT_CLASS;
      hint.button.insertAdjacentElement("afterend", hintNode);
    }

    hintNode.textContent = hint.hint;
    activeHints.add(hintNode);
  }

  removeInactiveHintNodes(RESET_HINT_CLASS, activeHints);

  return hints.map(({ button, ...hint }) => hint);
}
