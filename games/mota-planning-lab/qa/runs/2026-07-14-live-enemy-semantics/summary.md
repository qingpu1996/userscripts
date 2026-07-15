# 当前怪物实时语义 QA

结论：PASS。

- 运行态权威：怪物属性不进入本地模型；每轮只使用当前层当前坐标的 `getEnemyInfo/getDamage`，严格归一 `atk/attack`、`def/defense`、`money/gold`、`exp/experience`。双别名同值通过，冲突或非法值 fail closed；`special:0` 归一为 `[]`。历史 map fact 的 enemy stats 仅作审计，world search 不在非当前 map 上模拟战斗。
- 当前不可战斗：damage 为 null/`???` 且本轮 `hero.attack <= enemy.defense` 时，enemy 仍是不可穿越边界，但不全局暂停、不进入战斗候选；独立资源/门/楼梯/可战怪仍可规划。唯一通路被挡时返回明确 idle，不要求人工补怪物模型。
- 实时重判：同一 enemy 在 attack 10/defense 10 时 blocked；下一 observation attack 11 且引擎返回有限 damage 后立即成为战斗候选，不使用历史缓存。
- 真未知取证：attack 已能穿透、defense 缺失、别名冲突、非法属性或其他无法解释情况保持 `UNKNOWN_DAMAGE / DAMAGE_UNEXPLAINED`，证据包含 block identity、raw damage、当前怪物字段与 hero attack。
- 恢复顺序：synthetic MT0→MT1 楼梯完成后，MT1 含 damage null 的实时不可战斗怪物仍可形成完整 observation；服务日志先 `action_completed` 再 `completed_action_acknowledged`。浏览器刷新、reconnect 与服务重启均不重放，行动 API 调用数为零，SQLite 只有原 action 且无 unresolved。
- 回归：`108 JS + 103 Python + 1 integration = 212/212`。额外的显式回归证明 takeover scan 与 world search 都不会穿越 `known_unfightable`。协议/schema、compile/syntax、双 dist 确定性、Acorn 静态盲玩、文档/JSON、diff 与隔离 prospective index 全绿。
- 边界：修复 Agent 未操作真实浏览器、未启动真实自动驾驶，未读取或写入 `/tmp/mota-planning-lab-live-authority-20260714-fix8972` 或真实 knowledge 目录。

构建物：

- `dist/mota-planning-lab.user.js`: `sha256:a4cbfd777be6ba065f2d5037c4d0e8277d23ffd137e6ed2d447cdf2d87fd91e4`
- `dist/mota-planning-lab.direct-mount.js`: `sha256:9035667144826a40af745a834a7b9b9b3d16b1556de2a5b7cb7f9dbf6c7686e6`
