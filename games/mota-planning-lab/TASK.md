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
- [ ] 在重新澄清目标、终局条件和优化指标后，另立任务设计全局可行路线求解器。
- [ ] 全局求解器完成并通过独立验收前，禁止真实存档自动驾驶和真实页面行动回归。
- [ ] 正确性门禁建立后，再评估 idle 轮询、planner 长尾和换层 settle 等性能工作。

当前实例内仍必须满足 single-flight、guard、expected delta、ACK 和商店 at-most-once。页面或服务重启后 fresh start，不恢复、不重放旧 action；主动导出只用于人工诊断。

当前 guard、expected delta 与 ACK 只保护执行一致性，不能把启发式选择变成正确决策。现有 planner 不证明门后可解、不保证全局最优，也不保证安全通关；离线 QA 通过不得被表述成策略验收通过。

历史阶段记录已从当前任务契约移除，避免过时的磁盘恢复设计继续指导 production 行为；需要追溯时使用版本历史和既有 QA evidence。
