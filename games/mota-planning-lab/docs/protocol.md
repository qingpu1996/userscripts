# Protocol v2

机器契约以 `protocol/*.schema.json`、Pydantic models 和浏览器 parser 为准。v1 不会静默升级。

## Observation

每次仅包含当前动态地图：

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
  "captured_at": 0
}
```

浏览器必须在一次同步采集内生成整份 observation。读取当前 map、blocks 和可见怪物前后，至少核对 floorId、hero 完整面板/位置/keys 与 moving/lock/event 围栏；前后不一致则丢弃并同步重试，持续不稳定以 `RUNTIME_SNAPSHOT_UNSTABLE` 暂停。服务不能逐字段回调页面 JS，也不能用上一轮 observation 回填本轮缺失字段。

三色钥匙不允许缺失后默认为零。适配器支持 `hero.items.tools`、`hero.items.keys` 和 `hero.keys` 三种显式布局；每个候选必须完整，多个候选同时存在时数值必须一致，否则以 `ENGINE_API_INCOMPATIBLE` 暂停。

`rectangle` 必须省略 `valid_cells`；`valid_cells` 必须非空、唯一并位于 dimensions 内。英雄、block、operation、guard 坐标均需同时位于 dimensions 和有效格。浏览器最多发送 8192 个 block；轴上限 256。

当前动态 map 同时提供 `dimensions` 与 `grid` 时，两者必须联合校验：完整无洞且每行等长才可确认为 `rectangle`；空行、缺尾行、短行或稀疏洞必须降为从实际 grid 单元推导的 `valid_cells`；grid 越界或显式 valid cells 与 grid 冲突则拒绝观察。不能因声明了 dimensions 就把 ragged grid 补成矩形。

`source=engine_current_map/confidence=confirmed` 表示当前 map 明确声明；`runtime_observed/inferred` 表示只从当前动态 grid 形状推导。无法可靠解释时暂停，不猜测未到达区域。

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

operations 最多两段，末段最多一个状态变化边界。所有坐标必须位于 guard dimensions；浏览器还用当前 topology 复核。边界必须有可验证的非位置 postcondition；门、资源、怪物必须声明目标 block 移除。

换图以 `expected_delta.map_instance_id` 为主：省略表示不要求换图；字符串表示必须进入该精确实例；显式 `null` 表示目标尚未知但实例必须变化。旧式 `floor_id: null` 仅在已登记楼梯/传送边界中兼容，并同样要求实例变化。同一 `floor_id` 下 A→B 与不同 `floor_id` 下 A→C 走相同结算逻辑。跨实例时不比较两张无关地图的 block 差分，也禁止同时声明 `removed_blocks`/`added_blocks`。

execute、pause、idle 可携带 `scan_state`：phase、anchor/current map instance、已扫描实例、pending/traversed/frontier 数量与原因。字段可省略但不能为 null，浏览器 parser、Schema 和 Pydantic 共同严格校验。

服务成功结算请求中的 `completed_action_id` 时，不在同一响应签发下一行动，而返回独立 `idle`，并携带完全相同的 `acknowledged_action_id`。该字段可省略但不能为 null；浏览器只有在 status/identity 都匹配时才清除 pending 并记录 ack。

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
