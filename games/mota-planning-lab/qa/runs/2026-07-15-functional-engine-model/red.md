# 修复前功能红灯

真实页面已经采集到 MT2、13×13、hero `(1,2)`、HP 860/ATK 10/DEF 10，以及当前动态 blocks；但旧服务在空 knowledge 下仍返回：

```json
{"status":"pause","pause_kind":"UNKNOWN_FLOOR","detail_code":"FLOOR_MODEL_MISSING"}
```

根因是 `/cycle` 只读取持久 knowledge 的 floor/label，未消费游戏完整定义。
