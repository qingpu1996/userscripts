# 当前与目标世界模型

## 当前实现（legacy/transitional）

当前 Python planner 从本轮 observation 和当前进程已观察地图关系派生 world graph。英雄资源来自本轮 live observation；跨层搜索可参考已知楼层，但仍是有限 planning budget 的启发式，不搜索到终局，也不证明战略正确。

当前目标选择与路线执行分离，并以 guard、expected delta 和 ACK 约束当前实例动作。这些是 Protocol v2 事实，不是目标 V1 的长期模型。

## 目标 V1（尚未实现）

启动时 JS 只读扫描完整游戏定义，Rust 后端在内存中建立四层模型：

1. `CatalogIR`：全塔规则和静态实体的紧凑表；
2. `GlobalIndex`：区域/SCC、楼层连接、商店、关键道具、终局和反向依赖；
3. `ActiveDomain`：本轮精确搜索的局部子图；
4. `SearchState`：不可逆决策后的资源、flags、消耗集合和 Pareto 标签。

每轮 `StepObservation` 用游戏实时角色、资源、地图和 flags 覆盖内存推测，并按规则依赖使缓存失效。内存模型冲突且无法解释时暂停，不能从历史 observation 或日志恢复。

`StepObservation` 通过唯一版本化的 `DecisionStateProjectionV1` 绑定决策。它覆盖 bootstrap/model digest、位置和规则相关方向、英雄完整战斗/资源/装备/道具状态、决策相关 variables、交互 idle/busy/菜单/商店/事件、ActiveDomain 动态拓扑与实体触发/移除状态，以及伤害、奖励、通行和终局评分读取的实时规则字段。adapter、transition、bound、score 或 guard 新增任何读取时，必须同步扩展投影 schema；JS/Rust 用同一规范编码和 hash golden fixture 验证。时间戳、cycle/event 序号、UI 像素与纯动画帧不进入投影。

`/step` 是改变最新 `RuntimeState` 和触发规划的唯一入口。浏览器的 `/run-events` 只能追加诊断文件；即使收到 `execution_completed`，世界模型也不能据此推进。上一步的真实结果必须由下一轮完整 observation 覆盖进来。

600 层静态目录可以用 `O(T+E)` 扫描并常驻紧凑索引，但组合搜索只展开 ActiveDomain。当前最高层 `+10` 是软预算；远端关键道具、高性价比商店、区域锁和终局设施通过依赖切片与可采纳界进入决策。

只有严格零副作用的走廊/清空区域可以压缩为可逆闭包。商店、NPC、事件、路径伤害、单向边、关键道具和终局入口必须保留；未知语义 `OPAQUE`。

目标 V1 的内存模型只服务一个页面和一个 active run；第二页面必须使用独立 solver 进程/端口。`runId` 是日志关联字段，不属于世界状态，也不参与模型选择、动作授权或恢复。

详细数据结构、商店时序和关键道具索引见 [求解器架构与实施方案](solver-architecture.md)。
