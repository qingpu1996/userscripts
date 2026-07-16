# 当前与目标运行状态机

游戏实时 observation 在当前实现和目标 V1 中都是唯一权威，但两者的动作生命周期不同。

## 当前实现（legacy/transitional）

```text
PAUSED -> OBSERVING -> PLANNING -> ISSUED -> EXECUTING
   ^          |            |          |          |
   +----------+------------+----------+----------+
              guard/delta/error -> PAUSED
```

当前 Protocol v2 在页面和服务内存中保存一个 in-flight identity，并使用 guard、expected delta 和 completed ACK。页面或服务重新实例化后状态丢失，fresh start，不跨实例恢复。这是当前源码事实，迁移完成前仍需由现有测试保护。

## 目标 V1（尚未实现）

页面只需要一个普通全局 controller：

```text
IDLE ──收到一个 action──> EXECUTING ──动作结束且引擎 idle──> IDLE
  │                              │
  └────无法安全判断──────────────┴──────────────────────────> PAUSED
```

- `IDLE`：可以采集一份实时 observation 并请求 `/step`。
- `EXECUTING`：已有且仅有一个 action 正在交给游戏执行；不发新请求，不执行第二个动作。
- `PAUSED`：动作结果无法确定、规则不支持或运行异常；停止自动循环。

浏览器收到 action 后重新计算当前 hash；只有等于响应的 `baseStateHash` 才执行一次。不同就丢弃响应并重新采集，不进入恢复流程。

这里的 hash 只有一个定义：JS 和 Rust 都从完整、版本固定的 `DecisionStateProjectionV1` 计算。投影包含所有会被合法性检查或 solver 读取的实时字段；Rust 对 `/step` 请求重算后才允许生成响应，JS 执行前等待 idle、完整复采并再次计算。任何一端不一致都是零执行。`capturedAt`、cycle/log 序号、UI 像素和纯动画帧不进入投影；不存在另一个“轻量 hash”。

动作结束后不发 ACK。引擎回到可靠 idle 才重新进入 `IDLE`，下一轮 observation 即为实际 post-state。浏览器不自动重试动作，后端不保存 pending/outstanding action，也不返回动作队列。

浏览器独有的状态变化通过单向 `POST /run-events` 旁路追加：stale 丢弃、`execution_started/completed/failed/settlement_unknown`、`browser_paused` 和 `run_finished`。这些 event 不驱动上图状态，不被 solver 读取，也不替代下一轮 observation；`execution_completed` 不是 ACK。写 `execution_started` 失败时不执行并暂停；动作已经发生后的日志失败只标记日志不完整并暂停下一动作，绝不重放。

目标部署固定为一张游戏页面、一个 solver 进程、一个 active run。第一次成功 bootstrap 后第二次请求返回 `ACTIVE_RUN_EXISTS`；另一页面使用独立进程/端口。V1 不实现租约、选主或多客户端协调，诊断 `runId` 不能授权动作。

`PROVEN` 是 solver 对不可逆选择的内部结论，不是页面状态。普通已证明零副作用的移动无需全局最优证明；不可逆动作无法在预算内证明时返回 `wait/pause`。

完整目标循环见 [求解器架构与实施方案](solver-architecture.md)。
