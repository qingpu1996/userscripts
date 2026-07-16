# 魔塔自动驾驶求解器架构与实施方案

状态：目标 V1 设计，尚未实现

日期：2026-07-16

适用范围：`games/mota-planning-lab` 的下一代求解器与单步执行循环

> **当前与目标必须分开理解。** 当前仓库仍是 Python + Protocol v2 `/cycle`，包含 ACK、guard、expected delta 和内存 SQLite 等过渡实现；当前启发式 planner 不能安全接管真实存档。本文定义的是待实施的目标 V1。本轮只更新设计文档，不代表源码、Schema、测试或构建物已经迁移。

## 1. 一页结论

目标 V1 只有一条主链：

```text
启动一次
JS 全量扫描塔定义、规则和当前状态
  → Rust 后端在内存中构建 GlobalIndex 与搜索缓存

循环直到通关
JS 等引擎 idle
  → 采集一份实时 StepObservation
  → POST /step
  → 后端用当前 observation 覆盖旧推测，计算一个结果
  → 返回一个 action / wait / pause / terminal
  → JS 执行一个 action 并等待引擎再次 idle
  → 下一轮 observation 同时是上一步结果与下一步输入

旁路
后端把启动、输入、候选和决策直接追加到日志
浏览器把 stale/执行结果/暂停/终局 POST /run-events
  → 同一份 append-only 诊断日志（只写不读，不回流）
```

系统只分成三个组件：

| 组件 | 职责 | 不负责 |
| --- | --- | --- |
| 浏览器 `JS Adapter` | 全量 bootstrap、逐轮实时采集、陈旧响应检查、单动作执行 | 不做大规模搜索，不恢复旧 action |
| `In-memory Solver` | 编译塔规则、维护内存模型、搜索并返回一个决策 | 不保存运行状态，不返回动作队列 |
| `Run Logger` | 按本次启动追加诊断事件，供事后离线复盘 | 不参与决策，不参与恢复，运行时永远不读取历史日志 |

### 1.1 必须坚持的不变式

1. 游戏实时运行态是唯一事实来源；内存模型只是加速用的派生物。
2. 同一时刻最多一个动作，后端每轮最多返回一个动作。
3. 浏览器不自动重试动作；动作结果不确定时立即暂停。
4. 后端不保存 pending/outstanding action，不恢复旧 session、旧计划或旧搜索树。
5. JS 与 Rust 只使用一套 `DecisionStateProjection` 计算 `stateHash`；它只用于执行前发现响应已陈旧，不扩展成恢复协议。
6. `PROVEN` 只属于求解器内部；它不是浏览器协议或动作生命周期。
7. 唯一持久化数据是本次启动的诊断日志；日志只写不读。
8. 目标 V1 的部署单位是“一张游戏页面 + 一个 solver 进程 + 一个 active run”；多标签页和多客户端协调不在范围内。

### 1.2 目标 V1 明确删除的设计

目标架构不包含独立 ACK、cancel、resync、`RuntimeEpoch`、`ResyncIdentity`、outstanding action 表、tombstone、canonical response cache、跨进程恢复、分布式事务式 action lifecycle，也不包含复杂的 `BrowserExecutionFence`。页面侧只保留一个普通内存 single-flight controller。

当前 Protocol v2 中仍存在的同名机制属于 legacy/transitional 事实，迁移完成前不能假装它们已经消失；但实现目标不是把它们换名后继续保留。

## 2. 数据与目标边界

### 2.1 允许和禁止的数据

- 允许只读分析游戏自身完整源码、配置、地图、怪物、事件、道具、商店、终局与评分定义，包括尚未到达楼层。
- 每轮允许读取当前 `core.status`、动态 maps、角色、资源、flags、菜单与引擎 busy 状态。
- 禁止读取或导入外部攻略、标准路线、通关录像和人为整理的该塔答案。
- 禁止直接改英雄、地图、怪物、资源、flag 或存档；动作只能通过游戏正常接口发生。

### 2.2 终局目标

求解器先从游戏定义编译 `CompletionPredicate` 与可选 `NativeScore`：

- 有可解释的原生评分：通关是硬约束，最大化原生终局分数。
- 确认没有原生评分：通关且 `HP > 0` 是硬约束；先对终局仍可访问的商店做最优资源清算，再按以下顺序比较：
  1. 永久属性总量；
  2. 终局 HP；
  3. 更少的不可逆动作；
  4. 稳定 action ID，仅用于完全同分时确定性选路。
- 评分公式存在但无法解释时返回 `OPAQUE`，不能偷偷改用 fallback。

“偏向防杀”不硬编码成总是加防。防御减少战损时会自然提高终局 HP；破甲、坚固、反击、领域等塔内规则可能改变攻防收益，最终必须服从精确规则和终局目标。

## 3. ADR-001：目标生产后端采用 Rust

### 3.1 决定

- 浏览器侧保持 JavaScript。
- 目标生产后端是一个本地 Rust 进程 `mota-solverd`。
- `axum/tokio` 负责 localhost HTTP；CPU 搜索放在独立固定线程池，优先使用 Rayon 自建池。
- Python 只保留为离线小实例穷举 oracle、迁移差分工具和 fixture 生成器，不进入目标生产热路径。

### 3.2 为什么不直接沿用当前 Python 热路径

当前实现适合验证采集、协议和启发式循环，但没有证明它适合大规模精确搜索：

- `Planner` 默认 `planning_budget=4096`（[`planner.py`](../service/mota_lab/planner.py)），预算耗尽不等于证明最优。
- 模拟节点仍大量使用 Pydantic、dict、tuple、set、`frozenset` 和完整对象重建。
- 当前 API 收包后同步进入 CPU 规划；现有性能记录没有覆盖 600 层编译、跨期商店、Pareto 前沿、branch-and-bound、证明延迟与峰值 RSS。
- 内存 SQLite 仍会规范化并复制完整 observation；目标热路径需要 packed state、bitset、arena 和明确的无历史状态模型。

Rust 的价值是更直接地实现紧凑状态、低成本复制、受控内存和确定性 CPU 并行，不是语言本身能解决指数搜索。CPython free-threading 也不会自动消除对象分配、hash、模型转换和算法复杂度。因此语言决定必须由 Stage 0 基准复核，不能把本 ADR 写成已经跑出的性能结论。

### 3.3 Stage 0 决策门禁

在正式迁移前，用相同 fixture、相同规则和相同搜索边界比较当前 Python 原型与 Rust 紧凑 IR：

| 维度 | 必测指标 |
| --- | --- |
| 等价性 | 固定 fixtures、transition/search 投影、首动作 proof 和小塔 oracle 完全一致 |
| 普通 benchmark | transition/search 三份完整计时样本，报告 Rust/Python 比率 |

若 Rust 紧凑 IR 没有达到明确收益，重新记录 ADR；无论语言结论如何，精确规则、活动域、合法界和证明语义不能退回启发式。

### 3.4 Stage 0 结果（2026-07-16）

Stage 0 已在合成 `stage0-subset-v2` fixture 上完成。Python baseline 与 Rust 紧凑 IR 读取同一带 input digest 的 24/100/600 层输入，执行相同的 FIFO、源 action 顺序、互斥 opening 规则和 `min(16384, 64 * action_count)` 节点上限搜索。小塔 oracle 从规则穷举全部合法 action 顺序；两端均与 oracle 的 terminal、首 action、完整 route 和 score 完全一致。每个 phase 固定一次 warmup，再保留三份完整计时样本；本尖峰没有并行搜索。

比较器只检查固定 fixture、oracle、首动作 proof、transition/search 投影和计时样本，并输出 Rust/Python 的 600 层普通比率。transition/search 各取一次 warmup 和三份完整样本；所有样本计入，`(max-min)/median <= 35%`，不 retry 或挑选结果。Rust 的 transitions/s 与 nodes/s 都至少为 Python 的 2.0 倍时，Stage 0 结论是“进入 shadow-only”；否则重新评估路线。结果只适用于本机 synthetic serial bounded workload，不代表生产采用、真实规则正确性、Pareto 规模、并行扩展或 SLA。runner 使用临时目录，退出后清理，不在仓库保存 benchmark 结果。

最近一次普通运行（2026-07-16，本机）约为 transition `274.50x`、search `59.84x`。倍数会随机器负载变化，只能作为 synthetic 路线判断，不能当作稳定承诺、SLA 或外推值。

结果中的工作量、checksum、rate、median 和 dispersion 由比较器从每份样本重新计算；它们只是本机 synthetic workload 的可重复性检查，不是 allocator 统计或生产性能承诺。

24/100/600 fixture 都有两个合法且互斥的 opening。proof 对每个 opening 使用相同的 source-order topological replay，完成全部不冲突动作；此合成规则的共享 transition 全是加性且顺序无关，因此 replay 得到各候选的精确 complete-all terminal/score。只有最佳候选分数严格更高且终态逐分量严格支配其余候选，certificate 才为 `proven`；输出包含所有候选 route、terminal、score、触发延迟和状态，比较器独立重放。这个证明只覆盖该 synthetic completion condition，不等于生产 solver 的 branch-and-bound proof。

## 4. 目标 V1 运行循环

### 4.1 浏览器内存状态

页面全局只允许一个 controller；目标生产拓扑中，一张游戏页面独占一个 solver 进程和该进程唯一的 active run：

```text
IDLE ──收到 action──> EXECUTING ──动作结束且引擎 idle──> IDLE
  │                         │
  └────无法安全判断─────────┴──────────────────────────> PAUSED
```

内存字段可以收敛为：

```ts
type ControllerState = {
  phase: "IDLE" | "EXECUTING" | "PAUSED";
  inFlightAction: null | { actionId: string; baseStateHash: string };
};
```

这只是普通 single-flight guard。它不跨页面恢复，不维护 generation、retired ID、ACK slot 或 action tombstone。

solver 进程第一次成功 `/bootstrap` 后只服务这一个 active run；进程存活期间再次 `/bootstrap` 必须返回 `409 ACTIVE_RUN_EXISTS` 且不得修改内存。第二张页面必须使用独立 solver 进程和端口，否则明确拒绝。V1 不实现标签页选主、租约或多客户端协调；`runId` 仍只关联诊断日志，不是授权、session 或恢复身份。

### 4.2 启动 `/bootstrap`

JS 在用户本次启动时采集：

- 游戏和脚本版本、规则定义摘要；
- floors/maps/material、怪物、物品、门、商店、事件和评分定义；
- 当前完整动态状态；
- 可用于解释引擎 idle 与动作完成的能力信息。

请求可以按大小分片上传，但语义上属于同一次 bootstrap。后端只有收到完整、同 revision 的输入才原子构建：

- `CatalogIR`；
- `GlobalIndex`；
- 当前 `RuntimeState`；
- 空的搜索缓存和 Pareto 表。

失败就暂停，不混用新旧分片。再次启动是全新 run，从游戏当前状态重新扫描；不读取任何旧运行状态。

### 4.3 唯一决策投影与 hash 契约

`DecisionStateProjectionV1` 是 `StepObservation` 中**所有会影响动作合法性或 solver 决策字段**的规范化、无冗余投影。JS 发请求、Rust 验证、响应绑定和 JS 执行前复采必须调用同一份版本化规范；不存在“轻量 hash”或另一个字段子集。

投影固定包含：

| 分组 | 必含内容 |
| --- | --- |
| `bootstrapBinding` | `gameId`、`towerId`、`catalogDigest`、`ruleModelDigest`、规则适配器版本和投影 schema 版本；静态 `CatalogIR` 不必逐轮重传，但任何静态定义或模型变化都必须改变这里的 digest |
| `location` | `floorId`、`x`、`y`，以及规则或动作合法性读取方向时的 `direction` |
| `hero` | HP、攻、防、魔防、金币、经验、全部钥匙、装备、背包道具及数量、规则读取的永久/临时属性 |
| `variables` | 所有决策相关的 flags、values、switches、商店购买次数及塔自定义变量 |
| `interaction` | `engineIdle`、busy 原因、当前菜单/商店/事件、输入锁和任何会阻止或改变动作含义的交互状态 |
| `dynamicWorld` | ActiveDomain 内楼层尺寸与拓扑、门/怪/道具/NPC/事件/楼梯的稳定身份、位置、动态属性及已触发/移除状态；bounds 或规则读取的域外动态依赖也必须以精确字段或 digest 纳入 |
| `runtimeRules` | 当前影响伤害、奖励、通行、商店、事件、完成条件或终局评分的动态规则字段和 modifier |

`capturedAt`、日志 `cycleNo/eventSeq`、UI 像素、动画帧编号等不影响合法性或决策的瞬时字段明确排除。规则适配器必须声明 `reads`；任何被 adapter、transition、bound、score 或 action guard 读取的实时字段都必须映射进投影。新增读取却未更新投影 schema 是构建阻断错误，不能靠人工约定补救。

唯一编码与 hash 规则如下：

1. 投影根对象固定带 `schema: "mota.decision-state.v1"`；所有 schema 字段都必须出现，可选值统一写 `null`，禁止 `undefined` 和“缺失等于 null”。
2. 所有字符串先转 Unicode NFC；对象按 RFC 8785 JCS 进行 key 排序和 JSON 序列化。数组保留有规则含义的顺序；本质是 map/set 的集合先按稳定 ID/复合 key 排序再形成数组。
3. 普通整数必须处于 JavaScript safe integer 范围并编码为 JSON integer。超出范围或规则允许精确小数的 schema 字段使用规范十进制字符串：无 `+`、指数、前导零和无意义尾零，`-0` 归一为 `0`。`NaN`、Infinity、代理项错误或 NFC 后 key 冲突直接拒绝。
4. `canonicalBytes = UTF8(JCS(DecisionStateProjectionV1))`；`stateHash = "sha256:" + lowercaseHex(SHA256(canonicalBytes))`。
5. JS/Rust 共享 golden fixtures 和同一 schema 版本；实现可以不同，字节结果必须完全相同。

`/step` 请求携带完整 `StepObservation` 和由它生成的 `stateHash`。Rust 必须先独立重建同一投影并重算 hash；字段不完整、bootstrap binding 不匹配或 hash 不一致时拒绝本轮并且不得更新 `RuntimeState`、搜索或产生 action。所有响应的 `baseStateHash` 必须逐字等于已经验证的请求 `stateHash`。

### 4.4 单步 `/step`

每轮请求是自包含的实时 observation：

```json
{
  "stateHash": "sha256:...",
  "capturedAt": "2026-07-16T12:00:00.000Z",
  "engineIdle": true,
  "hero": {},
  "location": {},
  "resources": {},
  "dynamicMaps": {},
  "flags": {},
  "menu": null
}
```

目标响应保持最小：

```json
{
  "baseStateHash": "sha256:...",
  "result": "action",
  "action": { "actionId": "...", "kind": "...", "target": {} },
  "decisionSummary": { "reason": "...", "proof": "proven" }
}
```

`result` 只有四种语义：

- `action`：执行一个动作；
- `wait`：求解仍在预算内继续，JS 不执行游戏动作，稍后重新采集；
- `pause`：规则不透明、预算内无法证明或执行条件不安全；
- `terminal`：已通关或已明确不可继续。

后端收到 observation 后：

1. 按 4.3 构建投影并重算 `stateHash`，不一致就拒绝且零 action；
2. 校验它完整且来自 idle 状态；
3. 用实时字段覆盖内存中的旧推测；
4. 使依赖变化的缓存失效；
5. 搜索并只返回一个结果；
6. 将输入、候选、证明和输出旁路写日志。

浏览器收到 `action` 后等待引擎 idle，重新采集完整 `StepObservation`，按 4.3 生成同一份 `DecisionStateProjectionV1` 并重算 hash；若不再逐字等于 `baseStateHash`，丢弃响应、通过 `/run-events` 写入 `action_discarded_stale`，然后回到 `IDLE` 重新采集。hash 一致才把 controller 切到 `EXECUTING` 并调用一次游戏 API。

浏览器不重发 action。动作结束后不发送独立 ACK；它等待引擎回到可可靠判定的 idle，采集完整 post observation/hash 并通过 `/run-events` 记录 `execution_completed`，再进入下一轮。下一轮 observation 中的实际地图、属性和资源变化仍是 solver 判断上一步结果的**唯一输入**。如果无法判断动作是否完成、引擎长期不 idle、API 抛错或现场不符合支持规则，则通过 `/run-events` 写入对应事件并进入 `PAUSED`。

### 4.5 主循环伪代码

```js
await bootstrapFromCurrentGame();

while (controller.phase !== "PAUSED") {
  await waitUntilEngineIdle();

  const observation = await captureStepObservation();
  const stateHash = hashDecisionState(projectDecisionState(observation));
  const decision = await solver.step({ observation, stateHash });

  if (decision.baseStateHash !== stateHash) return pauseAndLog("invalid_response_hash");
  if (decision.result === "terminal") {
    await emitRunEvent("run_finished", { observation, stateHash, decision });
    break;
  }
  if (decision.result === "pause") {
    await emitRunEvent("browser_paused", { observation, stateHash, decision });
    return pause(decision);
  }
  if (decision.result === "wait") continue;

  await waitUntilEngineIdle();
  const preObservation = await captureStepObservation();
  const preStateHash = hashDecisionState(projectDecisionState(preObservation));
  if (preStateHash !== decision.baseStateHash) {
    await emitRunEvent("action_discarded_stale", {
      action: decision.action, baseStateHash: decision.baseStateHash,
      currentStateHash: preStateHash, observation: preObservation
    });
    continue;
  }

  controller.phase = "EXECUTING";
  const started = await tryEmitRunEvent("execution_started", {
    action: decision.action, baseStateHash: decision.baseStateHash
  });
  if (!started) {
    controller.phase = "PAUSED";
    return showIncompleteLogAndPause(); // 还没有调用游戏 API
  }

  try {
    await executeExactlyOnce(decision.action);
    await waitUntilEngineIdle();
    const postObservation = await captureStepObservation();
    const postStateHash = hashDecisionState(projectDecisionState(postObservation));
    const completedLogged = await tryEmitRunEvent("execution_completed", {
      action: decision.action, baseStateHash: decision.baseStateHash,
      postStateHash, observation: postObservation
    });
    if (!completedLogged) {
      controller.phase = "PAUSED";
      return showIncompleteLogAndPause(); // 动作已经发生，绝不重放
    }
    controller.phase = "IDLE";
  } catch (error) {
    await bestEffortRunEvent(classifyExecutionEvent(error), {
      action: decision.action, error
    });
    await bestEffortRunEvent("browser_paused", {
      reason: "execution_error", error
    });
    return pauseWithEvidence(error); // 任何日志失败都标记 run 不完整；从不重试 action
  }
}
```

## 5. 内存边界

### 5.1 后端内存中可以存在什么

- 一份 immutable `CatalogIR` 和 `GlobalIndex`；
- 最新实时 `RuntimeState`；
- 当前搜索任务及其 arena、memo、Pareto 前沿和 incumbent；
- 由依赖签名控制失效的规则和界缓存；
- 有界 telemetry buffer，随后旁路写入本轮日志。

这些数据全部可丢弃。内存模型与实时 observation 冲突时，实时 observation 无条件获胜；无法解释冲突则暂停，而不是从旧模型恢复。

### 5.2 明确不能成为运行状态的东西

- SQLite 或其他数据库中的 session/action/decision/world state；
- pending/outstanding action；
- 未完成动作恢复队列；
- 旧 run 的搜索树、地图索引或计划；
- 从日志反向加载出的任何运行数据。

进程退出就结束本次自动驾驶。用户再次启动时生成新 run，重新读取游戏当前状态并重建全部内存。

## 6. 唯一持久化：旁路全量诊断日志

### 6.1 边界

日志是 write-only observability sink：

```text
实时 observation → 内存求解器 → 单动作执行
                         │
                         └── append diagnostic event

历史日志 ──X──> 当前运行/求解/动作授权
```

每次启动生成新的 `runId`，它只用于关联诊断文件，不是协议 session，也不能授权或恢复动作。可以把完整事件追加到一个新日志文件：

```text
run-2026-07-16_20-30-01_<runId>.jsonl
```

`events.jsonl` 运行期间只追加；运行结束后可以压缩。不能使用数据库、WAL、恢复 journal 或 sidecar 来保存运行状态。

### 6.2 浏览器旁路事件接口

后端可直接记录它自己拥有的 `run_started`、`bootstrap`、`step_observation`、候选/bounds/剪枝/耗时和 `decision`。但 stale 丢弃、游戏 API 是否执行、settlement 是否可靠、页面暂停与终局发生在浏览器，不能指望“下一次 `/step`”补记，因为下一轮可能永远不会发生。

目标 V1 因此增加一个单向诊断端点 `POST /run-events`：

```json
{
  "runId": "diagnostic-only-id",
  "eventSeq": 42,
  "cycleNo": 17,
  "eventType": "execution_completed",
  "occurredAt": "2026-07-16T12:00:00.000Z",
  "stateHash": "sha256:...",
  "baseStateHash": "sha256:...",
  "action": { "actionId": "...", "kind": "...", "target": {} },
  "observation": {},
  "error": null
}
```

字段按事件需要出现；`eventSeq` 是浏览器本次 run 内单调递增的复盘排序号，`cycleNo` 只关联一次 step/action。它们都不参与决策、去重、完成判断或动作授权。成功响应只能是 `{ "logged": true }`；错误只表示本条日志未写入，响应绝不能包含 action。

端点处理器只把事件追加到当前 run 的 `events.jsonl`，代码依赖方向必须是 `api/run-events -> logging`，不能访问或修改 solver、`GlobalIndex`、planner、controller 授权状态。`/step` 不等待、查询或消费 run-event receipt；下一轮 observation 仍是 solver 唯一的 post-state 输入。这个端点不是 ACK，即便事件名为 `execution_completed`，后端也不得据此推进世界模型。

浏览器必须主动上报：

- `action_discarded_stale`：执行前完整复采 hash 不等，包含响应 hash、当前 hash 和当前 observation；
- `execution_started`：调用游戏动作 API 之前；
- `execution_completed`：等待可靠 idle 后，包含完整 post observation/hash，并用 `cycleNo/actionId/baseStateHash` 与动作关联；下一次 `/step` 重复携带同一现场是允许且必要的；
- `execution_failed`：动作 API 明确抛错；
- `execution_settlement_unknown`：无法确认动作是否完成或引擎无法回到可靠 idle；
- `browser_paused`：页面因协议、采集、执行或日志错误停止循环；
- `run_finished`：通关、明确终局或用户结束本 run。

目标 V1 不为 `/run-events` 设计自动重试、去重、补发或事务状态机。写 `execution_started` 失败时，不调用动作 API并暂停；动作已发生后任何事件写入失败，只显示“日志不完整”并暂停下一动作，绝不能重放 action。终局事件失败则显示本 run 日志不完整后结束。这样日志通道可以影响页面是否继续运行，但永远不能授权动作、恢复旧状态或改变 `/step` 结果。

### 6.3 必须记录的事件

| 事件 | 最低内容 |
| --- | --- |
| `run_started` | 代码/游戏版本、配置、seed、机器与线程参数 |
| `bootstrap` | 初始全塔扫描或可独立重放的完整快照、catalog digest |
| `step_observation` | 本轮自包含 observation、stateHash、采集耗时 |
| `decision` | 候选首动作、评分、上下界、剪枝数、节点数、耗时、选择和理由 |
| `action_discarded_stale` | action、响应 hash、当前 hash、当前完整 observation |
| `execution_started` | action、执行前 `baseStateHash` |
| `execution_completed` | action、完整 post observation/hash；下一轮 `step_observation` 仍会把它作为 solver 输入 |
| `execution_failed/execution_settlement_unknown/browser_paused` | 分类、原始错误和当时完整状态 |
| `run_finished` | 终局、动作数、耗时、HP/属性/资源与评分摘要 |

“全量”不要求写出每个搜索节点。完整输入、配置、seed、代码版本、关键统计和选择理由足以让离线工具重放同一次决策；逐节点落盘会污染热路径并制造无意义数据量。

### 6.4 日志失败

日志写入失败采用单一策略：UI 明确显示“日志不完整”，页面进入 `PAUSED`，不执行下一动作。若失败发生在动作之后，已经发生的动作既不回滚也不重放；终局时没有下一动作，只标记不完整并结束。任何情况下都不能读取历史日志“补回”状态或动作，当前运行与所有旧 run 完全隔离。

## 7. 600 层大塔：全塔扫描不等于全塔搜索

### 7.1 四层模型

1. `CatalogIR`：全塔规则与静态实体的紧凑表。
2. `GlobalIndex`：区域/SCC、楼层连接、商店、关键道具、终局、反向依赖和远端界摘要。
3. `ActiveDomain`：本轮进入精确搜索的局部子图。
4. `SearchState`：不可逆决策后的动态资源、flags、消耗集合和 Pareto 标签。

全塔 bootstrap 只做 `O(T+E)` 线性编译和索引；组合状态只在 ActiveDomain 中展开。

### 7.2 ActiveDomain

活动域至少包含：

- 已访问且仍有战略资源/商店/事件的区域；
- 当前最高层向前的软窗口，默认可从 `+10` 起步；
- 当前属性下可能改变可达性的门、怪物、商店和道具；
- GlobalIndex 指出的远端关键 landmark 及其依赖切片；
- 终局仍可访问的清算设施。

`+10` 只是性能预算，不是正确性边界。窗口外若存在金币翻倍、属性倍增、区域锁定或高性价比商店等可能改变最优首动作的设施，合法上界必须把它纳入；上界不够紧时按依赖关系扩域。

### 7.3 压缩条件

只有经过证明的零副作用走廊/区域才能压缩成可逆闭包：

- 无资源、钥匙、HP、属性、flag、计分和拓扑变化；
- 无商店、NPC、脚本事件、路径伤害、单向边或终局入口；
- 进出不改变后续规则读取结果。

商店、关键道具、事件和终局永远保留为战略节点。未知或脚本化语义 `OPAQUE`，不得为了缩图而猜测。

## 8. 状态、规则与搜索

### 8.1 紧凑状态

静态实体使用 interned integer ID；集合使用 bitset；节点和 witness 放入 arena。搜索 key 至少覆盖：

```text
position/region
HP + permanent stats
gold + exp + keys + inventory
shop purchase counters
consumed/opened/defeated bitsets
global and tower-specific flags
native score dependencies
```

只有证明与未来价值无关的字段才能从 key 中删除。Pareto 支配必须按依赖签名验证，不能用人工加权总分替代多维前沿。

### 8.2 精确转移

战斗、门、钥匙、道具、商店、事件、楼层锁和终局都编译为具有 `reads/writes/effects` 的精确 transition。规则不可解释时该分支为 `OPAQUE`。

普通移动若已证明零副作用，可以由最短路重建，不进入组合状态；否则移动本身也是精确 transition。

### 8.3 商店与跨期选择

“金币够买”只产生购买候选，不代表立即购买。求解器必须同时比较：

- 现在购买后减少前段战损；
- 留存货币进入后期高性价比商店；
- 攻击与防御触发的战斗阈值；
- 购买次数、动态价格、事件与终局清算。

只有当两段 transition 的 reads/writes/effects 证明可交换时，才允许把“现在买/以后买”合并；否则保留原始购买时点分支。

### 8.4 关键道具

GlobalIndex 为关键道具保存：

- 所在区域和可达依赖；
- 入口切点与必要怪物/门集合；
- 当前属性下的 Pareto 成本标签；
- 道具对战斗、奖励、商店、拓扑和评分的影响签名；
- 乐观后续收益上界。

人物属性变化、依赖怪物死亡、门/flag/区域变化时，只失效相关切片。打不过时成本为无穷；未知规则则 `OPAQUE`，不是无穷也不是零。

### 8.5 分层搜索

1. 可逆闭包与精确可达性；
2. 小域动态规划/Pareto 搜索；
3. branch-and-bound 比较首个不可逆动作组；
4. 远端 landmark 使用可采纳上界；
5. 上界过松时按依赖图扩域；
6. 得到终局可行 incumbent 与首动作证明，或预算内返回 `wait/pause`。

## 9. `PROVEN` 的最小职责

`PROVEN` 只是 solver 内部对不可逆选择的结论。

### 9.1 哪些动作需要证明

需要：开门、战斗、购买、消耗钥匙/道具、获取关键道具、触发事件、进入单向区域或不可返回区域。

不需要全局证明：已经证明零副作用的普通移动；它仍要满足实时可达与执行安全检查。

### 9.2 证明条件

按下一不可逆动作分组。候选 `a*` 只有满足以下条件才可输出：

```text
feasibleLowerBound(a*) >= max(admissibleUpperBound(other groups))
```

- 下界来自一条已精确 replay 到终局的可行路线。
- 其他组的上界必须合法乐观，不能低估其可能终局结果。
- 未搜索完、规则不透明或上界还压不住时，不得把当前最好猜测输出成 action。

solver 对外只需要在 `decisionSummary` 中给出简短解释；proof tree、bounds 和 replay witness 写入旁路日志，浏览器不参与 proof 协议。

## 10. Rust 模块划分

```text
mota-solverd/
├── api/            # /bootstrap、/step、/run-events、输入限额
├── catalog/        # 原始游戏定义 -> CatalogIR
├── runtime/        # 最新 StepObservation -> RuntimeState
├── rules/          # 战斗、门、道具、事件、评分精确转移
├── index/          # GlobalIndex、landmark、依赖失效
├── domain/         # ActiveDomain、可逆闭包与安全压缩
├── solver/         # Pareto、DP、B&B、bounds、proof replay
├── logging/        # append-only per-run 诊断 sink
└── main.rs         # localhost 服务与 CPU pool
```

API 任务只做解析、校验和调度；CPU 搜索不能占用 Tokio I/O worker。搜索可按首个不可逆动作分组并行，但合并顺序、tie-break 和日志必须确定性。

## 11. 分阶段实施路线

| 阶段 | 交付物 | 退出标准 |
| --- | --- | --- |
| 0. 基准与 oracle | 24/100/600 层 fixture、Python 基线、Rust IR spike、小塔穷举 oracle | 原始数据齐全，复核 Rust ADR |
| 1. 规范冻结 | completion/score、transition dependency、StepObservation、DecisionStateProjection、action/result、日志 schema | 文档、Schema 草案和 JS/Rust golden fixture 一致 |
| 2. Rust bootstrap | `CatalogIR + GlobalIndex`，全塔 O(T+E) 编译 | 与游戏定义差分一致；600 层有 RSS/耗时证据 |
| 3. 精确规则 | 战斗、门、物品、商店、事件、终局 | 与当前引擎/小塔 oracle 差分零错误 |
| 4. 单步 API | `/bootstrap + /step + /run-events`、纯内存 reducer、per-run logger | 无 ACK/恢复链；每轮只返回一个结果；浏览器事件严格旁路 |
| 5. 浏览器循环 | `IDLE/EXECUTING/PAUSED`、统一投影 stateHash、单动作执行 | 无队列、无自动重试、异常必暂停 |
| 6. 搜索 | Pareto、商店 DP、关键道具、bounds、ActiveDomain、PROVEN | proof replay 与 oracle 一致；触限零不可逆动作 |
| 7. Shadow | 真实页面只读采集和建议，不执行 | observation/规则/性能证据稳定 |
| 8. 受控行动 | 测试存档、独立验收、用户明确授权 | 才可讨论真实自动驾驶 |

首批 issue 建议顺序：`BENCH-001`、`SPEC-001`、`RUST-IR-001`、`RULES-*`、`STEP-API-001`、`JS-LOOP-001`、`SOLVER-*`、`LARGE-*`、`LOGGER-001`、`SHADOW-001`。

## 12. 测试与验收

### 12.1 正确性

- 小塔完整穷举与 Rust solver 对照终局、分数、首动作和 proof replay。
- 标准与特殊战斗、钥匙、商店时序、关键道具、区域锁定和终局清算 property tests。
- 可压缩/未压缩模型的候选、Pareto、终局和首动作完全等价。
- bounds admissibility 反例生成；任何非法上界都是阻断项。
- 同 observation、seed、1/N 线程重复运行结果一致。

### 12.2 极简单步循环

- 每个 `/step` 最多一个 action；Schema 不允许 action 数组。
- 新 observation 覆盖旧推测，并正确失效依赖缓存。
- 对每个投影字段做 mutation/property test：任何决策相关字段变化都必须改变 hash；`capturedAt/cycleNo/UI 像素/动画帧` 等排除字段变化可以不变。
- JS/Rust 对共享 golden fixtures 生成完全相同的规范字节与 hash；缺失/null、对象/集合顺序、Unicode、整数边界和规范十进制均有反例。
- Rust 重算请求 hash 不一致时不更新模型且零 action；响应 `baseStateHash` 不逐字等于请求 hash 时浏览器拒绝执行。
- 返回后游戏状态变化时，浏览器用完整同一投影复采，`baseStateHash` 检查丢弃 action，零执行。
- `EXECUTING` 时重复 tick 不请求、不执行第二个动作。
- 动作 API reject、引擎不再 idle、完成不可判断时进入 `PAUSED`，零自动重放。
- 下一轮 observation 正确体现上一步结果；没有独立 ACK/cancel/resync 流程。
- 一个 solver 进程只接受一个 active bootstrap；第二页面必须使用独立进程/端口或收到 `ACTIVE_RUN_EXISTS`，不引入租约或选主。
- 全新启动不读取任何旧运行状态、旧 action 或旧日志。

### 12.3 日志

- 每次启动创建唯一 per-run 目录，只有 append 写入。
- 用事件、seed、版本和每轮完整 observation 可离线复盘一次决策。
- 搜索热路径不逐节点同步写盘。
- 日志目录包含恶意旧文件时，当前运行仍不读取它们。
- stale 丢弃后即使没有下一次 `/step`，`action_discarded_stale` 也已通过 `/run-events` 落盘。
- 动作抛错、settlement unknown 和 `PAUSED` 后即使没有下一轮，也分别存在 `execution_failed`、`execution_settlement_unknown`、`browser_paused`。
- `execution_completed` 带完整 post observation/hash；重复出现在下一次 `/step` 不会把 event 变成 ACK。
- property test 向 `/run-events` 注入任意 event，solver 内存、搜索结果和动作输出必须完全不变，event 也不能触发 action。
- `/run-events` 写入失败显示日志不完整并暂停下一动作；已经发生的 action 永不重放。
- 新 run 不读取旧 event；写入失败绝不恢复历史状态。

### 12.4 交付门禁

1. 当前启发式测试通过不代表新 solver 策略正确。
2. 规则差分、proof replay、bounds、确定性或单动作约束失败均阻断。
3. 触及真实页面前必须先 shadow；执行真实存档必须另获用户明确授权。
4. 每阶段开发完成后必须由全新、未参与开发的只读验收角色复核。

## 13. 风险与非目标

| 风险 | 处理 |
| --- | --- |
| 任意脚本事件无法编译 | 分支 `OPAQUE`，补精确 adapter 前不执行 |
| Pareto 前沿爆炸 | 活动域、阈值 DP、合法支配、arena；预算内无法证明则 wait/pause |
| 远端上界过松 | 按 landmark 依赖逐步扩域，不用启发式猜一步 |
| 商店时序错误合并 | 只有 exchange witness 才合并；与完整时序枚举对照 |
| 清空区域压缩错误 | 仅压缩严格零副作用闭包；战略设施永不删除 |
| Rust 重写语义漂移 | 游戏引擎差分、小塔 oracle、proof replay |
| 日志拖慢求解 | logger 独立有界队列/追加，不记录每个节点；浏览器事件写入失败即暂停下一动作 |
| 日志被误用作恢复 | 运行时模块不提供日志读取接口；对旧日志目录做 hostile 测试 |

非目标：

- 不导入外部攻略、路线或录像。
- 不承诺任意 600 层脚本塔都能在有限时间证明最优。
- 不做跨启动恢复、动作重试、动作队列、云端 solver 或共享知识库。
- 不用 LLM 作为战斗、评分或 proof oracle。
- 不因“金币够”“当前战损低”“楼层更高”就直接授权不可逆动作。
- 本方案阶段不修改源码、Schema、测试、构建物，也不接管真实存档。

## 14. 当前实现到目标 V1 的迁移边界

当前仓库仍以 [`protocol.md`](protocol.md) 描述的 Protocol v2 `/cycle` 运行，Python service 与浏览器 controller 仍包含 ACK、guard、expected delta、single in-flight identity 和内存 SQLite。这些是当前事实，不能在实现前从运行文档中删除。

目标迁移必须按以下顺序发生：

1. 先完成 Stage 0、规则/评分规范和 Rust IR；
2. 新增目标 `/bootstrap + /step + /run-events`，但主链先只做 shadow，日志端点保持单向旁路；
3. 新 JS controller 只接目标单步 API，验证 `IDLE/EXECUTING/PAUSED`；
4. 离线与 shadow 证据通过后再切换入口；
5. 切换完成并独立验收后，才删除 Protocol v2 的 ACK/recovery 兼容代码和文档。

迁移期不得把 legacy ACK 和目标隐式 post-observation 混在同一 action lifecycle，也不得让 Python 与 Rust 两个生产 planner 同时签发动作。
