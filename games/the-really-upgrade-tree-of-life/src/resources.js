function normalizeResourceName(name) {
  const text = normalizeText(name).toLowerCase();

  if (text.includes("圣") || text.includes("sacred")) {
    return { key: "sacred", label: "圣叶" };
  }

  if (text.includes("落叶")
    || text.includes("fallen")
    || text.includes("bronze")
    || text.includes("silver")
    || text.includes("gold")
    || text.includes("autumn")) {
    return { key: "fallen", label: "落叶" };
  }

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

  if (text.includes("灰") || text.includes("ash")) {
    return { key: "ash", label: "灰烬" };
  }

  if (text.includes("细胞") || text.includes("cell")) {
    return { key: "cells", label: "细胞" };
  }

  if (text.includes("细菌") || text.includes("bacteria")) {
    return { key: "bacteria", label: "细菌" };
  }

  if (text.includes("树叶")
    || text.includes("叶子")
    || text.includes("leaf")
    || text.includes("leaves")) {
    return { key: "leaves", label: "树叶" };
  }

  return { key: text, label: normalizeText(name) };
}

const buttonResourceHints = [
  { key: "leaves", label: "树叶", labels: ["树叶", "叶子", "leaf"], groups: ["L", "LR"] },
  { key: "seeds", label: "种子", labels: ["种子", "seed"], groups: ["S", "SR"] },
  { key: "fruits", label: "水果", labels: ["水果", "fruit"], groups: ["F", "FR"] },
  { key: "entropy", label: "熵", labels: ["熵", "entropy"], groups: ["E", "ER"] },
  { key: "roots", label: "根", labels: ["根", "root"], groups: ["RO", "ROR"] },
  { key: "cells", label: "细胞", labels: ["细胞", "cell"], groups: ["cell"] },
  { key: "bacteria", label: "细菌", labels: ["细菌", "bacteria"], groups: ["bacteria"] },
];

const compostFrameSelector = ".fertilizer-frame, .composter-frame";

function getCompostFrame(button) {
  return button.closest(compostFrameSelector);
}

function getUpgradeGroupFromButton(button) {
  const text = normalizeText(button.textContent);
  const bracket = text.match(/^\s*\[([^\]\s]+)(?:\s+\d+)?\]/);

  if (bracket) {
    const label = bracket[1].toLowerCase();
    const matched = buttonResourceHints.find((hint) => hint.labels
      .some((candidate) => label.includes(candidate.toLowerCase())));

    if (matched) {
      return matched.groups[0];
    }

    return bracket[1].toUpperCase();
  }

  const className = Array.from(button.classList)
    .find((name) => name.startsWith("upgrade-"));

  return className ? className.replace(/^upgrade-/, "").toUpperCase() : null;
}

function inferButtonCostResource(button) {
  const group = getUpgradeGroupFromButton(button);

  if (!group) {
    return null;
  }

  const normalizedGroup = group.toUpperCase();
  return buttonResourceHints.find((hint) => hint.groups
    .some((candidate) => candidate.toUpperCase() === normalizedGroup)) || null;
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

function getResetResourceFromButton(button) {
  const resourceMap = {
    seeds: { key: "seeds", label: "种子" },
    fruits: { key: "fruits", label: "水果" },
    entropy: { key: "entropy", label: "熵" },
    roots: { key: "roots", label: "根" },
  };
  const dataResource = button.dataset.resetResource;

  if (dataResource && resourceMap[dataResource]) {
    return resourceMap[dataResource];
  }

  const classMap = [
    ["upgrade-S", { key: "seeds", label: "种子" }],
    ["upgrade-F", { key: "fruits", label: "水果" }],
    ["upgrade-E", { key: "entropy", label: "熵" }],
    ["upgrade-RO", { key: "roots", label: "根" }],
  ];

  for (const [className, resource] of classMap) {
    if (button.classList.contains(className)) {
      return resource;
    }
  }

  return null;
}

function parseLastDisplayedAmountFromText(text) {
  const normalized = normalizeText(text);
  const matches = Array.from(normalized.matchAll(new RegExp(
    `(∞|inf(?:inity)?|[+\\-]?${decimalNumberSource}(?:[eE][+\\-]?[\\d,.]+|\\s*[A-Za-z-]+)?)`,
    "gi",
  )))
    .map((match) => normalizeText(match[1]))
    .map((amountText) => ({
      amountText,
      amount: parseDisplayedNumber(amountText),
    }))
    .filter((entry) => entry.amount);

  return matches[matches.length - 1] || null;
}

function parseResetGainAmountFromButton(button) {
  const boldAmounts = Array.from(button.querySelectorAll("b"))
    .map((element) => normalizeText(element.textContent))
    .map((text) => ({
      amountText: text,
      amount: parseDisplayedNumber(text),
    }))
    .filter((entry) => entry.amount);

  return boldAmounts[boldAmounts.length - 1]
    || parseLastDisplayedAmountFromText(button.textContent);
}

function parseTextualResetGain(button) {
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

function parseResetGain(button) {
  if (!button.classList.contains("layer-reset-button")) {
    return parseTextualResetGain(button);
  }

  const resource = getResetResourceFromButton(button);
  const parsed = parseResetGainAmountFromButton(button);

  if (!resource || !parsed) {
    return null;
  }

  return {
    amount: parsed.amount,
    amountText: parsed.amountText,
    resourceKey: resource.key,
    resourceLabel: resource.label,
  };
}

function parseCostFromText(text) {
  const normalized = normalizeText(text);
  const matches = Array.from(normalized.matchAll(/(?:成本|cost)[:：]?\s*/gi));
  const match = matches[matches.length - 1];

  if (!match) {
    return null;
  }

  const parsed = splitLeadingAmount(normalized.slice(match.index + match[0].length));

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
  const directCost = parseCostFromText(button.textContent);
  const inferredResource = inferButtonCostResource(button);

  if (directCost) {
    if (inferredResource && getSpendResourceKey(directCost.resourceKey) === "other") {
      return Object.assign({}, directCost, {
        resourceKey: inferredResource.key,
        resourceLabel: inferredResource.label,
      });
    }

    return directCost;
  }

  if (button.classList.contains("compost-button")) {
    return parseCostFromText(getCompostFrame(button)?.textContent);
  }

  return null;
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
