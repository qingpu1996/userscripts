# StructuralLabel rebuild QA 归档（2026-07-18）

本目录归档本次 StructuralLabel A/B 与搜索剖析的原始文本证据，便于网页版及其他 AI 复核。基线 A 为 `4a7ad6c`，B 为 `d899a8f` 工作树。两版使用相同的 2,576,604 B 请求；每版预热一次，交错运行 5+5 个正式样本，均为纯 POST，并每 10 ms 采样服务 PID 的 RSS。

A 的中位耗时为 2049.516 ms、最大 RSS 为 138,706,944 B；B 分别为 3373.533 ms 与 83,755,008 B。B 的 RSS 降低 39.6%，耗时增加 64.6%。10 次响应均为 HTTP 200、探索 50k、`unproven`、`budget exhausted`，且 Phase B=0。B 的剖析显示 representative BFS 调用 394248 次、总计约 2.087 s。

这些结果只适用于一个未证明样本，不能外推为通用 SLA。A/B 脚本曾错误删除不存在的 `shadow.analysis.cycle`，实际字段为 `shadow.cycle`；不过逐对原始 response hashes 一致，因此结论仍可复算。原始 JSON 保持逐字不改写，包含该证据瑕疵。

本目录是仓库归档，仅供审阅，不是运行时依赖。
