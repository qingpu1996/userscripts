# 世界模型与物理遍历扫描

## 节点不是楼层数字

SQLite 以 session 内的 `map_instance_id` 保存节点，并附带 floorId、显示楼层、dimensions、topology fingerprint、首次/最近进入时间与不可变拓扑。相同显示楼层可以有多个 floorId；相同 floorId 的拓扑变化会形成新节点，不覆盖旧快照。

世界图中的 snapshot 是带 fingerprint/captured time 的历史观察证据，不是当前状态镜像。服务给规划器的 `HistoricalMapFact` 只含地图身份、topology、当时动态 blocks 和 `observed_anchor`；明确删除历史 hero、keys 与 busy。完整 observation 仍留在 action ledger 侧用于恢复和差分审计。重访同一 map instance 时，最新 revision 成为动态规划视图，旧 revision 保留证据；当前英雄资源始终从本轮请求 observation 注入模拟。每轮 `engine_model` 直接提供完整 floors/maps/material 定义和所有动态 maps，服务只临时派生全局 block identity 语义与当前 floor 模型，不持久化第二份权威缓存；模型中的当前 floor 动态 blocks 与 fresh observation 冲突时，以 observation 为执行真值。

## 持久物理扫描状态机

当前 v2 兼容扫描状态机仍可按以下步骤验证实际 transition；这不是读取边界。策略层可以先枚举游戏自身所有 maps/definitions 建模，扫描状态机只负责证明执行落点、动态变化和行动结算：

1. `anchor`：显式确认后的当前 map instance 成为接管锚点，并与第一份 snapshot 同事务落库。
2. `discover`：计算当前 topology 的无消耗可达区域；没有合法目标的安全楼梯/传送出口登记为 opaque pending，冲突目标登记为 ambiguous pending。唯一合法目标已存在的 verified transition 已经完成发现，不再成为 pending。
3. `sweep`：优先执行当前可达的 opaque pending；需要回到其他实例处理另一个 opaque pending 时，才把历史上真实经过、目标 snapshot 仍匹配且落点有效的 verified transition 当作无收益 reposition 边。
4. 每次真实 change-map 后读取 post observation，在 action completion 事务中同时确认 action、建立有向边、更新 current/scanned/traversed 和 audit。
5. `complete`：没有安全 pending 后才开放普通资源规划；以后出现新安全出口会重新激活扫描。
6. `paused`：仍有 pending 但受单向边或不可达约束时安全停止，不通过打怪、开门、拾资源来强行完成扫描。

出口目标可以从游戏自身楼层/事件定义预解析；没有静态定义、目标依赖动态脚本或解析结果冲突时才保持 opaque。无论是否已预读，执行结算仍要求 completed action 的真实 pre/post observation 唯一确认目标 map instance、floorId 和 landing；静态定义不能替代这条证据。显示楼层数字只作排序提示，verified edge 在 restart 后仍由持久 transition 身份判为已执行验证。

扫描行动仅允许安全空走廊加一个已登记 stair/portal 边界，且资源、钥匙和 block 差分必须为零；不会为了扩图主动打怪、开门、拾资源、访问 NPC 或触发未知机关。扫描 complete 后，普通规划器才可另行签发资源边界并在完成后重新计算连通性。

## Frontier

frontier 记录 session、map instance、坐标、block id、open/resolved 状态和最后 snapshot。引擎已定义的墙、普通地形、门、资源、怪物和楼梯自动分类；只有引擎定义仍无法解释的复杂事件保持 opaque。已知普通边界直接参与自动比较。边界从真实动态 blocks 消失后才标记 resolved。

已登记但 `supported=false` 的边界是“不可穿越的未解决 frontier”，不是整张当前地图的全局否决。可达性建图始终把它当作阻挡，因此本轮路线、空走廊快速移动和世界搜索都不能经过该坐标；若同一现场还有独立可达、标签完整且当前资源可承担的 supported 候选，规划器跳过该旁支并继续签发一个 supported 原子边界。只有不存在此类合法进展、同时仍有可达 unsupported frontier 时，才按 `distance → y → x → id → cls → trigger` 确定性选择证据并暂停。unknown block、未知战损和 incomplete label 等 fail-closed 门禁不参与这种跳过。

怪物可战斗性不是持久知识标签。当前 observation 中 damage 为有限非负整数才可进入战斗候选；只有 `getDamage()` 原始返回严格 null/`???` 且能由当前 `hero.attack <= enemy.defense` 解释时，该格才按 known-unfightable enemy boundary 阻挡，普通路线、fast path、接管扫描与世界搜索都不得穿越，但同图其他独立可达 supported frontier 继续比较。`undefined` 等非协议值不能归一成 null 后复用这条规则，而是在浏览器采集边界 fail closed。只有已解释阻挡且无其他进展时返回明确 no-progress idle，不要求人工补“怪物模型”。下一 cycle 用新 hero 与新坐标接口结果重新分类。

历史 `HistoricalMapFact` 为审计和几何所保留的 enemy stats/damage 永远不得成为模拟战斗权威。world search 的 enemy edge 必须同时满足：队列节点是本轮唯一初始 root、使用原始 live observation、位置和完整资源仍等于 live 值、尚未移除任何 block、路径尚无第一边界。这样的当前直接可达敌人只可成为一个终端原子候选，不能扩展战后后继。只要路径已模拟资源、门、楼梯、其他战斗、地图切换或任意状态变化，后续 enemy 一律保持阻挡且不计收益；A→B→A 回到相同 map id 也不会恢复新鲜度。必须先真实执行前一边界并重新逐坐标采集，下一 cycle 才能重新评价怪物。

## 规划状态

规划输入是：

- 游戏完整定义中的 map instances 与动态观察 revisions；
- 实际经过的 transitions；
- 当前英雄资源；
- 各节点剩余 frontier；
- 当前 topology 中的可达性。

其中“当前英雄资源”只能来自本轮 live observation。历史地图中的角色面板即使存在于审计记录，也不能进入世界规划上下文。可达性、路线、排名与搜索队列均为单轮派生值，不持久化为下一轮当前事实。

模拟非战斗边界后必须移除/更新该占用并重算可达性，不能将所有候选当作任意排列。搜索可用游戏静态定义和历史几何比较第一步，但不能借旧怪物战果覆盖 fresh runtime。已静态解析的换图可进入预测模型；真正执行后仍由实际 transition 校验，冲突立即暂停。

verified stair/portal 是世界搜索中的零收益中间边，不是终端候选。搜索只有在目标 snapshot 上找到资源可承担、标签完整且安全的真实非循环 frontier 后，才允许把当前 stair 作为返回响应的第一原子行动；响应估值和 reason 指向该远端实际目标。transition successor 在产生候选或奖励前先按 `map_instance_id + position + current resources + removed set` 做 visited/支配检查，因此 A→B→A 的同状态返回既没有 stair bonus，也不会制造候选。若只有互返楼梯则稳定 no-progress idle；当前图存在 redDoor 等直接进展时，无远端收益的返回边不参与 fallback 排名。规划器有显式节点预算；预算耗尽返回审计暂停。

transition 的可逆性按 map pair 加精确端点判断，不按地图对粗略推断。A 的出口坐标、B 的落点坐标必须在反向观察中严格对调；同一 A/B 上另一组 portal 仍保持单向，直到自己的严格反向边被真实走过。

## 原子边界

目标选择与路线执行分离。纯空走廊可用 `moveDirectly`；长走廊末端是边界时，先快速移动到已验证的边界前一格，最后一格仍用 `setAutomaticRoute` 触发。相邻边界直接使用正常寻路；direct 不可用时回退完整 `setAutomaticRoute`。direct 前缀后的安全比较使用 full observation 与 fast snapshot 共有的 runtime-only 投影：忽略位置和仅 full 形状携带的引擎目录 hash，但仍比较人物面板、钥匙、楼层、地图实例、尺寸、拓扑和当前动态 blocks（含战损）；任何非位置现场变化都立即暂停。每轮最多一个状态变化，完成后完整重读 observation、稳定两轮、校验差分，再事务性更新 action ledger、world snapshot 和可能的 transition。
