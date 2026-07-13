MotaLab.createPanel = function createPanel(documentObject) {
  const doc = documentObject;
  if (!doc || !doc.body) {
    return Object.freeze({ update() {}, setCollapsed() {} });
  }
  if (!doc.getElementById(MotaLab.STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = MotaLab.STYLE_ID;
    style.textContent = `
      #${MotaLab.PANEL_ID}{position:fixed;right:6px;bottom:6px;z-index:2147483646;width:196px;
      box-sizing:border-box;padding:7px 8px;border:1px solid #52606d;border-radius:7px;
      background:rgba(17,24,39,.94);color:#f3f4f6;font:11px/1.35 system-ui,sans-serif;
      box-shadow:0 4px 16px rgba(0,0,0,.32)}
      #${MotaLab.PANEL_ID}.collapsed{width:auto;max-width:196px}
      #${MotaLab.PANEL_ID} button{border:0;background:transparent;color:#d1d5db;cursor:pointer;padding:0 2px}
      #${MotaLab.PANEL_ID} .ml-head{display:flex;justify-content:space-between;gap:6px;font-weight:700}
      #${MotaLab.PANEL_ID} .ml-body{margin-top:5px;display:grid;grid-template-columns:56px 1fr;gap:2px 5px}
      #${MotaLab.PANEL_ID}.collapsed .ml-body{display:none}
      #${MotaLab.PANEL_ID} .ml-label{color:#9ca3af}
      #${MotaLab.PANEL_ID} .ml-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${MotaLab.PANEL_ID} .ml-bad{color:#fca5a5}.ml-good{color:#86efac}
    `;
    doc.head.appendChild(style);
  }

  const root = doc.createElement("section");
  root.id = MotaLab.PANEL_ID;
  const head = doc.createElement("div");
  head.className = "ml-head";
  const title = doc.createElement("span");
  title.textContent = "魔塔规划实验室";
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.textContent = "折叠";
  head.append(title, toggle);
  const body = doc.createElement("div");
  body.className = "ml-body";
  const fields = {};
  for (const [key, label] of [
    ["autopilot", "自动驾驶"],
    ["action", "action_id"],
    ["location", "现场"],
    ["reason", "最近决策"],
    ["service", "localhost"],
    ["pause", "暂停原因"],
  ]) {
    const labelNode = doc.createElement("span");
    labelNode.className = "ml-label";
    labelNode.textContent = label;
    const valueNode = doc.createElement("span");
    valueNode.className = "ml-value";
    valueNode.textContent = "—";
    valueNode.title = "";
    fields[key] = valueNode;
    body.append(labelNode, valueNode);
  }
  root.append(head, body);
  doc.body.appendChild(root);

  function setCollapsed(collapsed) {
    root.classList.toggle("collapsed", collapsed === true);
    toggle.textContent = collapsed ? "展开" : "折叠";
  }
  toggle.addEventListener("click", () => setCollapsed(!root.classList.contains("collapsed")));

  function setField(key, value, className) {
    if (value === undefined) return;
    const text = value === null || value === "" ? "—" : String(value);
    fields[key].textContent = text;
    fields[key].title = text;
    fields[key].className = `ml-value${className ? ` ${className}` : ""}`;
  }

  function update(state) {
    setField("autopilot", state.autopilot ? "运行" : "暂停", state.autopilot ? "ml-good" : "");
    setField("action", state.action_id);
    setField("location", state.location);
    setField("reason", state.reason);
    setField("service", state.connected ? "已连接" : "断开", state.connected ? "ml-good" : "ml-bad");
    setField("pause", state.pause_kind, state.pause_kind ? "ml-bad" : "");
  }
  return Object.freeze({ update, setCollapsed, element: root });
};
