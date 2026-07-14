# 魔塔规划实验室运行态代理：实施规划

> v2 状态（2026-07-14）：真实 AUTO3/4/5 序列暴露 verified stair 被错误赋予进展奖励，导致 MT0↔MT1 往返压过 MT1 可直接执行的 redDoor。本轮把 opaque 出口发现与 verified transition 运输彻底分开：verified 边为零收益中间边，只有通往远端实际 supported frontier 时才可成为第一原子行动，循环 successor 在候选/奖励前支配剪枝。完成后仍须由主会话派发全新只读验收。下方 v0.1 章节仅作历史原型记录。

## Protocol v2 重构任务

- [x] **V200 测试先行**：新增动态尺寸、异形拓扑、session、world graph、CORS、direct mount 红灯并保留回归。
- [x] **V210 动态 observation**：dimensions 取当前动态 map；支持 rectangle/valid_cells；英雄、block、operation 和 guard 跨字段校验。
- [x] **V211 引擎字段归一化**：支持 hero.exp/experience，缺失 keys 容器归零，不修改 runtime。
- [x] **V212 实例身份**：fingerprint 纳入 session/map/dimensions/topology/blocks；显示楼层仅为元数据。
- [x] **V220 会话基线**：new game、handoff expected guard、resume ledger；首次 observation 只展示，用户与服务双重显式确认。
- [x] **V221 迁移门禁**：v1 protocol/journal fail closed；SQLite schema v2；state dir 仍是持久身份根。
- [x] **V230 世界图**：持久 map instances、snapshots、frontiers、transitions；同层多图和同 floorId revision 共存。
- [x] **V231 物理遍历扫描**：只从当前 observation 和真实 change-map 扩展；未知出口 opaque；扫描不越过资源边界。
- [x] **V232 事务一致性**：observation/session/world 同事务；action completion 与 transition 同事务；重复行动不重复建边。
- [x] **V240 世界规划**：移除旧 depth=3 候选排列入口；按当前 topology 重算可达 frontier，接收持久跨图上下文和预算门禁。
- [x] **V250 执行安全适配**：guard 增 session/map/dimensions/topology；保留最多一次执行、稳定两轮和真实差分。
- [x] **V260 direct mount**：隔离 journal namespace、无 GM 面板控制、CORS 默认拒绝及精确 opt-in、独立确定性构建物。
- [x] **V270 离线验证**：11×11、13×13、7×19、异形空洞、多图同层、拓扑 revision、单双向边、frontier、session、CORS、direct mount。
- [x] **V280 文档与证据**：README、Protocol、world model、状态机、安装、合规、QA 和本轮 evidence。
- [ ] **V290 全新只读验收**：由主会话在开发 Agent 结束后派发，开发 Agent 不得自验替代。
- [ ] **V291 用户授权现场验证**：只读 observation、显式 baseline、分级单边界和 change-map 时序；本轮不执行。

## Protocol v2 首轮验收整改

- [x] **F201 v1 browser journal 绕过**：固定 v1 key 仍存在时，普通确认、启动、重连全部 fail closed；仅允许“完整归档 → archive id → 精确确认短语”的专用处置，并保留审计链。
- [x] **F202 legacy SQLite 静默升级**：任何写入前只读分类；非空 version 0、v1、future 与未知/不完整 v2 均保持原字节/schema 并拒绝启动。
- [x] **F203 同层多图结算**：`map_instance_id` 成为换图主断言；同 floorId A→B 与跨 floorId A→C 一致，跨图不比较无关 blocks。
- [x] **F204 接管扫描状态机**：持久 `anchor/discover/sweep/complete/paused`、pending/traversed、scan audit；扫描期硬排除资源、门、怪物、NPC、机关。
- [x] **F205 opaque 出口**：未知目标分支在出口边界终止，不假设留在原地图，不评价出口后的资源。
- [x] **F206 dimensions/grid 联合拓扑**：ragged、缺行、短行和洞转 `valid_cells`；完整矩形才 confirmed；冲突 fail closed。
- [x] **F207 精确可逆边**：只有 map pair 与两端坐标严格互换的真实反向 transition 才标记 reversible。
- [x] **F208 Protocol v2 错误文案**：schema 错误不再误称 protocol 1。
- [x] **F209 整改回归**：新增 JS/Python 覆盖迁移绕过、数据库原样拒绝、同层换图、扫描重启/幂等/单向暂停、opaque 搜索、异形 grid、精确端点可逆及 wire 严格对齐。
- [ ] **F210 全新只读复验**：必须由主会话在本修复 Agent 结束后新建未参与开发的验收 Agent 执行；本 Agent 不自验替代。

## Protocol v2 第二轮验收整改

- [x] **F211 legacy disposition 内容绑定**：处置 archive ID 与当前 legacy payload 精确绑定；后续改写重新 quarantine；已有 v2 session/pending/completed/ack/seen/scan 证据时拒绝处置且不清空。
- [x] **F212 SQLite 结构契约**：`user_version=2` 之外继续核验列序、declared type、NOT NULL/default、PK、UNIQUE、CHECK、FK、必要 index 和 action sequence；partial/伪 v2 在 WAL/DDL 前原态拒绝。
- [x] **F213 session-wide 单未决行动**：每个 session 最多一个 `issued`；reconnect/resume 携带真实 recovery identity，同 pre 重发原 ID，完成后才允许下一 ID，歧义现场 fail closed。
- [x] **F214 结构化静态合规**：token/member-chain/简单别名检测覆盖 dot、bracket、optional floors 读取和 hero status 直接写，合法当前 map/hero 读取保持通过；src/service/双 dist 同门禁。
- [x] **F215 Protocol v2 文案清理**：活跃 serializer docstring 和恢复文档统一为 v2 与 same-ID replay 语义。
- [x] **F216 第二轮回归**：新增浏览器、SQLite、service restart、localhost 和静态正反 fixture；149/149 离线 QA、确定性双构建与本轮 evidence 已固化。
- [ ] **F217 第二轮全新只读复验**：由主会话在本修复 Agent 结束后新建验收 Agent；本 Agent 不自验替代。

## Protocol v2 第三轮验收整改

- [x] **F218 malformed journal fail closed**：storage 读取明确区分 absent/parse/read/shape/protocol；固定 v1/v2 key 的损坏内容只留 key/长度/hash 摘要，内容绑定的独立归档处置后才能建立新会话。
- [x] **F219 SQLite 行为契约**：移除可被注释伪造的 SQL 子串判断；`table_xinfo` 拒绝 hidden/generated，私有内存副本真实探测 CHECK/AUTOINCREMENT，拒绝前原 DB/sidecar/模式不变。
- [x] **F220 reconnect 显式 ack**：发送前不清 pending；服务以独立 idle `acknowledged_action_id` 接受 completed；pause/error/schema/network 保留证据且零执行，重复重连幂等。
- [x] **F221 transition 精确目标**：唯一已验证出口绑定 target map instance 与 floorId；A→C mismatch；同 floorId A→B 正常；歧义目标暂停，未知出口保持 opaque。
- [x] **F222 静态合规加固**：覆盖括号/常量传播/nested destructure、`**=`、`delete`、`Object.assign/defineProperty`、`Reflect.set`，合法局部对象操作通过。
- [x] **F223 恢复注释与协议文档**：活跃代码统一 same-ID replay 与显式 completed ack，不再描述 replacement 签发。
- [x] **F224 第三轮回归**：73 JS + 81 Python + 1 integration，共 155/155；双构建、协议三侧、静态、文档与 prospective staged 检查全绿。
- [ ] **F225 第三轮全新只读复验**：由主会话新建未参与修复的验收 Agent；本 Agent 不自验替代。

## Protocol v2 第四轮验收整改

- [x] **F226 Tampermonkey absent 语义**：用 `GM_listValues` 先判固定 key existence；缺失不进入 parser，present 的 undefined/null/primitive/array/旧 sentinel 与读取异常全部 fail closed。
- [x] **F227 reconnect no-issue**：协议新增 strict `intent`；`reconnect_only` 不进入 planner/action/decision issuance，有 unresolved 时返回同 identity 暂停，错误 execute 在浏览器零执行并持久隔离。
- [x] **F228 WAL 私有一致快照**：分类前零连接真实 path；main/WAL/SHM 双读 stat/hash、framing/size 和分类后复核，只在私有临时目录打开；拒绝路径不改原 sidecar。
- [x] **F229 静态合规 root/mutation 扩展**：覆盖 window/unsafeWindow/globalThis core bracket/alias，status ancestor 与 Object/Reflect mutation APIs；合法局部对象写入保持通过。
- [x] **F230 第四轮回归**：新增 JS/Python/protocol/static fixture，75 JS + 86 Python + 1 integration 共 162/162；双构建与 fix-4 evidence 已固化。
- [ ] **F231 第四轮全新只读复验**：由主会话在本修复 Agent 结束后新建未参与开发的验收 Agent；本 Agent 不自验替代。

## Protocol v2 第五轮验收整改

- [x] **F232 显式运行模式与 GM API 门禁**：userscript/direct-mount 由构建 marker 决定；缺任一必需 GM API 返回 `USERSCRIPT_API_UNAVAILABLE`，不得读取 direct localStorage、建立 session、请求或行动。
- [x] **F233 fixed-key 双探针**：两次 `GM_listValues` 加两个动态 sentinel 的 `GM_getValue` 双读，覆盖 stale omission/inclusion、stored undefined/null/primitive/object、调用间变化及读写删异常；不稳定统一暂停 `JOURNAL_STORAGE_UNSTABLE`。
- [x] **F234 SQLite generation 身份绑定**：导入入口只作 immutable witness；一致 main/WAL/SHM 复制到 candidate 做 schema/行为分类，identity 复核后原子 manifest 发布，仅连接已分类 generation；发布及 connect 前后的 future/legacy/unknown swap 原态拒绝。
- [x] **F235 generation 重启与残留恢复**：manifest 是权威指针，合法 v2/active WAL 重启保留数据，candidate crash residual 清理，损坏 manifest fail closed，目录级备份迁移文档完成。
- [x] **F236 静态 destructure/function alias 门禁**：覆盖 `window/globalThis/unsafeWindow` 的 core nested/computed destructure，以及 `Object/Reflect` mutation API 的赋值/解构函数别名；合法 current runtime read 和 local object mutation 保持通过。
- [x] **F237 第五轮完整离线 QA 与证据**：79 JS + 90 Python + 1 integration，共 170/170；双 dist、protocol/schema、compile/syntax、static、docs/JSON、diff 与隔离 prospective index 全绿。
- [ ] **F238 第五轮全新只读复验**：由主会话在本修复 Agent 结束后新建未参与修复的只读验收 Agent；本 Agent 不自验替代。

## Protocol v2 第六轮验收整改

- [x] **F239 journal canonical 写后验证**：userscript GM storage 与 direct-mount localStorage 的关键 mutation 均执行写入后独立双读、完整 canonical JSON/hash 语义等价验证；silent no-op、旧值、截断、变形、读回变化和异常统一 `JOURNAL_STORAGE_UNSTABLE`。
- [x] **F240 at-most-once identity durability**：pending durable 是引擎 API 的硬前置；completed、ack、seen、session、scan、archive/disposition、pause 与 clear 均走同一验证事务。失败时保留上一份 durable identity、停止路线且不签收新 action。
- [x] **F241 静态符号传播门禁**：token IR 扩展常量字符串折叠、多级 global/Object/Reflect root 与 method alias、destructure alias 和 `call/apply/bind` 调用目标解析；指定五项攻击与扩展 apply/bind fixture 全拦，局部 Object-like/plain object 正例通过。
- [x] **F242 第六轮回归与构建证明**：88 JS + 90 Python + 1 integration，共 179/179；双 dist 包含写后验证门禁，协议、compile/syntax、静态、文档/JSON、确定性构建与隔离 prospective staged 检查全绿。
- [ ] **F243 第六轮全新只读复验**：由主会话新建未参与修复的验收 Agent；本 Agent 不自验替代。

## Protocol v2 第七轮验收整改

- [x] **F244 浏览器 A/B generation journal**：无单点 pointer；每槽 envelope 绑定 generation、previous commit、canonical state/hash、commit hash 与导入 witness；永远写非当前最高槽，部分 candidate 不破坏旧 identity。
- [x] **F245 故障恢复与兼容迁移**：GM/direct no-op、截断、变形、throw、complete-then-throw 可判定恢复；pending/completed/ack 链不丢；旧单 key v2/v1/corrupt 保留为只读 witness，改写重新 quarantine；clear 通过新 generation 表达。
- [x] **F246 Acorn AST 静态门禁**：离线 vendored Acorn 8.16.0，固定 MIT LICENSE/provenance/hash；scope-aware AST 数据流覆盖 parentheses、sequence、member/chain、assignment/update/delete、destructure、常量折叠、Object/Reflect 与 call/apply/bind，合法局部 shadow 不误报。
- [x] **F247 第七轮完整离线 QA 与证据**：97 JS + 90 Python + 1 integration，共 188/188；协议/compile、双 dist 确定性、Acorn AST、docs/JSON、diff 与隔离 prospective index 全绿，fix-7 evidence 已固化。
- [ ] **F248 第七轮全新只读复验**：由主会话新建未参与修复的验收 Agent；本 Agent 不自验替代。

## Protocol v2 第八轮验收整改

- [x] **F249 AST 词法 binding 与赋值解构**：函数参数默认 local unknown，只有可静态解析的立即函数或简单本地函数调用按实参传播；assignment 的 object/array/default/rest/computed pattern 进入同一 binding 分析，真实未 shadow 全局仍为 runtime root。
- [x] **F250 AST 对抗注入**：`({status:s}=core)` 与 IIFE 实参传播在 src、userscript、direct-mount 三份源码内存注入均被拦截；`function legal(core)` 参数 shadow 正例通过，Acorn/vendor/hash 与既有 fixture 保持不变。
- [x] **F251 journal 前代自证**：generation 1 固定 `previous_generation=0` 且 previous commit 为 null；generation >1 必须在单 envelope 内满足 `previous_generation=generation-1`，安全整数溢出 fail closed；双槽仍继续校验相邻 commit hash。
- [x] **F252 第八轮完整离线 QA 与证据**：从第七轮 `188/188` 基线扩展到 `101 JS + 90 Python + 1 integration = 192/192`；targeted、双 dist 重建、协议/schema/compile/static/deterministic/docs/JSON/diff 与隔离 prospective index 全绿，fix-8 evidence 已固化。
- [ ] **F253 第八轮全新只读复验**：由主会话在本修复 Agent 结束后新建未参与修复的验收 Agent；本 Agent 不自验替代。

## 当前运行态唯一权威重构

- [x] **F254 live observation 一致采集**：当前 map/blocks/怪物采集前后核对 floor、完整 hero/keys 与 moving/lock/event 围栏；瞬时变化重试，持续变化 `RUNTIME_SNAPSHOT_UNSTABLE` fail closed。
- [x] **F255 钥匙布局显式兼容**：支持 `hero.items.tools`、`hero.items.keys`、`hero.keys`；初始真实 tools fixture 为 `1/1/1`，未知容器、显式非法值、别名冲突和多布局冲突禁止默认为零；canonical tools 的零计数字段省略语义由 F268-F270 完整定义。
- [x] **F256 三处 fresh runtime 门禁**：cycle 起点、guard/plan 前和 pending durable 后行动 API 前均重采；行动后继续要求改变且稳定两轮的完整 observation，再做 expected delta。
- [x] **F257 历史地图事实投影**：SQLite 完整 observation 只保留作恢复/审计；planner 只接收 revisioned `HistoricalMapFact`，其中无 hero、keys、busy，跨图模拟的资源向量只来自本轮 live observation。
- [x] **F258 实时原子重规划**：每次仍只签一个状态边界，空走廊不跨边界；可达性、路线、估值和世界搜索队列每轮重算，未增加 current-state mirror 或持久派生 route cache。
- [x] **F259 回归与文档**：覆盖 tools key bug、torn snapshot、API 前现场变化零执行、历史资源污染、重访 map revision，并新增当前权威专题文档及 README/protocol/world/state/compliance 说明。
- [x] **F260 完整离线 QA 与双构建证据**：`104 JS + 91 Python + 1 integration = 196/196`；协议/schema/compile、双 dist 确定性、Acorn 静态盲玩、docs/JSON、diff 和隔离 prospective staged 检查全绿，证据位于 `qa/runs/2026-07-14-live-runtime-authority/`。
- [ ] **F261 全新只读验收**：由主会话在本开发 Agent 结束后新建未参与开发的验收 Agent；本 Agent 不自验替代。

## Optional unsupported frontier 修复

- [x] **F262 根因与红灯**：真实序章同形 synthetic case 证明可绕开 NPC 会在黄门候选前触发全局 `UNSUPPORTED_REGISTERED_INTERACTION`。
- [x] **F263 frontier 语义**：`supported=false` boundary 保持图级阻挡和未解决审计事实；有资源可承担的 supported 候选时跳过，不进入路线或 world-search 模拟。
- [x] **F264 无合法进展暂停**：唯一通路被 unsupported 阻挡、只有 unsupported、或其他 supported 候选资源不可承担时，稳定选择最近 evidence 并暂停。
- [x] **F265 硬门禁与原子性回归**：unknown block、unknown damage、incomplete label 仍优先 fail closed；operations 不触碰 unsupported，每次仍只有一个末端状态变化边界。
- [x] **F266 完整离线 QA 与证据**：`104 JS + 97 Python + 1 integration = 202/202`；双 dist hash、静态盲玩、协议/schema、compile/syntax、docs/JSON、diff 与隔离 prospective index 全绿，证据位于 `qa/runs/2026-07-14-optional-unsupported-frontier/`。
- [ ] **F267 全新只读验收**：由主会话在本修复 Agent 结束后新建未参与修复的只读验收 Agent；本 Agent 不自验替代。

## Canonical tools 零钥匙省略与 pending 恢复

- [x] **F268 零值数据模型**：canonical `hero.items.tools` 容器存在即声明三色布局；被引擎删除的零计数字段归一为 `0`，空容器表示三色全零。
- [x] **F269 严格布局门禁**：显式值必须是有限非负整数；非普通 tools 容器、同色长短别名冲突、多布局冲突与完全缺少可识别容器继续 fail closed，既有 `items.keys`/`hero.keys` 完整性不放宽。
- [x] **F270 已执行动作恢复**：黄门消失、位置改变、`yellowKey` 从 `1` 删除的 fresh observation 归一为 `yellow=0`，`keys.yellow=-1 + removed_blocks` 可补记 completed/ack；reconnect/reload 不重放引擎 API。
- [x] **F271 完整离线 QA 与证据**：定向红灯、完整 JS/Python/integration、协议/schema、compile/syntax、双 dist 确定性、Acorn 静态盲玩、docs/JSON、diff 与隔离 prospective index 全绿；证据位于 `qa/runs/2026-07-14-zero-key-omission-recovery/`。
- [ ] **F272 全新只读验收**：由主会话在本修复 Agent 结束后新建未参与修复的只读验收 Agent；本 Agent 不自验替代。

## 当前怪物实时语义与换层恢复

- [x] **F273 红灯复现**：真实 `exp` 字段被旧 adapter 丢失、可解释的 null/`???` 被 observation 全局拒绝、MT0→MT1 completed observation 无法形成的 synthetic 测试在实现前失败并保留证据。
- [x] **F274 字段严格归一**：当前坐标 `getEnemyInfo` 支持 `atk/attack`、`def/defense`、`money/gold`、`exp/experience`；同字段双别名同值通过，冲突或显式非法值 fail closed；`special:0` 归一为空数组。显式 own-property 非法值与缺席的严格区分由 F282 补强。
- [x] **F275 实时不可战斗语义**：仅当当前 `hero.attack <= enemy.defense` 时，null/`???` 解释为本轮 `known_unfightable`；它仍是不可穿越边界，不进入战斗候选，但不会否决独立资源、门、楼梯或可战怪。下一轮重新读取，不保存旧结论；历史 map fact 的 enemy stats 只作审计。仅按“非当前 map”排除 future combat 的不足由 F281 补强。
- [x] **F276 真未知伤害证据**：当前攻击已能穿透、defense 缺失、别名冲突、非法属性或其他无法解释情形继续 `UNKNOWN_DAMAGE / DAMAGE_UNEXPLAINED`，证据含坐标、identity、raw damage、当前怪物字段和 hero attack。
- [x] **F277 换层 pending/ack**：进入含可解释不可战斗怪物的新 map 后，合法 observation 先结算旧楼梯 action，决策日志按 `action_completed → completed_action_acknowledged` 排序；刷新、重连和服务重启不重放、不签第二个 action。
- [x] **F278 完整离线 QA 与证据**：`108 JS + 103 Python + 1 integration = 212/212`；协议/schema、compile/syntax、双 dist 确定性、Acorn 静态盲玩、docs/JSON、diff 与隔离 prospective index 全绿，证据位于 `qa/runs/2026-07-14-live-enemy-semantics/`。
- [x] **F279 首轮全新只读验收（未放行）**：验收发现 world search 在同图资源后及 A→B→A 后仍消费旧战损，以及显式 alias `undefined` 被当作缺席；结论不可以交付，进入下列整改。

## 怪物事实 root-live-only 验收整改

- [x] **F280 验收反例红灯**：`redGem → enemy`、非攻击资源 → enemy、A→B→A 另一入口 → enemy 与 `atk/def/exp/money:undefined` 在修复前稳定失败并保留输出。
- [x] **F281 root-live-only terminal**：只有 untouched live root 可使用本轮 enemy facts；直接可达可战怪是一个终端原子候选，任何资源、门、楼梯、战斗、地图切换或返回后的节点都不得模拟旧战损或收益。
- [x] **F282 alias 存在性门禁**：optional alias 只有全部 own property 缺席才归一 null；显式 `undefined/null/NaN/Infinity`、字符串、非整数和负数均 `ENGINE_API_INCOMPATIBLE / INVALID_RUNTIME_FIELD`，双别名同值/冲突语义保持。
- [x] **F283 恢复与盲玩回归**：known_unfightable、真正未知 damage、takeover scan、MT0→MT1 completed/ack、浏览器和服务重启零重放、单边界与静态盲玩门禁继续通过。
- [x] **F284 完整离线 QA 与证据**：`108 JS + 107 Python + 1 integration = 216/216`；协议/schema、compile/syntax、双 dist 确定性、Acorn 静态盲玩、docs/JSON、diff 与隔离 prospective index 全绿，证据位于 `qa/runs/2026-07-14-live-enemy-root-only-followup/`。
- [ ] **F285 整改后全新只读验收**：由主会话新建未参与本轮修复的只读验收 Agent；本 Agent 不自验替代。

## getDamage undefined fail-closed 验收整改

- [x] **F286 第二轮验收反例红灯**：`getDamage()` 返回 `undefined` 且 `hero.attack <= enemy.defense` 时，旧逻辑把它归一为 null 并误判 known-unfightable；定向测试在修复前稳定失败。
- [x] **F287 damage 严格值域门禁**：只有有限非负整数、严格 null 和字符串 `???` 属于可解释输入；其中仅严格 null/`???` 可在实时攻防不穿透时成为 known-unfightable。`undefined`、NaN、Infinity、负数、非整数、其他字符串、对象和布尔值均在浏览器采集边界 `UNKNOWN_DAMAGE / DAMAGE_UNEXPLAINED` 暂停。
- [x] **F288 原始证据与 wire 边界**：非法 damage 的暂停证据保留坐标、identity、`raw_damage` 类型、hero attack、enemy defense 和当前怪物字段；controller 在采集失败后零 localhost 请求、零行动，服务不会接收被静默转成 null 的 undefined。
- [x] **F289 完整离线 QA 与证据**：`111 JS + 108 Python + 1 integration = 220/220`；协议/schema、compile/syntax、双 dist 确定性、Acorn 静态盲玩、docs/JSON、diff 与隔离 prospective index 全绿，证据位于 `qa/runs/2026-07-14-damage-undefined-fail-closed/`。
- [ ] **F290 整改后全新只读验收**：由主会话新建未参与本轮修复的只读验收 Agent；本 Agent 不自验替代。

## verified stair 循环与实际进展整改

- [x] **F291 红灯复现**：两图互返楼梯无其他候选、MT1-like redDoor + return stair、远端实际 resource、AUTO3/4/5 synthetic 序列在旧逻辑下分别证明 stair bonus、终端候选和重扫语义会制造 ping-pong。
- [x] **F292 opaque/verified 扫描分离**：opaque/ambiguous 出口仍由 takeover scan 发现；唯一 verified transition 已经完成发现，不再作为 pending，仅可在另一实例仍有 opaque pending 时作 BFS reposition。
- [x] **F293 verified 零收益中间边**：verified stair 本身不写 best candidate、不加 progress/return bonus；只有远端实际可执行的非循环 frontier 提供 score/reason，并仍只签当前 stair 这一个原子边界。
- [x] **F294 successor 先支配剪枝**：transition successor 以 `map + position + live-derived resources + removed` 在候选/奖励前检查 visited/dominance；A→B→A 同状态返回没有候选或收益。
- [x] **F295 现场序列与恢复回归**：synthetic AUTO3 首次 opaque、AUTO4 以远端 redDoor 为目标走 verified upFloor、AUTO5 选择 OPEN_DOOR 而非 downFloor；completed/ack 后重启保持 verified identity、仅一条 action/transition、零重放。
- [x] **F296 完整离线 QA 与证据**：`111 JS + 114 Python + 1 integration = 226/226`；protocol/schema、compile/syntax、双 dist 确定性、Acorn 静态盲玩、docs/JSON、diff 与隔离 prospective index 全绿，证据位于 `qa/runs/2026-07-14-verified-stair-cycle/`。
- [ ] **F297 全新只读验收**：由主会话新建未参与本轮修复的只读验收 Agent；本 Agent 不自验替代。

## v0.1 历史原型记录（不适用于 v2 运行逻辑）

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
- 油猴权限最小集为 `unsafeWindow`、`GM_getValue`、`GM_setValue`、`GM_deleteValue`、`GM_listValues`、`GM_registerMenuCommand`、`GM_xmlhttpRequest` 和 `@connect 127.0.0.1`；缺任一运行必需 GM API 都 fail closed，不授予无关权限。
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
      current-4f-synthetic-blocks.json
      protocol-responses.json
  qa/
    README.md
    legacy-v0.1/
      current-4f-baseline.json
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

1. **未执行**：当前 fingerprint 等于 pre-fingerprint。上报 `not_executed`，服务只重发同一 action_id；浏览器仅在收到该 ledger 身份一致的响应后执行，不自行生成或替换 ID。
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
- 楼梯完成覆盖 `A pending -> A`、`A completed -> B` 与重启后的 completed/ack 零重放；若返回相同 fingerprint 后只剩 verified 互返边，则稳定 idle，不为生成新 action_id 再走一次楼梯。
- 持久 issuance sequence 覆盖旧 action_id 碰撞跳过、已保留 gap 不复用和服务重启。

### 15.5 差分与稳定测试

- fingerprint 变化后必须连续两次一致才算稳定。
- moving、lockControl 或 event 任一仍活动时不结算。
- HP、资源、钥匙、block 或楼层差分不符时暂停。
- 已知 `+200 HP` 资源 fixture 正确验证单个资源边界。
- 战损未知、负数异常或非有限值时暂停。

### 15.6 当前层模拟数据

v2 活跃 fixture 只使用明确标记的 synthetic 运行态；v0.1 固定现场交接资料已退出测试输入：

1. `tests/fixtures/current-4f-synthetic-blocks.json`：使用明确标记为 synthetic 的 blocks，覆盖墙、空路、门、怪物、资源、楼梯、disable block 和未知 block；不得伪装成真实 4F 地图。
2. `tests/fixtures/runtime-topologies-v2.json`：覆盖 11×11、13×13、7×19 和带空洞的异形 topology，用于证明 v2 不把 11×11 作为运行时设计前提。
3. `qa/legacy-v0.1/current-4f-baseline.json`：仅作为历史交接证据归档，Protocol v2 运行时、fixture validator 和自动化测试都不得加载它。

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

- 第四轮独立只读验收发现的 fresh GM sentinel、reconnect issuance、WAL SHM 触碰和静态 mutation 漏检已由全新一次性修复 SubAgent 测试先行整改。
- 本轮离线 QA、构建 hash 与 fix-4 evidence 完成后，仍必须由主会话创建全新的只读验收 SubAgent；修复 Agent 不得自验代替。
- 验收通过后才允许主会话 stage/commit；push 前仍需用户明确确认。
- T73/T74 保持未完成，不能用 fake core 结果冒充真实页面 QA。
- 未经用户另行授权，不安装脚本、不访问真实页面、不读写存档或执行真实行动。
