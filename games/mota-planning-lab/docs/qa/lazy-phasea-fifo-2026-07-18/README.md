# 惰性 Phase A compact FIFO QA（2026-07-18）

本归档用于网页版审阅，不是运行时依赖。基线 A 为 `d899a8f` StructuralLabel；B 为当前未提交的 Phase A 惰性 compact FIFO 工作树。两版使用相同归档 request、release 构建、各一次预热、交错 7+7 正式样本、纯 `POST /cycle`，服务 PID 每 10ms 采样 RSS；canonical response 正确移除 `shadow.cycle`。

A/B 响应语义一致：HTTP 200、`proof=unproven`、`reason=search_budget_exhausted`、`explored_states=50000`、`phase_b_explored=0`，canonical response hash 相同。A 中位 POST 为 **4266.899 ms**、峰值 RSS 为 **84,541,440 B**（原始 TSV 的 `82,560 KiB × 1024`）；B 中位 POST 为 **2429.033 ms**、峰值 RSS 为 **53,280,768 B**（原始 TSV 的 `52,032 KiB × 1024`）。

惰性 FIFO 剖析：`accepted=50000 expanded=50000 rejected=147187 pending=315033 representative_calls=0`。这表明代表 BFS 热路径为 0；本轮样本只有单一 `Phase B=0`，不能外推到复杂 proven 存档或 SLA。

证据文件：[`ab.json`](ab.json) 与 [`profile.log`](profile.log) 分别逐字复制本轮 `/private/tmp/mota-phasea-fifo-ab.json` 和 `/private/tmp/mota-phasea-fifo-profile.log`。原始 TSV 路径记录在 JSON 中。归档不包含二进制、`target`、request body 或其他构建产物。
