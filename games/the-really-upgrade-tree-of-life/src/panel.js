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
      margin: 3px auto 5px;
    }
    .${RESET_HINT_CLASS} + .${RESET_HINT_CLASS} {
      margin-top: -2px;
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

  const speedControl = createSegmentedControl([
    { label: "稳健", value: "steady", title: "750ms 购买 / 750ms 状态" },
    { label: "快速", value: "fast", title: "250ms 购买 / 500ms 状态" },
    { label: "爆发", value: "burst", title: "50ms 购买 / 500ms 状态" },
  ], (value) => {
    updateConfig({ speedMode: value, buyTickMs: null, statusTickMs: null });
  });

  const compostSwitch = createSwitch(() => {
    const config = loadConfig();
    updateConfig({ autoCompost: !config.autoCompost });
  });

  panelBody.appendChild(createControlRow("开关", enabledSwitch));
  panelBody.appendChild(createControlRow("模式", modeControl.wrapper));
  panelBody.appendChild(createControlRow("速度", speedControl.wrapper));
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
    speedButtons: speedControl.buttons,
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
  setSegmentedState(controlRefs.speedButtons, getSpeedMode(config));

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
    createStatRow("速度", formatSpeedMode(config)),
    createStatRow("状态", formatReason(lastSummary.reason)),
  );

  resetNode.textContent = `重置提示：${resetHintText}`;
}
