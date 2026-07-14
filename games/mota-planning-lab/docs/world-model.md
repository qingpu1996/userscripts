# 世界模型与物理遍历扫描

## 节点不是楼层数字

SQLite 以 session 内的 `map_instance_id` 保存节点，并附带 floorId、显示楼层、dimensions、topology fingerprint、首次/最近进入时间与不可变拓扑。相同显示楼层可以有多个 floorId；相同 floorId 的拓扑变化会形成新节点，不覆盖旧快照。

世界图中的 snapshot 是带 fingerprint/captured time 的历史观察证据，不是当前状态镜像。服务给规划器的 `HistoricalMapFact` 只含地图身份、topology、当时动态 blocks 和 `observed_anchor`；明确删除历史 hero、keys 与 busy。完整 observation 仍留在 action ledger 侧用于恢复和差分审计。重访同一 map instance 时，最新 revision 成为规划视图，旧 revision 保留证据；当前英雄资源始终从本轮请求 observation 注入模拟。

## 持久物理扫描状态机

接管不是枚举内存中所有 maps，也不是按楼层数字循环：

1. `anchor`：显式确认后的当前 map instance 成为接管锚点，并与第一份 snapshot 同事务落库。
2. `discover`：计算当前 topology 的无消耗可达区域，把安全楼梯/传送出口登记为 verified 或 opaque pending。
3. `sweep`：优先执行当前可达 pending；需要回到其他实例时，只使用历史上真实经过、目标 snapshot 仍匹配且落点有效的 transition。
4. 每次真实 change-map 后读取 post observation，在 action completion 事务中同时确认 action、建立有向边、更新 current/scanned/traversed 和 audit。
5. `complete`：没有安全 pending 后才开放普通资源规划；以后出现新安全出口会重新激活扫描。
6. `paused`：仍有 pending 但受单向边或不可达约束时安全停止，不通过打怪、开门、拾资源来强行完成扫描。

未知出口始终 opaque：搜索只评价“执行一次出口边界”，不假设出口后仍位于原地图，也不评价其后资源。已验证出口必须能唯一关联同 session 的最新合法目标 snapshot，且 floorId、topology、dimensions 与 map-instance 元数据一致，landing 坐标有效；签发时 expected delta 精确绑定目标 `map_instance_id + floor_id`。同一出口出现多个冲突目标时暂停审计，数据不完整则保持 opaque，绝不任选其一。显示楼层数字只作遍历顺序提示。

扫描行动仅允许安全空走廊加一个已登记 stair/portal 边界，且资源、钥匙和 block 差分必须为零；不会为了扩图主动打怪、开门、拾资源、访问 NPC 或触发未知机关。扫描 complete 后，普通规划器才可另行签发资源边界并在完成后重新计算连通性。

## Frontier

frontier 记录 session、map instance、坐标、block id、open/resolved 状态和最后 snapshot。未知对象会暂停等待标签；已登记普通边界可参与自动比较。边界从真实动态 blocks 消失后才标记 resolved。

## 规划状态

规划输入是：

- 已探索 map instances；
- 实际经过的 transitions；
- 当前英雄资源；
- 各节点剩余 frontier；
- 当前 topology 中的可达性。

其中“当前英雄资源”只能来自本轮 live observation。历史地图中的角色面板即使存在于审计记录，也不能进入世界规划上下文。可达性、路线、排名与搜索队列均为单轮派生值，不持久化为下一轮当前事实。

模拟边界后必须移除/更新该占用并重算可达性，不能将所有候选当作任意排列。未知换图分支在出口处终止；已验证换图才可进入目标 snapshot 继续搜索。规划器有显式节点预算；预算耗尽返回审计暂停。当前实现支持已验证跨图返回和拓扑重算，但未宣称穷举整局最优路线。

transition 的可逆性按 map pair 加精确端点判断，不按地图对粗略推断。A 的出口坐标、B 的落点坐标必须在反向观察中严格对调；同一 A/B 上另一组 portal 仍保持单向，直到自己的严格反向边被真实走过。

## 原子边界

目标选择与路线执行分离。空走廊可用 `moveDirectly`；边界用 `setAutomaticRoute`。每轮最多一个状态变化，完成后完整重读 observation、稳定两轮、校验差分，再事务性更新 action ledger、world snapshot 和可能的 transition。
