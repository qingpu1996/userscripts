# 魔塔规划实验室运行态代理

Protocol v2 是一个运行态驱动的本地盲玩代理。浏览器端只读取英雄实际所在的当前动态地图，本地服务把每次亲自进入过的地图实例持久化为世界图，并且每次只签发一个可验证的原子边界行动。

它不是针对某一层或某种尺寸的脚本。地图尺寸、有效格拓扑、英雄初态和会话基线全部来自本轮 observation；显示楼层名称和数字仅是元数据。

## v2 设计

```text
当前动态运行态
  -> dimensions + topology + map instance observation
  -> 显式会话基线确认
  -> 已探索 map-instance 世界图
  -> 当前资源与 frontier 预算搜索
  -> 一个原子行动
  -> guard / 稳定两轮 / 真实差分
  -> transaction ledger + transition edge
```

- 动态矩形：支持 `1..256` 的宽高，运行时和测试没有固定 11×11 或 13×13 分支。
- 异形地图：只要当前动态 map 暴露 grid，就与 dimensions 联合核验；缺行、短行和空洞生成显式 `valid_cells`，只有完整矩形才能标记 `rectangle/confirmed`，冲突则暂停。
- 多图同层：节点身份是 `session_id + map_instance_id`。`floor_number` 和名称不参与主键。
- 拓扑版本：同一 `floor_id` 的新 `topology_fingerprint` 生成新 map instance，不覆盖历史快照。
- 物理扫描：接管先进入持久 `anchor/discover/sweep/complete/paused` 扫描状态机；未知出口目标保持 opaque，只有正常行动真正换图后才用 pre/post observation 建边。
- frontier：扫描不会为看图而打怪、开门、取资源或触发未知机关；这些对象留作单独规划边界。
- 世界规划：每轮以持久 map instances、transitions、frontiers 和当前资源重新计算可达性；边界消失后不会继续沿用旧连通性。
- 已验证换图边零收益：verified stair/portal 只可作为通往远端实际可执行 frontier 的中间边，本身不算进展、不进入终端排名；A→B→A 回到同一地图/位置/资源/removed 状态会在入队前被支配剪枝。只有互返楼梯时稳定 idle，当前图有合法门/资源时不会被无收益返回楼梯压过。
- Unsupported frontier：已登记但尚不支持的边界始终不可穿越；若另有可达且资源可承担的 supported 边界则跳过该旁支继续规划，只有不存在合法进展时才确定性暂停取证。
- 当前唯一权威：hero、keys、位置、busy 和当前 blocks 每轮只来自页面 JS 的同步 observation；历史完整 observation 只作恢复审计，规划前投影为不含 hero/resources 的地图事实。
- 钥匙零值语义：canonical `hero.items.tools` 容器存在即是三色钥匙布局；引擎删除归零的 `*Key` 字段时归一为 `0`，显式非法值、别名冲突和多布局冲突仍立即暂停。
- 怪物实时语义：每轮逐坐标直接读取当前 `getEnemyInfo/getDamage`，严格归一 `atk/attack`、`def/defense`、`money/gold`、`exp/experience`；不建立本地怪物属性库。别名字段只有完全缺席时才可按协议归一为 null，显式 `undefined/null`、非有限数、字符串、非整数或负数均以 `ENGINE_API_INCOMPATIBLE / INVALID_RUNTIME_FIELD` 拒绝。只有 `getDamage()` 原始返回严格 null/`???` 且实时攻防可解释时，才表示当前不可战斗阻挡；`undefined` 等非协议返回值保留 raw evidence 后 `UNKNOWN_DAMAGE / DAMAGE_UNEXPLAINED` 暂停，绝不发送给服务。
- 战斗 root-live-only：world search 只能把未模拟任何状态变化的本轮 live root 怪物作为一个终端原子候选；拾资源、开门、换图、其他战斗或 A→B→A 返回后，即使 map id 相同，也不得消费旧 enemy stats/damage 或给未来战斗计分，必须先执行前一个边界并取得 fresh observation。
- 防撕裂采集：读取当前 map/blocks/怪物前后核对 floor、完整 hero/keys 与 moving/lock/event 围栏；不稳定时重试后 fail closed，绝不拼接跨时刻现场。
- 安全执行：保留 action ledger、浏览器 journal、唯一 action_id、guard、稳定两轮、真实 expected delta 与最多一次执行。

## 会话基线

新 journal 不会自动接受任意现场。首次稳定 observation 只展示和导出，用户必须点击面板“确认基线”或油猴菜单“确认新会话基线”。服务端还会要求显式 `session.command=confirm`。

三种模式：

- `new_game`：从当前新游戏现场建立会话。
- `handoff_expected_guard`：用外部会话配置给出的完整 guard 逐字段核对后接管。
- `resume_existing_ledger`：只恢复同一 `MOTA_LAB_STATE_DIR` 中已经确认的 session。

Protocol v1 journal 和数据库不会被静默当成 v2。userscript 与 direct mount 在构建时写入不同的显式 mode marker；缺任一必需 GM API 都暂停 `USERSCRIPT_API_UNAVAILABLE`，绝不降级到 direct-mount `localStorage`。浏览器 journal 使用 A/B 双 generation 槽：每个 envelope 绑定单调 generation、上一 committed generation/hash、canonical state/hash、commit hash 和首次导入 witness；写入永远落到非当前最高槽，完整读回前不覆盖当前最高合法 identity，也不依赖单 pointer。部分写、截断、变形、no-op 和异常会暂停，但刷新仍可从旧完整槽或已完整落盘的新槽唯一恢复。旧单 key v2/v1/corrupt 内容只作只读 witness，安全导入后仍保留，内容变化重新 quarantine。pending 未 durable 前绝不调用引擎；completed/ack 失败保留可恢复链。

SQLite 分类前绝不连接导入 pathname，包括 `mode=ro`。服务对 main/WAL/SHM 做双读和 identity/hash 复核，只在 state dir 的私有 candidate generation 执行结构/行为探针；通过后原子发布 manifest，正常 SQLite 只连接已经分类且再次核对身份的 generation。任何 snapshot→open rename/swap 都不能把未经分类的 inode 导向 DDL/WAL；legacy、partial、unknown、future、复制中变化和损坏 manifest 均保持替换库原态并拒绝。详见 [SQLite generation 与恢复](docs/storage.md)。

同一 session 在 SQLite 中最多有一个 `issued` 行动。普通循环发送 `intent=cycle`；菜单“仅重新连接”发送 `intent=reconnect_only`。后者只检查连接、ACK 与 unresolved identity，服务绝不签发新 action/decision。若错误服务仍返回 `execute`，浏览器零执行并把 action ID、guard 与响应 hash 保存为隔离证据。服务仅在成功结算后用 `acknowledged_action_id` 的独立 idle 响应确认，浏览器核对同一 ID 后才清 pending/ack。

## 构建物

- Tampermonkey：仓库根 `dist/mota-planning-lab.user.js`
- direct mount：仓库根 `dist/mota-planning-lab.direct-mount.js`

direct mount 不要求扩展；它只使用精确命名空间下的旧 witness key 与 `journal:v2:slot:a/b`，不使用 pointer，也不枚举其他 storage key。服务默认拒绝跨域，必须用精确 origin 参数显式开启，详见[安装与启动](docs/install-and-run.md)。两个模式都不会自动打开游戏、确认基线或开始行动。

## 快速验证

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

QA 包含 11×11 回归、13×13、7×19、ragged/异形空洞、多 floorId 同显示层、同 floorId revision、精确/歧义/opaque transition、持久接管扫描、浏览器 A/B generation 故障注入、SQLite WAL 私有快照、observe-only reconnect、显式 completed ack、session-wide 单未决行动、CORS、direct-mount fake core、协议三侧和 AST 静态盲玩检查。静态门禁固定 vendored Acorn 8.16.0（MIT，hash/provenance 校验），覆盖 parentheses/sequence、词法 binding shadow、多级 global/Object/Reflect alias、声明与赋值 destructuring、IIFE/简单本地调用实参传播、常量字符串折叠和 `call/apply/bind`，并保留合法 current-runtime 只读与局部对象 mutation 正例。

## 文档

- [Protocol v2](docs/protocol.md)
- [当前运行态唯一权威](docs/live-runtime-authority.md)
- [世界模型与物理扫描](docs/world-model.md)
- [状态机与恢复](docs/state-machine.md)
- [SQLite generation 与恢复](docs/storage.md)
- [安装与 direct mount](docs/install-and-run.md)
- [严格盲玩合规](docs/blind-play-compliance.md)
- [人工打标](docs/manual-labeling.md)
- [QA Runbook](docs/qa-runbook.md)
- [实施任务](TASK.md)

## 当前限制

离线实现不会伪装成全游戏穷举求解器。当前规划是“持久世界上下文 + 当前可达 frontier 的预算搜索”；商店、复杂选择、剧情和真实存档分支仍会暂停。本轮 verified stair 循环修复使用 synthetic map instances 和隔离 journal/SQLite 证明 opaque 首次发现、verified 中间边零收益、跨图 successor 入队前支配剪枝、AUTO3/4/5 序列选择远端实际目标及重启零重放；修复 Agent 不操作真实浏览器或现场状态目录，现场复核由主会话在独立验收后统一安排，见 [QA 证据](qa/README.md)。
