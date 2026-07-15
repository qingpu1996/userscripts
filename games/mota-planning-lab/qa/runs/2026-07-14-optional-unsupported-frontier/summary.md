# Optional unsupported frontier 修复 QA

- 结果：PASS。
- 完整 QA：`104 JS + 97 Python + 1 integration = 202/202`。
- 根因红灯：修复前的 13×13 序章同形 synthetic observation 中，hero `(6,10)`、optional NPC `(5,9)`、黄门 `(6,8)`、黄钥匙 `1` 错误返回 `UNSUPPORTED_REGISTERED_INTERACTION`。
- 正向行为：修复后签发单一 `OPEN_DOOR`，末端 operation 为 `(6,8)`，expected key delta 为 `yellow=-1`，operations 不含 NPC 坐标。
- 阻挡行为：NPC 位于唯一有效走廊 `(6,9)` 时，黄门不进入 reachable candidates，结果保持 unsupported pause 且没有 action ID。
- 资源门禁：黄钥匙为 `0` 时黄门不可承担；若另有可达 unsupported frontier，则确定性暂停而不误开门。
- Fail closed：unknown block、unknown damage 和 incomplete label 与 optional unsupported 并存时仍按原硬门禁暂停；原有 guard、delta、幂等、恢复和单边界测试全部通过。
- 扫描与世界搜索：takeover scan 仍只选择 supported 的安全 stair/portal；普通 world search 跳过 unsupported，且 `CurrentFloorGraph` 将其作为 blocked cell，不能模拟穿越。
- 构建与合规：双 dist 两次构建 hash 稳定；Acorn 静态盲玩、协议/schema、compile/syntax、docs/JSON、git diff 与隔离 prospective staged check 全绿。
- 未运行：真实页面、真实移动、真实存档与外网；本轮仅使用 synthetic observation、fake core 和 localhost integration fixture。
