# 当前 Protocol v2 与目标 V1 单步接口

本页同时记录当前运行事实和目标迁移边界。当前 Schema、源码和构建物仍使用 Protocol v2；目标 V1 尚未实现。

## 当前实现：Protocol v2 `/cycle`

浏览器向 `POST /cycle` 发送当前完整 observation、当前实例 session command、可选 completed action 和当前内存 recovery phase。服务返回 `execute | idle | pause | error`。

当前 observation 包含 floor/map identity、dimensions、topology、hero、keys、busy、动态 blocks 和 capture time。当前 floor observation 冲突时，以本轮 observation 为行动真值；非法或无法解释的怪物数值 fail closed。

当前同一实例最多一个 in-flight action。行动包含唯一 ID、guard、operations 和 expected delta；执行后通过下一次 completed action ACK 释放当前内存 identity。`reconnect_only` 只检查当前实例连接，不恢复跨实例 action。页面或服务重新实例化后 fresh start。

这些机制是 legacy/transitional 当前事实，不是下一代策略正确性的证明。

## 目标 V1：`/bootstrap + /step + /run-events`

目标链路只有两个主链接口和一个旁路日志接口：

1. `/bootstrap`：本次启动上传完整塔定义、规则和当前状态；后端在内存中构建 `CatalogIR + GlobalIndex`。
2. `/step`：上传一份自包含实时 `StepObservation`；后端返回一个 `action | wait | pause | terminal`。
3. `/run-events`：浏览器把只有自己知道的执行、暂停和终局事件单向追加到本轮 `events.jsonl`；响应只表示是否写入，不能返回 action，也不能影响 solver。

一个 solver 进程只接受一张游戏页面和一个 active run。第一次成功 `/bootstrap` 后，再次 bootstrap 返回 `409 ACTIVE_RUN_EXISTS` 且不改变内存；第二张页面必须使用独立进程/端口。V1 不实现多页面租约、选主或协调，`runId` 只用于日志关联，不是授权 session。

### 唯一 `stateHash` 契约

`/step` 必须同时携带完整 `StepObservation` 和 `stateHash`。这个 hash 只能来自版本固定的 `DecisionStateProjectionV1`，不存在轻量子集：凡是 adapter、transition、bound、score 或 action guard 会读取、并可能影响动作合法性或决策的实时字段，都必须进入投影。

投影至少覆盖 bootstrap/model binding；楼层、位置和规则相关方向；英雄 HP/攻防/魔防、金币、经验、钥匙、装备、道具；决策相关 flags/values/switches；菜单、商店、事件、idle/busy；ActiveDomain 动态拓扑以及门、怪物、道具、NPC、事件、楼梯的触发/移除状态；伤害、奖励、通行和终局评分所读取的动态规则字段。`capturedAt`、`cycleNo/eventSeq`、UI 像素和纯动画帧等非决策字段排除。

JS 与 Rust 共享同一 schema 版本和规范化规则：必填字段不得缺失，可选值显式为 `null`；字符串 NFC；对象使用 RFC 8785 JCS；有规则顺序的数组保序，map/set 型数组先按稳定 key 排序；整数和规范十进制按 [架构方案](solver-architecture.md#43-唯一决策投影与-hash-契约) 约束。最终统一计算 `UTF8(JCS(projection))` 的 SHA-256。

Rust 收到请求后必须独立重建投影并重算 hash。不一致、字段缺失或 bootstrap binding 不匹配时，拒绝且不更新模型、不搜索、不产生 action。响应 `baseStateHash` 必须逐字回显已经验证的请求 hash。JS 在执行前等待 idle，重新采集完整 observation、重建同一投影并比较；不等就丢弃 action、写 `action_discarded_stale`，绝不执行。hash 只防陈旧响应，不负责恢复、幂等或多客户端协调。

目标 action 响应最小结构：

```json
{
  "baseStateHash": "sha256:...",
  "result": "action",
  "action": { "actionId": "...", "kind": "...", "target": {} },
  "decisionSummary": { "reason": "...", "proof": "proven" }
}
```

`baseStateHash` 只用于浏览器执行前的陈旧检查：当前实时 hash 不同就丢弃响应并重新采集。它不是 session、恢复或幂等协议。

目标 V1 不发送独立 ACK。动作结束并且游戏再次 idle 后，下一轮 observation 同时承担“上一步实际结果”和“下一步决策输入”。目标也不定义 cancel、resync、outstanding action、RuntimeEpoch、tombstone、跨启动恢复或动作自动重试。

`decisionSummary` 供 UI 显示；完整候选、bounds、proof replay 和耗时写入本次启动的旁路诊断日志。日志字段不构成执行授权。

### 浏览器旁路事件

`POST /run-events` 的最小公共字段是诊断用 `runId/eventSeq/cycleNo/eventType/occurredAt`，并按事件携带 hash、action 摘要、错误和必要的完整 observation。浏览器必须能独立记录：

- `action_discarded_stale`；
- `execution_started`；
- `execution_completed`，包含可靠 idle 后的完整 post observation/hash；
- `execution_failed`；
- `execution_settlement_unknown`；
- `browser_paused`；
- `run_finished`。

后端自行记录 bootstrap、step request、候选、bounds、剪枝、耗时和 decision response。`/run-events` 处理器只能依赖 logger 并 append 当前 run 的 `events.jsonl`；solver、`GlobalIndex`、planner 和 controller 永远不读取 event。`/step` 不等待、查询或消费日志 receipt，下一轮 observation 仍是唯一规划输入和上一步结果。因此 `execution_completed` 不是 ACK。

V1 不给日志事件做自动重试、去重或事务状态机。`execution_started` 写失败时不执行并暂停；动作已发生后的日志写失败则标记本轮日志不完整并暂停下一动作，绝不重放或恢复。新 run 不读取旧 event。

## 目标错误边界

- observation 不完整、引擎不 idle、规则不透明或预算内无法证明：`pause` 或 `wait`，零动作。
- action 响应返回后现场发生变化：浏览器丢弃响应，重新采集，零执行。
- 动作 API 抛错、完成无法判断或引擎不再可靠 idle：页面进入 `PAUSED`，不重试。
- 新启动从当前游戏状态重新 bootstrap；运行时永远不读取历史诊断日志。
- `/run-events` 失败只影响是否继续本轮，不得改变 solver、触发 action 或被 `/step` 当作执行结果。

完整目标规范见 [求解器架构与实施方案](solver-architecture.md)。迁移完成并独立验收前，不能把本节当成现有 API 使用说明。
