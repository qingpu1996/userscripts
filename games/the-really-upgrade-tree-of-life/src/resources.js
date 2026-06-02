function normalizeResourceName(name) {
  const text = normalizeText(name).toLowerCase();

  if (text.includes("种子") || text.includes("seed")) {
    return { key: "seeds", label: "种子" };
  }

  if (text.includes("水果") || text.includes("fruit")) {
    return { key: "fruits", label: "水果" };
  }

  if (text.includes("根") || text.includes("root")) {
    return { key: "roots", label: "根" };
  }

  if (text.includes("熵") || text.includes("entropy")) {
    return { key: "entropy", label: "熵" };
  }

  if (text.includes("树叶") || text.includes("leaf") || text.includes("leaves")) {
    return { key: "leaves", label: "树叶" };
  }

  return { key: text, label: normalizeText(name) };
}

function readVisibleResources() {
  const resources = new Map();

  for (const element of document.querySelectorAll(".currency-frame")) {
    const text = normalizeText(element.textContent);
    const match = text.match(/^([^:：]+)[:：]\s*([^()]+)(?:\(([^)]*)\))?/);

    if (!match) {
      continue;
    }

    const resource = normalizeResourceName(match[1]);
    const amount = parseDisplayedNumber(match[2]);
    const rate = parseProductionRate(match[3]);

    if (amount) {
      resources.set(resource.key, {
        label: resource.label,
        amount,
        display: normalizeText(match[2]),
        element,
        rate,
      });
    }
  }

  return resources;
}

function getLeafLayerFrame() {
  const leafButton = getVisibleUpgradeButtons()
    .find((button) => hasClassStartingWith(button, "upgrade-L"));

  return leafButton?.closest(".layer-frame") || null;
}

function readVisibleLeafLayerResource() {
  const frame = getLeafLayerFrame();
  const element = frame?.querySelector(".layer-content");

  if (!element || !isVisible(element)) {
    return null;
  }

  const text = normalizeText(element.textContent);
  const match = text.match(/^你有\s+(.+?)\s*(?:\(([^)]*)\))?\s*(树叶|leaf|leaves)[.。]?/i);

  if (!match) {
    return null;
  }

  const amount = parseDisplayedNumber(match[1]);
  const rate = parseProductionRate(match[2]);

  if (!amount) {
    return null;
  }

  return {
    label: "树叶",
    amount,
    display: normalizeText(match[1]),
    element,
    rate,
  };
}

function parseProductionRate(value) {
  if (!value) {
    return null;
  }

  const text = normalizeText(value);
  const isPerSecond = /\/\s*秒|\/\s*(s|sec|second)s?\b|每秒|per\s*(sec|second)/i.test(text);

  if (!isPerSecond) {
    return null;
  }

  const parsed = splitLeadingAmount(text);

  if (!parsed || !parsed.amount) {
    return null;
  }

  return {
    amount: parsed.amount,
    display: parsed.amountText,
  };
}

function parseResetGain(button) {
  const text = normalizeText(button.textContent);
  const match = text.match(/(?:获得|gain)\s+(.+)/i);

  if (!match) {
    return null;
  }

  const parsed = splitLeadingAmount(match[1]);

  if (!parsed || !parsed.amount) {
    return null;
  }

  const resourceName = normalizeText(parsed.tail).replace(/[，。,.].*$/, "");
  const resource = normalizeResourceName(resourceName);

  return {
    amount: parsed.amount,
    amountText: parsed.amountText,
    resourceKey: resource.key,
    resourceLabel: resource.label,
  };
}

function parseButtonCost(button) {
  const text = normalizeText(button.textContent);
  const match = text.match(/(?:成本|cost)[:：]?\s*(.+)$/i);

  if (!match) {
    return null;
  }

  const parsed = splitLeadingAmount(match[1]);

  if (!parsed || !parsed.amount) {
    return null;
  }

  const resourceName = normalizeText(parsed.tail).replace(/[，。,.].*$/, "");
  const resource = normalizeResourceName(resourceName);

  return {
    amount: parsed.amount,
    amountText: parsed.amountText,
    resourceKey: resource.key,
    resourceLabel: resource.label,
  };
}

function getVisibleCostTargets(resourceKey) {
  return getVisibleUpgradeButtons()
    .filter((button) => !button.classList.contains("o-primary-btn--bought"))
    .filter((button) => !isRiskyButton(button))
    .map((button) => {
      const cost = parseButtonCost(button);
      return cost ? { button, cost } : null;
    })
    .filter((target) => target && target.cost.resourceKey === resourceKey)
    .sort((left, right) => left.cost.amount.log10 - right.cost.amount.log10);
}
