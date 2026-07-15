# 实现前红灯证据

定向测试先于实现加入，旧代码结果如下：

```text
JS: 20 tests; 18 pass; 2 fail
- 当前怪物字段别名严格归一且 exp 是实时经验字段
  DAMAGE_UNEXPLAINED; field=enemy.experience
- 实时攻防可解释的 null 或问号战损是可序列化的当前不可战斗边界
  DAMAGE_NULL

Python: 4 targeted; 3 failures; 1 initial test-import error
- expected execute for independent resource, actual pause
- expected idle behind known-unfightable blocker, actual pause
- expected DAMAGE_UNEXPLAINED when attack penetrates, actual DAMAGE_NULL
```

初次 Python 运行的第四项错误是新增测试漏引入 `make_enemy_block`，修正测试 import 后再进入实现；它不是产品绿灯。实现后的相同定向范围全部通过，并由完整 `212/212` QA 覆盖。
