function isRiskyButton(button) {
  const text = normalizeText(button.textContent);

  if (button.closest(".o-options-grid")) {
    return true;
  }

  if (button.matches(".tab-button, .stab-button, .no-active, .layer-reset-button, #sacred-reset, #bacteria-reset, .no-grid-big-upgrade")) {
    return true;
  }

  return riskyTextPatterns.some((pattern) => pattern.test(text));
}

function isUpgradeLike(button) {
  return hasClassStartingWith(button, "upgrade-") || button.classList.contains("repeatable-upgrade");
}

function isClickablePrimary(button) {
  return !button.disabled && !button.classList.contains("o-primary-btn--disabled");
}

function getVisibleUpgradeButtons() {
  return Array.from(document.querySelectorAll("button.o-primary-btn, button.repeatable-upgrade"))
    .filter((button) => isVisible(button))
    .filter((button) => isUpgradeLike(button));
}

function getBuyableUpgradeButtons() {
  return getVisibleUpgradeButtons()
    .filter(isClickablePrimary)
    .filter((button) => !button.classList.contains("o-primary-btn--bought"))
    .filter((button) => !isRiskyButton(button));
}

const cellLabUpgradeClasses = [
  "upgrade-cell",
  "upgrade-bacteria",
  "upgrade-virus",
  "upgrade-BV",
];

function isCellLabUpgradeButton(button) {
  return button.classList.contains("big-upgrade")
    && cellLabUpgradeClasses.some((className) => button.classList.contains(className));
}

function getBuyableNormalUpgradeButtons() {
  return getBuyableUpgradeButtons()
    .filter((button) => !isCellLabUpgradeButton(button));
}

function getBuyableCellLabUpgradeButtons() {
  return getBuyableUpgradeButtons()
    .filter(isCellLabUpgradeButton);
}

function getVisibleCompostButtons() {
  return Array.from(document.querySelectorAll("button.compost-button"))
    .filter((button) => isVisible(button));
}

function getBuyableCompostButtons() {
  return getVisibleCompostButtons()
    .filter(isClickablePrimary)
    .filter((button) => !isRiskyButton(button));
}

function getVisibleResetButtons() {
  return Array.from(document.querySelectorAll("button.layer-reset-button, button#sacred-reset"))
    .filter((button) => isVisible(button));
}

function describeButton(button) {
  const cost = typeof parseButtonCost === "function" ? parseButtonCost(button) : null;

  return {
    text: normalizeText(button.textContent),
    classes: Array.from(button.classList),
    cost: cost
      ? {
        amountText: cost.amountText,
        resourceKey: cost.resourceKey,
        resourceLabel: cost.resourceLabel,
      }
      : null,
  };
}
