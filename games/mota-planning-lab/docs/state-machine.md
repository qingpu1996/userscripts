# 运行状态机

游戏实时 observation 是唯一权威。每轮从页面重新采集地图、角色、怪物、资源、楼层和菜单；采样围栏不一致则整轮作废。

```text
PAUSED -> OBSERVING -> PLANNING -> ISSUED -> EXECUTING
   ^          |            |          |          |
   +----------+------------+----------+----------+
              guard/delta/error -> PAUSED
```

当前页面和服务进程各自只在内存中保存一个 in-flight action。重复启动或重复 cycle 只能得到相同 identity，不能签发第二个动作。执行前核对 guard，执行后等待稳定 observation 并核对 expected delta；完成后 ACK 才能释放当前 identity。

页面刷新、服务退出或重新实例化会丢弃全部运行状态。新实例从 fresh observation 建立新 session，不读取历史状态，不恢复 action，不补 ACK，也不重放旧决策。跨实例的 at-most-once 不属于本项目契约；安全性来自重新接管时的实时状态与新基线确认。

商店购买在当前进程内同样遵循 single-flight：一次 `menu_choice` 绑定 shop、choice、价格、效果和 guard。重复回调不得再次输入选择。guard 或购买结果不符立即暂停。

`reconnect_only` 只检查当前实例连接与当前内存 action；它不会规划或签发新动作。实例重启后不存在可连接的旧 action。
