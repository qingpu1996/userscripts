# QA Runbook

## Offline

运行 `scripts/run-offline-qa.sh`，必须通过：

- fixtures 与三个 JSON Schema；
- 全部 JS、Python unittest、localhost fake-core integration；
- Pydantic/Schema/browser response fixture；
- Python compileall 和所有 JS syntax；
- userscript/direct-mount 双次确定性构建；
- src/service/dist 静态运行态写安全与 localhost 边界扫描；
- Markdown local links、JSON parse、whitespace；
- 临时 Git index prospective staged diff check。

重点 fixture：11×11 回归、13×13、7×19、valid_cells 空洞、多图同显示层、同 floorId revision、单/双向 transition、frontier 不越界、边界移除重算、hero.exp、缺 keys、v1 fail closed、三种 session、CORS、direct mount。

首轮验收整改还必须覆盖：既有 v2 journal 不能掩盖 v1 key；普通确认/启动/重连零请求零行动；legacy/future SQLite 拒绝前后文件字节、user_version 与 schema 不变；同 floorId A→B；scan restart/idempotency/audit/单向 paused；opaque 出口分支终止；dimensions 与 ragged/缺行/短行 grid 联合校验；同 map pair 的不同 portal 不误标 reversible；Protocol v2 错误文案和 scan_state 三层 wire 对齐。

第二轮整改还必须覆盖：legacy disposition 不清除任何已有 v2 recovery evidence，archive 后 legacy 改写重新 quarantine；伪同列 v2、缺 PK/UNIQUE/CHECK/FK/index、错 type/default/NOT NULL、partial scan tables 和 future version 均在 WAL/DDL 前原态拒绝；同 session 换 fingerprint 不签第二个 issued，同 pre 重连/服务重启重发原 action ID，完成后才签下一 ID；reconnectOnly 携带真实 recovery identity 且零执行。该轮曾使用 floors 读取禁令，现已被“完整游戏数据可读、权威状态不可直接 mutation”门禁替代。

第三轮整改还必须覆盖：malformed v1/v2、JSON primitive/array、wrong protocol/shape、storage read exception 和内容改写重新 quarantine；注释/string 伪 CHECK、hidden/generated column 与合法库 INVALID 行为 probe；reconnect pause/error/malformed/network 保留 completed recovery，明确同 ID ack 后才清；ordinary/scan 的 A→B 精确目标、A→C mismatch、同 floorId 与歧义 target；括号 alias、常量 bracket、nested destructure、`**=`/delete/Object mutation APIs 的静态正反 fixture。

第四轮整改还必须覆盖：Tampermonkey 两 key 全缺/单缺、旧 sentinel、present `undefined/null`、object clone、read/list throw 与 GM delete 后 absent；`intent=reconnect_only` 无 pending 时 action/decision 零新增、有 unresolved 时同 identity 暂停、错误 execute 零执行且持久留证；合法活动 WAL 可重开、非法 WAL/无 SHM/截断 sidecar/复制不稳定在拒绝时原 main/WAL/SHM hash+mtime 不变且私有临时目录清理；status ancestor mutation 与 `Reflect.deleteProperty` 全拦，完整 floors 只读与局部对象 mutation 正例通过。

第五轮整改还必须覆盖：双构建物显式且互斥的 runtime marker；缺 `GM_getValue/GM_setValue/GM_deleteValue/GM_listValues/GM_xmlhttpRequest` 任一项零降级，stale list omission/inclusion、stored undefined、两次 get/list 变化、读写删/request throw；SQLite 在分类前、复制中、发布时和 generation connect 时的 inode swap，对 future 99 替换库 main/sidecar bytes+mtime+user_version 零写，合法 v2/active WAL/服务重启保留，manifest 与 crash candidate 恢复；bare global/nested/computed destructure 和 Object/Reflect 函数别名全拦，合法局部 alias mutation 通过。详见 [storage](storage.md)。

第六轮整改还必须覆盖：GM `setValue` silent no-op/旧值/截断/clone 变形、delete no-op、read→write witness 变化、写后两次读取变化/throw；direct mount `setItem/removeItem` no-op 与读回变化/throw；正常 structured clone canonical 等价通过；pending 写失败引擎 API 为零，completed/ack 写失败保留上一 identity 且下一响应不执行；双 dist 必须包含同一门禁。静态 fixture 必须拦截二级 Object/Reflect alias、global destructure root 和 `call/apply/bind` 对 runtime 的 mutation，并保留 Object-like/local plain object/full runtime read 正例。

第七轮整改还必须覆盖：A/B 连续多代交替、同 generation 冲突、previous hash 断裂、rollback/gap/unexpected higher；GM/direct no-op、截断、变形、throw、complete-then-throw；pending candidate 失败时引擎零调用且刷新保留旧或完整新 identity，completed/ack candidate 失败仍保留 recovery 链；旧单 key v2/v1/corrupt 安全导入且不覆盖，内容变化重新 quarantine；备份文档包含所有 slots。静态门禁必须离线校验 Acorn 8.16.0 parser/LICENSE/provenance hash，允许 `(core).floors`、`(globalThis.core).floors` 和 `(0,globalThis).core.floors` 只读，拦截 `(runtime.status).hero.hp=1`、立即 `bind` mutation，并通过局部 `core/runtime/globalThis` shadow 正例。

第八轮整改还必须覆盖：generation 1 的完整 base invariant、generation 2/previous 1 合法、单槽 generation 100/previous 1 gap 拒绝、单槽 generation 100/previous 99 可恢复、安全整数上界与下一次写入溢出拒绝、双槽连续链。AST 必须拦截 assignment object/array/default/rest/computed destructure、IIFE/简单本地函数实参传播，并通过参数名为 `core/runtime` 的 local shadow；两项核心攻击要分别注入实际 src、userscript 和 direct-mount 源文本做内存扫描。文档必须明确无外部高水位时浏览器单槽不能检测完整历史回放。

策略数据边界移除后的修复轮还必须覆盖：权威 runtime 引用经数组/对象 carrier、简单函数 return/parameter、rest/spread、Object/Reflect `call/apply/bind` 和 Array/Map/Set prototype/实例原地 mutator 后仍被识别；合法完整 floors/maps/material/source/save 读取、局部快照 mutation 与正常引擎行动接口不得误报。integration 必须通过 `python -m mota_lab serve --port <random-loopback-port>` 的生产 CLI 启动，并把同一显式 endpoint 交给 client；不得在 transport 内把固定 URL 偷换端口。另行断言无参数 `serve` 默认仍为 `18724`，随机实例不得连接、停止或复用用户的 `18724` 服务。

Fix 6 起，上述 snippet 矩阵只作为受控项目 lint 的历史回归集，不构成对任意 JavaScript 语义的 sandbox 承诺。当前硬门禁是：逐个审计实际 production src/service/双 dist；adapter 权威 alias 与 engine API inventory 明确分类，未分类调用 fail closed；实际 source 中出现 user-defined constructor、bound-this runtime carrier 或 identity-producing collection callback 必须拒绝或单独审查；full-cycle fake core 用写入 instrumentation 证明 collector/client/service 零直接写，权威变化仅来自模拟公开行动 API。完整游戏数据仍可读，唯一盲玩限制仍是不使用外部攻略/路线/录像/针对性解法。

Fix 7 进一步要求 production source discovery 递归扫描 `src/**/*.js` 与 `service/mota_lab/**/*.py`，并与 userscript production manifest 精确相等；新增嵌套模块未入 manifest 或 manifest 指向非 production source 都必须失败。adapter API inventory 必须追踪 `runtime/core` 的简单对象 alias、`scope.core/globalThis.core`、静态成员 alias、对象解构，以及邻近 `bind/call/apply`；动态或未知 engine method 统一报 `UNCLASSIFIED_ENGINE_API`。fake core instrumentation 必须覆盖 `core/status/maps/hero/current map/blocks/enemy` 根与子容器的 `set/delete/defineProperty`，读取、collector、client、service 和初始化阶段不能开启 action scope；只有模拟 `moveDirectly/setAutomaticRoute` 的内部回调可以产生带 API、路径和操作类型的权威写入记录。

Fix 8 将 engine member reference 作为统一 inventory 单元：direct member、静态 bracket member、member alias 和它们的直接调用或 `call/apply/bind` 都必须归回原始 engine method；任何 engine-rooted 动态 property 在成员读取处立即报 `UNCLASSIFIED_ENGINE_API` 与 `DYNAMIC_ENGINE_API`，动态 alias 的后续调用仍保持 fail closed。完整 QA 会临时向实际 `src/engine-adapter.js` 注入点名反例、重建 userscript 与 direct-mount 两个 dist、执行完整 production audit 并要求非零退出，随后在 `finally` 恢复源码、重建并逐字节核对两个 dist。

## 后续现场门禁

现场 QA 必须由用户另行授权：

1. 读取首次现场与所需游戏完整定义，不确认、不行动。
2. 核对动态 dimensions、topology 来源、hero.exp/keys、map instance。
3. 用户显式确认 session baseline，仍不启动。
4. 分别授权空走廊、单资源、单门、单怪、单次换图。
5. 允许预读目标布局做策略，但换图 action 的完成仍只由实际 pre/post transition 结算。
6. 验证刷新、服务重启、响应丢失恢复。

任一 API、事件时序、topology 或差分不可靠立即暂停。不得使用外部攻略、标准路线或通关录像，也不得用真实游戏结果修改 synthetic 预期以掩盖问题。

## 证据

每轮 QA 在 `qa/runs/<date>-<name>/` 保存 commands、summary、机器可读 results、构建 hash、工作区状态和明确未覆盖风险。prospective staged 检查必须使用临时 index 与隔离 object directory，且记录真实 index 检查前后哈希。真实页面未跑时必须写 `not-run`。
