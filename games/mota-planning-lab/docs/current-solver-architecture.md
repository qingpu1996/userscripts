# 当前魔塔 Shadow 求解器：架构与决策技术方案

## 1. 文档定位与版本基线

本文描述仓库当前实现，而不是下一阶段目标。Rust 服务是只读 Shadow runtime：它在一次请求内解析 observation、建立求解状态、搜索有界的全局终局路线，并把证明结果或 `unproven` 状态返回给浏览器；浏览器当前强制 `shadowOnly`，不会执行路线。Rust 进程只保留进程内 cycle 计数，不持久化世界、搜索队列或路线。

`docs/solver-architecture.md`、`docs/protocol.md` 中仍有 Stage2B 的历史描述；当描述与当前代码不一致时，以 `rust/shadow-runtime/src/main.rs`、`src/observer.js` 和协议 schema 为准。本文不把未来的自动驾驶、逆向搜索或更强剪枝写成已实现能力。

## 2. 组件与运行数据流

```mermaid
flowchart LR
  P[游戏页面运行时] --> O[src/observer.js\n实时 observation + engine_model]
  O --> C[src/controller.js\n创建 cycle 请求]
  C --> H[127.0.0.1:18724\nPOST /cycle]
  H --> R[Rust shadow-runtime\n校验/解析/全局搜索]
  R --> S[idle + shadow\ncurrent_floor_immediate + global]
  S --> V[JS 校验与面板展示]
  V -. shadowOnly .-> X[不调用 adapter/executor]
```

服务只监听 `127.0.0.1`。业务入口是 `POST /cycle`；请求要求 `Content-Type: application/json`、`X-Mota-Lab: 1`、`Content-Length`，请求体上限为 9 MiB。`OPTIONS /cycle` 只为配置的 `https://h5mota.com` 提供严格预检。`shadow_response` 返回 `status: idle`，`shadow.mode: read_only`，并把 `cycle` 计数、当前 observation 身份和分析结果放入响应。未知请求、非法 JSON、来源、Origin 或 header 失败时返回错误，不生成执行包。

## 3. 输入与静态世界模型

浏览器采集当前 hero、钥匙、位置、忙闲状态、当前楼层 blocks，以及可选的完整 `engine_model`。`collectEngineModel` 从引擎的 floors/status maps、blocksInfo、items、enemies、values、inventory 建立结构化模型，并缓存静态来源；动态地图可使用压缩表示，`decodeDetachedDynamicMap` 把整行 `0` 或单格 `-1` 从定义地图继承，形状或 token 不合法就暂停。

求解器看到的是 `solver_model`，而不是原始 JavaScript。每层包含 `floor_id`、宽高、`rectangle` 或 `valid_cells` 拓扑，以及 blocks。`buildSolverModel` 将 block 投影为 `terrain`、`door`、`enemy`、`resource`、`shop`、`transition`、`event` 或 `opaque`；楼梯目标由 `change_floor` 和目标楼层落点归一化，无法确定时成为 blocker。终局来自检测到的 `win` 事件位置，支持一个位置或最多 32 个 `any_location` 位置。24 层、每层 13×13（169 格、合计约 4056 格）是 games/24 的输入例子，不是求解器的固定层数；schema 允许更大的有限模型。

事件不是通用脚本解释器。普通运行时事件只保留坐标和 `event_script` blocker；只有 `auditedSolverEvent` 中登记的有限 ID 才投影成可模拟事件。商店同样先由 `parseRestrictedShop` 校验为受限、可递增计数的结构，再进入 solver model。存在任一 blocker 时，global 分析直接返回 `unsupported_solver_blocker`，避免猜测脚本语义。

## 4. 搜索状态与共享数据

一个 `SolverState` 包含：

- `floor/x/y`：当前策略位置；进入联通闭包后会归一化为该闭包的代表坐标。
- `hp/attack/defense`（有限 `f64`）、`level`、`gold`、`experience`、三色钥匙。
- 规范化的 `inventory`、事件 `flags`、每个商店 choice 的 `shop_counts`。
- `ConsumedBits`：只为门、敌人、资源、事件、初始 inactive block 和审计事件目标分配状态槽；一次真实 50k 测量得到 754 个槽，位图是 12 个 `u64`（`af5b511`）。

`inventory`、`flags`、`shop_counts` 和位图以 `Arc` 共享，写入时使用 copy-on-write；候选 materialize 时复制状态外壳，未修改的大数组仍共享。静态 floors、blocks、shop 定义不属于每个状态。hero 的方向、捕获时间、原始 damage 证据也不是策略状态；damage 只在 observation 采集或敌人模拟时使用。

## 5. 轻量全局联通

`ConnectivityIndex` 预先保存每层有效格和每格 block 索引，并为每个 transition 检查“纯、激活、非自环、唯一且互相可逆”的伙伴。只有满足这些条件的换层才是免费导航边；单向、inactive、带额外字段（副作用）或无法唯一配对的换层保留为战略 boundary。

对每个搜索状态，`view` 从当前位置做局部 BFS：未消耗的非 `terrain`、非 `shop` block 阻断格子；门、敌人、资源、事件和战略换层停在边界。发现可逆楼梯后，会进入目标楼层并重算局部 BFS。组件用 `(floor, 最小可达格索引)` 去重，因而 floor 只是坐标命名空间，不是策略阶段。第一阶段不记录 transition 序列；只有路线见证阶段才重新计算并保留 navigation witness，远端楼层的候选仍可直接入队。

动态门、事件替换或激活会改变 `ConsumedBits`/flags；下一状态会重新计算闭包，不复用过时的可达区域。对应 transition 的移动步骤仍写入 route witness/最终 route；系统没有独立的移动代价模型，也不制造一个“只是在第 N 层”的战略状态。

## 6. 决策生成流程

```mermaid
flowchart TD
  A[解析 solver_model 与初始 hero] --> B[建立 ConsumedBits、inventory、shop counts、flags]
  B --> C[ConnectivityIndex.view：局部 BFS + 可逆换层闭包]
  C --> D[收集 boundary、shops、reachable terminal]
  D --> E[Phase 1 VecDeque PendingCandidate\n只存 source/动作句柄]
  E --> F[pop_front，模拟动作]
  F --> G[模拟 door/resource/enemy/event/shop/transition]
  G --> H[canonical representative]
  H --> I[exact seen]
  I --> J[StructuralKey + 8 维 dominance]
  J --> K[state_arena + NumericObjective]
  K --> L{terminal?}
  L -- 否 --> D
  L -- 是 --> M[只更新数值目标并继续搜索]
  M --> N{Phase 1 队列耗尽?}
  N -- 是 --> O[Phase 2：固定数值目标，字典序路线见证]
```

Phase 1 是 FIFO 的 bounded state-space search：`VecDeque<PendingCandidate>` 按入队顺序取出，不按启发式优先级排序。每个已接受节点只把 `SolverState` 放进 `state_arena`；候选只保留 source index 及 block/shop 的稳定索引和相邻坐标，真正执行规则时才 materialize。它不创建 `RouteAction`、父链、route arena 或长期 navigation payload。无效钥匙、资源、战斗、商店或未支持事件在 materialize 阶段返回 `None`，不会产生后继。

对每个新节点，先用 `view` 得到代表位置，再做 exact seen、dominance、入 arena、终局检查和候选入队。终局只更新 `NumericObjective`。候选包括所有可达 boundary（door、enemy、resource、event、战略 transition）以及可达受限商店的每个 choice；当前楼层的 `current_floor_immediate` 分析是同一响应中的独立即时 BFS，最多返回 256 个候选。

## 7. 当前动作模型与 fail-closed 边界

- **战斗**：只接受有 hp/attack/defense/gold/experience 且无 special 的敌人；按英雄攻击减敌防计算回合数和战损，致死动作被拒绝。
- **门**：支持三色钥匙成本和可审计的 inventory 成本（如 special key）；扣费后消费 block。
- **资源**：支持三色钥匙、`bigKey`、`centerFly`、`superPotion`、`skill1`、`wand` 等已审计 item，以及受限的 `itemEffect` 数字增量语法；未知 item effect 形成 blocker。
- **商店**：支持经验商店、钥匙商店及通过固定表达式验证的 gold 属性商店；每个 choice 的购买次数在状态中独立递增，价格按模型计算。
- **事件**：覆盖 `fairy_mt0`、奖励/交易、`thief_quest`、`princess_quest`、`wand_gate_*`、一次性对白等审计 ID，并可激活、消费或替换指定 block。任何未登记事件、未知怪物 special、未知楼梯落点或不完整终局都 fail closed。

## 8. 目标函数与终局比较

终局比较拆为两个严格阶段。Phase 1 到达任一终局坐标时只记录 `NumericObjective`，搜索仍会继续以寻找更优数值。该目标顺序是：

1. `attack + defense` 最大；
2. `min(attack, defense)` 最大，用于偏好攻防均衡；
3. 终局 `hp` 最大；

Phase 1 队列耗尽后，才启动独立、同预算上限的 Phase 2。它将数值目标固定为 Phase 1 的最优三元组，重新计算 connectivity/navigation，并以 route steps JSON 前缀的最小堆展开。`ConnectivityView` 收集当前闭包内的全部可达终点（按 floor/坐标/导航稳定排序），因此 Phase 2 会为每个终点构造完整候选，再以完整 route steps JSON 取全局字典序最小者。对同一完整 `SolverState`，它保留字典序较小的前缀；路线见证同时要求 canonical state-simple，故两个有效的同状态前缀不会互为严格前缀，追加相同后缀不会逆转 JSON 字典序。这里的 tie-break 范围是 canonical BFS navigation、全部可达终点和战略动作路线；它不枚举同一导航闭包内所有物理绕行路线。Phase 2 枚举耗尽后，从初始状态重放 block/shop/transition 段验证。Phase 2 达到预算时沿用协议合法的 `reason: search_budget_exhausted`、`truncated: true`、`route: null`；无法重放时 fail closed，返回 `unproven`、`route: null`。响应的 `explored_states` 始终是 Phase 1 数量，避免把两阶段计数混合。

金币、经验、钥匙和背包不直接进入终局评分，但会影响可达性和后续消费。找到路线不等于已证明全局最优：只有队列耗尽且没有 blocker 时才返回 `proof: proven`；达到 `search_budget`（默认最多 50,000）返回 `proof: unproven`、`reason: search_budget_exhausted`，不返回路线。

## 9. 去重与剪枝

`seen: HashSet<SolverState>` 是精确去重，包含所有状态字段（包括 HP、攻防、货币、钥匙、库存、位图、商店计数、flags 和归一化位置）。`StructuralKey` 则保留 floor/x/y、inventory、ConsumedBits、shop_counts、level、flags，排除八个可比较资源：`hp、attack、defense、gold、experience、yellow、blue、red`。同一 StructuralKey 下维护一个 `[f64; 8]` frontier：若已有向量在八个维度都不小于新状态，新状态被 dominance 淘汰；若新状态全维不小于旧状态，旧向量被移除；不可比较的向量并存。

这一剪枝依赖受支持规则的单调性假设：结构投影相同且资源更多不会减少未来合法动作或终局评分。库存、消费位、flags 和购买计数被放入 key，是为了不把“同一坐标但地图/事件状态不同”错误合并。外部方案若改变 key 或资源维度，必须给出可验证的不变量和反例测试。

## 10. 路线记录与 Shadow 边界

Phase 2 的临时节点保存 block/shop 动作及 navigation segment，生成 steps 后追加 terminal step；Phase 1 不保留这些数据。响应中的 route 只读描述字段可按 step 类型变化，例如包含 `step_kind`、`floor_id`、坐标和详情；block step 还带 `block_id`，shop step 还带 `shop_id`/`choice_id`。协议递归拒绝 `action`、`operation`、`guard` 等可执行字段。当前 Rust 不自动操作页面、不保存路线到磁盘；下一轮由 JS 重新采集 observation。浏览器 journal 可保存会话/恢复元数据，但不承载 Rust 搜索状态。

## 11. 性能与内存（版本区分）

`af5b511` 的正式 50k HTTP 基线结果为：请求耗时 `2.987945 s`，`explored_states=50000`，`truncated=true`，`reason=search_budget_exhausted`；`/usr/bin/time -l` 最大 RSS 为 `144,850,944 B`（约 138.14 MiB），peak memory footprint 为 `144,114,168 B`。本轮修复后使用同一 request 只发送一次 HTTP 请求：耗时 `1.857626 s`，最大 RSS `125,452,288 B`（约 119.64 MiB），peak memory footprint `124,715,488 B`；响应与基线逐字节一致，`explored_states=50000`、`Phase 2=0`、`reason=search_budget_exhausted`。证据保存在本机一次性 `/tmp` 临时目录，不是仓库运行时依赖。上述性能数据只代表一个固定 observation，不是所有存档的 SLA；Phase 2 在复杂且最终 `proven` 的真实世界上的额外开销尚未实测。

历史 profile 中出现的“frontier 约 40 MiB、route/navigation 等分项”来自更早的容器快照或 bitset 之前版本；当前没有把这些旧分项相加当作 `af5b511` 的精确结构占用。已保留的优化包括 COW 状态、动态 mutable slots、Phase 1 移除父链和 route arena、typed `StructuralKey`、lazy candidate queue、可逆联通索引和 `ConsumedBits`；Phase 2 只在当前请求内保存临时 route/navigation witness。曾经的 eager reversible-region 搜索已在 `bf33f0d` 回滚；PendingCandidate 缩窄实验未保留，不能算当前实现。

## 12. 为什么 4000 格仍会组合爆炸

格子主要描述通行拓扑；真正的搜索维度是会改变未来可行性的动作。若有 `m` 个独立的一次性资源/门/敌人，单看“已消耗子集”就有上界 `2^m`；20 个动作的二进制子集是 `1,048,576` 种。若还区分先后顺序，长度为 `k` 的序列有 `P(m,k)` 种。实际会因钥匙不足、致死战斗和重复状态而减少，但商店计数、事件 flags、战损与不同消费顺序又会拆开原本相同的子集。

例如“先吃攻 +3 再战斗”和“先战斗再吃攻”消耗同一组方块，却有不同 HP；“先用钥匙开 A 门”与“先用钥匙开 B 门”会留下不同可达区域。因此 24×169 的静态格数不是主要复杂度；50k 是当前搜索预算，而不是整个理论状态空间大小。

## 13. 已知缺口与风险

- 50k 预算可能在仍有候选时停止，结果必须显示 `unproven`，不能当作无解或全局最优。
- queue、state arena、exact seen 和 dominance frontier 会随动作组合增长；Phase 2 的 route/navigation witness 只在当前请求内临时存在，当前没有最终每类结构的稳定内存配额。
- solver model 只覆盖已审计规则子集；真实页面的动态事件、怪物 special、楼梯映射和终局投影仍需以 observation 覆盖率验证。
- Shadow 输出是路线证明/建议，不是执行授权；`main.js` 的 `shadowOnly: true` 会在任何 adapter/executor 调用前拒绝 `execute` 响应。
- 现有测试覆盖固定 fixture、协议和 Rust 单元行为；它们不证明任意真实存档都存在完整终局路线。

## 14. 给外部 AI 的评审问题

请在“不降低正确性、不引入局部贪心死档、保持全局跨层、且不采用固定 8 步窗口”的前提下评估：

1. 是否能证明更小的状态抽象/等价类，尤其是 inventory、flags、ConsumedBits 和代表位置的最小充分集合？
2. 当前八维资源 dominance 能否用安全的 DP、可证明上下界或 branch-and-bound 加强？请给反例和单调性证明。
3. AND/OR 图、资源关键点图、分层规划或关键门先验，如何在全局搜索外层保持完备性？
4. 双向/逆向搜索、symbolic/BDD、ILP/SAT 是否适合含事件副作用和商店计数的模型？边界条件是什么？
5. 对 24 层×13×13 的典型输入，请估算最坏状态数、峰值内存、单次决策时间，并说明迁移步骤。
6. 每个建议必须列出可验证不变量：终局可达性不丢失、未知规则仍 fail closed、route witness 可重放、结果确定性和预算耗尽语义不变。

不可擅自改变的约束：全塔全局规划；终局目标顺序（攻防总和、均衡度、HP、路线 tie-break）；未知脚本不猜测；不能用局部贪心或固定窗口替代证明；在用户授权前保持 Shadow-only。

## 15. 术语与代码索引

| 术语 | 代码入口 |
| --- | --- |
| observation/动态地图 | [`src/observer.js`](../src/observer.js)：`decodeDetachedDynamicMap`、`collectEngineModel`、`buildSolverModel` |
| 浏览器请求与 Shadow-only | [`src/controller.js`](../src/controller.js)：`cycleBody`；[`src/main.js`](../src/main.js)：`shadowOnly: true` |
| HTTP/响应 | [`rust/shadow-runtime/src/main.rs`](../rust/shadow-runtime/src/main.rs)：`read_request`、`handle_connection`、`shadow_response` |
| 状态/位图/去重 | 同上：`ConsumedBits`、`SolverState`、`StructuralKey`、`global_analysis` |
| 联通与 route witness | 同上：`ConnectivityIndex::view`、`ReachBoundary`、`ReachTerminal`、`Phase2Node`、`Phase2Route` |
| 动作模拟 | 同上：`materialize_pending_action`、`apply_audited_event`、`enemy_loss` |
| 协议约束 | [`protocol/cycle-response.schema.json`](../protocol/cycle-response.schema.json)、[`src/protocol.js`](../src/protocol.js) |
