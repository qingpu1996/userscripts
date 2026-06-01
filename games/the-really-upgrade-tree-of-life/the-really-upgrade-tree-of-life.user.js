// ==UserScript==
// @name         The Really Upgrade Tree of Life Helper
// @namespace    local.incremental.userscripts
// @version      0.6.0
// @description  Conservative automation helper for The Really Upgrade Tree of Life.
// @match        https://the-really-upgrade-tree-of-life.g8hh.com.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG_KEY = "trutol-helper-config";
  const PANEL_ID = "trutol-helper-panel";
  const STYLE_ID = "trutol-helper-style";
  const LOG_PREFIX = "[TRUTOL Helper]";
  const RESET_HINT_CLASS = "trutol-inline-reset-hint";
  const LEAF_HINT_CLASS = "trutol-inline-leaf-hint";
  const decimalNumberSource = "(?:\\d+(?:[\\d,]*\\d)?(?:\\.\\d+)?|\\.\\d+)";
  const oneWeekSeconds = 7 * 24 * 60 * 60;
  const oneWeekLog10 = Math.log10(oneWeekSeconds);

  const defaultConfig = {
    enabled: true,
    scanOnly: true,
    autoUpgrades: true,
    autoCompost: true,
    panelCollapsed: false,
    tickMs: 750,
    maxUpgradeClicksPerTick: 3,
    maxCompostClicksPerTick: 1,
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
    /\bSacred\b/i,
    /\bPrestige\b/i,
  ];

  const suffixes = buildSuffixMap();

  let panel;
  let statusNode;
  let resetNode;
  let intervalId;
  let controlRefs = {};
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

  function loadConfig() {
    return Object.assign({}, defaultConfig, gmGetValue(CONFIG_KEY, {}));
  }

  function saveConfig(config) {
    gmSetValue(CONFIG_KEY, config);
  }

  function updateConfig(nextConfig) {
    const config = Object.assign({}, loadConfig(), nextConfig);
    saveConfig(config);
    renderPanel(config);
    return config;
  }

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function formatReason(reason) {
    return reasonLabels[reason] || reason;
  }

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

  function removeInactiveHintNodes(className, activeHints) {
    for (const node of document.querySelectorAll(`.${className}`)) {
      if (!activeHints.has(node)) {
        node.remove();
      }
    }
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

  function scan() {
    const visibleUpgrades = getVisibleUpgradeButtons();
    const buyableUpgrades = getBuyableUpgradeButtons();
    const visibleCompost = getVisibleCompostButtons();
    const buyableCompost = getBuyableCompostButtons();
    const resetHints = getResetRatioHints();
    const leafTimeHint = getLeafTimeHint();

    return {
      upgrades: {
        visible: visibleUpgrades.map(describeButton),
        buyable: buyableUpgrades.map(describeButton),
      },
      compost: {
        visible: visibleCompost.map(describeButton),
        buyable: buyableCompost.map(describeButton),
      },
      resetHints: resetHints.map(({ button, ...hint }) => hint),
      leafTimeHint: leafTimeHint
        ? (({ element, ...hint }) => hint)(leafTimeHint)
        : null,
    };
  }

  function emptyClickSummary() {
    return {
      candidates: 0,
      clicked: 0,
      skipped: 0,
    };
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
    const candidates = getBuyableUpgradeButtons();
    const legacyLimit = config.maxClicksPerTick;
    const configuredLimit = config.maxUpgradeClicksPerTick === undefined
      ? legacyLimit
      : config.maxUpgradeClicksPerTick;
    const limit = readLimit(configuredLimit, defaultConfig.maxUpgradeClicksPerTick);

    return clickButtons(candidates, limit, "upgrade", config);
  }

  function clickBuyableCompost(config) {
    const candidates = getBuyableCompostButtons();
    const limit = readLimit(config.maxCompostClicksPerTick, defaultConfig.maxCompostClicksPerTick);

    return clickButtons(candidates, limit, "compost", config);
  }

  function summarizeScanOnly(scanResult, reason) {
    const upgradeCandidates = scanResult.upgrades.buyable.length;
    const compostCandidates = scanResult.compost.buyable.length;

    return {
      candidates: upgradeCandidates + compostCandidates,
      clicked: 0,
      skipped: upgradeCandidates + compostCandidates,
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
      resetHints: scanResult.resetHints,
      reason,
    };
  }

  function runAutomation(config = loadConfig()) {
    if (!document.querySelector("#app")) {
      lastSummary = {
        candidates: 0,
        clicked: 0,
        skipped: 0,
        upgrades: emptyClickSummary(),
        compost: emptyClickSummary(),
        resetHints: [],
        reason: "Waiting for app",
      };
      renderPanel(config);
      return lastSummary;
    }

    const scanResult = scan();
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

    lastSummary = {
      candidates: upgrades.candidates + compost.candidates,
      clicked: upgrades.clicked + compost.clicked,
      skipped: upgrades.skipped + compost.skipped,
      upgrades,
      compost,
      resetHints: scanResult.resetHints,
      reason: "Buy mode",
    };
    renderPanel(config);
    return lastSummary;
  }

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
        width: 236px;
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
        grid-template-columns: 1fr 1fr;
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
        margin: 3px auto 8px;
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

    const buttons = {};

    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "trutol-segment";
      button.textContent = option.label;
      button.addEventListener("click", () => onSelect(option.value));
      buttons[option.value] = button;
      wrapper.appendChild(button);
    }

    return { wrapper, buttons };
  }

  function createControlRow(labelText, control) {
    const row = document.createElement("div");
    row.className = "trutol-control";

    const label = document.createElement("div");
    label.className = "trutol-label";
    label.textContent = labelText;

    row.appendChild(label);
    row.appendChild(control);

    return row;
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

    const compostSwitch = createSwitch(() => {
      const config = loadConfig();
      updateConfig({ autoCompost: !config.autoCompost });
    });

    panelBody.appendChild(createControlRow("开关", enabledSwitch));
    panelBody.appendChild(createControlRow("模式", modeControl.wrapper));
    panelBody.appendChild(createControlRow("堆肥", compostSwitch));

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
      compostSwitch,
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
    setSegmentedState(controlRefs.modeButtons, config.scanOnly ? "scan" : "buy");

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
      createStatRow("状态", formatReason(lastSummary.reason)),
    );

    resetNode.textContent = `重置提示：${resetHintText}`;
  }

  function startLoop() {
    const config = loadConfig();

    if (intervalId) {
      window.clearInterval(intervalId);
    }

    intervalId = window.setInterval(() => {
      runAutomation(loadConfig());
    }, Math.max(250, Number(config.tickMs) || defaultConfig.tickMs));

    renderPanel(config);
    log("started", config);
  }

  function main() {
    window.__trutolHelper = {
      getConfig: loadConfig,
      setConfig: updateConfig,
      scan,
      leafTimeHint: () => scan().leafTimeHint,
      resetHints: () => scan().resetHints,
      tick: () => runAutomation(loadConfig()),
    };

    startLoop();
  }

  main();
})();
