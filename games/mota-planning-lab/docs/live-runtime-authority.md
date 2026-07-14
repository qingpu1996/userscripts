# 当前运行态唯一权威

## 设计原则

游戏页面中的当前 JS 运行态是人物面板、钥匙、当前位置、忙碌状态和当前动态 blocks 的唯一权威来源。本地服务不会维护一份可覆盖现场的“当前角色”或“当前地图”镜像：每轮决策、行动前 guard 和行动后结算都重新采集当前运行态。

```text
同步采集当前运行态
  -> 发送一份不可变 LiveObservation
  -> 当前 observation + 历史地图事实实时规划
  -> 持久化 pending 行动身份
  -> 行动 API 前再次同步采集并核对
  -> 正常游戏 API 执行一个原子边界
  -> 连续两次稳定的全量 observation
  -> expected_delta 校验与 completed/ack
  -> 下一轮重新规划
```

这里的“实时”不是逐字段跨时刻询问。浏览器适配器先记录 `floorId + hero 完整面板/位置/keys + moving/lock/event` 围栏，读取当前 map、当前 blocks 和当前可见怪物，再读取同一围栏。前后完全一致才产生 observation；瞬时变化最多同步重试三次，持续变化暂停为 `ENGINE_API_INCOMPATIBLE / RUNTIME_SNAPSHOT_UNSTABLE`。这样不会把换层前的 hero 与换层后的 blocks 拼成撕裂快照。

## 四类数据

### 1. 实时当前现场

只存在于本轮 `LiveObservation`：

- `floor_id`、`map_instance_id`、dimensions/topology；
- hero HP/攻防/金币/经验、位置和方向；
- 三色钥匙；
- busy；
- 当前层仍存在的动态 blocks 和当前可见怪物战损。

服务规划当前动作时只能从请求中的 observation 取得这些当前值。浏览器 controller 的 `currentObservation` 只是进程内的本轮不可变引用，下一轮会被新采集替换，不是持久缓存。

### 2. 历史已观察地图事实

离开地图后允许保留亲自进入时合法观察到的 revision：

- session/map-instance 身份；
- floor 元数据、dimensions、topology；
- 当时真实存在的动态 blocks；
- `observed_anchor`（当时观察坐标，仅用于历史图的可达起点证据）；
- snapshot fingerprint 和 captured time。

规划器接收的 `HistoricalMapFact` 明确不含 hero、keys 或 busy。跨图模拟始终把**当前请求 observation** 的资源向量带入历史几何；重访同一 map instance 后，最新 snapshot revision 替换规划视图，但旧 revision 仍作为审计证据保留。topology 改变时必须产生新的 map instance。

### 3. 持久行动账本与恢复证据

以下内容不是第二份当前状态，而是 at-most-once 与刷新恢复必需的事务证据：

- session identity 与显式 baseline；
- pending/completed/ack action identity；
- pre fingerprint、足够的 pre observation、guard、operations、expected delta；
- 实际 post observation/fingerprint；
- 已真实经过的 transitions、人工标签、暂停证据和 scan audit。

完整历史 observation 只允许被 action recovery、expected-delta 审计和证据导出使用；进入 planner 前必须投影成不含 hero/resources 的 `HistoricalMapFact`。

### 4. 可丢弃派生结果

可达性、路径、候选排序、资源估值和世界搜索队列都由“当前 observation + 历史地图事实 + transitions + 标签”实时重算。它们不是权威数据，不跨 cycle 作为当前状态复用。`decisions` 表只承担同一 observation/knowledge 身份下的幂等响应与行动签名审计；现场 fingerprint 或知识版本变化后会重新规划。

## 钥匙布局兼容与失败策略

当前适配器只接受显式登记的三色钥匙容器：

1. canonical `hero.items.tools`：容器自身存在即声明三色钥匙布局；`yellowKey/blueKey/redKey` 或对应短别名存在时读取显式值，归零后被引擎删除的字段按 `0` 归一；
2. `hero.items.keys.yellowKey/blueKey/redKey`（兼容既有引擎形状，也接受同容器的 `yellow/blue/red` 别名）；
3. `hero.keys.yellowKey/blueKey/redKey`（同样接受短别名）。

至少一个可识别布局必须存在。只有 canonical `hero.items.tools` 具有“容器存在 + 零计数字段可省略”的语义，空 `tools` 因而表示三色钥匙均为零；这不是对任意缺失数据的兜底。`hero.items.keys` 与 `hero.keys` 仍必须给出完整三色布局。任何显式字段都必须是有限、非负整数；同一容器长短别名冲突、多个布局归一后冲突、声明为非普通对象的 `tools`，以及完全没有可识别钥匙容器时，都暂停 `ENGINE_API_INCOMPATIBLE`。

## 原子重规划

一次响应最多包含“安全空走廊到边界前 + 一个末端状态变化边界”。门、怪物、资源、NPC、机关和楼梯不能在同一行动中跨越两个。行动后必须取得改变且连续两轮一致的 observation，校验非位置 postcondition，再结算 action。下一边界只能由下一轮实时 observation 重新规划。

已登记但尚未支持的边界也属于不可跨越集合。实时重规划可以跳过一个可绕开的 optional unsupported frontier，选择另一个独立可达且当前资源可承担的 supported 边界；不能把 unsupported 当作可通行地形，也不能在没有其他合法进展时返回 idle 或尝试穿越。

刷新时不能简单丢弃 pre observation：如果当前 fingerprint 等于 pre，证明尚未执行并重发同一 action ID；如果真实现场满足 expected post，补记 completed；否则暂停为恢复歧义。该审计链与“游戏现场是当前权威”并不冲突——账本只解释动作历史，永远不能把旧面板写回或覆盖现场。

钥匙字段归零省略同样先在 fresh observation 中归一，再进入 fingerprint、guard 和 expected-delta。比如门动作前 `yellow=1`，动作后 canonical `tools` 删除 `yellowKey` 且目标门 block 消失，会得到真实 `yellow=0`，从而以 `keys.yellow=-1` 和 `removed_blocks` 证明 pending 已执行；刷新或 `reconnect_only` 只补记 completed/ack，不会再次调用移动 API。
