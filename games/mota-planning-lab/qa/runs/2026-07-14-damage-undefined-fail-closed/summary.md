# getDamage undefined fail-closed 验收整改 QA

结论：修复 Agent 离线验证 PASS；等待全新只读验收，不以本文件替代验收门禁。

- 严格 damage 值域：有限非负整数是可战斗战损；只有原始值严格 null/`???` 且本轮 hero attack 不穿透当前 enemy defense 时才是 known-unfightable。`undefined`、NaN、Infinity、负数、非整数、其他字符串、对象和布尔值全部 fail closed。
- 原始证据：非法值的暂停使用 `UNKNOWN_DAMAGE / DAMAGE_UNEXPLAINED`，保留 block x/y/id/cls/trigger、类型安全的 `raw_damage`、hero attack、enemy defense、当前怪物字段和 normalized 投影。
- 双层 wire 门禁：浏览器 controller 在采集失败后 localhost 请求为零、行动 API 为零；服务 Pydantic 与 JSON Schema 同时要求显式 `damage` 字段并拒绝负数等非协议值，防止 JavaScript `undefined` 经 JSON property omission 伪装成 null。
- 未削弱项：明确 null/`???` 的可解释/不可解释分支、root-live-only world search、同图和 A→B→A 的旧敌人事实禁用、alias own-property 严格性、pending completed/ack、浏览器/服务重启零重放、零钥匙、optional unsupported 和盲玩边界全部回归通过。
- 完整离线 QA：`111 JS + 108 Python + 1 integration = 220/220`。Protocol Pydantic/JSON Schema、Python compile、JS syntax、双 dist 确定性、Acorn 静态盲玩、文档/JSON、`git diff --check` 和隔离 prospective staged index 均通过。
- 严格边界：修复 Agent 未操作真实浏览器或自动驾驶，未读取/写入真实现场 state/knowledge 目录，未执行 stage、commit、push、PR、rebase、squash 或 merge。

构建物：

- `dist/mota-planning-lab.user.js`: `sha256:68be8d7d1fee049caaba36c43f877bfc817f4b3db71085e8f49889a3698ab4e7`
- `dist/mota-planning-lab.direct-mount.js`: `sha256:524fbe3f3370d52d226b2bfae01ec42c8af7973886d2f918e0ea6ffb56e76651`
