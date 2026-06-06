const CONFIG_KEY = "trutol-helper-config";
const PANEL_ID = "trutol-helper-panel";
const STYLE_ID = "trutol-helper-style";
const LOG_PREFIX = "[TRUTOL Helper]";
const RESET_HINT_CLASS = "trutol-inline-reset-hint";
const LEAF_HINT_CLASS = "trutol-inline-leaf-hint";

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

function createDefaultSpendResources() {
  return Object.fromEntries(
    spendResourceOptions.map((option) => [option.key, option.defaultAllowed]),
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
  panelCollapsed: false,
  speedMode: "fast",
  buyTickMs: null,
  statusTickMs: null,
  tickMs: 750,
  spendResources: createDefaultSpendResources(),
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
  config.spendResources = Object.assign(
    {},
    defaultConfig.spendResources,
    storedConfig.spendResources || {},
  );
  return config;
}

function saveConfig(config) {
  gmSetValue(CONFIG_KEY, config);
}

function updateConfig(nextConfig) {
  const config = Object.assign({}, loadConfig(), nextConfig);
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
