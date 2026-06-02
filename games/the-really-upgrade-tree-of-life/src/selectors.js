function isRiskyButton(button) {
  const text = normalizeText(button.textContent);

  if (button.closest(".o-options-grid")) {
    return true;
  }

  if (button.matches(".tab-button, .stab-button, .no-active, .layer-reset-button")) {
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
  return {
    text: normalizeText(button.textContent),
    classes: Array.from(button.classList),
  };
}
