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
