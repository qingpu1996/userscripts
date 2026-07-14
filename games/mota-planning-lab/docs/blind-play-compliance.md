# 严格盲玩合规

## 读取边界

浏览器唯一运行态入口是 `src/engine-adapter.js`。每轮先读取当前 floorId，之后只读取 hero 白名单、`status.maps[currentFloorId]`、`getMapBlocksObj(currentFloorId,true)` 和当前可见怪物坐标的 enemy info/damage。dimensions 与 valid cells 只从这一个当前动态 map 获得。

怪物属性不建立本地数据库。`atk/attack`、`def/defense`、`money/gold`、`exp/experience` 只在本次同步采集内严格归一；own property 显式非法不能伪装成缺席，别名冲突、非法值和无法解释的 damage 均 fail closed。只有 `getDamage()` 原始返回严格 null/`???` 且可由当前 hero 攻击不穿透当前 enemy 防御解释时，才仅形成不可穿越边界；`undefined` 等非协议值保留 raw evidence 后在采集边界暂停，不发送给服务，不触发攻略查询、历史 stats 回填或人工“模型补全”。历史 observation 中为审计保留的 enemy 字段不参与任何 simulated node 的战斗数值；只有 untouched live root 的直接战斗可作为终端候选，同图状态变化或 A→B→A 后也必须等 fresh observation。

同一次采集在读取 map/blocks/怪物前后核对当前 floor、hero/keys/位置和最小 busy 围栏；不一致则整份丢弃，不会混合两个时刻。钥匙必须来自已登记布局：canonical `hero.items.tools` 容器存在时，只有被引擎省略的零计数字段按 `0` 归一；其他容器残缺、显式非法值、别名冲突或多布局冲突不会用零兜底。

禁止读取 floor catalogue、非 current map、完整 maps、全量素材、工程地图源码、存档原文、攻略或路线资料。出口后的布局保持 opaque，只有英雄正常转移进入后才采集。

不使用图像输入、像素提取或识别；网络只向固定 localhost 发送当前 observation。adapter 逐字段复制，不传 core/status/map 原对象。

## 写入边界

不直接赋值 hero、map、block、enemy 或 event。只 capability-probe 并调用 `moveDirectly`、`setAutomaticRoute`、`stopAutomaticRoute`。物理 save/load 默认禁用且没有内置槽位，不调用 `doSL`。

接管扫描只允许安全空走廊和一个已登记楼梯/传送边界；扫描未 complete 前硬排除怪物、门、资源、NPC 和机关。opaque 出口执行后必须重新观察，不能在旧地图上继续推演。每次最多一个状态边界；行动后完整重读、稳定两轮并核对真实差分。

## 世界模型来源

SQLite 的 map instances、snapshots、frontiers、scan state/audit 和 transitions 全部来自历史上合法收到的 observation。transition 只从实际 completed change-map 的 pre/post 建立，不预测未走过出口目标。显示楼层数字不作为身份；同 floorId 的不同 map instance 独立建模。可逆性要求精确端点反向观察。

当前 hero/resources/keys/current blocks 的唯一权威是本轮请求 observation。完整历史 snapshot 仅为 action recovery 和审计证据；传给 planner 前投影成不含 hero/keys/busy 的 `HistoricalMapFact`。跨图搜索只把本轮 live resource vector 带入历史 topology/blocks，不能用旧面板补足当前资源。可达性、路线与排名每轮重算，不是持久当前状态。

浏览器 v1 journal 必须先专用归档并显式处置，普通控制不能绕过。构建 marker 明确区分 userscript/direct；userscript 缺 GM API 不会读取 direct namespace。A/B generation envelope 无单点 pointer，物理写永远落到非当前最高槽；旧完整槽在 candidate 截断/变形/no-op/throw 时仍可恢复，完整 candidate 则携带 pending 或 completed/ack 证据成为新最高。旧单 key 只读 witness 的任何改写都会重新 quarantine。pending 未验证持久前行动 API 调用数必须为零。

服务在接受前不以任何 SQLite URI/连接模式打开导入 path。main/WAL/SHM 经过成对检查、WAL framing、SHM size、双读 identity/stat/hash 与分类后复核，只复制到私有 candidate generation 进行 schema/行为 probe；通过后以原子 manifest 发布，并且只连接该已分类 generation。导入 witness 和 generation 在发布、connect 后都再次核对；拒绝时被换入的 legacy/future/unknown main 与 sidecar 不被 DDL/WAL 改写。

行动恢复同样 fail closed：服务按 session 而非当前 fingerprint 查唯一 unresolved action，同 pre 只重发原 ID；completed 通过独立显式 ack 结算后，下一轮才签下一 ID。`intent=reconnect_only` 是 no-issue 路径，不进入 planner 或 issuance；错误 execute 在浏览器被持久隔离并零执行。

## Direct mount

direct mount 构建物与 userscript 使用相同采集和执行模块。它只使用项目 namespace 内的旧 witness、v1 quarantine 与两个 A/B slot，不枚举其他 localStorage；CORS 默认关闭，显式模式也只允许精确目标 origin 和必要 headers/method。没有外网 URL或自动更新入口。

## 自动化证明

- Proxy fake core 对未知 status/map/runtime 读取和所有写入投毒。
- 静态扫描覆盖 src、service、userscript 和 direct-mount 构建物。
- 固定 vendored Acorn 8.16.0 AST 扫描先校验 parser、MIT LICENSE 与 provenance hash，再按词法 scope/binding identity 做传播。只有未 shadow 的真实 global root，或可静态解析的 IIFE/简单本地函数调用实参，才传播为 runtime；函数参数不会因名称恰好是 `core/runtime` 而升级。规则覆盖 Parenthesized/Sequence/Chain/Member、声明与赋值 destructure/default/rest/computed pattern、assignment/update/delete、常量 `+`/template、global root，以及 Object/Reflect `call/apply/bind`；真实 global runtime 被禁止，局部参数/变量 shadow、Object-like 与 detached copy 正例必须通过。
- 11×11、13×13、7×19 和异形空洞走同一通用代码。
- v1 journal/协议、legacy/future SQLite、dimensions/grid 冲突、未知 topology、未知伤害、guard/delta mismatch 全部 fail closed。
- localhost + fake core 集成只使用 synthetic fixtures。
- canonical `hero.items.tools` 全量与零字段省略形状 fixture、显式非法值、key layout 冲突、torn snapshot、历史资源污染和重访 revision 均有 fail-closed 回归；门后黄钥匙字段删除的 pending/reload 测试证明 completed/ack 且引擎 API 调用数为零。

本轮没有访问真实游戏、存档或外网，也没有执行真实行动；离线 QA 不能替代后续用户授权的现场验证。
