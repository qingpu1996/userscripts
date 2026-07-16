# 当前任务边界

- [x] 保留浏览器实时采集、观察、控制和单步执行前端。
- [x] 移除旧 Python 后端、后端专用测试/数据、历史 QA 和静态合规体系。
- [x] 保留固定 Stage 0 fixtures、Python baseline 与 Rust spike。
- [ ] 实现纯内存 Rust shadow runtime：JS 采集实时状态，Rust 只返回建议，JS 暂不执行。
- [ ] 用受控合成 observation 验证 JS/Rust shadow 契约，再单独评估真实页面只读采集。

后续运行链固定为：JS 实时采集 → Rust 内存决策 → JS 单步执行。旧 action、世界和规划状态不持久化；允许的唯一持久化是本次启动的旁路全量日志，且运行时只写不读。

不得把 Stage 0 的合成结果表述为真实页面策略正确性或自动驾驶授权。
