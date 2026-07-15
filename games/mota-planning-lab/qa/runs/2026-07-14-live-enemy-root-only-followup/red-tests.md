# 验收反例红灯证据

测试先于整改实现加入，旧未提交实现得到：

```text
Python: 4 targeted; 1 pass; 3 fail
- redGem(+attack) -> enemy: expected path_length=1, actual 2
- non-attack resource -> enemy: expected path_length=1, actual 2
- A -> B -> A other entrance -> enemy: expected score < 1000, actual 40601.5
- untouched live root direct enemy remained a valid single candidate

JavaScript: 1 selected test; 0 pass; 1 fail
- explicit own atk:undefined did not throw ENGINE_API_INCOMPATIBLE / INVALID_RUNTIME_FIELD
```

这组输出直接证明旧条件 `map_id == observation.map_instance_id` 不足以表示战损新鲜：同图模拟状态和跨图返回都会重新命中旧怪物事实。JS 反例证明 own-property 存在性不能用归一后的 `undefined` 与缺席混为一谈。
