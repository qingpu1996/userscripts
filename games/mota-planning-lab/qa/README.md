# QA 证据索引

> 本索引包含旧版磁盘恢复方案的历史证据，仅用于版本追溯，不代表当前 production 契约。当前运行状态纯内存，重启后 fresh start。

## 纯内存测试契约迁移

本轮没有恢复旧版磁盘 journal、SQLite 文件恢复或跨进程 action replay 测试。整文件删除前仍适用于当前版本的契约，迁移到以下聚焦位置：

| 旧测试来源 | 当前仍有效的契约 | 当前测试位置 |
| --- | --- | --- |
| `tests/python/test_runtime_v2.py` | world search、planning budget、verified transition、循环避免、不可战斗怪物、takeover scan | `tests/python/test_memory_planner_contracts.py`；独立进展分支同时在 `tests/python/test_state_planner.py` |
| `tests/python/test_storage_recovery_cli.py` | 同进程 completed ACK、expected delta mismatch、reconnect-only、loopback host/默认端口/端口范围 | `tests/python/test_memory_planner_contracts.py` |
| `tests/js/journal-client-controller.test.js` | localhost client、严格响应协议、controller single-flight、显式启动/停止、guard、completed ACK/delta report、重复 action identity | `tests/js/client-controller-memory-contract.test.js` |
| `tests/js/journal-dual-slot.test.js` 与 `tests/js/runtime-v2.test.js` 的持久化部分 | 浏览器 storage、双槽 generation、legacy quarantine、刷新/重启恢复 | **不迁移**：与当前纯内存、fresh-session 契约冲突 |

这些测试只锁定工程行为，不证明 planner 的战略正确性、门后全局可行性、全局最优或安全通关。

当前完整离线测试计数：`112` 项 JavaScript、`70` 项 Python、`1` 项 integration，共 `183` 项；协议/Schema、静态完整性、双 dist 确定性重建和文档校验另行执行并全部通过。

历史 v0.1 evidence 保留在既有日期目录，只描述当时固定尺寸执行原型，不代表 Protocol v2。

本轮 v2 证据：[`runs/2026-07-14-runtime-v2/`](runs/2026-07-14-runtime-v2/)。覆盖动态 topology、session baseline、世界图、direct mount、CORS、构建确定性与完整离线闭环。

首轮独立验收整改证据：[`runs/2026-07-14-runtime-v2-fix-1/`](runs/2026-07-14-runtime-v2-fix-1/)。覆盖 6 个 P1、2 个 P2 的测试先行复现、迁移 fail-closed、持久接管扫描、同层换图、opaque 出口、ragged grid、精确端点可逆和最终 144 项离线测试。

第二轮独立验收整改证据：[`runs/2026-07-14-runtime-v2-fix-2/`](runs/2026-07-14-runtime-v2-fix-2/)。覆盖内容绑定的 legacy disposition、严格 SQLite contract、session-wide 单未决行动与 same-ID recovery、结构化静态合规和完整离线 QA。

第三轮独立验收整改证据：[`runs/2026-07-14-runtime-v2-fix-3/`](runs/2026-07-14-runtime-v2-fix-3/)。覆盖 malformed journal quarantine、不可伪造的 SQLite 行为契约、显式 completed ack、精确 transition target、扩展静态合规及 155 项离线 QA。

第四轮独立验收整改证据：[`runs/2026-07-14-runtime-v2-fix-4/`](runs/2026-07-14-runtime-v2-fix-4/)。覆盖 Tampermonkey absent key、observe-only reconnect、WAL 私有一致快照、全局 core/mutation 静态门禁及 162 项离线 QA。

第五轮独立验收整改证据：[`runs/2026-07-14-runtime-v2-fix-5/`](runs/2026-07-14-runtime-v2-fix-5/)。覆盖显式 runtime marker、GM storage 双探针、SQLite generation/manifest 身份绑定、snapshot→open 对抗 swap、destructure/function alias 静态门禁及完整离线 QA。

第六轮独立验收整改证据：[`runs/2026-07-14-runtime-v2-fix-6/`](runs/2026-07-14-runtime-v2-fix-6/)。覆盖 journal canonical 写后验证、读写 witness、pending/completed/ack identity 故障注入、direct mount localStorage 双读回、静态多级 alias/常量折叠/`call/apply/bind` 对抗 fixture 及 179 项离线 QA。

第七轮独立验收整改证据：[`runs/2026-07-14-runtime-v2-fix-7/`](runs/2026-07-14-runtime-v2-fix-7/)。覆盖浏览器 A/B generation 非破坏恢复、旧单 key witness 迁移、GM/direct candidate 故障矩阵、固定 vendored Acorn AST 与 scope-aware 静态对抗；真实页面仍为 `not-run`。

第八轮独立验收整改证据：[`runs/2026-07-14-runtime-v2-fix-8/`](runs/2026-07-14-runtime-v2-fix-8/)。覆盖 AST 词法 binding、assignment destructure、IIFE/本地调用实参传播、src/双 dist 内存注入，以及 journal envelope 自身相邻前代、base/overflow/gap 对抗；真实页面仍为 `not-run`。

当前运行态唯一权威重构证据：[`runs/2026-07-14-live-runtime-authority/`](runs/2026-07-14-live-runtime-authority/)。覆盖真实 tools key shape、key layout fail-closed、同步采集围栏、行动 API 前 fresh guard、历史 map fact 去 hero/resources、重访 revision、单边界重规划与 `196/196` 完整离线 QA。

canonical tools 零钥匙省略恢复证据：[`runs/2026-07-14-zero-key-omission-recovery/`](runs/2026-07-14-zero-key-omission-recovery/)。覆盖零字段/空 tools 归一、显式非法值与布局冲突 fail closed、黄门后 `yellowKey` 删除的 expected-delta completed/ack，以及 reconnect/reload 零重放；完整离线 QA 为 `203/203`。

当前怪物实时语义证据：[`runs/2026-07-14-live-enemy-semantics/`](runs/2026-07-14-live-enemy-semantics/)。覆盖 `exp/experience` 等别名严格归一、`special:0`、可解释 null/`???` 的不可战斗阻挡、独立 supported 进展、攻击变化实时重判、scan/world search 不穿越、真正未知伤害取证，以及 MT0→MT1 pending/completed/ack 与浏览器/服务重启零重放；完整离线 QA 为 `212/212`。

怪物事实 root-live-only 验收整改证据：[`runs/2026-07-14-live-enemy-root-only-followup/`](runs/2026-07-14-live-enemy-root-only-followup/)。保留上一轮未放行结论，覆盖同图资源后、非攻击资源后、A→B→A 后禁止消费旧战损，root live 直接战斗终端候选，以及 alias own-property 显式非法与完全缺席的严格区分；完整离线 QA 为 `216/216`。

`getDamage()` undefined fail-closed 验收整改证据：[`runs/2026-07-14-damage-undefined-fail-closed/`](runs/2026-07-14-damage-undefined-fail-closed/)。覆盖 undefined 在攻防不可穿透/可穿透两种情况下均暂停、raw type 证据、非法 damage 矩阵、明确 null/`???` 分支、浏览器零 wire/零行动，以及服务 required damage 与非负 schema；完整离线 QA 为 `220/220`。

verified stair 循环整改证据：[`runs/2026-07-14-verified-stair-cycle/`](runs/2026-07-14-verified-stair-cycle/)。覆盖 opaque 首次发现、verified edge 不重复扫描、零收益中间边、successor 入队前支配剪枝、互返楼梯 idle、当前 redDoor 优先、远端实际 frontier 导航、AUTO3/4/5 synthetic 序列和 completed/ack 重启零重放。

策略数据边界重置初始证据：[`runs/2026-07-14-remove-blind-data-boundary/`](runs/2026-07-14-remove-blind-data-boundary/)。覆盖撤销 floors/maps/material/source/save structure 读取禁令、完整游戏数据只读正例、全 runtime 权威对象 mutation 反例和初始隔离 integration；完整离线 QA 为 `228/228`。

策略数据边界重置第一轮修复证据：[`runs/2026-07-14-remove-blind-data-boundary-fix1/`](runs/2026-07-14-remove-blind-data-boundary-fix1/)。补齐 carrier/function/Object/Reflect/container mutator 数据流门禁，并让 integration 通过生产 `python -m mota_lab serve --port <random>` 链启动、client 使用同一显式 endpoint；默认 `18724` 契约独立受测，完整离线 QA 为 `234/234`。

策略数据边界重置第二轮修复证据：[`runs/2026-07-14-remove-blind-data-boundary-fix2/`](runs/2026-07-14-remove-blind-data-boundary-fix2/)。补齐 array spread、返回型 mutator、rest/spread 函数、method alias、dynamic/loop/Reflect/Object/Map/Set carrier，加入 taint-signature 函数摘要与 source/step/call-depth fail-closed 预算，并清理 TASK 历史架构误导；完整离线 QA 为 `237/237`。

策略数据边界重置第三轮修复证据：[`runs/2026-07-14-remove-blind-data-boundary-fix3/`](runs/2026-07-14-remove-blind-data-boundary-fix3/)。修复嵌套 closure 摘要跨实例及预分析/真实调用串污：scope identity、binding revision 与深层 container owner revision 共同隔离缓存；覆盖 local/runtime 双顺序、深层 taint、递归门禁和 depth 22/40 DAG，完整离线 QA 为 `239/239`。

策略数据边界重置第四轮修复证据：[`runs/2026-07-14-remove-blind-data-boundary-fix4/`](runs/2026-07-14-remove-blind-data-boundary-fix4/)。修复 mutable function return memo clone 丢失 captured container alias：heap-producing return 改为每次重分析，同时保留 scalar/runtime DAG 摘要；覆盖 object/array/Map/Set、nested closure、同/异函数 alias 与 fresh-container 反例，完整离线 QA 为 `240/240`。

策略数据边界重置第五轮修复证据：[`runs/2026-07-14-remove-blind-data-boundary-fix5/`](runs/2026-07-14-remove-blind-data-boundary-fix5/)。修复 callable return 跨调用复用首个 closure allocation：heap 与 callable identity-bearing return 均不缓存，只缓存安全 scalar/runtime immutable 摘要；覆盖同表达式多实例、相同结构实参、顺序、nested closure、closure-returning-closure、bound callable 和 2000 allocation 性能/预算，完整离线 QA 为 `241/241`。

策略数据边界重置第六轮方向纠正证据：[`runs/2026-07-14-remove-blind-data-boundary-fix6/`](runs/2026-07-14-remove-blind-data-boundary-fix6/)。静态分析重新定位为受控项目源码 lint；交付保证改由实际 production tree 审计、adapter engine API allowlist 与 full-cycle 权威写入 instrumentation 共同提供。`this`/user constructor/identity callback 作为 unsupported lint syntax fail closed，不再把理论 snippet 完备性当成 sandbox 门槛。

策略数据边界重置第七轮实际生产完整性整改证据：[`runs/2026-07-14-remove-blind-data-boundary-fix7/`](runs/2026-07-14-remove-blind-data-boundary-fix7/)。覆盖递归 production source discovery 与 userscript manifest 精确一致、runtime/core/scope/globalThis 及解构/成员/bound alias 的 engine API inventory、临时 actual-adapter 注入与未知 API fail closed、全部权威 root/container 的 set/delete/defineProperty 动态负向矩阵，以及 full-cycle 每次权威变化的公开行动 API 归因；完整离线 QA 为 `251/251`。

策略数据边界重置第八轮 engine API inventory 修复证据：[`runs/2026-07-14-remove-blind-data-boundary-fix8/`](runs/2026-07-14-remove-blind-data-boundary-fix8/)。覆盖 direct/static-bracket/dynamic-bracket engine member、member alias 的直接调用与 `call/apply/bind`，点名三个 Acceptance8 漏报全部 fail closed；完整 QA 临时注入实际 adapter、重建双 dist、要求 production audit 非零退出，再恢复源码与制品，最终为 `252/252`。

本轮明确 `not-run`：真实游戏页面、真实存档、真实移动/换图、内置浏览器注入和外网。离线 fake core 结果不得冒充现场验证。
