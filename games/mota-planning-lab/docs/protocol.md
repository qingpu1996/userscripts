# Protocol 1

本文定义油猴运行态代理与本机决策服务之间的唯一网络协议。协议只承载当前楼层动态观察、行动完成标识和最小恢复信息；不得携带完整 `core`、完整 `status`、整个 `maps`、全量素材、存档或任何未到达楼层信息。

机器可读 schema 位于：

- [`protocol/observation.schema.json`](../protocol/observation.schema.json)
- [`protocol/cycle-request.schema.json`](../protocol/cycle-request.schema.json)
- [`protocol/cycle-response.schema.json`](../protocol/cycle-response.schema.json)

## 传输

```http
POST http://127.0.0.1:18724/cycle
Content-Type: application/json
X-Mota-Lab: 1
```

浏览器只能向上面的固定地址发送协议请求。服务只能绑定 `127.0.0.1`，拒绝错误 header、错误 media type、过大 body、未知来源和 schema 之外的字段。

## 请求包络

```json
{
  "source": "mota-planning-lab-userscript",
  "completed_action_id": null,
  "observation": {},
  "recovery": {
    "phase": "none",
    "pending_action_id": null,
    "pre_fingerprint": null,
    "current_fingerprint": "sha256:...",
    "detail_code": null
  }
}
```

- `source` 固定，不允许第三方客户端借此端点提交任意数据。
- `completed_action_id` 只在浏览器已通过真实 post-state 校验后填写。
- `observation` 必须是当前 floorId 的完整、最小、白名单观察。
- `recovery` 只描述浏览器持久 journal 中的一个 pending action。

恢复阶段统一为：

| phase | 含义 | 浏览器行为 |
| --- | --- | --- |
| `none` | 没有待恢复行动 | 正常请求下一决定 |
| `pending` | 已持久化但尚不能判定 | 不重放，等待服务处理 |
| `not_executed` | 当前 fingerprint 仍等于 pre-state | 不自行重放；等待服务用新 action_id 重签 |
| `completed` | 当前状态满足 expected post-state | 携带 completed_action_id 补报 |
| `mismatch` | 现场既非 pre-state，也不满足 expected post-state | 停止循环并固化证据 |

`not_executed` 的重签响应必须用全新 `action_id`，并通过 `supersedes_action_id` 精确指向旧 pending action。旧 action_id 永远不得再次执行。

## 当前层 observation

顶层字段固定为：

- `protocol=1`
- `page=/games/24/`
- 引擎原始 `floor_id`
- 可合法取得时的 `floor_name`、`floor_number`，否则为 `null`
- 固定核验为 `11×11` 的 `dimensions`
- 白名单复制的 `hero` 与 `keys`
- 由移动、控制锁、活动事件三项布尔值派生的 `busy`
- 当前动态地图中仍存在且未 disable 的 `blocks`
- 毫秒 Unix 时间 `captured_at`

坐标始终为引擎 0 基坐标。规划器如需人类坐标，自行转换为 `row=y+1`、`col=x+1`。

blocks 按 `y、x、numeric_id、id` 排序。非怪物的 `damage` 与 `enemy` 为 `null`；怪物数据只按当前层当前坐标调用引擎公开查询接口。damage 为 `null`、`"???"`、非有限数、负数或无法解释时不得执行战斗。观察器会先完成本轮所有当前层 blocks 的白名单序列化，再抛出 `UNKNOWN_DAMAGE`；非有限战损在 observation 中安全规范化为 `null`，原始类型/字面与规范化值只保存在本地 pause evidence，不将不合规运行时对象发往决策器。

## 响应

### execute

```json
{
  "status": "execute",
  "action_id": "AUTO-0123456789ABCDEF",
  "action_kind": "MOVE_TO_RESOURCE",
  "reason": "已知资源位于当前可达边界，先处理一个状态变化。",
  "operations": [{"type": "grid", "x": 6, "y": 3}],
  "guard": {
    "floor_id": "引擎原始floorId",
    "floor": 4,
    "position": {"x": 8, "y": 3, "direction": "down"},
    "hp": 208,
    "attack": 23,
    "defense": 21,
    "gold": 16,
    "experience": 63,
    "keys": {"yellow": 4, "blue": 1, "red": 0}
  },
  "expected_delta": {
    "hp": 200,
    "removed_blocks": [{"x": 6, "y": 3, "id": "redPotion"}]
  },
  "supersedes_action_id": null,
  "registry_entries": []
}
```

执行前浏览器重新观察并精确核对 guard。`floor_id` 是身份真值；`floor` 是必填可空字段，只用于显示，不可替代 floorId。当前显示无法可靠解析时必须发送显式 `null`，不能删除字段或猜测数字。

`action_id` 必须精确匹配 `^AUTO-[A-F0-9]{16}$`。execute 根对象、operation、guard、keys、expected_delta、block reference 和 registry entry 都拒绝额外字段；不允许通过截断字符串、补默认版本或忽略未知字段来接受混合版本响应。

一个响应应优先只包含一个 `grid`。若未来返回多段，非末段必须由当前观察证明为纯空走廊，末段最多含一个已知边界；每段后都重新观察，任何面板、钥匙、blocks 或楼层变化都会终止剩余 operations。

### registry_entries

服务只返回当前 observation 中实际出现并已登记的 block identity，不下发其他楼层或整个知识库。每项固定包含：

```json
{
  "id": "...",
  "cls": "...",
  "trigger": null,
  "category": "terrain",
  "passable": true,
  "boundary": false,
  "fast_path": true,
  "version": 1
}
```

`trigger` 是必填可空字段；普通墙等无 trigger 的 identity 必须保留显式 `null`。`category` 只能是 `terrain`、`wall`、`door`、`resource`、`enemy`、`npc`、`mechanism`、`stair`、`other`。`version` 是必填的正整数，缺失时不会默认为 1。浏览器忽略或拒绝不对应当前 blocks 的条目；只有 `passable=true`、`boundary=false`、`fast_path=true` 的已登记地块可参与快速走廊证明。

### pause / idle / error

- `pause` 必须使用八种固定 `pause_kind` 之一，并提供 `detail_code`、`reason`、`details` 和最小证据。
- `idle` 表示现场合法但当前没有需要执行的行动，可继续低频轮询。
- `error` 必须提供 `error_code` 和 `reason`；浏览器不会把它当作可执行行动。

四种 status 都使用各自封闭的根字段集。任何缺少必填字段、额外根/嵌套字段、非法 action_id 或 registry version 的 localhost 响应都在调用行动 API 前拒绝，并映射为 `DECISION_SERVICE_UNAVAILABLE / INVALID_RESPONSE`。

服务与知识文件统一使用 field-aware 序列化：必填可空字段和显式设置的合法 `null` 保留，只省略真正未设置的 optional 字段。禁止用全局 `exclude_none`，因为它会把 `guard.floor`、`registry_entries[].trigger` 和知识标签的 `trigger` 删除；也不允许无条件输出所有 `null`，以免把 schema 规定“可省略但不可为 null”的字段写成非法 wire 数据。

## expected_delta

可声明 `hp`、`attack`、`defense`、`gold`、`experience`、三色钥匙差分、目标位置、目标 floorId、移除或新增 block。数值必须是有限整数，execute 中不允许空对象。

未声明的面板、钥匙、blocks 和 floorId 默认保持不变；位置和方向只有在行动语义允许时变化。纯空走廊必须声明最终 `position`，且不得声明状态变化。状态变化边界必须包含至少一个可验证的非位置 postcondition；怪物、门和资源必须精确声明目标 block 移除，楼梯必须声明 `floor_id`。NPC、机关、`other` 或边界地形若无法表达可验证 postcondition，服务/标签 CLI 会拒绝或在既有八类中暂停，不会执行。

浏览器还会在结算时独立确认边界确实发生非位置状态变化。目标 block 仍存在、只改变坐标或其他与 expected_delta 不符的结果都进入 `EXPECTED_DELTA_MISMATCH`，不会请求下一行动。

## 幂等

- 浏览器在调用行动 API 前先持久化 `pendingAction`。
- 已完成或 pending 的同一 action_id 均不会再次执行。
- 服务用 SQLite 事务将 request fingerprint、action_id、响应和完成状态关联；同一 pending 行动的 HTTP 重试和服务重启返回同一个决定。
- action_id 由 SQLite 持久单调 issuance sequence 生成，不依赖时间；保留过的序列值不复用，遇到旧账本碰撞会递增跳过。
- 行动 completed 后若玩家合法返回完全相同 fingerprint，服务会签发全新 action_id；该新 pending 的重试和重启继续返回新 ID，不会重放旧 completed ID。
- 同一 decision key 的 completed 往返原位更新 cache 行；action ledger 每个真实签发行动保留一条，普通重试不增加行。
- 响应在网络中丢失时，浏览器按 pre / expected post / ambiguous 三分法恢复，不以超时作为重放依据。

fingerprint 的唯一投影为 `floor_id + hero（含 loc）+ keys + blocks`。blocks 先按 `y/x/numeric_id/id` 排序，再递归按对象键排序，使用 UTF-8 SHA-256，并加 `sha256:` 前缀。`protocol`、`page`、楼层显示名/数字、dimensions、`busy` 和 `captured_at` 不进入 fingerprint。浏览器与 Python 使用同一固定向量测试，防止恢复阶段因两端 hash 漂移而误判。
