# 当前任务边界

- [x] 保留浏览器实时采集、观察、控制和单步执行前端。
- [x] 移除旧 Python 后端、后端专用测试/数据、历史 QA 和静态合规体系。
- [x] 保留固定 Stage 0 fixtures、Python baseline 与 Rust spike。
- [x] 实现纯内存 Rust shadow runtime：JS 采集实时状态，Rust 只返回 `idle + shadow` 建议，JS `shadowOnly` 暂不执行。
- [x] 用受控合成 observation 验证 JS/Rust shadow 契约；测试不访问真实页面。
- [ ] 在 shadow 通过独立验收后，再单独评估真实页面只读采集。

后续运行链固定为：JS 实时采集 → Rust 内存决策 → JS 单步执行。Stage1 只停在中间的只读建议，尚未授权最后一步。旧 action、世界和规划状态不持久化；旁路日志尚未实现。

不得把 Stage 0 的合成结果表述为真实页面策略正确性或自动驾驶授权。
