# Canonical tools 零钥匙省略恢复 QA

结论：PASS。

- 数据模型：canonical `hero.items.tools` 容器存在即声明三色钥匙布局；被引擎删除的零计数字段归一为 `0`，空容器归一为三色全零。这个规则不扩散到任意未知容器。
- Fail closed：显式 null/字符串/布尔/对象/NaN/Infinity/负数/非整数、非普通 tools 容器、同色长短别名冲突、多布局冲突、完全缺少可识别容器均拒绝；`hero.items.keys` 与 `hero.keys` 仍要求完整布局。
- 恢复：synthetic 黄门动作前 `yellow=1`，动作后 canonical tools 删除 `yellowKey`、门 block 消失且位置变化；fresh observation 得到 `yellow=0`，`keys.yellow=-1 + removed_blocks` 将 pending 分类为 completed。刷新 `reconnect_only` 上报同 action ID 并收到 ack，再次 reload 不携带 completed ID，也不调用任何移动 API。
- 回归：`105 JS + 97 Python + 1 integration = 203/203`。协议/schema、compile/syntax、双 dist 确定性、Acorn 静态盲玩、文档/JSON、diff 与隔离 prospective index 全绿。
- 边界：修复 Agent 未操作真实浏览器、未启动自动驾驶，也未读取或写入真实现场 `/tmp` 状态目录。

构建物：

- `dist/mota-planning-lab.user.js`: `sha256:d572bbd91c19db3f38f2a7b7ab16e90732592a25c716b9123ff62d86aa366462`
- `dist/mota-planning-lab.direct-mount.js`: `sha256:f90b9e9778876721aa89e8d3f7fe8eeae8518ce872042532432e0a11162f88cf`
