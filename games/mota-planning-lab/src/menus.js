MotaLab.downloadObservation = function downloadObservation(observation, environment = {}) {
  const doc = environment.documentObject || document;
  const BlobType = environment.BlobType || Blob;
  const urlApi = environment.urlApi || URL;
  const blob = new BlobType([JSON.stringify(observation, null, 2)], { type: "application/json" });
  const url = urlApi.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = `mota-current-floor-${Date.now()}.json`;
  link.style.display = "none";
  doc.body.appendChild(link);
  link.click();
  link.remove();
  urlApi.revokeObjectURL(url);
};

MotaLab.registerMenus = function registerMenus({
  register,
  controller,
  confirmAction = (message) => confirm(message),
  exporter = MotaLab.downloadObservation,
}) {
  const registrations = [
    ["启动自动驾驶", () => controller.start()],
    ["暂停自动驾驶", () => controller.manualPause()],
    ["导出当前层运行态", () => {
      const observation = controller.getCurrentObservation();
      if (observation) exporter(observation);
    }],
    ["清除待执行行动", () => {
      if (confirmAction("只清除浏览器待执行账本，不会改变游戏现场。确定继续？")) {
        controller.clearPending();
      }
    }],
    ["仅重新连接本地决策器", () => controller.reconnectOnly()],
  ];
  for (const [label, handler] of registrations) register(label, handler);
  return registrations.map(([label]) => label);
};
