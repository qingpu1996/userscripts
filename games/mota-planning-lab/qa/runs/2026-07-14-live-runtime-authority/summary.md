# 当前运行态唯一权威重构 QA

- 结果：PASS。
- 完整 QA：`104 JS + 91 Python + 1 integration = 196/196`。
- 浏览器：真实 `hero.items.tools.*Key` 形状 fixture 输出 `1/1/1`；缺失、残缺和冲突不再默认为零；采集前后围栏可重试瞬时变化并拒绝持续 torn snapshot；pending durable 后、行动 API 前现场变化保持零执行。
- 服务：planner 只接收不含 hero/keys/busy 的 `HistoricalMapFact`；历史完整 observation 仅用于 action recovery/audit。跨图搜索使用本轮 live resource vector，重访 map instance 选择最新 revision。
- 原子性：一次响应仍最多一个末端状态变化边界；完成后完整重采、稳定两轮、真实差分，再进入下一轮实时规划。
- 兼容性：未改变 Protocol v2 wire schema 或 SQLite v2 schema；旧 pending、完整 observation、action ledger 与 generation 恢复链保留。
- 构建：userscript/direct mount 均重建两次且 hash 稳定；Acorn 静态盲玩检查覆盖 src/service/双 dist 并通过。
- 未运行：真实页面、真实移动、真实存档与外网；本轮只使用当前项目离线 fixture/fake core。
