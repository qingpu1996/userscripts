# 魔塔求解器方向

状态：Stage1 Rust shadow runtime 已实现并通过合成 HTTP 合同测试；完整规划器和真实页面执行未实现。

本仓库当前保留浏览器前端、最小协议 Schema、Rust Stage 0 spike，以及一个可启动但只读的 Stage1 shadow runtime。旧 Python 后端及其完整规划、执行、恢复和存储实现已移除，因此不存在完整的规划或执行 runtime。

## 目标运行边界

```text
JS 实时采集当前游戏状态
  → Rust 在进程内存中计算一个建议
  → Stage1 JS 只展示建议（后续才可能单步执行）
  → 下一轮重新采集实时状态
```

实时 observation 是运行事实来源。Stage1 Rust 仅保存进程内 shadow cycle，返回 `idle + shadow`；不输出 action。旧 action、世界和规划状态不持久化，也不恢复或重放。旁路全量日志尚未实现。

## 下一步

1. [完成] 实现只读 Rust shadow runtime：接收 JS 实时状态并返回建议，不执行页面动作。
2. [完成] 用固定 fixture 和真实 HTTP 核对 JS/Rust 字段与 `idle + shadow` 合同。
3. [待定] 在 shadow 通过独立验收后，再评估页面侧单步执行接入。

不得把 Stage 0 的合成结果当作策略正确性、服务 SLA 或真实存档自动驾驶授权。
