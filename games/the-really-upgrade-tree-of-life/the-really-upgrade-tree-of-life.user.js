// ==UserScript==
// @name         The Really Upgrade Tree of Life Helper
// @namespace    local.incremental.userscripts
// @version      0.4.1
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
  const decimalNumberSource = "(?:\\d+(?:[\\d,]*\\d)?(?:\\.\\d+)?|\\.\\d+)";
  const displayedNumberTokenSource = `[+\\-]?(?:${decimalNumberSource}[eE][+\\-]?[\\d,.]+|${decimalNumberSource}\\s*[A-Za-z-]+|${decimalNumberSource}|∞)`;

  const defaultConfig = {
    enabled: true,
    scanOnly: true,
    autoUpgrades: true,
    autoCompost: true,
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
      const match = text.match(/^([^:：]+)[:：]\s*([^(]+)/);

      if (!match) {
        continue;
      }

      const resource = normalizeResourceName(match[1]);
      const amount = parseDisplayedNumber(match[2]);

      if (amount) {
        resources.set(resource.key, {
          label: resource.label,
          amount,
          display: normalizeText(match[2]),
        });
      }
    }

    return resources;
  }

  function parseResetGain(button) {
    const text = normalizeText(button.textContent);
    const match = text.match(new RegExp(`(?:获得|gain)\\s+(${displayedNumberTokenSource})\\s*([^，。,.]+)`, "i"));

    if (!match) {
      return null;
    }

    const amount = parseDisplayedNumber(match[1]);
    const resource = normalizeResourceName(match[2]);

    if (!amount) {
      return null;
    }

    return {
      amount,
      amountText: normalizeText(match[1]),
      resourceKey: resource.key,
      resourceLabel: resource.label,
    };
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

    for (const node of document.querySelectorAll(`.${RESET_HINT_CLASS}`)) {
      if (!activeHints.has(node)) {
        node.remove();
      }
    }

    return hints.map(({ button, ...hint }) => hint);
  }

  function scan() {
    const visibleUpgrades = getVisibleUpgradeButtons();
    const buyableUpgrades = getBuyableUpgradeButtons();
    const visibleCompost = getVisibleCompostButtons();
    const buyableCompost = getBuyableCompostButtons();
    const resetHints = getResetRatioHints();

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
      #${PANEL_ID} .trutol-title {
        font-weight: 700;
        letter-spacing: 0;
      }
      #${PANEL_ID} .trutol-badge {
        min-width: 44px;
        padding: 2px 7px;
        border-radius: 999px;
        text-align: center;
        font-size: 11px;
        color: #a7f3d0;
        background: rgba(16, 185, 129, 0.16);
        border: 1px solid rgba(16, 185, 129, 0.28);
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
        color: #fbbf24;
        font-size: 11px;
        line-height: 1.35;
      }
      .${RESET_HINT_CLASS} {
        width: fit-content;
        max-width: min(360px, 90vw);
        margin: 4px auto 10px;
        padding: 4px 8px;
        border-radius: 6px;
        color: #fbbf24;
        background: rgba(251, 191, 36, 0.1);
        border: 1px solid rgba(251, 191, 36, 0.22);
        font-size: 12px;
        line-height: 1.35;
        pointer-events: none;
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
    button.setAttribute("title", isOn ? "On" : "Off");
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

    panel = document.createElement("div");
    panel.id = PANEL_ID;

    const header = document.createElement("div");
    header.className = "trutol-header";

    const title = document.createElement("div");
    title.className = "trutol-title";
    title.textContent = "TRUTOL Helper";

    const badge = document.createElement("div");
    badge.className = "trutol-badge";

    header.appendChild(title);
    header.appendChild(badge);
    panel.appendChild(header);

    const enabledSwitch = createSwitch(() => {
      const config = loadConfig();
      updateConfig({ enabled: !config.enabled });
    });

    const modeControl = createSegmentedControl([
      { label: "Scan", value: "scan" },
      { label: "Buy", value: "buy" },
    ], (value) => {
      updateConfig({ scanOnly: value === "scan" });
    });

    const compostSwitch = createSwitch(() => {
      const config = loadConfig();
      updateConfig({ autoCompost: !config.autoCompost });
    });

    panel.appendChild(createControlRow("Power", enabledSwitch));
    panel.appendChild(createControlRow("Mode", modeControl.wrapper));
    panel.appendChild(createControlRow("Compost", compostSwitch));

    const actions = document.createElement("div");
    actions.className = "trutol-action-row";
    actions.appendChild(createActionButton("Tick Now", () => {
      runAutomation(loadConfig());
    }));
    panel.appendChild(actions);

    statusNode = document.createElement("div");
    statusNode.className = "trutol-stats";
    panel.appendChild(statusNode);

    resetNode = document.createElement("div");
    resetNode.className = "trutol-reset";
    panel.appendChild(resetNode);

    controlRefs = {
      badge,
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
      ? "none"
      : lastSummary.resetHints
        .slice(0, 2)
        .map((hint) => hint.hint || hint.text)
        .join(" || ");

    setSwitchState(controlRefs.enabledSwitch, config.enabled);
    setSwitchState(controlRefs.compostSwitch, config.autoCompost);
    setSegmentedState(controlRefs.modeButtons, config.scanOnly ? "scan" : "buy");

    controlRefs.badge.textContent = config.enabled ? "ON" : "OFF";
    controlRefs.badge.style.color = config.enabled ? "#a7f3d0" : "#cbd5e1";
    controlRefs.badge.style.background = config.enabled
      ? "rgba(16, 185, 129, 0.16)"
      : "rgba(100, 116, 139, 0.2)";
    controlRefs.badge.style.borderColor = config.enabled
      ? "rgba(16, 185, 129, 0.28)"
      : "rgba(148, 163, 184, 0.24)";

    statusNode.replaceChildren(
      createStatRow("Upgrades", `${lastSummary.upgrades.candidates}/${lastSummary.upgrades.clicked}`),
      createStatRow("Compost", `${lastSummary.compost.candidates}/${lastSummary.compost.clicked}`),
      createStatRow("Last", lastSummary.reason),
    );

    resetNode.textContent = `Reset hints: ${resetHintText}`;
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
      resetHints: () => scan().resetHints,
      tick: () => runAutomation(loadConfig()),
    };

    startLoop();
  }

  main();
})();
