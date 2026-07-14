# verified stair 循环整改 QA 摘要

结论：离线开发验证通过，待主会话派发全新只读验收。不能用本摘要替代独立验收或真实页面复核。

## 最终语义

- opaque/ambiguous exit 仍由 takeover scan 发现；唯一 verified transition 已经完成发现，不再因为“扫描尚未走过”成为 pending。
- verified stair/portal 的 progress/reward 为零，只能作为通往远端实际 supported frontier 的中间边。
- transition successor 在写候选或奖励前按 `map + position + live-derived resources + removed` 检查 visited/dominance；A→B→A 同状态返回不产生候选。
- 只有互返楼梯且无其他实际进展时稳定 idle；当前图有 redDoor 时选择 `OPEN_DOOR`。
- 远端确有安全非敌人 frontier 时，当前 stair 可作为唯一第一原子行动，但 score/reason 来自远端目标。
- 历史 enemy 仍是 root-live-only；known-unfightable、未知 damage、pending/recovery、动态图/异形、多 map 与盲玩门禁没有放宽。

## AUTO3/4/5 synthetic 结果

1. AUTO3：MT1 的未知 `downFloor` 以 `SCAN_OPAQUE_EXIT` 首次发现，仍只有一个楼梯边界。
2. AUTO4：transition 建立后 scan 进入 complete；MT0 的 verified `upFloor` 只有因为 MT1 存在实际 `redDoor` 才成为第一步，reason 指向 `MT1 redDoor`。
3. AUTO5：回到 MT1 后直接选择 `OPEN_DOOR`，不选择 verified `downFloor`，不形成 ping-pong。

completed/ack synthetic 测试在隔离临时 SQLite 中重启服务：verified transition 保持一条，action 保持一条，重复 completed 返回同 ack，下一普通 cycle idle，零重放。

## 测试结果

- 红灯：4 项中 3 项按预期失败，直接证明 stair bonus、return stair 优先和远端目标丢失；1 项既有 restart/traversed 情形已通过。
- 完整离线 QA：`111 JS + 114 Python + 1 integration = 226/226`。
- Protocol Pydantic/JSON Schema、compile/syntax、双 dist 确定性、Acorn 静态盲玩、docs/JSON、`git diff --check` 与隔离 prospective staged check 全部通过。
- userscript SHA-256：`68be8d7d1fee049caaba36c43f877bfc817f4b3db71085e8f49889a3698ab4e7`。
- direct mount SHA-256：`524fbe3f3370d52d226b2bfae01ec42c8af7973886d2f918e0ea6ffb56e76651`。
- 本轮仅修改 Python service/tests/docs/QA，双 dist 与 HEAD 内容 hash 一致。

## 边界

修复 Agent 未操作真实浏览器、真实游戏、存档或 localhost 自动驾驶；未读取/写入真实 state/knowledge 目录。真实现场中尚未 ACK 的 AUTO5 由主会话在独立验收后按正常恢复链处理。本轮没有任何版本控制写操作。
