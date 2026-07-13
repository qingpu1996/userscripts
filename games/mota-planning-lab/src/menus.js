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
    ["确认新会话基线", () => controller.confirmBaseline({ mode: "new_game" })],
    ["归档旧 v1 journal 证据", () => controller.archiveLegacyJournal()],
    ["确认归档后开始 v2 新会话", () => {
      const archive = controller.getLegacyArchive();
      if (!archive) return;
      if (confirmAction("旧 v1 journal 已本地归档。明确放弃旧 pending/recovery 身份链并开始全新 v2 会话？")) {
        controller.beginV2AfterLegacyArchive({
          archive_id: archive.archive_id,
          confirmation: "START_V2_NEW_SESSION",
        });
      }
    }],
    ["归档损坏 journal 摘要", () => controller.archiveCorruptJournal()],
    ["确认损坏 journal 归档后开始 v2", () => {
      const archive = controller.getCorruptArchive();
      if (!archive) return;
      if (confirmAction("损坏 journal 的 key、长度和内容哈希已归档。确认按该 fingerprint 处置并开始全新 v2 会话？")) {
        controller.beginV2AfterCorruptArchive({
          archive_id: archive.archive_id,
          confirmation: "ARCHIVE_CORRUPT_AND_START_V2",
        });
      }
    }],
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
