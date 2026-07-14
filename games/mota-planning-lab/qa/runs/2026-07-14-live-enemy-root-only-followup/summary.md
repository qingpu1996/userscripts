# 怪物事实 root-live-only 验收整改 QA

结论：修复 Agent 离线验证 PASS；等待全新只读验收，不以本文件替代验收门禁。

- world search 形式化约束：enemy edge 只允许出现在 `depth=0`、`first is None`、map/position/resources 等于本轮 live observation 且 `removed` 为空的唯一 root。root 直接可达、有限 damage 的敌人仍可作为一个原子候选，但该分支立即终止；任何模拟状态变化后不消费、不计分、不穿越旧 enemy facts。
- 同图与返回反例：`redGem(+attack) → enemy`、不改变 attack 的 potion → enemy、A→B→A 从另一入口接近 enemy 均只评价前面的非战斗进展，旧怪物的高额收益不再污染第一行动。map id 相同不恢复战损新鲜度。
- alias 存在性：`atk/def/exp/money` 只有对应语义的两个 own property 都缺席时才视为缺席；任一显式 `undefined/null/NaN/Infinity`、字符串、非整数或负数均立即 `ENGINE_API_INCOMPATIBLE / INVALID_RUNTIME_FIELD`。attack/defense 完全缺席可按协议归一 null；gold/experience 缺席继续 fail closed；双别名同值通过，冲突继续 fail closed。
- 未削弱项：known_unfightable 仍按本轮实时攻防阻挡但不全局暂停；真正 unexplained damage 仍暂停；takeover scan 不穿越怪物；MT0→MT1 pending 仍先 completed/ack；浏览器 reload/reconnect 与服务重启均零重放；每次仍只签一个状态边界。
- 完整离线 QA：`108 JS + 107 Python + 1 integration = 216/216`。Protocol Pydantic/JSON Schema、Python compile、JS syntax、双 dist 确定性、Acorn 静态盲玩、文档/JSON、`git diff --check` 和隔离 prospective staged index 均通过。
- 严格边界：修复 Agent 未操作真实浏览器或自动驾驶，未读取/写入真实现场 state/knowledge 目录，未执行 stage、commit、push、PR、rebase、squash 或 merge。

构建物：

- `dist/mota-planning-lab.user.js`: `sha256:d00d9608a0aef2ef738c01b7eda2a023099b8d433cd5a8d71bbb309bb8bd77ab`
- `dist/mota-planning-lab.direct-mount.js`: `sha256:6cae2ffc12f93c4f21b5ec3e48d2271b224659cbebe8b2655d78a6d213ef27e5`
