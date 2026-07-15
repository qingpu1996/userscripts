# Protocol v2

机器契约以 `protocol/*.schema.json`、Pydantic models 和浏览器 parser 为准。v1 不会静默升级。

## Observation

每次包含当前执行现场，并可携带游戏自身完整定义的规范化 `engine_model`：

```json
{
  "protocol": 2,
  "page": "/games/24/",
  "session_id": "SESSION-...",
  "floor_id": "engine-floor-id",
  "floor_name": "显示名",
  "floor_number": 4,
  "dimensions": {"width": 7, "height": 19},
  "topology": {
    "kind": "valid_cells",
    "valid_cells": [{"x": 0, "y": 0}],
    "source": "runtime_observed",
    "confidence": "inferred"
  },
  "topology_fingerprint": "sha256:...",
  "map_instance_id": "map:...",
  "hero": {},
  "keys": {"yellow": 0, "blue": 0, "red": 0},
  "busy": false,
  "blocks": [],
  "engine_model": {
    "protocol": 1,
    "catalog_hash": "sha256:...",
    "model_hash": "sha256:...",
    "floors": [], "blocks": [], "items": [], "enemies": [], "values": {},
    "inventory": {"classes": {}, "key_slots": {}}
  },
  "captured_at": 0
}
```

`engine_model` 可省略以兼容旧客户端，但不能显式为 null。浏览器从 `core.floors`、全部 `core.status.maps`、`getMapBlocksObj(floorId,true)`、`core.maps.blocksInfo`、`core.material` 和 `core.values` 读取后，只发送 schema 中列出的 JSON 标量，不发送函数、DOM、循环引用或原型对象。动态 floors/blocks/inventory 每轮重读；`catalog_hash` 只绑定静态目录，`model_hash` 绑定本轮完整投影。observation fingerprint 只纳入两个 hash，不把静态大对象重复并入恢复指纹。

服务收到模型后立即以其覆盖同 identity 的历史人工标签，并自动承认模型中存在且尺寸匹配的 floor。`trigger=openDoor` 从 `door_info.keys` 得到成本，普通 `tools/constants` 物品按 inventory 增量处理，`cls=items` 的简单算术 `itemEffect` 由受限解释器计算面板、钥匙或 inventory 差分；解释器不执行 JS 字符串。选择、脚本事件和其他复杂效果保持 opaque。

浏览器必须在一次同步采集内生成整份 observation。读取当前 map、blocks 和可见怪物前后，至少核对 floorId、hero 完整面板/位置/keys 与 moving/lock/event 围栏；前后不一致则丢弃并同步重试，持续不稳定以 `RUNTIME_SNAPSHOT_UNSTABLE` 暂停。服务不能逐字段回调页面 JS，也不能用上一轮 observation 回填本轮缺失字段。

三色钥匙必须来自可识别容器。canonical `hero.items.tools` 容器存在时，引擎可通过删除归零的 `yellowKey/blueKey/redKey` 字段表达零计数，因此省略色归一为 `0`，空容器归一为三色全零；`hero.items.keys` 和 `hero.keys` 候选仍必须完整。显式值必须是有限、非负整数；同色长短别名或多个候选布局归一后不一致、canonical 容器结构非法、完全缺少可识别容器时，均以 `ENGINE_API_INCOMPATIBLE` 暂停。

`rectangle` 必须省略 `valid_cells`；`valid_cells` 必须非空、唯一并位于 dimensions 内。英雄、block、operation、guard 坐标均需同时位于 dimensions 和有效格。浏览器最多发送 8192 个 block；轴上限 256。

当前动态 map 同时提供 `dimensions` 与 `grid` 时，两者必须联合校验：完整无洞且每行等长才可确认为 `rectangle`；空行、缺尾行、短行或稀疏洞必须降为从实际 grid 单元推导的 `valid_cells`；grid 越界或显式 valid cells 与 grid 冲突则拒绝观察。不能因声明了 dimensions 就把 ragged grid 补成矩形。

怪物字段只来自本轮当前层当前坐标的 `getEnemyInfo/getDamage`。adapter 严格归一 `atk/attack`、`def/defense`、`money/gold`、`exp/experience`：同一语义的双别名同值可接受，冲突 fail closed；attack/defense 双别名都完全缺席时协议允许归一为 null，gold/experience 缺席仍不合法。任一别名作为 own property 显式存在但值为 `undefined/null/NaN/Infinity`、字符串、非整数或负数时，立即暂停 `ENGINE_API_INCOMPATIBLE / INVALID_RUNTIME_FIELD`，不能借 optional null 规则吞掉；`special:0` 表示无特殊并归一为 `[]`。协议不增加持久 `fightable` 字段：服务由本轮 `hero.attack + enemy.defense + damage` 推导。有限非负整数 damage 是本轮引擎战损真值；只有原始返回值严格等于 `null` 或字符串 `"???"`，且 `hero.attack <= enemy.defense`，才是可解释的当前不可战斗边界。`undefined`、NaN、Infinity、负数、非整数、其他字符串、对象和布尔值一律在浏览器采集边界暂停 `UNKNOWN_DAMAGE / DAMAGE_UNEXPLAINED`，保留安全标量化 raw evidence，且不得进入 localhost wire；不能先归一为 null 再套用不可战斗解释。

enemy combat fact 的有效域比 map fact 更窄：仅本轮原始 live root 可使用，且只能产生一个终端原子候选。任何已模拟边界都会使旧 enemy stats/damage 失效；同一 map id 上的资源后继和跨图返回都不能重新消费，必须等待新的 observation。历史 enemy 字段仍可留作审计，但不进入 future-state 数值模拟。

`source=engine_current_map/confidence=confirmed` 表示当前 map 明确声明；`runtime_observed/inferred` 表示从当前动态 grid 形状推导。这些字段描述当前 Protocol observation 的来源，不限制策略层读取完整 floors/maps/material/source definitions；策略层可预建未到达区域模型，但执行时仍以 fresh runtime guard 和真实差分结算。

## Map identity

`floor_id` 是引擎当前标识，`floor_number` 和显示名仅供 UI。`topology_fingerprint` 哈希 dimensions 和有效格；`map_instance_id` 至少绑定 floorId 与该拓扑。因此同显示层多图、不同 floorId、同 floorId 的拓扑 revision 都可共存。

## Cycle request

请求根字段严格为 `source`、`intent`、`completed_action_id`、`observation`、`session` 和可选 `recovery`。`intent` 必须是 `cycle | reconnect_only`，不能省略或为 null。

`session`：

- `mode`: `new_game | handoff_expected_guard | resume_existing_ledger`
- `command`: `observe | confirm`
- `expected_guard`: 仅 handoff 必填，其他模式禁止

首次 `observe` 返回 `SESSION_CONFIRMATION_REQUIRED` 且零行动。显式用户确认后发送 `confirm`。resume 只接受 ledger 已存在的 session。

## Execute response

guard 必须包含：`session_id`、`map_instance_id`、`dimensions`、`topology_fingerprint`、`floor_id/floor`、完整位置面板和 keys。浏览器在行动 API 前重读并精确核对。

决策请求 observation、controller guard capture 与行动 API 前 capture 是三个 fresh current-runtime 检查点。pending 先持久化；真正调用引擎 API 前仍须再次读取，fingerprint 或 guard 已变化则零执行。行动后的 observation 同样来自 fresh capture，并要求相同 fingerprint 稳定两轮。

operations 最多两段，末段最多一个状态变化边界。所有坐标必须位于 guard dimensions；浏览器还用当前 topology 复核。边界必须有可验证的非位置 postcondition；门、资源、怪物必须声明目标 block 移除。非面板物品用 `expected_delta.inventory[itemId]` 声明增量，并由行动前后 `engine_model.inventory` 校验。

换图以 `expected_delta.map_instance_id` 为主：省略表示不要求换图；字符串表示必须进入该精确实例；显式 `null` 表示目标尚未知但实例必须变化。旧式 `floor_id: null` 仅在已登记楼梯/传送边界中兼容，并同样要求实例变化。同一 `floor_id` 下 A→B 与不同 `floor_id` 下 A→C 走相同结算逻辑。跨实例时不比较两张无关地图的 block 差分，也禁止同时声明 `removed_blocks`/`added_blocks`。

execute、pause、idle 可携带 `scan_state`：phase、anchor/current map instance、已扫描实例、pending/traversed/frontier 数量与原因。字段可省略但不能为 null，浏览器 parser、Schema 和 Pydantic 共同严格校验。

服务成功结算普通 cycle 请求中的 `completed_action_id` 后，可在同一响应携带完全相同的 `acknowledged_action_id` 并直接返回下一 `execute`、`idle` 或规划暂停。该字段可省略但不能为 null；浏览器先核对并持久结算旧 ID，之后才消费同响应的新行动。`reconnect_only` 仍禁止签发行动，只返回 idle ACK。

新 map observation 中存在可解释的当前不可战斗怪物不影响这条顺序：服务先事务性校验 change-map delta 并记录 `action_completed`，再用同一 observation 规划后续响应并附加 ACK。刷新或重连不会因为怪物 damage 为 null 而重放楼梯 action。

## Transition 与恢复

未走过出口不包含目标布局。仅 completed action 的 pre/post map instance 不同才创建 transition；同一 action_id 不重复建边。`reversible` 只在实际观察到严格端点反向边时成立：A(exit x,y)→B(entry x,y) 必须由 B(同 entry)→A(同 exit) 反向验证；同一地图对上的另一组传送点不能误标可逆。

浏览器恢复仍分为 pre-state、expected post-state、ambiguous 三类。同一 session 任意时刻最多一个 unresolved `issued` action：当前仍为 pre-state 时请求携带原 action ID/pre fingerprint，服务字节等价地重发该 ID；能证明 expected post 时先以 completed_action_id 结算；其余情况暂停。仅完成后才可签下一 ID，改变 observation fingerprint 不能绕过这条约束。同一 action_id 最多执行一次。fingerprint 包含 session、map instance、dimensions、topology、英雄资源和动态 blocks，不包含时间戳或 busy。

浏览器 journal 与 SQLite ledger 的 pending identity 必须一致。仅重新连接也发送真实 recovery phase/action ID/pre/current fingerprint，但不会执行响应中的行动，且发送前不清除证据。pause/error/非法响应/网络失败均保留 pending；只有显式 ack 才结算。服务重启从同一 state dir 恢复唯一未决 action；若浏览器丢失 pending 且现场也不再等于 pre，返回 `RECOVERY_JOURNAL_LEDGER_MISMATCH`。

运行载体不是协议猜测项：userscript 和 direct mount 由各自构建物中的显式 marker 决定。userscript 缺少必需 GM API 或 journal storage 调用不稳定时，在生成 session/request/action 前分别暂停 `USERSCRIPT_API_UNAVAILABLE` 或 `JOURNAL_STORAGE_UNSTABLE`；不得切换 namespace 继续循环。

`intent=reconnect_only` 是协议级 no-issue 门禁：没有 unresolved 时只返回 idle/health；存在 unresolved 时返回带同一 ledger identity 的暂停，不返回可执行 action，也不写 action/decision issuance。浏览器仍防御错误服务的 `execute`：保存 action ID、guard 与响应 fingerprint，暂停为 `RECONNECT_UNEXPECTED_EXECUTE`，行动 API 调用数保持零。

## 错误与暂停

沿用对象/战损/楼层/差分/guard/交互/服务/API 分类，并增加：

- `SESSION_CONFIRMATION_REQUIRED`：会话还未显式确认。
- `PLANNING_BUDGET_EXHAUSTED`：节点或时间预算耗尽，安全停止而非猜测。

商店、剧情、复杂选择和未知机制不得伪装为完成。
