# getDamage undefined fail-closed 红灯证据

测试先于修复实现加入。旧未提交实现运行：

```text
node --test --test-name-pattern='undefined 战损|damage 严格值域|采集期未知战损' \
  games/mota-planning-lab/tests/js/observer-and-compliance.test.js

tests 3; pass 2; fail 1
✖ undefined 战损无论攻防关系都 fail closed 并保留原始证据
  AssertionError: Missing expected exception.
```

反例中的 `getDamage()` 原始返回值为 JavaScript `undefined`，hero ATK 10、enemy DEF 10。旧逻辑把 `undefined` 与 null/`???` 合并，误判为 known-unfightable；红灯证明 API 异常可被静默转换为正常不可战斗语义。
