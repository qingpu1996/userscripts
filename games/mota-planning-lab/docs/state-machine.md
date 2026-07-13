# 浏览器控制状态机

## 主循环

```text
STOPPED
  -> PREFLIGHT
  -> BASELINE_VERIFIED
  -> OBSERVING
  -> REQUESTING
  -> VALIDATING_RESPONSE
  -> GUARD_CHECK
  -> EXECUTING
  -> SETTLING
  -> VERIFYING_DELTA
  -> REPORTING
  -> OBSERVING

任意阶段 -> PAUSED
PAUSED -> PREFLIGHT（只允许用户启动或明确重新连接）
```

脚本注入后固定从 `STOPPED` 开始。首次观察只核对用户给出的 4F 面板与坐标；核对一致只进入 `BASELINE_VERIFIED`，不会自动进入执行循环，仍需用户选择“启动自动驾驶”。初始化不读档。

## 行动事务

```text
收到 execute
  -> 校验响应 schema / action_id / 当前 registry
  -> 重新观察
  -> 精确核对 guard
  -> 计算 pre-fingerprint
  -> 确认边界具有可验证非位置 postcondition
  -> 持久化 pendingAction
  -> 调用一个公开行动接口
  -> 轮询 moving / lock / event
  -> fingerprint 发生变化并连续两次一致
  -> 校验真实非位置状态变化与 expected_delta
  -> 持久化 lastCompletedAction
  -> 携 completed_action_id 上报
```

任何 guard、路径、稳定或差分失败都发生在下一行动之前。行动 API 调用前的 pending journal 是“最多一次执行”门禁。

## journal

GM 持久记录至少包含：

- `autopilotEnabled`
- `initialBaselineVerifiedFingerprint`
- `pendingAction`
- `lastCompletedAction`
- `lastAcknowledgedActionId`
- `lastPause`
- `knownProtocolVersion`

`pendingAction` 包含 action_id、pre-fingerprint、pre-observation、guard、expected_delta、`requires_non_position_change`、operations、operation index、phase 和 started_at。清除 pending 只清浏览器账本，绝不改游戏现场或服务 ledger；该菜单需要二次确认。只要行动尚未 completed/acknowledged、浏览器仍有 pending 或现场尚未确认，就禁止使用该菜单绕过恢复。

## 服务状态根与浏览器 journal 共同恢复链

最多一次执行依赖两侧持久身份同时存在：

- 浏览器 GM journal 保存 pending、completed、acknowledged、pre-fingerprint 和 expected post-state；
- `MOTA_LAB_STATE_DIR` 保存 SQLite action ledger、observation、decision cache、持久 `action_id_sequence` issuance sequence、JSONL 决策日志和 pause evidence。

因此 `MOTA_LAB_STATE_DIR` 不是 cache。正常服务重启、升级和重新连接必须复用同一个绝对路径与完整目录；删除、清空或换成空目录会切断 action_id 身份和恢复链。只保留独立的 `MOTA_LAB_KNOWLEDGE_DIR` 只能恢复知识标签，不能恢复 action ledger。

当 pending 尚未 completed/acknowledged、浏览器仍有 pending journal，或现场状态尚未确认时，绝对不得切换或迁移 state dir，也不得清 browser pending 规避门禁。删除整个 state dir 是需要用户明确确认的显式状态重置，不属于“服务重启恢复”。完整的停机迁移、备份和只读核对步骤见[安装文档的状态目录章节](install-and-run.md#21-状态目录不是缓存)。

## 刷新与丢包恢复

页面恢复时，如果存在 pending action，浏览器先重新观察，不调用行动 API：

| 判断 | 分类 | 后续 |
| --- | --- | --- |
| current fingerprint == pre-fingerprint | `not_executed` | 向服务报告；只有全新 action_id 且带 `supersedes_action_id` 才可重新签发 |
| current 满足 expected_delta，且边界已证明非位置变化 | `completed` | 本地补记完成并携 completed_action_id 上报 |
| 两者均不满足 | `mismatch` | `EXPECTED_DELTA_MISMATCH / RECOVERY_STATE_AMBIGUOUS` 暂停 |

同一 action_id 在正常循环、刷新、HTTP 重试和服务重启后均不得再次进入 `EXECUTING`。
旧 journal 若没有任何 expected_delta 字段，或边界只发生坐标变化，不得通过恢复门禁，必须进入 `RECOVERY_STATE_AMBIGUOUS`。

服务端区分“同一 pending 行动重试”和“completed 后再次来到同一现场”：前者从 SQLite ledger 重放同一个 action_id；后者通过持久 issuance sequence 签发新 action_id。浏览器继续保留 completed 去重，不因服务修复而削弱门禁；新 ID 才能作为新的行动事务进入 `GUARD_CHECK`。

### `UNKNOWN_ACTION_ID` 人工恢复

浏览器持有 pending/completed action_id，而服务返回 `409 UNKNOWN_ACTION_ID` 时，说明当前 `MOTA_LAB_STATE_DIR` 的 ledger 无法识别该身份。它可能来自目录切错、空目录初始化、备份不完整、目录损坏或真正丢失；**不能**据此推断行动未执行。

处理流程：

1. 立即保持 `PAUSED` 并调用 `stopAutomaticRoute`；不执行、不重放、不请求替代 action，也不清 browser journal。
2. 保存当前层 observation/fingerprint、pending 的 action_id/phase/pre-fingerprint/expected_delta、last completed/acknowledged 和结构化错误详情。
3. 停止服务，恢复原 state dir 或完整备份；不得新建空目录冒充恢复，也不得编辑 SQLite 手工伪造 action。
4. 只读核对 ledger 中的 action_id、状态、replacement chain 和 issuance sequence，再启动服务并使用“仅重新连接”进入上表的 pre / expected post / mismatch 三分法。
5. 如果原 ledger 无法恢复，继续暂停，由人工依据保留的 journal 与真实现场判断“未执行、已执行或不明”。只有用户明确确认该结论、归档证据并接受显式状态重置后，才能另行建立新状态根；结果不明时不得继续行动。

这一流程恢复的是身份链，而不是“让服务重新规划一次”。任何新 action_id 都必须建立在旧 pending 已被 ledger 正确完成、确认或人工关闭之后。

## 多路段限制

v0.1.0 服务优先每次只返回一个 grid。若浏览器收到多段：

- 非末段必须是当前观察中完整证明的纯空走廊；
- 末段最多一个已登记状态变化边界；
- 每段后都重新观察并核对派生 guard；
- floor、面板、钥匙或 blocks 一旦变化立即停止剩余段；
- 多边界计划被拒绝，不逐格模拟点击。

## 暂停与恢复

`PAUSED` 是吸收态：定时循环停止，自动路线停止，证据固化。只有用户执行“启动自动驾驶”或“仅重新连接本地决策器”才会重新进入 `PREFLIGHT`；服务恢复本身不会在后台悄悄重新启动车辆。
