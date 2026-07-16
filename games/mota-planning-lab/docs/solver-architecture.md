# 魔塔求解器方向

状态：Stage2B 当前楼层只读候选分析已实现；全局规划器和真实页面执行未实现。

本仓库当前保留浏览器前端、最小协议 Schema、Rust Stage 0 spike，以及只分析单次 observation 当前楼层边界的 Stage2B shadow runtime。它不跨楼层、不选择动作。

## 目标运行边界

```text
JS 实时采集当前游戏状态
  → Rust 在进程内存中计算一个建议
  → Stage2B JS 只展示只读分析
  → 下一轮重新采集实时状态
```

实时 observation 是运行事实来源。Stage2B Rust 仅保存进程内 shadow cycle，返回 `idle + shadow` 当前楼层即时分析；不输出 action。旧 action、世界和规划状态不持久化，也不恢复或重放。旁路全量日志尚未实现。

## 下一步

1. [完成] 实现只读 Rust shadow runtime：接收 JS 实时状态并返回建议，不执行页面动作。
2. [完成] 用固定 fixture 和真实 HTTP 核对 JS/Rust 字段与 `idle + shadow` 合同。
3. [完成] 在真实页面完成只读联通验证，并增加当前楼层边界与即时成本分析。
4. [待定] Stage2B 独立验收后，再由用户决定是否做真实页面只读候选验证。

不得把 Stage 0 的合成结果当作策略正确性、服务 SLA 或真实存档自动驾驶授权。
