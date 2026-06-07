// ==UserScript==
// @name         The Really Upgrade Tree of Life Helper
// @namespace    local.incremental.userscripts
// @version      0.13.0
// @description  Conservative automation helper for The Really Upgrade Tree of Life.
// @match        https://the-really-upgrade-tree-of-life.g8hh.com.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/qingpu1996/userscripts/main/dist/the-really-upgrade-tree-of-life.user.js
// @downloadURL  https://raw.githubusercontent.com/qingpu1996/userscripts/main/dist/the-really-upgrade-tree-of-life.user.js
// ==/UserScript==

// This file is generated. Edit shared/ or games/*/src/ and rebuild it.
(function () {
  "use strict";

  // Source: shared/storage.js

  function gmGetValue(key, fallback) {
    if (typeof GM_getValue === "function") {
      return GM_getValue(key, fallback);
    }

    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function gmSetValue(key, value) {
    if (typeof GM_setValue === "function") {
      GM_setValue(key, value);
      return;
    }

    window.localStorage.setItem(key, JSON.stringify(value));
  }

  // Source: shared/dom.js

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function hasClassStartingWith(element, prefix) {
    return Array.from(element.classList).some((className) => className.startsWith(prefix));
  }

  function removeInactiveHintNodes(className, activeHints) {
    for (const node of document.querySelectorAll(`.${className}`)) {
      if (!activeHints.has(node)) {
        node.remove();
      }
    }
  }

  // Source: shared/large-number.js

  const decimalNumberSource = "(?:\\d+(?:[\\d,]*\\d)?(?:\\.\\d+)?|\\.\\d+)";
  const oneWeekSeconds = 7 * 24 * 60 * 60;
  const oneWeekLog10 = Math.log10(oneWeekSeconds);

  function buildSuffixMap() {
    const units = ["", "U", "D", "T", "Qa", "Qt", "Sx", "Sp", "Oc", "No"];
    const tens = ["", "Dc", "Vg", "Tg", "Qag", "Qtg", "Sxg", "Spg", "Ocg", "Nog"];
    const hundreds = ["", "Ce", "De", "Te", "Qae", "Qte", "Sxe", "Spe", "Oce", "Noe"];
    const secondUnits = ["", "Mi", "Mc", "Na", "Pc", "Fm", "At", "Zp", "Yc", "Xn"];
    const secondTens = ["", "Me", "Du", "Tr", "Te", "Pe", "He", "Hp", "Ot", "En"];
    const secondHundreds = ["", "c", "Ic", "TCn", "TeC", "PCn", "HCn", "HpC", "OCn", "ECn"];
    const secondThousands = ["", "Hc", "DHe", "THt", "TeH", "PHc", "HHe", "HpH", "OHt", "EHc"];

    function part1(value) {
      return units[value % 10]
        + tens[Math.floor(value / 10) % 10]
        + hundreds[Math.floor(value / 100)];
    }

    function part2(value) {
      const ones = value % 10;
      const tensValue = Math.floor(value / 10) % 10;
      const hundredsValue = Math.floor(value / 100) % 10;

      if (value < 10) {
        return secondUnits[value];
      }

      let suffix = "";
      suffix += tensValue === 1 && ones === 0
        ? "Vec"
        : secondTens[ones] + secondHundreds[tensValue];
      suffix += secondThousands[hundredsValue];
      return suffix;
    }

    function makeSuffix(group) {
      if (group < 1) {
        return "";
      }

      if (group < 4) {
        return ["", "K", "M", "B"][group];
      }

      let value = group - 1;
      let level = Math.floor(Math.log(value) / Math.log(1000));
      let suffix = "";

      if (level < 100) {
        level = Math.max(level - 1, 0);
      }

      value = Math.floor(value / (1000 ** level));

      while (value > 0) {
        const next = Math.floor(value / 1000);
        const chunk = Math.floor(value - next * 1000);

        if (chunk > 0) {
          if (chunk === 1 && !level) {
            suffix = "U";
          }

          if (level) {
            suffix = part2(level) + (suffix ? `-${suffix}` : "");
          }

          if (chunk > 1) {
            suffix = part1(chunk) + suffix;
          }
        }

        value = next;
        level += 1;
      }

      return suffix;
    }

    const map = new Map([
      ["", 0],
    ]);

    for (let group = 1; group <= 5000; group += 1) {
      const suffix = makeSuffix(group);
      if (suffix) {
        map.set(suffix, group);
      }
    }

    return map;
  }

  const suffixes = buildSuffixMap();

  function parseDisplayedNumber(value) {
    const text = normalizeText(value)
      .replace(/,/g, "")
      .replace(/^×/, "")
      .replace(/^\+/, "");

    if (!text || text === "0") {
      return { log10: Number.NEGATIVE_INFINITY, zero: true };
    }

    if (text === "∞" || /^inf(?:inity)?$/i.test(text)) {
      return { log10: Number.POSITIVE_INFINITY, zero: false };
    }

    const scientificMatch = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))e([+-]?\d+(?:\.\d+)?)$/i);

    if (scientificMatch) {
      const mantissa = Number(scientificMatch[1]);
      const exponent = Number(scientificMatch[2]);

      if (mantissa > 0 && Number.isFinite(exponent)) {
        return {
          log10: Math.log10(mantissa) + exponent,
          zero: false,
        };
      }
    }

    const suffixMatch = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*([A-Za-z-]+))?$/);

    if (!suffixMatch) {
      return null;
    }

    const mantissa = Number(suffixMatch[1]);
    const suffix = suffixMatch[2] || "";
    const group = suffixes.get(suffix);

    if (!(mantissa > 0) || group === undefined) {
      return null;
    }

    return {
      log10: Math.log10(mantissa) + group * 3,
      zero: false,
    };
  }

  function splitLeadingAmount(value) {
    const text = normalizeText(value)
      .replace(/^×/, "")
      .replace(/^\+/, "");

    if (!text) {
      return null;
    }

    const infinityMatch = text.match(/^(∞|inf(?:inity)?)\s*(.*)$/i);

    if (infinityMatch) {
      return {
        amountText: infinityMatch[1],
        amount: parseDisplayedNumber(infinityMatch[1]),
        tail: normalizeText(infinityMatch[2]),
      };
    }

    const scientificMatch = text.match(new RegExp(`^([+\\-]?${decimalNumberSource}[eE][+\\-]?[\\d,.]+)\\s*(.*)$`, "i"));

    if (scientificMatch) {
      return {
        amountText: scientificMatch[1],
        amount: parseDisplayedNumber(scientificMatch[1]),
        tail: normalizeText(scientificMatch[2]),
      };
    }

    const numberMatch = text.match(new RegExp(`^([+\\-]?${decimalNumberSource})\\s*([A-Za-z-]+)?\\s*(.*)$`));

    if (!numberMatch) {
      return null;
    }

    const suffix = numberMatch[2] || "";
    const suffixIsKnown = suffixes.has(suffix);
    const amountText = suffixIsKnown ? `${numberMatch[1]}${suffix}` : numberMatch[1];
    const tail = suffixIsKnown
      ? numberMatch[3]
      : `${suffix} ${numberMatch[3]}`;

    return {
      amountText,
      amount: parseDisplayedNumber(amountText),
      tail: normalizeText(tail),
    };
  }

  function formatRatio(log10Ratio) {
    if (log10Ratio === Number.POSITIVE_INFINITY) {
      return "∞";
    }

    if (log10Ratio === Number.NEGATIVE_INFINITY) {
      return "0";
    }

    if (!Number.isFinite(log10Ratio)) {
      return "无法计算";
    }

    if (log10Ratio < -3) {
      return "<0.001";
    }

    if (log10Ratio < 6) {
      const ratio = 10 ** log10Ratio;

      if (ratio >= 1000) {
        return ratio.toLocaleString("en-US", { maximumFractionDigits: 0 });
      }

      if (ratio >= 100) {
        return ratio.toFixed(1).replace(/\.0$/, "");
      }

      if (ratio >= 10) {
        return ratio.toFixed(2).replace(/\.?0+$/, "");
      }

      return ratio.toFixed(3).replace(/\.?0+$/, "");
    }

    const exponent = Math.floor(log10Ratio);
    const mantissa = 10 ** (log10Ratio - exponent);
    return `${mantissa.toFixed(2).replace(/\.?0+$/, "")}e${exponent}`;
  }

  function subtractLog10(minuendLog10, subtrahendLog10) {
    if (subtrahendLog10 === Number.NEGATIVE_INFINITY) {
      return minuendLog10;
    }

    if (minuendLog10 <= subtrahendLog10) {
      return Number.NEGATIVE_INFINITY;
    }

    const gap = subtrahendLog10 - minuendLog10;

    if (gap < -15) {
      return minuendLog10;
    }

    return minuendLog10 + Math.log10(1 - (10 ** gap));
  }

  function addLog10(leftLog10, rightLog10) {
    if (leftLog10 === Number.NEGATIVE_INFINITY) {
      return rightLog10;
    }

    if (rightLog10 === Number.NEGATIVE_INFINITY) {
      return leftLog10;
    }

    const high = Math.max(leftLog10, rightLog10);
    const low = Math.min(leftLog10, rightLog10);
    const gap = low - high;

    if (gap < -15) {
      return high;
    }

    return high + Math.log10(1 + (10 ** gap));
  }

  function formatDuration(log10Seconds) {
    if (log10Seconds > oneWeekLog10) {
      return "大于一周";
    }

    if (!Number.isFinite(log10Seconds) || log10Seconds < 0) {
      return "不到 1 秒";
    }

    const seconds = 10 ** log10Seconds;
    const roundedSeconds = Math.ceil(seconds);

    if (roundedSeconds < 60) {
      return `${roundedSeconds} 秒`;
    }

    if (roundedSeconds < 3600) {
      const minutes = Math.floor(roundedSeconds / 60);
      const restSeconds = roundedSeconds % 60;
      return restSeconds > 0 ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分`;
    }

    if (roundedSeconds < 86400) {
      const hours = Math.floor(roundedSeconds / 3600);
      const minutes = Math.ceil((roundedSeconds % 3600) / 60);
      return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
    }

    const days = Math.floor(roundedSeconds / 86400);
    const hours = Math.ceil((roundedSeconds % 86400) / 3600);
    return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  }

  // Source: games/the-really-upgrade-tree-of-life/src/config.js

  const CONFIG_KEY = "trutol-helper-config";
  const PANEL_ID = "trutol-helper-panel";
  const STYLE_ID = "trutol-helper-style";
  const LOG_PREFIX = "[TRUTOL Helper]";
  const RESET_HINT_CLASS = "trutol-inline-reset-hint";
  const LEAF_HINT_CLASS = "trutol-inline-leaf-hint";
  const AUTO_RESET_HINT_CLASS = "trutol-inline-auto-reset";

  const minBuyTickMs = 20;
  const minStatusTickMs = 250;

  const spendResourceOptions = [
    { key: "leaves", label: "树叶", defaultAllowed: true },
    { key: "seeds", label: "种子", defaultAllowed: true },
    { key: "fruits", label: "水果", defaultAllowed: true },
    { key: "entropy", label: "熵", defaultAllowed: false },
    { key: "roots", label: "根", defaultAllowed: false },
    { key: "ash", label: "灰烬", defaultAllowed: false },
    { key: "fallen", label: "落叶", defaultAllowed: false },
    { key: "sacred", label: "圣叶", defaultAllowed: false },
    { key: "cells", label: "细胞", defaultAllowed: false },
    { key: "bacteria", label: "细菌", defaultAllowed: false },
    { key: "other", label: "其他", defaultAllowed: false },
  ];

  const autoResetResourceOptions = [
    {
      key: "seeds",
      label: "种子",
      defaultMultiplierThreshold: "100",
      defaultAmountThreshold: "1e6",
      defaultTimeThresholdSeconds: 600,
      defaultTimeMinMultiplierThreshold: "1",
    },
    {
      key: "fruits",
      label: "水果",
      defaultMultiplierThreshold: "100",
      defaultAmountThreshold: "1e5",
      defaultTimeThresholdSeconds: 600,
      defaultTimeMinMultiplierThreshold: "1",
    },
    {
      key: "entropy",
      label: "熵",
      defaultMultiplierThreshold: "10",
      defaultAmountThreshold: "1",
      defaultTimeThresholdSeconds: 1800,
      defaultTimeMinMultiplierThreshold: "1",
    },
  ];

  function createDefaultSpendResources() {
    return Object.fromEntries(
      spendResourceOptions.map((option) => [option.key, option.defaultAllowed]),
    );
  }

  function createDefaultAutoResetConfig() {
    return Object.fromEntries(
      autoResetResourceOptions.map((option) => [option.key, {
        enabled: false,
        mode: "multiplier",
        multiplierThreshold: option.defaultMultiplierThreshold,
        amountThreshold: option.defaultAmountThreshold,
        timeThresholdSeconds: option.defaultTimeThresholdSeconds,
        timeThresholdUnit: "minutes",
        timeMinMultiplierThreshold: option.defaultTimeMinMultiplierThreshold,
        enabledAt: null,
        lastResetAt: null,
        lastAutoResetAt: null,
      }]),
    );
  }

  const speedProfiles = {
    steady: {
      label: "稳健",
      buyTickMs: 750,
      statusTickMs: 750,
    },
    fast: {
      label: "快速",
      buyTickMs: 250,
      statusTickMs: 500,
    },
    burst: {
      label: "爆发",
      buyTickMs: 50,
      statusTickMs: 500,
    },
  };

  const defaultConfig = {
    enabled: true,
    scanOnly: true,
    autoUpgrades: true,
    autoCompost: true,
    autoCellLab: false,
    backgroundAutomation: true,
    panelCollapsed: false,
    speedMode: "fast",
    buyTickMs: null,
    statusTickMs: null,
    tickMs: 750,
    spendResources: createDefaultSpendResources(),
    maxUpgradeClicksPerTick: 3,
    maxCompostClicksPerTick: 1,
    maxCellLabClicksPerTick: 3,
    maxBackgroundClicksPerTick: 3,
    maxBackgroundUpgradeClicksPerTick: 3,
    maxBackgroundCompostClicksPerTick: 4,
    maxBackgroundCellLabClicksPerTick: 3,
    maxAutoResetsPerTick: 1,
    autoResetEnabled: true,
    autoResetCooldownMs: 500,
    autoReset: createDefaultAutoResetConfig(),
    logScans: false,
    logClicks: true,
  };

  const riskyTextPatterns = [
    /\bWIPE\b/i,
    /\bSave\b/i,
    /\bExport\b/i,
    /\bImport\b/i,
    /\bReset\b/i,
    /\bRespec\b/i,
    /\bReload\b/i,
    /\bReinforcement\b/i,
    /\bTransform\b/i,
    /\bChallenge\b/i,
    /\bEnter\b/i,
    /\bExit\b/i,
    /\bConvert\b/i,
    /\bHarvest\b/i,
    /\bDecompolize\b/i,
    /\bReinforce\b/i,
    /\bExtend\s+Limit\b/i,
    /\bSacred\b/i,
    /\bPrestige\b/i,
  ];

  let panel;
  let statusNode;
  let resetNode;
  let buyIntervalId;
  let statusIntervalId;
  let controlRefs = {};
  let lastPurchaseSummary = {
    candidates: 0,
    clicked: 0,
    skipped: 0,
    upgrades: {
      candidates: 0,
      clicked: 0,
      skipped: 0,
    },
    compost: {
      candidates: 0,
      clicked: 0,
      skipped: 0,
    },
    cellLab: {
      candidates: 0,
      clicked: 0,
      skipped: 0,
    },
    background: {
      candidates: 0,
      clicked: 0,
      skipped: 0,
    },
    autoReset: {
      candidates: 0,
      clicked: 0,
      skipped: 0,
    },
    reason: "Starting",
  };
  let lastSummary = {
    candidates: 0,
    clicked: 0,
    skipped: 0,
    upgrades: {
      candidates: 0,
      clicked: 0,
      skipped: 0,
    },
    compost: {
      candidates: 0,
      clicked: 0,
      skipped: 0,
    },
    cellLab: {
      candidates: 0,
      clicked: 0,
      skipped: 0,
    },
    background: {
      candidates: 0,
      clicked: 0,
      skipped: 0,
    },
    autoReset: {
      candidates: 0,
      clicked: 0,
      skipped: 0,
    },
    resetHints: [],
    reason: "Starting",
  };

  const reasonLabels = {
    "Buy mode": "购买模式",
    Paused: "已暂停",
    "Scan only": "仅扫描",
    Starting: "启动中",
    "Waiting for app": "等待游戏",
  };

  function loadConfig() {
    const storedConfig = gmGetValue(CONFIG_KEY, {});
    const config = Object.assign({}, defaultConfig, storedConfig);
    const storedCooldownMs = Number(storedConfig.autoResetCooldownMs);
    if (storedConfig.autoResetCooldownMs === undefined
      || storedConfig.autoResetCooldownMs === null
      || storedCooldownMs === 5000
      || !Number.isFinite(storedCooldownMs)) {
      config.autoResetCooldownMs = defaultConfig.autoResetCooldownMs;
    }
    config.spendResources = Object.assign(
      {},
      defaultConfig.spendResources,
      storedConfig.spendResources || {},
    );
    config.autoReset = mergeAutoResetConfig(storedConfig.autoReset);
    return config;
  }

  function saveConfig(config) {
    gmSetValue(CONFIG_KEY, config);
  }

  function updateConfig(nextConfig) {
    const config = Object.assign({}, loadConfig(), nextConfig);
    if (nextConfig.autoReset) {
      config.autoReset = mergeAutoResetConfig(nextConfig.autoReset);
    }
    saveConfig(config);

    if (typeof restartLoops === "function") {
      restartLoops(config);
    }

    renderPanel(config);
    return config;
  }

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function formatReason(reason) {
    return reasonLabels[reason] || reason;
  }

  function getSpendResourceConfig(config = loadConfig()) {
    return Object.assign({}, defaultConfig.spendResources, config.spendResources || {});
  }

  function mergeAutoResetConfig(storedAutoReset = {}) {
    const defaults = createDefaultAutoResetConfig();
    const merged = {};

    for (const option of autoResetResourceOptions) {
      const storedResource = storedAutoReset?.[option.key] || {};
      merged[option.key] = Object.assign({}, defaults[option.key], storedResource);
      if (!["multiplier", "amount", "time", "hybrid"].includes(merged[option.key].mode)) {
        merged[option.key].mode = defaults[option.key].mode;
      }
    }

    return merged;
  }

  function getAutoResetResourceOption(resourceKey) {
    return autoResetResourceOptions.find((option) => option.key === resourceKey) || null;
  }

  function isAutoResetResourceSupported(resourceKey) {
    return Boolean(getAutoResetResourceOption(resourceKey));
  }

  function getAutoResetConfig(config = loadConfig()) {
    return mergeAutoResetConfig(config.autoReset);
  }

  function getAutoResetResourceConfig(resourceKey, config = loadConfig()) {
    return getAutoResetConfig(config)[resourceKey] || null;
  }

  function updateAutoResetResourceConfig(resourceKey, patch) {
    if (!isAutoResetResourceSupported(resourceKey)) {
      return loadConfig();
    }

    const config = loadConfig();
    const autoReset = getAutoResetConfig(config);
    const current = autoReset[resourceKey];
    const now = Date.now();
    const next = Object.assign({}, current, patch);

    if (patch.enabled === true && !current.enabled) {
      next.enabledAt = now;
      next.lastResetAt = current.lastResetAt || now;
    }

    autoReset[resourceKey] = next;
    return updateConfig({ autoReset });
  }

  function getSpendResourceKey(resourceKey) {
    return spendResourceOptions.some((option) => option.key === resourceKey)
      ? resourceKey
      : "other";
  }

  function isSpendResourceAllowed(resourceKey, config = loadConfig()) {
    const spendResources = getSpendResourceConfig(config);
    return Boolean(spendResources[getSpendResourceKey(resourceKey)]);
  }

  function getSpeedMode(config = loadConfig()) {
    return speedProfiles[config.speedMode] ? config.speedMode : defaultConfig.speedMode;
  }

  function getSpeedProfile(config = loadConfig()) {
    return speedProfiles[getSpeedMode(config)];
  }

  function formatSpeedMode(config = loadConfig()) {
    return getSpeedProfile(config).label;
  }

  function readTickMs(value, fallback, minimum) {
    const tickMs = Number(value);
    const resolved = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : fallback;
    return Math.max(minimum, resolved);
  }

  function getAutomationTimings(config = loadConfig()) {
    const profile = getSpeedProfile(config);

    return {
      buyTickMs: readTickMs(config.buyTickMs, profile.buyTickMs, minBuyTickMs),
      statusTickMs: readTickMs(config.statusTickMs, profile.statusTickMs, minStatusTickMs),
    };
  }

  // Source: games/the-really-upgrade-tree-of-life/src/selectors.js

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

  // Source: games/the-really-upgrade-tree-of-life/src/resources.js

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

  // Source: games/the-really-upgrade-tree-of-life/src/hints.js

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

  // Source: games/the-really-upgrade-tree-of-life/src/automation.js

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

  // Source: games/the-really-upgrade-tree-of-life/src/panel.js

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 12px;
        top: 12px;
        z-index: 999999;
        width: 278px;
        max-height: calc(100vh - 24px);
        overflow-y: auto;
        box-sizing: border-box;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        line-height: 1.35;
        color: #f8fafc;
        background: rgba(16, 20, 26, 0.88);
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 8px;
        padding: 10px;
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.36);
        backdrop-filter: blur(12px);
      }
      #${PANEL_ID}.is-collapsed {
        width: 158px;
        padding: 8px 9px;
      }
      #${PANEL_ID} * {
        box-sizing: border-box;
      }
      #${PANEL_ID} .trutol-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }
      #${PANEL_ID}.is-collapsed .trutol-header {
        margin-bottom: 0;
      }
      #${PANEL_ID} .trutol-title {
        font-weight: 700;
        letter-spacing: 0;
      }
      #${PANEL_ID} .trutol-header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #${PANEL_ID} .trutol-badge {
        min-width: 32px;
        padding: 2px 7px;
        border-radius: 999px;
        text-align: center;
        font-size: 11px;
        color: #a7f3d0;
        background: rgba(16, 185, 129, 0.16);
        border: 1px solid rgba(16, 185, 129, 0.28);
      }
      #${PANEL_ID} .trutol-collapse {
        min-width: 36px;
        height: 22px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 6px;
        color: #e2e8f0;
        background: rgba(30, 41, 59, 0.74);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        font-weight: 700;
      }
      #${PANEL_ID}.is-collapsed .trutol-body {
        display: none;
      }
      #${PANEL_ID} .trutol-control {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-top: 8px;
      }
      #${PANEL_ID} .trutol-control.is-top {
        align-items: flex-start;
      }
      #${PANEL_ID} .trutol-label {
        min-width: 62px;
        color: #cbd5e1;
        font-weight: 600;
      }
      #${PANEL_ID} .trutol-switch {
        position: relative;
        width: 52px;
        height: 28px;
        flex: 0 0 auto;
        border: 0;
        border-radius: 999px;
        padding: 0;
        background: rgba(100, 116, 139, 0.45);
        cursor: pointer;
        transition: background 160ms ease, box-shadow 160ms ease;
      }
      #${PANEL_ID} .trutol-switch::after {
        content: "";
        position: absolute;
        left: 3px;
        top: 3px;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
        transition: transform 160ms ease;
      }
      #${PANEL_ID} .trutol-switch.is-on {
        background: #22c55e;
      }
      #${PANEL_ID} .trutol-switch.is-on::after {
        transform: translateX(24px);
      }
      #${PANEL_ID} .trutol-segmented {
        display: grid;
        grid-template-columns: repeat(var(--trutol-segments, 2), minmax(0, 1fr));
        flex: 1;
        min-width: 0;
        padding: 3px;
        gap: 3px;
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.82);
        border: 1px solid rgba(148, 163, 184, 0.22);
      }
      #${PANEL_ID} .trutol-segment {
        min-width: 0;
        height: 26px;
        border: 0;
        border-radius: 6px;
        color: #cbd5e1;
        background: transparent;
        cursor: pointer;
        font: inherit;
        font-weight: 650;
      }
      #${PANEL_ID} .trutol-segment.is-active {
        color: #0f172a;
        background: #e2e8f0;
        box-shadow: 0 1px 8px rgba(0, 0, 0, 0.2);
      }
      #${PANEL_ID} .trutol-resource-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        flex: 1;
        gap: 4px;
        min-width: 0;
      }
      #${PANEL_ID} .trutol-resource-toggle {
        min-width: 0;
        height: 24px;
        border: 1px solid rgba(148, 163, 184, 0.24);
        border-radius: 6px;
        color: #cbd5e1;
        background: rgba(30, 41, 59, 0.76);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        font-weight: 700;
      }
      #${PANEL_ID} .trutol-resource-toggle.is-on {
        color: #064e3b;
        background: #86efac;
        border-color: rgba(134, 239, 172, 0.75);
      }
      #${PANEL_ID} .trutol-action-row {
        display: flex;
        gap: 8px;
        margin-top: 10px;
      }
      #${PANEL_ID} .trutol-action {
        width: 100%;
        height: 30px;
        border: 1px solid rgba(148, 163, 184, 0.26);
        border-radius: 7px;
        color: #e2e8f0;
        background: rgba(30, 41, 59, 0.84);
        cursor: pointer;
        font: inherit;
        font-weight: 700;
      }
      #${PANEL_ID} .trutol-stats {
        display: grid;
        gap: 5px;
        margin-top: 10px;
        padding-top: 9px;
        border-top: 1px solid rgba(148, 163, 184, 0.18);
      }
      #${PANEL_ID} .trutol-stat {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        color: #cbd5e1;
      }
      #${PANEL_ID} .trutol-stat strong {
        color: #f8fafc;
        font-weight: 700;
      }
      #${PANEL_ID} .trutol-reset {
        margin-top: 8px;
        color: #86efac;
        font-size: 11px;
        line-height: 1.35;
      }
      #${PANEL_ID} .trutol-section {
        display: grid;
        gap: 6px;
        margin-top: 10px;
        padding-top: 9px;
        border-top: 1px solid rgba(148, 163, 184, 0.18);
      }
      #${PANEL_ID} .trutol-section-label {
        color: #cbd5e1;
        font-weight: 700;
      }
      #${PANEL_ID} .trutol-auto-reset-panel {
        display: grid;
        gap: 6px;
        min-width: 0;
      }
      #${PANEL_ID} .trutol-auto-reset-master {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 5px 7px;
        border-radius: 6px;
        color: #14532d;
        background: rgba(187, 247, 208, 0.46);
        border: 1px solid rgba(34, 197, 94, 0.28);
        font-size: 11px;
        font-weight: 700;
      }
      #${PANEL_ID} .trutol-auto-reset-panel .trutol-auto-reset-config {
        width: 100%;
        min-width: 0;
        max-width: none;
        margin: 0;
      }
      #${PANEL_ID} .trutol-auto-reset-panel .trutol-auto-reset-row {
        justify-content: space-between;
      }
      .${RESET_HINT_CLASS},
      .${LEAF_HINT_CLASS} {
        width: fit-content;
        max-width: min(360px, 90vw);
        padding: 2px 7px;
        border-radius: 6px;
        color: #14532d;
        background: rgba(187, 247, 208, 0.52);
        border: 1px solid rgba(34, 197, 94, 0.28);
        font-size: 11px;
        line-height: 1.2;
        pointer-events: none;
      }
      .${RESET_HINT_CLASS} {
        margin: 3px auto 5px;
      }
      .${RESET_HINT_CLASS} + .${RESET_HINT_CLASS} {
        margin-top: -2px;
      }
      .${AUTO_RESET_HINT_CLASS} {
        margin: 3px auto 7px;
      }
      .trutol-auto-reset-config {
        display: grid;
        gap: 4px;
        width: fit-content;
        min-width: 226px;
        max-width: min(360px, 92vw);
        padding: 5px 7px;
        border-radius: 6px;
        color: #14532d;
        background: rgba(187, 247, 208, 0.58);
        border: 1px solid rgba(34, 197, 94, 0.32);
        font-size: 11px;
        line-height: 1.2;
      }
      .trutol-auto-reset-config .trutol-auto-reset-row {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
      }
      .trutol-auto-reset-config .trutol-auto-reset-title {
        min-width: 54px;
        font-weight: 700;
        text-align: left;
      }
      .trutol-auto-reset-config .trutol-auto-reset-field {
        min-width: 28px;
        font-weight: 700;
        text-align: left;
      }
      .trutol-auto-reset-config button,
      .trutol-auto-reset-config input,
      .trutol-auto-reset-config select {
        height: 22px;
        border: 1px solid rgba(21, 128, 61, 0.34);
        border-radius: 5px;
        font: inherit;
        font-size: 11px;
      }
      .trutol-auto-reset-config button {
        min-width: 34px;
        padding: 0 7px;
        color: #166534;
        background: rgba(240, 253, 244, 0.74);
        cursor: pointer;
        font-weight: 700;
      }
      .trutol-auto-reset-config button.is-on,
      .trutol-auto-reset-config button.is-active {
        color: #052e16;
        background: #86efac;
        border-color: rgba(22, 101, 52, 0.45);
      }
      .trutol-auto-reset-config .trutol-auto-reset-input {
        width: 76px;
        min-width: 0;
        padding: 0 5px;
        color: #052e16;
        background: rgba(240, 253, 244, 0.82);
      }
      .trutol-auto-reset-config .trutol-auto-reset-unit {
        width: 48px;
        padding: 0 3px;
        color: #052e16;
        background: rgba(240, 253, 244, 0.82);
      }
      .trutol-auto-reset-config .trutol-auto-reset-suffix {
        width: 30px;
        text-align: left;
        font-weight: 700;
      }
      .trutol-auto-reset-config .trutol-auto-reset-status {
        text-align: center;
        color: #166534;
      }
      .${LEAF_HINT_CLASS} {
        position: absolute !important;
        left: 50%;
        top: 50%;
        display: inline-block !important;
        height: auto !important;
        min-height: 0 !important;
        max-height: none !important;
        margin: 0;
        white-space: nowrap;
        transform: translate(-50%, -50%);
      }
    `;

    document.documentElement.appendChild(style);
  }

  function createActionButton(text, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.className = "trutol-action";
    button.addEventListener("click", onClick);
    return button;
  }

  function createSwitch(onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "trutol-switch";
    button.setAttribute("role", "switch");
    button.addEventListener("click", onClick);
    return button;
  }

  function createCollapseButton(onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "trutol-collapse";
    button.addEventListener("click", onClick);
    return button;
  }

  function createSegmentedControl(options, onSelect) {
    const wrapper = document.createElement("div");
    wrapper.className = "trutol-segmented";
    wrapper.style.setProperty("--trutol-segments", String(options.length));

    const buttons = {};

    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "trutol-segment";
      button.textContent = option.label;
      if (option.title) {
        button.setAttribute("title", option.title);
      }
      button.addEventListener("click", () => onSelect(option.value));
      buttons[option.value] = button;
      wrapper.appendChild(button);
    }

    return { wrapper, buttons };
  }

  function createResourceToggleGrid(options, onToggle) {
    const wrapper = document.createElement("div");
    wrapper.className = "trutol-resource-grid";

    const buttons = {};

    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "trutol-resource-toggle";
      button.textContent = option.label;
      button.addEventListener("click", () => onToggle(option.key));
      buttons[option.key] = button;
      wrapper.appendChild(button);
    }

    return { wrapper, buttons };
  }

  function createControlRow(labelText, control, options = {}) {
    const row = document.createElement("div");
    row.className = "trutol-control";
    row.classList.toggle("is-top", Boolean(options.alignTop));

    const label = document.createElement("div");
    label.className = "trutol-label";
    label.textContent = labelText;

    row.appendChild(label);
    row.appendChild(control);

    return row;
  }

  function createPanelSection(labelText, content) {
    const section = document.createElement("div");
    section.className = "trutol-section";

    const label = document.createElement("div");
    label.className = "trutol-section-label";
    label.textContent = labelText;

    section.appendChild(label);
    section.appendChild(content);
    return section;
  }

  function createAutoResetPanelGrid() {
    const wrapper = document.createElement("div");
    wrapper.className = "trutol-auto-reset-panel";
    const nodes = {};

    const masterRow = document.createElement("div");
    masterRow.className = "trutol-auto-reset-master";

    const masterLabel = document.createElement("span");
    masterLabel.textContent = "总开关";

    const masterSwitch = createSwitch(() => {
      const config = loadConfig();
      updateConfig({ autoResetEnabled: !config.autoResetEnabled });
    });

    masterRow.appendChild(masterLabel);
    masterRow.appendChild(masterSwitch);
    wrapper.appendChild(masterRow);

    for (const option of autoResetResourceOptions) {
      const node = createAutoResetNode(option.key, { inline: false });
      nodes[option.key] = node;
      wrapper.appendChild(node);
    }

    return { wrapper, nodes, masterSwitch };
  }

  function createStatRow(labelText, valueText) {
    const row = document.createElement("div");
    row.className = "trutol-stat";

    const label = document.createElement("span");
    label.textContent = labelText;

    const value = document.createElement("strong");
    value.textContent = valueText;

    row.appendChild(label);
    row.appendChild(value);

    return row;
  }

  function setSwitchState(button, isOn) {
    button.classList.toggle("is-on", isOn);
    button.setAttribute("aria-checked", String(isOn));
    button.setAttribute("title", isOn ? "已开启" : "已关闭");
  }

  function setSegmentedState(buttons, activeValue) {
    for (const [value, button] of Object.entries(buttons)) {
      button.classList.toggle("is-active", value === activeValue);
      button.setAttribute("aria-pressed", String(value === activeValue));
    }
  }

  function setResourceToggleState(buttons, config) {
    const spendResources = getSpendResourceConfig(config);

    for (const [key, button] of Object.entries(buttons)) {
      const isOn = Boolean(spendResources[key]);
      button.classList.toggle("is-on", isOn);
      button.setAttribute("aria-pressed", String(isOn));
      button.setAttribute("title", isOn ? `允许自动花费${button.textContent}` : `保护${button.textContent}`);
    }
  }

  function ensurePanel() {
    if (panel && document.contains(panel)) {
      return panel;
    }

    ensureStyles();

    document.getElementById(PANEL_ID)?.remove();

    panel = document.createElement("div");
    panel.id = PANEL_ID;

    const header = document.createElement("div");
    header.className = "trutol-header";

    const title = document.createElement("div");
    title.className = "trutol-title";
    title.textContent = "TRUTOL 助手";

    const badge = document.createElement("div");
    badge.className = "trutol-badge";

    const collapseButton = createCollapseButton(() => {
      const config = loadConfig();
      updateConfig({ panelCollapsed: !config.panelCollapsed });
    });

    const headerActions = document.createElement("div");
    headerActions.className = "trutol-header-actions";
    headerActions.appendChild(badge);
    headerActions.appendChild(collapseButton);

    header.appendChild(title);
    header.appendChild(headerActions);
    panel.appendChild(header);

    const panelBody = document.createElement("div");
    panelBody.className = "trutol-body";
    panel.appendChild(panelBody);

    const enabledSwitch = createSwitch(() => {
      const config = loadConfig();
      updateConfig({ enabled: !config.enabled });
    });

    const modeControl = createSegmentedControl([
      { label: "扫描", value: "scan" },
      { label: "购买", value: "buy" },
    ], (value) => {
      updateConfig({ scanOnly: value === "scan" });
    });

    const speedControl = createSegmentedControl([
      { label: "稳健", value: "steady", title: "750ms 购买 / 750ms 状态" },
      { label: "快速", value: "fast", title: "250ms 购买 / 500ms 状态" },
      { label: "爆发", value: "burst", title: "50ms 购买 / 500ms 状态" },
    ], (value) => {
      updateConfig({ speedMode: value, buyTickMs: null, statusTickMs: null });
    });

    const spendControl = createResourceToggleGrid(spendResourceOptions, (key) => {
      const config = loadConfig();
      const spendResources = getSpendResourceConfig(config);
      updateConfig({
        spendResources: Object.assign({}, spendResources, {
          [key]: !spendResources[key],
        }),
      });
    });

    const compostSwitch = createSwitch(() => {
      const config = loadConfig();
      updateConfig({ autoCompost: !config.autoCompost });
    });

    const cellLabSwitch = createSwitch(() => {
      const config = loadConfig();
      updateConfig({ autoCellLab: !config.autoCellLab });
    });

    const backgroundSwitch = createSwitch(() => {
      const config = loadConfig();
      updateConfig({ backgroundAutomation: !config.backgroundAutomation });
    });
    const autoResetPanel = createAutoResetPanelGrid();

    panelBody.appendChild(createControlRow("开关", enabledSwitch));
    panelBody.appendChild(createControlRow("模式", modeControl.wrapper));
    panelBody.appendChild(createControlRow("速度", speedControl.wrapper));
    panelBody.appendChild(createPanelSection("重置", autoResetPanel.wrapper));
    panelBody.appendChild(createControlRow("花费", spendControl.wrapper, { alignTop: true }));
    panelBody.appendChild(createControlRow("堆肥", compostSwitch));
    panelBody.appendChild(createControlRow("细胞", cellLabSwitch));
    panelBody.appendChild(createControlRow("后台", backgroundSwitch));

    const actions = document.createElement("div");
    actions.className = "trutol-action-row";
    actions.appendChild(createActionButton("立即执行", () => {
      runAutomation(loadConfig());
    }));
    panelBody.appendChild(actions);

    statusNode = document.createElement("div");
    statusNode.className = "trutol-stats";
    panelBody.appendChild(statusNode);

    resetNode = document.createElement("div");
    resetNode.className = "trutol-reset";
    panelBody.appendChild(resetNode);

    controlRefs = {
      badge,
      collapseButton,
      title,
      enabledSwitch,
      modeButtons: modeControl.buttons,
      speedButtons: speedControl.buttons,
      spendButtons: spendControl.buttons,
      compostSwitch,
      cellLabSwitch,
      backgroundSwitch,
      autoResetMasterSwitch: autoResetPanel.masterSwitch,
      autoResetNodes: autoResetPanel.nodes,
    };

    document.documentElement.appendChild(panel);
    return panel;
  }

  function renderPanel(config = loadConfig()) {
    ensurePanel();

    const resetHintText = lastSummary.resetHints.length === 0
      ? "无"
      : lastSummary.resetHints
        .slice(0, 2)
        .map((hint) => hint.hint || hint.text)
        .join(" ｜ ");

    panel.classList.toggle("is-collapsed", Boolean(config.panelCollapsed));
    controlRefs.title.textContent = config.panelCollapsed ? "TRUTOL" : "TRUTOL 助手";
    controlRefs.collapseButton.textContent = config.panelCollapsed ? "展开" : "收起";
    controlRefs.collapseButton.setAttribute("title", config.panelCollapsed ? "展开辅助面板" : "收起辅助面板");
    controlRefs.collapseButton.setAttribute("aria-expanded", String(!config.panelCollapsed));

    setSwitchState(controlRefs.enabledSwitch, config.enabled);
    setSwitchState(controlRefs.compostSwitch, config.autoCompost);
    setSwitchState(controlRefs.cellLabSwitch, config.autoCellLab);
    setSwitchState(controlRefs.backgroundSwitch, config.backgroundAutomation);
    setSwitchState(controlRefs.autoResetMasterSwitch, config.autoResetEnabled);
    setSegmentedState(controlRefs.modeButtons, config.scanOnly ? "scan" : "buy");
    setSegmentedState(controlRefs.speedButtons, getSpeedMode(config));
    setResourceToggleState(controlRefs.spendButtons, config);
    for (const node of Object.values(controlRefs.autoResetNodes || {})) {
      updateAutoResetNode(node);
    }

    controlRefs.badge.textContent = config.enabled ? "开" : "关";
    controlRefs.badge.style.color = config.enabled ? "#a7f3d0" : "#cbd5e1";
    controlRefs.badge.style.background = config.enabled
      ? "rgba(16, 185, 129, 0.16)"
      : "rgba(100, 116, 139, 0.2)";
    controlRefs.badge.style.borderColor = config.enabled
      ? "rgba(16, 185, 129, 0.28)"
      : "rgba(148, 163, 184, 0.24)";

    statusNode.replaceChildren(
      createStatRow("升级", `${lastSummary.upgrades.candidates}/${lastSummary.upgrades.clicked}`),
      createStatRow("堆肥", `${lastSummary.compost.candidates}/${lastSummary.compost.clicked}`),
      createStatRow("细胞", `${lastSummary.cellLab.candidates}/${lastSummary.cellLab.clicked}`),
      createStatRow("后台", `${lastSummary.background.candidates}/${lastSummary.background.clicked}`),
      createStatRow("重置", `${lastSummary.autoReset.candidates}/${lastSummary.autoReset.clicked}`),
      createStatRow("速度", formatSpeedMode(config)),
      createStatRow("状态", formatReason(lastSummary.reason)),
    );

    resetNode.textContent = `重置提示：${resetHintText}`;
  }

  // Source: games/the-really-upgrade-tree-of-life/src/main.js

  function clearLoops() {
    if (buyIntervalId) {
      window.clearInterval(buyIntervalId);
      buyIntervalId = null;
    }

    if (statusIntervalId) {
      window.clearInterval(statusIntervalId);
      statusIntervalId = null;
    }
  }

  function startLoops(config = loadConfig()) {
    const timings = getAutomationTimings(config);

    clearLoops();

    buyIntervalId = window.setInterval(() => {
      runPurchaseTick(loadConfig());
    }, timings.buyTickMs);

    statusIntervalId = window.setInterval(() => {
      runStatusTick(loadConfig());
    }, timings.statusTickMs);

    log("started", Object.assign({}, config, { timings }));
  }

  function restartLoops(config = loadConfig()) {
    startLoops(config);
  }

  function main() {
    window.__trutolHelper = {
      getConfig: loadConfig,
      setConfig: updateConfig,
      timings: () => getAutomationTimings(loadConfig()),
      spendResources: () => getSpendResourceConfig(loadConfig()),
      autoReset: () => getAutoResetConfig(loadConfig()),
      learnedActions: () => getLearnedAutomationSummary(loadConfig()),
      learnedResets: () => getAutoResetSummary(loadConfig()),
      scan,
      leafTimeHint: () => scan().leafTimeHint,
      resetHints: () => scan().resetHints,
      purchaseTick: () => runPurchaseTick(loadConfig()),
      statusTick: () => runStatusTick(loadConfig()),
      tick: () => runAutomation(loadConfig()),
    };

    const config = loadConfig();
    startLoops(config);
    runStatusTick(config);
  }

  main();
})();
