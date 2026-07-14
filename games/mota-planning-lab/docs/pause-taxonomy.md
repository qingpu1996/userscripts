# 暂停分类与取证

顶层 `pause_kind` 是封闭集合。Protocol v2 保留原有八类并增加两个安全控制类；更细原因放在 `detail_code`，不得把普通路线判断推给人工。

- `SESSION_CONFIRMATION_REQUIRED`：首次 observation 尚未由用户和服务显式确认，不签发行动。
- `PLANNING_BUDGET_EXHAUSTED`：世界状态搜索达到节点/时间预算，保留审计上下文后停止。

| pause_kind | 使用条件 | 典型 detail_code |
| --- | --- | --- |
| `NEW_OBJECT_OR_MECHANISM` | 新 block identity、trigger、NPC/机关，或边界标签缺少可验证 postcondition | `UNKNOWN_BLOCK`、`UNKNOWN_TRIGGER`、`UNKNOWN_NPC`、`UNKNOWN_MECHANISM`、`INCOMPLETE_LABEL` |
| `UNKNOWN_DAMAGE` | 当前可见怪物 damage 不是有限非负整数、严格 null 或 `???`，或 null/`???` 无法由本轮实时 hero attack 与当前坐标 enemy defense 解释 | `DAMAGE_UNEXPLAINED` |
| `UNKNOWN_FLOOR` | 完整游戏 floors/maps/source definitions 仍无法为当前 floorId 建立合法模型 | `FLOOR_MODEL_MISSING` |
| `EXPECTED_DELTA_MISMATCH` | 实际资源/block/floor 差分不符，或恢复/ledger identity 无法安全解释 | `RESOURCE_DELTA_MISMATCH`、`RECOVERY_STATE_AMBIGUOUS`、`RECOVERY_JOURNAL_LEDGER_MISMATCH`、`RECONNECT_UNRESOLVED_ACTION` |
| `GUARD_MISMATCH` | 行动前现场与 guard 不同；首次现场与用户基线不同 | `PRE_ACTION_GUARD_MISMATCH`、`INITIAL_BASELINE_MISMATCH` |
| `UNSUPPORTED_INTERACTION` | 剧情、选择菜单、商店等尚未实现的交互 | `STORY_EVENT`、`CHOICE_MENU`、`SHOP` |
| `DECISION_SERVICE_UNAVAILABLE` | localhost 不可达、响应非法、仅重连错误签发 execute 或持续返回不安全计划 | `CONNECTION_FAILED`、`INVALID_RESPONSE`、`RECONNECT_UNEXPECTED_EXECUTE`、`UNSAFE_MULTI_BOUNDARY_RESPONSE` |
| `ENGINE_API_INCOMPATIBLE` | 必需公开 API/GM API 缺失、journal storage 不稳定、签名不兼容或稳定状态无法可靠判断 | `MISSING_API`、`USERSCRIPT_API_UNAVAILABLE`、`JOURNAL_STORAGE_UNSTABLE`、`SIGNATURE_MISMATCH`、`STABILITY_TIMEOUT` |

`UNSUPPORTED_REGISTERED_INTERACTION` 只在普通规划没有任何资源可承担的 supported 进展、但存在当前可达的已登记 unsupported boundary 时使用。unsupported boundary 本身永远不可穿越；旁支可绕开时保留为 frontier 并继续比较其他合法候选，不能因为它存在就全局暂停。多个可达 unsupported 的证据按距离、坐标和 block identity 稳定选择。

## 不允许人工暂停的情况

知识已经登记且 schema/guard/delta 完整时，下列情况必须由决策器自动处理：

- 普通路径比较与安全空走廊移动；
- 零伤怪和 damage 已知的普通怪物候选比较；
- 已知门及其钥匙消耗；
- 已知资源包及其明确差分；
- 已知楼层之间的返回路径。

“当前没有正收益行动”可以返回 `idle`，但不能伪装成新 pause_kind。

`hero.attack <= enemy.defense` 时引擎原始返回值严格为 null/`???` 才是已解释的“当前不可战斗”，不属于暂停：该 enemy 格仍阻挡全部路线与扫描，跳过战斗候选；若没有其他合法进展，返回明确 no-progress idle。攻击已能穿透或 defense 缺失时进入 `UNKNOWN_DAMAGE / DAMAGE_UNEXPLAINED`。`undefined` 不是 null：它与 NaN、Infinity、负数、非整数、其他字符串、对象和布尔值都进入同一 fail-closed 暂停，并在 `raw_damage` 保留原始类型；属性别名 own property 显式非法进入 `ENGINE_API_INCOMPATIBLE / INVALID_RUNTIME_FIELD`，别名冲突继续 fail closed。

## 统一暂停步骤

无论暂停来自浏览器还是服务，都必须按同一顺序处理：

1. 调用兼容的 `stopAutomaticRoute()`；失败只记录能力错误，不使用私有写入。
2. 关闭自动循环，不再请求或执行下一行动。
3. 保存引发暂停的本轮 Protocol observation 与 fingerprint；采集期未知战损会先完成所有当前层 blocks，再携带 observation 暂停。
4. 保存当前 action、guard、expected_delta、实际差分及恢复 journal 摘要。
5. 未知 block 额外保留 `x/y/numeric_id/id/cls/trigger/damage`；未知战损同时保留安全标量化的 `raw_damage`、`normalized_damage` 和怪物字段证据。
6. 在控制台输出结构化对象，在悬浮面板显示 pause_kind 与简短原因。
7. 服务侧如可用，将证据写入本地 pause 包，等待人工标签。

暂停证据不得包含 Cookie、登录凭据或无关个人数据。完整引擎定义、存档结构和未到达楼层可以作为本地诊断/策略证据，但应记录来源并避免无意复制整份个人存档。

## 稳定等待超时归因

- 明确存在剧情、菜单或商店：`UNSUPPORTED_INTERACTION`。
- 现场已经改变且与 expected_delta 不符：`EXPECTED_DELTA_MISMATCH`。
- 引擎无法可靠报告移动/锁/事件结束：`ENGINE_API_INCOMPATIBLE`。

超时只暂停，不重放 action_id。
