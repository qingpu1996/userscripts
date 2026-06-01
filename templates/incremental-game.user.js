// ==UserScript==
// @name         Incremental Game Helper
// @namespace    local.incremental.userscripts
// @version      0.1.0
// @description  Lightweight automation helper for an incremental browser game.
// @match        https://example.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG_KEY = "incremental-game-helper-config";

  const defaultConfig = {
    enabled: true,
    tickMs: 1000,
  };

  function loadConfig() {
    return Object.assign({}, defaultConfig, GM_getValue(CONFIG_KEY, {}));
  }

  function saveConfig(config) {
    GM_setValue(CONFIG_KEY, config);
  }

  function log(...args) {
    console.log("[Incremental Helper]", ...args);
  }

  function query(selector, root = document) {
    return root.querySelector(selector);
  }

  function clickIfVisible(selector) {
    const element = query(selector);

    if (!element) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;

    if (!visible || element.disabled) {
      return false;
    }

    element.click();
    return true;
  }

  function runAutomation(config) {
    if (!config.enabled) {
      return;
    }

    // Add game-specific strategy here.
    // Example:
    // clickIfVisible("#main-button");
    // clickIfVisible(".upgrade.can-buy");
  }

  function main() {
    const config = loadConfig();

    log("started", config);

    window.setInterval(() => {
      runAutomation(loadConfig());
    }, config.tickMs);

    window.__incrementalGameHelper = {
      getConfig: loadConfig,
      setConfig(nextConfig) {
        const config = Object.assign({}, loadConfig(), nextConfig);
        saveConfig(config);
        return config;
      },
    };
  }

  main();
})();
