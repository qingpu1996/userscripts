# Protocol v2 状态机

```text
STOPPED
 -> PREFLIGHT
 -> AWAITING_BASELINE_CONFIRMATION
 -> BASELINE_VERIFIED
 -> TAKEOVER_SCAN(anchor -> discover -> sweep -> complete|paused)
 -> OBSERVING -> REQUESTING -> GUARD_CHECK
 -> EXECUTING -> SETTLING -> VERIFYING_DELTA -> REPORTING
任意阶段 -> PAUSED
```

首次 observation 只展示。用户显式确认后浏览器 journal 保存 session_id、mode、baseline 摘要；服务收到 `command=confirm` 前保持 `SESSION_CONFIRMATION_REQUIRED`。启动是与确认分开的第二个用户动作。

`OBSERVING` 不是读取浏览器缓存：每轮都从当前页面 JS 同步重采。采样前后围栏不一致时整轮 observation 作废；不会用 journal baseline、上轮 observation 或 SQLite snapshot 填补当前 hero、keys 或 blocks。

## Journal v2

持久字段包括 protocol、session_id/mode/baseline、service confirmation、scan state、pending、completed、ack、seen action IDs、registry 和 pause evidence。只要固定 v1 key 仍存在且未留下专用处置审计，即使已有 v2 journal 也只会触发 `JOURNAL_V1_MIGRATION_REQUIRED`；普通 baseline 确认、启动和重连都不能绕过。

所有会改变这些身份字段的 mutation 都写入 A/B 中非当前最高的 generation 槽。base envelope 固定 `generation=1, previous_generation=0, previous_commit_hash=null`；后续 envelope 必须在自身内部声明 `previous_generation=generation-1`，并携带 previous committed hash、完整 state/hash、commit hash 与导入 witness。安全整数溢出、单槽内部 gap、双槽链断都 fail closed。完整双读并从两槽重新选出唯一最高前，状态机不能进入下一阶段。pending generation 可验证后才能进入 `EXECUTING`；mark-completed 或 ack 的 candidate 不完整时保留旧 pending/completed，candidate 已完整但 API 报错时刷新选择新 generation，仍不会丢失“未执行/已执行待 ack”身份。clear/abandon/archive/disposition 同样是新 generation，不物理删除唯一证据。

唯一迁移入口先把完整 v1 payload 归档到 v2 journal，生成内容哈希 archive id；随后要求用户输入精确确认短语并回传同一 archive id，才可开始一个不继承旧行动身份的新 v2 session。处置时重新哈希当前固定 legacy key，内容与 archive 不同即拒绝；处置后 legacy 内容发生变化会再次 quarantine。若 v2 journal 已有 session、pending、completed、ack、seen action 或 scan identity，专用处置也拒绝且不清空任何证据，必须交给未来的独立审计迁移。direct mount 使用自己的 v1 quarantine key，不枚举游戏 storage。

direct mount 和 userscript 使用隔离 namespace。任何模式都不能枚举游戏 storage。

固定 v1/v2 key 的读取区分 `ABSENT / PARSE_FAILED / WRONG_SHAPE_OR_PROTOCOL / STORAGE_UNSTABLE / VALID`。userscript/direct 模式由构建 marker 决定，不从 GM API 是否存在推断。Tampermonkey 每次 inspect 读取两次 key list，并用两个不同动态 sentinel 双读同一 key；两个默认各自返回才是 absent，同一真实值返回两次才是 present。stale omission/inclusion 可被交叉验证，list/get 变化、异常或不一致暂停 `JOURNAL_STORAGE_UNSTABLE`。存在的 `undefined/null/primitive/array/旧 sentinel` 均按损坏内容处理；证据只保存 key、长度、SHA-256 与错误类别。

## 行动事务

```text
response schema
 -> session/map/dimensions/topology/full-panel guard
 -> current topology route proof
 -> verified durable pending journal before API
 -> fresh current-runtime observation 与 guard/pre fingerprint 再核对
 -> one public engine action
 -> moving/lock/event all clear
 -> changed fingerprint stable twice
 -> non-position postcondition + expected delta
 -> completed report
 -> SQLite action/world/transition transaction
```

同一 action_id 最多进入 EXECUTING 一次，同一 session 最多存在一个 unresolved `issued`。pre fingerprint 未变说明尚未执行时，服务重发原 ID，浏览器核对 pending/ledger identity 后才执行；不得用 replacement ID 绕过未决行动。completed 后若 fresh planning 确有下一行动，只能由持久 sequence 签发新 ID；若返回现场只剩无收益 verified 往返边，则稳定 idle，不为制造新 ID 而重走楼梯。

## 刷新与故障

- fingerprint 等于 pre：`not_executed`，浏览器携带真实 pending 身份请求服务重发同一 action_id，绝不自行换 ID。
- 符合 expected post 且边界确有非位置变化：补记 completed。
- 两者都不满足：`RECOVERY_STATE_AMBIGUOUS` 暂停。

`reconnectOnly` 走同一分类并携带 phase/action ID/pre/current fingerprint，同时明确发送 `intent=reconnect_only`。服务在该 intent 下禁止进入 planner、decision cache 或 action issuance；无 unresolved 返回 idle，有 unresolved 返回同 identity 暂停。浏览器若收到违反门禁的 execute，持久保存 action ID/guard/response hash 并进入 `RECONNECT_UNEXPECTED_EXECUTE`，绝不执行。completed 分类在发送前只形成 recovery report，不清 pending；服务成功结算后必须用独立 idle + 同 ID `acknowledged_action_id` 明确确认。

fresh observation 在恢复分类前先按运行态数据模型归一钥匙：canonical `hero.items.tools` 中被引擎省略的零计数字段变成 `0`。因此门动作后的 `1 -> 字段删除` 可被 expected delta 判为 `1 -> 0`；若目标 block 也按声明消失，则 pending 进入 completed。这个过程只解释已发生的正常引擎动作，刷新、`reconnect_only` 和再次 reload 都不会重放行动 API。显式非法值或布局冲突在恢复分类前即 fail closed。

SQLite 状态机是 `IMPORT_WITNESS -> CONSISTENT_PRIVATE_SNAPSHOT -> CANDIDATE_SCHEMA_AND_BEHAVIOR_PROBE -> IDENTITY_RECHECK -> ATOMIC_GENERATION_MANIFEST -> GENERATION_CONNECT_RECHECK -> WAL`。调用方 pathname 只作导入 witness；分类后不再重开它。WAL/SHM 必须成对且 framing/size 合法，私有 probe 前后复核 source；发布和实际 connect 前后的 replace/swap 只能触发拒绝，不能让替换 inode 接受 DDL/WAL。manifest 指向 state dir 内权威 generation，重启从该 generation 恢复；candidate 崩溃残留在成功启动后清理。

fingerprint 包含 session、map instance、dimensions、topology、英雄面板、keys 和当前 blocks；忽略时间和 busy。

state dir 与 journal 共同组成身份链。`UNKNOWN_ACTION_ID` 不能解释为“没执行”；恢复原目录并只读核对。删除 state dir 属于用户明确授权的状态重置，不是重启。

pending 中的 pre observation 是恢复证据，不是可恢复进游戏的当前状态。恢复分类永远拿 fresh live observation 与它比较；任何代码都不得把 pre hero/resources 或 blocks 覆盖回现场，也不得把它当作新 cycle 的 current observation。

## 换图

出口目标可由游戏自身完整 floors/maps/event definitions 预解析；只有缺定义、动态脚本依赖或解析冲突时才保持 opaque。扫描状态以 SQLite 和浏览器 journal 持久化实际执行证据：anchor 固定接管起点，discover 处理仍 opaque/ambiguous 的安全出口，verified transition 不再作为“需要走一次”的 pending；sweep 仅在另一实例仍有 opaque pending 时通过 verified 边 reposition。预解析目标不能代替真实行动的 pre/post transition 结算；单向边导致真实 pending 无法安全返回时进入 paused，不消耗资源强行扩图。

completed action 的 pre/post map instance 不同才建立 transition，同 floorId 换图也算换图。未知目标由 `map_instance_id: null` 要求“实例必须改变”，已验证目标要求精确实例。跨图不拿两张地图的 blocks 做 removed/added 比较。重复 completed report 不重复建边；只有端点严格互换的实际反向边才升级为 reversible。

## 暂停

暂停会停止自动路线、关闭 autopilot、保存完整当前 observation 和结构化 evidence。未知对象、伤害、交互、guard、差分、API、session 和规划预算都 fail closed。只有用户明确启动或重连才能离开暂停态。

普通规划中的已登记 unsupported boundary 先作为不可穿越 frontier 留在图中。存在其他独立可达、标签完整且资源可承担的 supported 候选时不会进入 `PAUSED`；没有合法 supported 进展而仍有可达 unsupported 时，才进入 `UNSUPPORTED_INTERACTION / UNSUPPORTED_REGISTERED_INTERACTION`。这不改变 unknown block、unknown damage、incomplete label、busy、guard、recovery 或 delta 的优先 fail-closed 行为。

当前怪物 damage 原始值严格为 null/`???` 时先用同一 observation 的 `hero.attack` 与该坐标 `enemy.defense` 分类。若攻击不能穿透，它只是本轮 `known_unfightable` 阻挡：不进入 `PAUSED`、不穿越、不签战斗 action；没有其他进展时返回明确 idle。hero 攻击变化后的下一轮必须重新读取 `getEnemyInfo/getDamage` 并重新分类，不沿用 journal、SQLite snapshot 或旧派生结果。攻击已能穿透、defense 缺失/非法或字段冲突等无法解释情况进入 `UNKNOWN_DAMAGE / DAMAGE_UNEXPLAINED`；`undefined` 和其他非协议 damage 不参与攻防解释，采集侧直接 fail closed。

world-search 状态机把 live root 与所有 simulated node 明确分开。只有 `depth=0 + 无 first action + live map/position/resources + removed 为空` 的 root 能读取本轮战斗事实；enemy 候选写入排名后立刻终止该分支。任何非 root 节点（包括同图拾取后和 A→B→A 返回）都不能模拟 enemy outcome，必须先进入 `EXECUTING -> SETTLING -> REPORTING`，再由下一轮 `OBSERVING` 取得新战损。

world-search 对 verified transition 采用零奖励中间边语义：先检查 successor 是否已访问或被同状态更优路径支配，再决定是否入队；楼梯自身不写 best candidate。只有后继地图上的实际 supported frontier 能给整条路径计分，并把当前楼梯选为一个原子 first action。两图只有互返楼梯时没有候选，返回 idle；服务和浏览器重启不会把持久 verified edge 降级为 opaque 或重放 completed action。
