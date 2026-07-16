# 当前运行状态与目标日志边界

## 当前实现（legacy/transitional）

当前 Python `serve` 的运行状态驻留内存。它不读取、创建或修改 `state_dir`、`knowledge_dir`；兼容 CLI 参数对 production `serve` 无作用。

当前服务内部 `Store()` 使用数据库引擎的 `:memory:` 模式。进程退出后 session、action、decision 和 world context 全部消失。规划静态规则从 `service/data/block-labels.json` 与 `service/data/floor-models.json` 启动时只读载入；用户点击“导出”才生成诊断下载，当前没有目标 V1 所述的后台 per-run 日志。

## 目标 V1：运行状态纯内存

目标 Rust 后端只在本次启动内存中保存：

- immutable `CatalogIR + GlobalIndex`；
- 最新实时 `RuntimeState`；
- 当前搜索 arena、memo、Pareto 前沿、incumbent 和依赖缓存；
- 有界 telemetry buffer。

实时 observation 覆盖旧推测。后端不持久化 session、pending/outstanding action、plan、搜索树或世界状态；进程退出即结束本次自动驾驶。用户再次启动时从游戏当前状态重新扫描和计算。

目标生产热路径不需要 SQLite、WAL、恢复 journal、运行状态 sidecar 或数据库迁移。

## 唯一持久化：per-run 诊断日志

目标 V1 每次启动创建一个新的诊断 `runId` 和独立日志：

```text
run-<timestamp>_<runId>.jsonl
```

它是旁路 append-only 输出：运行时只写，不提供历史日志读取接口。每条记录可以包含完整 observation、决策、动作摘要、执行结果、暂停和终局信息；`runId` 只关联复盘文件，不是协议 session。旧日志不能恢复地图索引、搜索状态、世界状态或 action，也不能成为 source of truth。

日志记录版本、配置、seed、初始扫描、每轮自包含 observation、候选/bounds/剪枝/耗时、选择理由、执行前 hash、下一轮实际结果、pause/error 和终局摘要。无需记录每个搜索节点；这些输入足以由独立离线工具重放决策。

浏览器通过单向 `POST /run-events` 追加只有页面知道的 `action_discarded_stale`、`execution_started/completed/failed/settlement_unknown`、`browser_paused` 和 `run_finished`。请求带诊断用 `runId/eventSeq/cycleNo/type/time`，以及事件需要的 hash、action、error 和完整 observation；响应只表示写入结果，不能包含 action。后端自己追加 bootstrap、step request、候选、bounds、剪枝、耗时和 decision response。

依赖方向只能是 `api/run-events -> logger -> events.jsonl`。solver、`GlobalIndex`、planner 和 controller 不读取 event；`/step` 不等待或消费 receipt。下一轮完整 observation 仍是唯一规划输入和上一步结果，`execution_completed` 不是 ACK。新 run 也不读取旧 event。

运行期间 `events.jsonl` 只追加，结束后才可压缩。V1 不做日志自动重试、去重或事务恢复。若 `execution_started` 写入失败，浏览器不调用动作 API并暂停；动作已经发生后的日志失败统一标记本轮日志不完整并暂停下一动作，绝不回滚、重放或恢复。终局事件失败则标记不完整后结束。

一个 solver 进程只有一个 active run 和对应 logger。第二次 bootstrap 被拒绝；第二张页面必须使用独立进程/端口。`runId` 只决定诊断关联，不作为选择 logger、授权调用或协调多客户端的 session token。

完整设计见 [求解器架构与实施方案](solver-architecture.md)。本节目标尚未实现。
