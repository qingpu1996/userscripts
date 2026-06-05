const CONFIG_KEY = "trutol-helper-config";
const PANEL_ID = "trutol-helper-panel";
const STYLE_ID = "trutol-helper-style";
const LOG_PREFIX = "[TRUTOL Helper]";
const RESET_HINT_CLASS = "trutol-inline-reset-hint";
const LEAF_HINT_CLASS = "trutol-inline-leaf-hint";

const minBuyTickMs = 20;
const minStatusTickMs = 250;

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
  return Object.assign({}, defaultConfig, gmGetValue(CONFIG_KEY, {}));
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
