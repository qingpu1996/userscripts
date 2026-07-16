# 实时运行时权威

当前页面的 live observation 是行动唯一权威：地图实例、角色位置与属性、钥匙、动态 blocks、怪物、商店、flags、菜单和 busy 状态都必须从当前游戏读取。

静态 floors/maps/material/source definitions 用于解释规则和建立索引，不能覆盖动态现场。读取完整未来地图不授权直接修改现场；所有动作仍须通过游戏正常接口执行。

## 当前实现（legacy/transitional）

当前 controller 和 Python service 使用 Protocol v2 `/cycle`，在当前实例内缓存 world context 和一个 action identity，并以 guard、expected delta 与 completed ACK 约束动作。重新实例化后 fresh start，不读取旧运行目录或浏览器 storage。

## 目标 V1（尚未实现）

启动时 JS 做一次完整扫描，后端只在内存中建立索引。之后每轮 JS 等游戏 idle，采集一份自包含 `StepObservation`；后端必须用它覆盖内存中的旧推测，然后只返回一个结果。

浏览器和 Rust 只从完整、版本固定的 `DecisionStateProjectionV1` 计算 hash；所有影响合法性或决策的实时字段都必须纳入，不存在轻量子集。Rust 重算 `/step` 请求 hash 后才返回逐字相同的 `baseStateHash`；浏览器等待 idle、完整复采同一投影。不同就通过 `/run-events` 旁路记录 stale、丢弃且绝不执行；相同才执行一个动作。下一轮 observation 是上一步实际结果，不另设 ACK 或恢复链。

地图索引、搜索树、缓存和当前候选全部可丢弃。历史诊断日志只写不读，`/run-events` 也不能修改 solver 或代替下一轮 observation，永远不能反向覆盖 live observation。一个 solver 进程只服务一张页面和一个 active run；第二页面使用独立进程/端口或被拒绝。完整目标见 [求解器架构与实施方案](solver-architecture.md)。
