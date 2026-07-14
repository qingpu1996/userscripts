# QA 证据索引

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

本轮明确 `not-run`：真实游戏页面、真实存档、真实移动/换图、内置浏览器注入和外网。离线 fake core 结果不得冒充现场验证。
