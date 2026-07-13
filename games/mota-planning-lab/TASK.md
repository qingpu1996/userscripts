# 魔塔规划实验室运行态代理：实施规划

> 文档状态：v0.1.0 第三轮验收唯一 P2 文档问题已修复
>
> 更新日期：2026-07-14
>
> 当前阶段：等待第三轮文档修复后的全新第四轮只读复验；真实页面核对与分级行动尚未授权、未执行
>
> 目标页面：`https://h5mota.com/games/24/`

## 1. 项目终止目标

交付一套“浏览器运行态代理 + localhost 决策服务”，在严格盲玩边界内完成以下闭环：

1. 油猴脚本只读取当前已经进入楼层的动态运行态。
2. 脚本将当前 11×11 地图、角色面板和可见怪物信息序列化为最小观察。
3. 本地服务只依据历史上真实观察过的状态建立模型并返回原子行动。
4. 脚本在执行前重新核对 guard，通过游戏正常公开接口执行行动。
5. 每个状态变化边界后重新读取真实状态，等待稳定，校验预期差分并回报。
6. 仅在新对象、新机制、新楼层、未知交互、服务不可用或预测不符时暂停。
7. 刷新、超时、丢包和服务重启时不盲目重放同一个行动。
8. 最终生成可直接安装的 `dist/mota-planning-lab.user.js`，但不自动安装、不自动发布、不自动覆盖存档。

项目完成不等于“脚本能够点击几步”，而是盲玩数据边界、行动原子性、恢复幂等、差分校验、暂停取证、决策日志和自动化测试全部通过。

## 2. 本轮开发明确不做

- 不访问目标游戏页面。
- 不读取任何当前或历史游戏运行态。
- 不检索《魔塔24层》的攻略、路线、录像、地图或工程文件。
- 不自动安装油猴脚本，不注入真实页面，不调用真实游戏 API。
- 不读档、不存档、不执行任何移动或交互。
- 不 stage、commit、push、创建 PR、rebase、squash 或 merge。

本轮只在隔离 worktree 中使用 fake core、synthetic fixtures 和临时 localhost 服务完成实现与离线 QA。

## 3. 不可放宽的盲玩边界

### 3.1 浏览器侧读取白名单

运行代码只能通过一个集中式 `engine-adapter` 访问以下现场数据：

- `core.status.floorId`
- `core.status.hero` 中当前面板、位置和钥匙字段的显式白名单
- `core.status.maps[currentFloorId]`
- `core.getMapBlocksObj(currentFloorId, true)`
- 当前层、当前仍可见怪物坐标对应的 `core.getEnemyInfo(...)`
- 当前层、当前仍可见怪物坐标对应的 `core.getDamage(...)`
- 为判断执行稳定性所需的最小布尔状态：`core.isMoving()`、`core.status.lockControl` 和“当前事件是否结束”的窄化状态；事件内容不得序列化或发送

任何模块不得持有或序列化完整 `core`、`core.status`、`maps` 或游戏工程对象。`currentFloorId` 必须先从现场读取，再作为唯一允许访问的地图键。

### 3.2 永久禁止的数据源

- `core.floors`
- `core.status.maps` 中除 `currentFloorId` 外的任何键
- `floors.min.js`、项目地图源码、完整初始地图或游戏工程
- `material` 全量对象
- 存档中尚未进入楼层的地图数据
- 截图、Canvas 图像、OCR 或图像识别主输入
- 《魔塔24层》的攻略、标准路线、录像、地图或任何针对性资料

### 3.3 数据最小化

- 网络请求只允许发往 `http://127.0.0.1:18724/cycle`。
- 请求体只允许包含协议包络、当前楼层观察、上一行动完成标识和恢复元数据。
- 不允许通用对象展开、递归序列化或 `JSON.stringify(core.status)` 一类写法。
- 当前层离开后，本地服务可以保留此前合法收到的观察；浏览器脚本不得为了建模回读非当前楼层。
- 日志不得包含完整游戏对象、未访问楼层、Cookie、登录信息或存档原文。

### 3.4 行动完整性

- 禁止直接写入 hero 数值、地图块、怪物、事件或 `core.status`。
- 只通过运行时检测到且签名兼容的公开接口行动。
- 所有互动必须让游戏自身完成录像、事件、触发器和存档状态更新。
- 发现接口不兼容时暂停，不使用私有字段写入作为兜底。

## 4. 当前现场与首次启动闸门

### 4.1 现场基线

首次真实运行必须直接读取并核对：

| 字段 | 预期值 |
| --- | ---: |
| 当前楼层显示 | 4F |
| 引擎坐标 | `x=8, y=3` |
| 模型坐标 | `row=4, col=9` |
| HP | 208 |
| ATK | 23 |
| DEF | 21 |
| Gold | 16 |
| EXP | 63 |
| 黄钥匙 | 4 |
| 蓝钥匙 | 1 |
| 红钥匙 | 0 |

用户给出的分支历史与面板数值自洽：

- `442 - 210 - 24 = 208 HP`
- `6 + 5 + 5 = 16 Gold`
- `54 + 5 + 4 = 63 EXP`
- `6 - 2 = 4` 把黄钥匙

该算式只用于核对用户提供的基线，不会用于推断或读取地图。

### 4.2 已知现场事实

- 4F 右侧模型坐标 `(2,11)` 的黄门已经打开。
- 模型坐标 `(1,10)` 的白色怪已经击败，用户记录战损 210、金币 `+5`、经验 `+5`。
- 模型坐标 `(2,9)` 的黄门已经打开。
- 模型坐标 `(4,9)` 的骷髅已经击败，用户记录战损 24、金币 `+5`、经验 `+4`。
- 右侧两瓶各 `+200 HP` 的血瓶可达但未拾取。
- 血瓶的准确引擎坐标和动态 block 标识尚未由脚本合法观察，不在规划中猜测。

### 4.3 存档槽 8 保护规则

- slot 8 是进入资源包前的物理回滚点：4F，HP 442，ATK 23，DEF 21，Gold 6，EXP 54，黄钥匙 6、蓝钥匙 1、红钥匙 0。
- 初始化不得调用 `core.doSL(8, "load")`。
- 任何阶段都不得调用 `core.doSL(8, "save")`。
- 默认不启用任何物理存档分支；搜索先使用本地纯数据状态分支。
- 将来如需物理存档，只能使用用户另行明确授权的槽位白名单，并在 UI 中二次确认；slot 8 永久列入保护黑名单。

### 4.4 首次运行顺序

1. 脚本注入后保持 `STOPPED`，不自动行动。
2. 只读取一次当前现场并生成观察。
3. 核对上述基线；任何字段不符都以 `pause_kind=GUARD_MISMATCH`、`detail_code=INITIAL_BASELINE_MISMATCH` 暂停。
4. 基线一致时只显示“现场核对通过”，仍等待用户选择“启动自动驾驶”。
5. 启动后如果当前楼层、block 或机制尚未建模，生成一次可打标暂停包。
6. 完成人工打标并重新连接后，才允许进入常规自动循环。

## 5. 总体架构

```text
H5 魔塔当前页面
    │
    │ 仅当前 floorId / hero / current map / visible blocks & enemies
    ▼
Tampermonkey 运行态代理
    ├─ engine-adapter：唯一 core 读取与行动边界
    ├─ observer：白名单观察序列化
    ├─ guard / fingerprint / delta：执行前后校验
    ├─ executor / stability：单边界执行与稳定等待
    ├─ journal / recovery：持久幂等与丢包恢复
    ├─ localhost-client：仅发送最小协议体
    └─ panel / menus：控制、暂停、导出与取证
    │
    │ POST 127.0.0.1:18724/cycle
    ▼
Python 本地决策服务
    ├─ protocol：请求/响应强校验
    ├─ observation store：仅保留合法历史观察
    ├─ knowledge registry：楼层、block、trigger、机制标签
    ├─ state model：当前真实状态与历史已观察图
    ├─ planner：路线、资源价值、战损和已知楼层返回
    ├─ action ledger：action_id 幂等与恢复
    ├─ diff validator：预期差分
    ├─ pause/label workflow：人工打标入口
    └─ structured logs：决策、执行与 QA 证据
```

### 5.1 技术选型

- 浏览器侧：原生 JavaScript，按仓库现有 userscript 构建方式合并为单文件。
- 通信：优先 `GM_xmlhttpRequest`，通过 `@connect 127.0.0.1` 避免 HTTPS 页面到 HTTP localhost 的混合内容和 CORS 问题。
- 油猴权限最小集计划为 `unsafeWindow`、`GM_getValue`、`GM_setValue`、`GM_registerMenuCommand`、`GM_xmlhttpRequest` 和 `@connect 127.0.0.1`；实现时逐项验证，不授予无关权限。
- metadata 只匹配 `https://h5mota.com/games/24/*`，使用 `document-idle`；本地项目不配置 `rawBaseUrl`、`updateURL` 或 `downloadURL`，避免任何自动更新或发布路径。
- 服务侧：Python 3.11+、FastAPI、Pydantic、Uvicorn。
- 持久化：协议化 JSONL 日志 + SQLite 行动账本；知识标签使用可审计 JSON/YAML 文件。
- JavaScript 测试：Node 内置 `node:test`，尽量不引入前端测试框架。
- Python 测试：`pytest`。
- 哈希：对规范化观察执行 SHA-256；规范化时排序对象键和 blocks 坐标。

服务只绑定 `127.0.0.1`，不监听局域网地址。

## 6. 计划目录

```text
games/mota-planning-lab/
  README.md
  READMD.md
  TASK.md
  userscript.config.json
  src/
    constants.js
    engine-adapter.js
    observer.js
    block-registry.js
    protocol.js
    fingerprint.js
    guard.js
    delta.js
    stability.js
    executor.js
    journal.js
    recovery.js
    localhost-client.js
    controller.js
    panel.js
    menus.js
    main.js
  service/
    pyproject.toml
    requirements.lock
    mota_lab/
      __init__.py
      __main__.py
      api.py
      models.py
      storage.py
      knowledge.py
      state.py
      combat.py
      valuation.py
      search.py
      planner.py
      guards.py
      deltas.py
      recovery.py
      labels.py
      logging.py
    data/
      block-labels.json
      floor-models.json
  docs/
    protocol.md
    blind-play-compliance.md
    pause-taxonomy.md
    state-machine.md
    install-and-run.md
    manual-labeling.md
    qa-runbook.md
  tests/
    js/
    python/
    integration/
    fixtures/
      current-4f-baseline.json
      current-4f-synthetic-blocks.json
      protocol-responses.json
  qa/
    README.md
    runs/
```

生成物位于仓库根目录：

```text
dist/mota-planning-lab.user.js
```

`dist/` 文件只由构建脚本生成，不直接编辑。

## 7. 浏览器侧设计

### 7.1 `engine-adapter`

这是唯一可以引用页面上下文 `core`（油猴隔离环境中通常为 `unsafeWindow.core`）的模块，职责是：

- 严格按字段读取当前 floorId、hero、当前 map 和当前 blocks。
- 只对当前层实际存在的怪物逐坐标调用敌人信息和战损接口。
- 检测 `setAutomaticRoute`、`moveDirectly`、`canMoveDirectly`、`stopAutomaticRoute`、`doSL` 的存在性与兼容签名。
- 提供 `isMoving`、`isControlLocked`、`isEventActive` 的窄接口。
- 提供只读能力探测报告；缺少必需 API 时以 `pause_kind=ENGINE_API_INCOMPATIBLE` 暂停。
- 不提供任何直接修改 hero、地图或事件状态的写接口。

为了防止旁路读取，其他模块只接收 adapter 返回的不可变普通对象。

### 7.2 观察采集

观察器输出协议 1 的最小对象：

- `floor_id` 使用引擎原始值，作为楼层身份真值。
- `floor_name` 只从当前动态 map 自身允许字段或当前可见 HUD 文本获得；不得查询楼层全集。
- `floor_number` 从当前显示名称或当前 floorId 解析，无法可靠解析时为 `null`，不能猜测。
- `dimensions` 固定核验为 11×11；不符时暂停。
- hero 只复制 HP、ATK、DEF、Gold、EXP、位置、方向和三种钥匙。
- blocks 只保留当前动态地图上仍存在且未 disable 的项。
- blocks 按 `y, x, numeric_id, id` 稳定排序。
- 怪物属性只从当前层当前可见怪物坐标读取。
- 战损为 `null`、`"???"`、非有限数或无法解释时暂停。
- `busy` 仅由移动、锁控制和活动事件布尔状态派生。
- `captured_at` 使用毫秒 Unix 时间。

禁止把 Canvas 截图、图像数据、DOM 全文或完整运行时对象放入 observation。

### 7.3 block 知识与暂停

block 注册表的键至少包含 `id + cls + trigger`，标签内容包含：

- 类别：地形、门、资源、怪物、NPC、机关、楼梯、其他。
- 是否可通行。
- 是否为状态变化边界。
- 是否允许空走廊快速通过。
- 已知资源差分或交互机制。
- 标签来源、首次观察坐标和版本。

任何未登记组合均以 `pause_kind=NEW_OBJECT_OR_MECHANISM`、`detail_code=UNKNOWN_BLOCK` 暂停，并保存当前层完整观察和以下定位信息：

```json
{
  "x": 0,
  "y": 0,
  "id": "...",
  "cls": "...",
  "trigger": "...",
  "numeric_id": 0,
  "damage": null
}
```

已经登记的普通门、资源、零伤怪和跨层返回不得再次要求人工确认。

### 7.4 控制状态机

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

自动驾驶默认关闭。暂停时必须先调用 `stopAutomaticRoute()`（若兼容可用），再固化证据和更新面板。

## 8. 协议设计

### 8.1 请求

固定端点：

```http
POST http://127.0.0.1:18724/cycle
Content-Type: application/json
X-Mota-Lab: 1
```

协议包络保留用户要求的字段，并计划增加可选的恢复元数据：

```json
{
  "source": "mota-planning-lab-userscript",
  "completed_action_id": null,
  "observation": {},
  "recovery": {
    "phase": "none",
    "pending_action_id": null,
    "pre_fingerprint": null,
    "current_fingerprint": "sha256:..."
  }
}
```

兼容原则：协议 1 的必需字段保持不变；新增字段只能是可选字段，服务必须拒绝未知来源、错误请求头、超大请求和不符合 schema 的 observation。

### 8.2 响应

支持状态：

- `execute`：返回唯一 action_id、原因、operations、guard 和 expected_delta。
- `pause`：返回结构化 pause_kind 和详情。
- `idle`：当前无需行动，但保持可继续轮询。
- `error`：协议或服务错误，浏览器侧进入暂停。

guard 以引擎原始 `floor_id` 为首要字段；示例中的数字 `floor` 仅作为兼容字段。楼层号不能替代 floorId 身份判断。

### 8.3 operations 的安全语义

为了兼容示例中的多个 `grid`，但仍遵守“单个状态变化边界”：

1. 一个 action_id 可以包含多个 grid 路段。
2. 除最后一段外，每段都必须被本地观察证明为纯空走廊移动，只允许位置/方向变化。
3. 最后一段最多触发一个已知边界（一个怪物、一扇门、一个资源、一个 NPC/机关或一次楼层切换）。
4. 每个路段完成后都等待稳定、重新取观察并重新核对剩余路径。
5. 纯空走廊路段后生成派生 guard：floorId、完整面板和钥匙必须仍等于原 guard，位置必须等于上一 operation 目标；通过后才检查下一段。
6. 一旦发生面板、钥匙、blocks、floorId 或事件状态变化，立即停止整个 action，回报真实观察；不得继续执行剩余路段。
7. 若预检发现非最后一段可能发生状态边界，不执行该响应，向服务返回 `UNSAFE_MULTI_BOUNDARY_RESPONSE` 协议错误并要求重新决策；首次拒绝不要求人工介入。
8. 若服务连续返回同类不安全响应，视为决策服务协议不可用，以 `pause_kind=DECISION_SERVICE_UNAVAILABLE`、`detail_code=UNSAFE_MULTI_BOUNDARY_RESPONSE` 暂停。
9. 决策器应优先每次只返回一个 grid；多路段只用于已证明安全的空走廊拼接。

这样既不逐格模拟鼠标，也不会把多个资源或战斗打包执行。

## 9. guard、执行与稳定性

### 9.1 guard

执行前重新采集现场，逐字段精确比较：

- floorId
- x、y、direction（如果响应提供 direction）
- HP、ATK、DEF、Gold、EXP
- 黄、蓝、红钥匙

任何字段不符时：

1. 停止自动寻路。
2. 不调用行动 API。
3. 记录 guard、实际值和差异。
4. 暂停为 `GUARD_MISMATCH`。

### 9.2 空走廊

只有同时满足以下条件才使用 `moveDirectly`：

- `canMoveDirectly` 存在并明确允许目标。
- 基于当前 11×11 动态观察计算出的路径只经过已登记的普通可通行地块。
- 路径上没有怪物、资源、门、NPC、机关、楼梯或未知 trigger。
- 目标不是状态变化边界。

否则使用 `setAutomaticRoute`，并把目标限制为最近的一个边界或安全停靠点。

### 9.3 状态变化边界

- 怪物、门、资源、楼梯、NPC 和机关每次只处理一个。
- 边界完成后不继续当前路线，先读完整当前现场并回报。
- 如果自动寻路可能跨越多个边界，预检直接拒绝该计划。
- 不逐格伪造键盘或鼠标点击。

### 9.4 稳定判定

行动后轮询以下条件：

- `core.isMoving() === false`
- `core.status.lockControl === false`
- 当前事件已经结束
- fingerprint 已发生预期变化
- 同一个 fingerprint 连续两次轮询一致

建议初始参数：100ms 轮询、连续 2 次稳定、10 秒软超时、30 秒硬超时。参数最终通过现场兼容测试调整；超时只暂停，不重放。

## 10. fingerprint、幂等与恢复

### 10.1 fingerprint 内容

规范化后计算 SHA-256：

- floorId
- hero 位置、方向和完整允许面板
- keys
- 当前动态 blocks（稳定排序后的允许字段）

时间戳、UI 状态和网络状态不进入 fingerprint。

### 10.2 持久行动日志

浏览器侧使用 `GM_setValue` 保存：

- `autopilotEnabled`
- `initialBaselineVerifiedFingerprint`
- `pendingAction`
- `lastCompletedAction`
- `lastAcknowledgedActionId`
- `lastPause`
- `knownProtocolVersion`

`pendingAction` 至少记录 action_id、pre-fingerprint、guard、expected_delta、operations、当前 operation index、阶段和开始时间。

### 10.3 重复 action_id

- action_id 与已完成 action_id 相同：绝不执行，只重报完成状态。
- action_id 与 pending action 相同：进入恢复判定，不直接重放。
- action_id 早于行动账本或格式非法：暂停。
- 新 action_id 只有在上一行动已经完成或明确清除后才可接受。
- 服务端 action_id 由 SQLite 持久 issuance sequence 签发，不依赖墙钟；序列值一经保留即不复用，并跳过旧账本中的碰撞。
- 同一未完成行动的 HTTP 重试或服务重启仍返回原 action_id；旧行动 completed 后合法返回完全相同 fingerprint 时，签发全新 action_id，并原位刷新该 decision cache 行。
- 每个真实签发行动在 action ledger 保留一行；pending 重试不增加 action/decision 行，同 fingerprint 的历次 completed 往返不让 decision cache 无界增长。

### 10.4 刷新/丢包恢复三分法

1. **未执行**：当前 fingerprint 等于 pre-fingerprint。上报 `not_executed`，等待服务明确重新签发；浏览器不自行重放。
2. **已执行**：当前状态满足 expected_delta/目标结果并稳定。将行动标记完成，携带 completed_action_id 重报。
3. **结果不符**：既不等于 pre-state，也不能解释为预期 post-state。以 `pause_kind=EXPECTED_DELTA_MISMATCH`、`detail_code=RECOVERY_STATE_AMBIGUOUS` 暂停。

服务端用 action ledger 对重复请求返回同一决定或明确后继决定，不能因为 HTTP 重试生成第二个不同动作。

## 11. 预期差分

`expected_delta` 支持以下显式字段：

- hp、attack、defense、gold、experience
- keys.yellow、keys.blue、keys.red
- position
- floor_id
- removed_blocks / added_blocks（坐标和标识）

规则：

- 未声明字段默认要求保持不变，但位置/方向可以由行动类型明确允许。
- 数值必须是有限整数；`null` 表示不能预测并应在执行前决定是否允许。
- 战斗、门、资源等已知边界必须给出足以验证的差分。
- 实际与预期不符时暂停 `EXPECTED_DELTA_MISMATCH`，不得请求下一行动。
- 首次遇到的机制不得使用宽松容差掩盖差异。

## 12. 本地决策服务

### 12.1 安全入口

- 只绑定 `127.0.0.1:18724`。
- 只接收 `POST /cycle`，并核对 `X-Mota-Lab: 1`。
- 限制请求体大小和频率。
- schema 白名单拒绝多余根字段和完整游戏对象形态。
- 日志记录观察摘要、fingerprint、决策原因和差分，不记录浏览器隐私数据。

### 12.2 状态模型

- 只从合法观察构建当前层和历史已访问楼层的图。
- 离开楼层后使用服务自己保存的旧观察，不要求浏览器回读旧 map。
- 每层以引擎 floorId 标识，以坐标和 block 版本维护动态图。
- 发现新楼层时暂停一次，建立模型和标签后继续。
- 对已建模楼层的跨层返回自动规划，不要求人工拍板。

### 12.3 决策逻辑

按以下顺序构建：

1. 过滤不合法/未知状态。
2. 识别当前可达区域与最近边界。
3. 使用游戏实际 `getDamage` 结果作为当前怪物战损真值。
4. 以当前资源、钥匙和已知地图建立候选行动。
5. 对候选行动做资源差分和生存约束。
6. 在已观察图上做有限深度搜索和支配剪枝。
7. 自动处理普通路线比较、零伤怪、已知门、已知资源包和已知楼层返回。
8. 返回一个原子行动、精确 guard、expected_delta 和中文决策原因。

不得把地图攻略、隐藏楼层或未观察 block 编码进启发式。

### 12.4 存档分支

- 默认使用内存/SQLite 中的纯状态分支进行搜索，不触碰游戏物理存档。
- `doSL` 能力单独实现、默认禁用。
- 任何真实 save/load 都要求用户预先配置允许槽位，并在 UI 中明确确认。
- slot 8 永久禁止保存；初始化与自动循环不读取 slot 8。
- `save` 只能写入用户明确预留的白名单槽位，并在行动账本记录槽位、pre-fingerprint 和完成结果。
- `load` 只能读取由本实验室账本确认创建的白名单分支，加载后立即停止路线、重读完整当前现场并执行恢复校验。
- 刷新或丢包后不得凭 action_id 猜测一次 save/load 是否完成；无法由账本和现场共同证明时暂停。

### 12.5 人工打标

暂停包写入本地 `qa/runs/<timestamp>/pause.json`，包含：

- pause_kind
- 当前观察和 fingerprint
- 未知 block 的坐标、id、cls、trigger、numeric_id、damage
- 最近行动、guard、expected_delta 和实际 delta
- 引擎能力探测摘要

打标通过本地 CLI 或受限本地页面完成；浏览器只通过后续 `/cycle` 获取更新结果。标签写入可审计知识文件，不能直接改游戏。

## 13. UI 与菜单

### 13.1 小型悬浮面板

面板默认停靠地图外侧或页面边缘，并支持折叠，显示：

- 自动驾驶：运行 / 暂停
- 当前 action_id
- 当前楼层和坐标
- 最近一次决策原因
- localhost：已连接 / 断开
- pause_kind 和简短原因

面板不得遮挡 11×11 地图，不显示大段调试 JSON。

### 13.2 油猴菜单

- 启动自动驾驶
- 暂停自动驾驶
- 导出当前层运行态
- 清除待执行行动
- 仅重新连接本地决策器

“清除待执行行动”需要确认，只清浏览器行动账本，不读档、不改游戏状态。

## 14. 暂停分类

顶层 `pause_kind` 只允许用户指定的八类；更细原因放进 `detail_code`，不得通过新增顶层类型扩大人工暂停范围：

| pause_kind | 触发条件 | 典型 detail_code |
| --- | --- | --- |
| `NEW_OBJECT_OR_MECHANISM` | 新 block id、cls、trigger、NPC 或机关 | `UNKNOWN_BLOCK`、`UNKNOWN_TRIGGER`、`UNKNOWN_NPC`、`UNKNOWN_MECHANISM` |
| `UNKNOWN_DAMAGE` | 战损为 null、`???`、非有限值或无法解释 | `DAMAGE_NULL`、`DAMAGE_UNEXPLAINED` |
| `UNKNOWN_FLOOR` | 进入尚未建模的新楼层 | `FLOOR_MODEL_MISSING` |
| `EXPECTED_DELTA_MISMATCH` | 资源差分不符或恢复后的状态无法解释 | `RESOURCE_DELTA_MISMATCH`、`RECOVERY_STATE_AMBIGUOUS` |
| `GUARD_MISMATCH` | 执行前现场与 guard 不一致，或首次现场基线不一致 | `PRE_ACTION_GUARD_MISMATCH`、`INITIAL_BASELINE_MISMATCH` |
| `UNSUPPORTED_INTERACTION` | 剧情、选择菜单、商店等尚未实现的交互状态 | `STORY_EVENT`、`CHOICE_MENU`、`SHOP` |
| `DECISION_SERVICE_UNAVAILABLE` | localhost 不可达、协议非法或持续返回不安全行动 | `CONNECTION_FAILED`、`INVALID_RESPONSE`、`UNSAFE_MULTI_BOUNDARY_RESPONSE` |
| `ENGINE_API_INCOMPATIBLE` | 必需公开 API 缺失、签名不兼容或无法可靠判断稳定 | `MISSING_API`、`SIGNATURE_MISMATCH`、`STABILITY_TIMEOUT` |

稳定等待超时必须先归因：明确卡在剧情/菜单时归入 `UNSUPPORTED_INTERACTION`；状态已异常变化时归入 `EXPECTED_DELTA_MISMATCH`；引擎 API 无法可靠报告移动/事件结束时才归入 `ENGINE_API_INCOMPATIBLE`。

普通路径比较、零伤怪、已知门、已知资源和已知楼层返回不在暂停白名单内，必须由决策器自行处理。

所有暂停统一执行：停止自动寻路、固化当前层观察、更新 UI、输出结构化控制台日志、保留人工打标字段。

## 15. 测试与合规验证

### 15.1 静态禁区测试

扫描实际运行代码而非文档，失败条件包括：

- 出现 `core.floors` 读取。
- 动态索引 `core.status.maps` 时无法证明键为刚读取的 currentFloorId。
- 引用 `floors.min.js`、游戏项目地图文件或全量 `material`。
- 调用 screenshot、Canvas 导出、OCR 库或图像上传。
- 直接赋值 hero、map block、enemy、event 或 `core.status`。
- 将完整 `core`、`status`、`maps`、`floors`、`material` 传入序列化或网络函数。

除文本扫描外，使用带毒数据的 Proxy fake-core：任何非白名单属性读取立即抛错并记录调用栈。

### 15.2 观察测试

- 准确采集 HP、攻防、金币、经验、钥匙、floorId、坐标和方向。
- 只序列化当前 11×11 地图仍存在且未 disable 的 blocks。
- 只对当前可见怪物坐标调用敌人接口。
- block 排序稳定，fingerprint 对等价对象一致。
- 在未访问 floors、material 和其他 maps 中放置毒值，确认请求体绝不泄漏。
- floor_name/floor_number 无法合法得到时不猜测。

### 15.3 执行测试

- guard 任一字段不符时所有行动 API 调用数为 0。
- 纯空走廊且 `canMoveDirectly` 允许时使用 `moveDirectly`。
- 路径含怪物、门、资源、NPC、机关、楼梯或未知 block 时不用快速移动。
- 边界通过 `setAutomaticRoute` 处理，并在第一个状态变化后停止。
- 多边界计划被拒绝。
- 不逐格模拟点击。

### 15.4 幂等与恢复测试

- 相同 action_id 在同一页面、刷新后、服务重启后都只执行一次。
- 请求在服务处理后丢失响应，重试不产生新行动。
- pre-fingerprint 未变化时归类为未执行且不自行重放。
- expected post-state 成立时归类为已执行并补报。
- 无法解释的中间状态暂停。
- 清除 pending action 不改变游戏现场。
- 楼梯往返同一 fingerprint 覆盖 `A pending -> A`、`A completed -> B`、重启后 `B pending -> B`、`B completed -> C`，并核对浏览器可执行 B。
- 持久 issuance sequence 覆盖旧 action_id 碰撞跳过、已保留 gap 不复用和服务重启。

### 15.5 差分与稳定测试

- fingerprint 变化后必须连续两次一致才算稳定。
- moving、lockControl 或 event 任一仍活动时不结算。
- HP、资源、钥匙、block 或楼层差分不符时暂停。
- 已知 `+200 HP` 资源 fixture 正确验证单个资源边界。
- 战损未知、负数异常或非有限值时暂停。

### 15.6 当前层模拟数据

fixture 分两类：

1. `current-4f-baseline.json`：只包含用户已明确提供的 floor/hero/keys 基线和历史一致性数据。
2. `current-4f-synthetic-blocks.json`：使用明确标记为 synthetic 的 11×11 blocks，覆盖墙、空路、门、怪物、资源、楼梯、disable block 和未知 block；不得伪装成真实 4F 地图。

首次合法只读采集后，可另存一份脱敏的真实当前层 fixture，但必须确认只含当前层白名单字段。

### 15.7 集成与人工 QA

- fake-core 端到端跑通 observe → cycle → guard → execute → settle → report。
- 本地服务断开、超时、500、非法 JSON、重复响应均安全暂停。
- 在真实页面首次只做基线读取和导出，确认无行动调用。
- 用户明确允许后才进行空走廊、单资源、单门、单怪和楼层切换的分级现场测试。
- 每次 QA 保存命令、结果、观察摘要和屏幕外结构化日志；不使用截图作为规划输入。

## 16. 实施任务清单

状态说明：`[ ]` 待开始或仍需授权，`[x]` 已有文件与命令证据。

### M0：规划冻结与开发隔离

- [x] **T00 用户确认规划**：确认目录、协议安全语义、技术选型和 slot 8 保护规则。
- [x] **T01 建立开发分支/worktree**：从最新稳定 `main` 创建 `feature/mota-planning-lab/v0.1.0` 和隔离 worktree；先记录基线状态。
- [x] **T02 派发一次性开发 SubAgent**：prompt 完整包含背景、终止目标、范围、允许文件、禁止事项、验收标准、验证要求和回告格式；开发 Agent 不得 stage/commit/push。

出口条件：用户明确说可以开始开发；分支/worktree 边界确认；开发 Agent 已收到完整任务。

### M1：协议、脚手架与安全测试先行

- [x] **T10 创建项目骨架和构建配置**。
- [x] **T11 固化 protocol 1 JSON schema 与错误码**。
- [x] **T12 建立 fake-core、毒值 Proxy 和静态禁区扫描**。
- [x] **T13 建立用户基线 fixture 与 synthetic blocks fixture**。
- [x] **T14 编写盲玩合规文档和数据流清单**。

出口条件：在没有真实游戏页面的情况下，违规读取和违规网络字段会让测试失败。

### M2：运行态采集

- [x] **T20 实现 engine-adapter 白名单读取**。
- [x] **T21 实现当前 11×11 动态 blocks 过滤与排序**。
- [x] **T22 实现当前可见怪物信息/战损读取和异常暂停**。
- [x] **T23 实现观察 schema、busy 派生和导出**。
- [x] **T24 实现当前现场首次基线闸门**。

出口条件：观察测试全部通过；没有行动能力也能安全导出现场；基线不符时零行动。

### M3：guard、原子执行与稳定等待

- [x] **T30 实现公开 API 能力探测**。
- [x] **T31 实现精确 guard 比对**。
- [x] **T32 实现空走廊判定和 `moveDirectly`**。
- [x] **T33 实现单边界 `setAutomaticRoute` 执行**。
- [x] **T34 实现多路段安全语义与多边界拒绝**。
- [x] **T35 实现停止、稳定两轮和超时暂停**。
- [x] **T36 实现 expected_delta 校验**。

出口条件：所有执行测试、差分测试通过；不存在直接状态写入。

### M4：通信、幂等与恢复

- [x] **T40 实现 `GM_xmlhttpRequest` localhost 客户端**。
- [x] **T41 实现 action_id 持久账本与去重**。
- [x] **T42 实现 pre/post fingerprint 和 canonical hash**。
- [x] **T43 实现刷新/丢包恢复三分法**。
- [x] **T44 实现控制状态机和统一暂停证据**。

出口条件：相同 action_id 在所有故障注入场景中最多执行一次。

### M5：UI 与人工打标接口

- [x] **T50 实现小型可折叠面板**。
- [x] **T51 实现五个油猴菜单命令**。
- [x] **T52 实现 pause_kind、控制台结构化详情和当前层导出**。
- [x] **T53 实现未知 block/机制打标包**。

出口条件：面板不遮挡地图；暂停证据完整；UI 操作不修改游戏状态。

### M6：Python 决策服务

- [x] **T60 实现 localhost API、schema 与安全限制**。
- [x] **T61 实现观察存储、SQLite action ledger 和 JSONL 日志**。
- [x] **T62 实现 floor/block 知识注册与标签更新**。
- [x] **T63 实现已观察地图状态图和可达性**。
- [x] **T64 实现战损、资源价值和状态转移模型**。
- [x] **T65 实现有限深度搜索、支配剪枝和原子行动生成**。
- [x] **T66 实现普通路线/零伤怪/已知门/资源/跨层返回自动决策**。
- [x] **T67 实现 expected_delta、guard、reason 与服务端幂等**。
- [x] **T68 实现本地人工打标 CLI/页面**。

出口条件：服务仅用 fixtures 和合法历史观察即可稳定决策；新知识暂停，已知普通情况自动处理。

### M7：集成、打包与文档

- [x] **T70 端到端故障注入测试**。
- [x] **T71 生成并语法检查 `.user.js`**。
- [x] **T72 完成协议、安装启动、标签、QA 和合规文档**。
- [ ] **T73 首次真实页面只读基线核对**：不得行动、不得读档。
- [ ] **T74 用户授权后的分级现场验证**。
- [x] **T75 整理 QA 证据和未覆盖风险**。

出口条件：九类交付物齐全，所有自动化检查通过，现场测试范围得到用户授权。

### M8：独立验收与版本控制收尾

- [x] **T80 开发 SubAgent 完整回告并结束**：包含变更摘要、修改文件、命令与结果、风险、问题、分支、worktree、HEAD 和 dirty 状态。
- [x] **T81 创建全新只读验收 SubAgent**：首次验收按仓库 `AGENTS.md` 要求完成，结论为 2 个 P1、1 个 P2，当时不可交付。
- [ ] **T82 若发现问题，创建全新修复 SubAgent，再创建全新只读验收 SubAgent**：第二次修复后的第三轮只读验收无 P0/P1，仅发现 state dir 持久化与恢复文档 P2；第三个一次性修复 SubAgent 已补齐文档与 QA 证据，尚待主会话确认其结束后创建全新第四轮只读验收 SubAgent 复核。
- [ ] **T83 验收通过后由主会话统一 stage/commit**。
- [ ] **T84 push 前获取用户明确确认**。
- [ ] **T85 仅在需要远程留痕、协作或 CI 时创建/更新 PR**。

出口条件：独立验收明确“可以交付”；相关 SubAgent 已结束；未经用户确认不 push。

## 17. 验收矩阵

| 用户验收条件 | 设计控制 | 主要证据 |
| --- | --- | --- |
| 不调用 screenshot/OCR | 无图像依赖 + 静态禁区扫描 | 静态测试、依赖清单 |
| 准确读取角色和位置 | engine-adapter 白名单 | fake-core + 首次只读核对 |
| 导出 11×11 blocks | observer 过滤/排序 | fixture 与 schema 测试 |
| 空走廊快速移动 | 双重路径证明 + `canMoveDirectly` | 执行单测 |
| 边界单独处理 | 原子 envelope + 状态变化即停 | 集成测试 |
| action_id 不重复 | 浏览器 journal + 服务 ledger | 刷新/丢包故障注入 |
| 差分不符不继续 | expected_delta 闸门 | mismatch 测试与暂停包 |
| 不读取禁止数据 | 集中 adapter + Proxy 毒值 + 静态扫描 | 合规测试报告 |
| 现场核对后才执行 | 首次 baseline gate | 零行动调用测试 |
| 不自动安装/覆盖/发布 | 构建与发布手动门禁，slot 8 保护 | 文档、API 调用审计、git 状态 |

## 18. 交付清单

- [x] `dist/mota-planning-lab.user.js`
- [x] 运行态采集模块
- [x] 动作执行模块
- [x] localhost 通信模块
- [x] 幂等与恢复模块
- [x] 小型悬浮控制面板与油猴菜单
- [x] Python 决策服务
- [x] 协议文档
- [x] 盲玩合规文档
- [x] 当前层基线和 synthetic 模拟数据
- [x] JavaScript、Python、集成与静态合规测试
- [x] 安装、启动、打标和 QA 说明
- [ ] 独立只读验收结论

## 19. 主要风险与预案

| 风险 | 预案 |
| --- | --- |
| H5 引擎 API 签名与预期不同 | 只做能力探测；不兼容即暂停，不使用状态写入兜底 |
| `moveDirectly` 语义跨事件 | 必须同时通过当前地图路径证明与 `canMoveDirectly`；真实页面先按 T74 分级验证空走廊 |
| 自动寻路经过多个事件 | 路径预检、最近边界目标、首次状态变化即 stop |
| 页面刷新发生在行动中 | pending journal + pre/post/recovery 三分法 |
| 服务处理成功但响应丢失 | completed_action_id 重报 + 服务 action ledger |
| `MOTA_LAB_STATE_DIR` 被当作 cache 删除、清空或切错 | 将其视为 action_id 持久身份根；pending 时禁止迁移/清 journal；停机整目录迁移并保留备份，先只读核对 ledger |
| floor_name 无法从白名单获得 | 允许为 null；身份只依赖 floorId |
| 新楼层包含剧情或商店 | `UNKNOWN_FLOOR` / `UNSUPPORTED_INTERACTION` 暂停打标 |
| 用户存档被覆盖 | 默认禁用 doSL；slot 8 永久保护；真实槽位需用户白名单和确认 |
| 测试 fixture 被误认为真实地图 | 文件名、字段和文档明确标记 synthetic；不补猜未知坐标 |
| 本地服务被局域网访问 | 只绑定 127.0.0.1，校验头，限制体积与 schema |

## 20. 当前交付门

- 离线实现、构建、前两轮验收问题修复与 112 项自动化 QA 已完成；第三轮仅发现 state dir 文档 P2，本轮已补齐持久化、备份、迁移、故障恢复与 pending 门禁说明。
- 第三轮只读验收已完成且当时不可交付；本轮文档修复仍需一个全新第四轮只读验收 SubAgent 复核。
- 下一步必须由主会话在本修复 SubAgent 结束后创建全新第四轮只读验收 SubAgent；修复 Agent 不得自验代替。
- 验收通过后才允许主会话 stage/commit；push 前仍需用户明确确认。
- T73/T74 保持未完成，不能用 fake core 结果冒充真实页面 QA。
- 未经用户另行授权，不安装脚本、不访问真实页面、不读写存档或执行真实行动。
