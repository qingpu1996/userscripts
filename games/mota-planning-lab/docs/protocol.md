# Protocol v2

浏览器向 `POST /cycle` 发送当前完整 observation、当前实例 session command、可选 completed action 和当前内存 recovery phase。服务返回 `execute | idle | pause | error`。

## Observation

必须包含 floor/map identity、dimensions、topology、hero、keys、busy、动态 blocks 和 capture time。引擎模型提供本轮静态目录与动态 maps；当前 floor observation 冲突时，以当前 observation 为行动真值。怪物字段只来自本轮 `getEnemyInfo/getDamage`，非法或无法解释的数值 fail closed。

## Session 与行动

新页面先 observe，显式确认后才能行动。当前兼容 schema 仍接受旧 mode 枚举，但 production 不据此读取任何旧状态；服务或页面重启后建立 fresh session。

同一实例同一 session 最多一个 in-flight action。行动包含唯一 ID、guard、operations 和 expected delta。调用游戏 API 前再次采集并比较 guard；执行后要求相同结果稳定两轮并校验 delta。完成请求可携带 `completed_action_id`，服务 ACK 后才释放当前内存 identity。

重复 cycle 或重复启动不能产生第二个 action；当前 pre-state 仍一致时只能返回相同 identity。guard、结果或 identity 无法解释则暂停。同进程商店 `menu_choice` 也遵守 at-most-once。

`intent=reconnect_only` 不进入 planner，不签发 action，只检查当前实例连接与当前内存 identity。实例重启后没有旧 action 可恢复。

## 错误边界

协议、引擎 API、采样稳定性、未知交互、guard 或 expected delta 失败均返回结构化 pause/error，且不执行下一动作。运行状态不进入浏览器 storage 或文件系统；用户主动导出诊断不参与协议恢复。
