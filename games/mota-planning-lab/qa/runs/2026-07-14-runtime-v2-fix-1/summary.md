# Protocol v2 首轮验收整改结果

状态：离线 QA PASS，等待全新只读验收；不代表真实页面验收。

## 修复证明

- v1 journal：固定遗留 key 优先于已有 v2 状态；普通确认、启动、重连不能绕过；专用归档与 archive-id 确认留下审计链。direct mount 使用独立 quarantine key。
- SQLite：非空 version 0、v1、future、未知/不完整 v2 在任何 schema 写入前拒绝；测试逐字节并逐 schema 核对拒绝前后不变。
- map instance：同 floorId A→B 和跨 floorId A→C 都按换图结算；未知/精确目标均可断言；跨图不比较无关 blocks。
- takeover scan：`anchor/discover/sweep/complete/paused`、pending、traversed 与 audit 持久化；重启保持；单向不可返时 paused；扫描期不选择资源、门、怪物、NPC 或机关。
- opaque exit：未知目标在出口边界终止，不在原地图继续评价其后资源；已验证目标还需最新合法 snapshot、元数据和落点一致。
- topology：dimensions 与当前动态 grid 联合校验；ragged、缺行、短行、洞变成 `valid_cells`，完整矩形才 confirmed，冲突拒绝。
- reversible：同 map pair 中只有精确端点互换的真实反向边可逆，其他 portal 保持单向。
- protocol：错误文案明确 Protocol v2；Schema/Pydantic/browser parser 对 `map_instance_id`、`scan_state` 和显式 null 规则一致。

## 最终结果

- fixture/schema provenance：7 active JSON fixtures，PASS。
- JavaScript：66/66 PASS。
- Python unittest：77/77 PASS。
- localhost fake-core integration：1/1 PASS。
- 自动化测试合计：144/144 PASS。
- Protocol wire：1 observation + 4 responses，PASS。
- 静态盲玩扫描：18 browser + 16 service files + 两个 dist，PASS。
- 文档/JSON：25 Markdown、18 local links、17 JSON，PASS。
- 双次确定性构建、compile/syntax、diff/check：PASS。
- 真实 Git index 检查前后哈希均为 `f2e2321282b6086cd29edc4ed4c91c24f79a5fc2d27529ec3431369bb2ed3989`。

## 未覆盖与交付门

- `not-run`：真实游戏页面、真实存档、真实移动/换图、内置浏览器注入、外网。
- 未宣称整局全局最优；当前证明的是运行态边界、持久扫描、原子执行和有限预算规划的离线正确性。
- 必须由主会话新建未参与开发的只读验收 Agent；验收通过前不可交付，push 前仍需用户明确确认。
