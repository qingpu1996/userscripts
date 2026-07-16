# 当前任务与验收边界

- [x] 游戏实时 observation 是规划唯一权威。
- [x] 页面与服务运行状态改为当前实例纯内存。
- [x] production 不读取或写入 state/knowledge 兼容目录。
- [x] 静态 bundled rules 启动时只读载入一次，非法时 fail closed。
- [x] 动态地图压缩 token 在 detached copy 上解压。
- [x] 方块差分忽略怪物派生 damage，保留稳定身份。
- [x] 保留有限 planning budget、人工权重的跨层 frontier 启发式基线，仅供离线研究。
- [x] 支持受约束商店购买与绑定 menu choice。
- [x] 记录真实运行失败结论：当前启发式会错误开门和分配资源，决策不可靠。
- [x] 冻结目标 V1 架构：纯内存单步循环、实时 observation 唯一权威、旁路只写诊断日志。
- [x] 记录 Rust 后端 ADR、大塔 ActiveDomain、商店/关键道具、终局目标和内部 `PROVEN` 方案。
- [x] Stage 0：固定 24/100/600 层合成基准、竞争首动作 proof replay、小塔 oracle，以及一次性 Python/Rust 等价和普通 benchmark；结果只用于判断 Rust shadow 路线。
- [ ] 下一步：实现只读 Rust shadow runtime，在内存中建立 `CatalogIR + GlobalIndex`，接收 JS 实时 observation 并返回单步建议，不执行动作。
- [ ] 为 shadow runtime 接入最小的完整状态投影/hash 校验和旁路诊断日志；运行时不读取旧日志或持久化 action、计划、世界状态。
- [ ] 用受控合成 observation 验证 JS/Rust shadow 等价，再单独评估真实页面只读采集。
- [ ] 全局求解器完成并通过独立验收前，禁止真实存档自动驾驶和真实页面行动回归。
- [ ] 正确性门禁建立后，再评估 idle 轮询、planner 长尾和换层 settle 等性能工作。

目标方案见 [求解器架构与实施方案](docs/solver-architecture.md)。上述已勾选项只表示设计文档完成，不表示目标源码、Schema、测试或构建物已经实现。

当前 legacy/transitional 实例内仍必须满足 single-flight、guard、expected delta、ACK 和商店 at-most-once。页面或服务重新实例化后 fresh start，不恢复、不重放旧 action；主动导出只用于人工诊断。

当前 guard、expected delta 与 ACK 只保护执行一致性，不能把启发式选择变成正确决策。现有 planner 不证明门后可解、不保证全局最优，也不保证安全通关；离线 QA 通过不得被表述成策略验收通过。

历史阶段记录已从当前任务契约移除，避免过时的磁盘恢复设计继续指导 production 行为；需要追溯时使用版本历史和既有 QA evidence。
