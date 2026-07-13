# 暂停分类与取证

顶层 `pause_kind` 是封闭集合，只允许以下八类。更细原因放在 `detail_code`，不得新增顶层类型把普通路线判断推给人工。

| pause_kind | 使用条件 | 典型 detail_code |
| --- | --- | --- |
| `NEW_OBJECT_OR_MECHANISM` | 新 block identity、trigger、NPC/机关，或边界标签缺少可验证 postcondition | `UNKNOWN_BLOCK`、`UNKNOWN_TRIGGER`、`UNKNOWN_NPC`、`UNKNOWN_MECHANISM`、`INCOMPLETE_LABEL` |
| `UNKNOWN_DAMAGE` | 当前可见怪物 damage 为 null、`???`、非有限、负数或无法解释 | `DAMAGE_NULL`、`DAMAGE_UNEXPLAINED` |
| `UNKNOWN_FLOOR` | 当前 floorId 尚无合法模型 | `FLOOR_MODEL_MISSING` |
| `EXPECTED_DELTA_MISMATCH` | 实际资源/block/floor 差分不符，或恢复状态无法解释 | `RESOURCE_DELTA_MISMATCH`、`RECOVERY_STATE_AMBIGUOUS` |
| `GUARD_MISMATCH` | 行动前现场与 guard 不同；首次现场与用户基线不同 | `PRE_ACTION_GUARD_MISMATCH`、`INITIAL_BASELINE_MISMATCH` |
| `UNSUPPORTED_INTERACTION` | 剧情、选择菜单、商店等尚未实现的交互 | `STORY_EVENT`、`CHOICE_MENU`、`SHOP` |
| `DECISION_SERVICE_UNAVAILABLE` | localhost 不可达、响应非法或持续返回不安全计划 | `CONNECTION_FAILED`、`INVALID_RESPONSE`、`UNSAFE_MULTI_BOUNDARY_RESPONSE` |
| `ENGINE_API_INCOMPATIBLE` | 必需公开 API 缺失、签名不兼容或稳定状态无法可靠判断 | `MISSING_API`、`SIGNATURE_MISMATCH`、`STABILITY_TIMEOUT` |

## 不允许人工暂停的情况

知识已经登记且 schema/guard/delta 完整时，下列情况必须由决策器自动处理：

- 普通路径比较与安全空走廊移动；
- 零伤怪和 damage 已知的普通怪物候选比较；
- 已知门及其钥匙消耗；
- 已知资源包及其明确差分；
- 已知楼层之间的返回路径。

“当前没有正收益行动”可以返回 `idle`，但不能伪装成新 pause_kind。

## 统一暂停步骤

无论暂停来自浏览器还是服务，都必须按同一顺序处理：

1. 调用兼容的 `stopAutomaticRoute()`；失败只记录能力错误，不使用私有写入。
2. 关闭自动循环，不再请求或执行下一行动。
3. 保存引发暂停的本轮当前层白名单 observation 与 fingerprint；采集期未知战损会先完成所有当前层 blocks，再携带 observation 暂停。
4. 保存当前 action、guard、expected_delta、实际差分及恢复 journal 摘要。
5. 未知 block 额外保留 `x/y/numeric_id/id/cls/trigger/damage`；未知战损同时保留安全标量化的 `raw_damage`、`normalized_damage` 和怪物字段证据。
6. 在控制台输出结构化对象，在悬浮面板显示 pause_kind 与简短原因。
7. 服务侧如可用，将证据写入本地 pause 包，等待人工标签。

暂停证据不得包含截图、Canvas、Cookie、存档原文、完整引擎对象或未访问楼层。

## 稳定等待超时归因

- 明确存在剧情、菜单或商店：`UNSUPPORTED_INTERACTION`。
- 现场已经改变且与 expected_delta 不符：`EXPECTED_DELTA_MISMATCH`。
- 引擎无法可靠报告移动/锁/事件结束：`ENGINE_API_INCOMPATIBLE`。

超时只暂停，不重放 action_id。
