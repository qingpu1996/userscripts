# QA 手册

## 离线门禁

依次运行 Node、Python、integration、protocol、双构建确定性、static compliance 和 production integrity。必须验证：

- production 只使用内存 `Store()`；没有带 path 的调用。
- hostile `state_dir`/`knowledge_dir` 的目录树、内容、mtime 和权限位完全不变，恶意规则不影响规划。
- packaged rules 缺失或非法时启动 fail closed，不回退旧目录。
- 同一进程 single in-flight、重复启动不重复 action、guard/delta mismatch 暂停、完成 ACK、商店选择 at-most-once。
- 页面与服务重新实例化后 fresh session，旧 action 不恢复、不重放。
- 双 dist 无 storage 写入、旧 action replay 或临时诊断标记。

## 真实页面

先确认唯一构建和唯一服务实例，再注入页面。真实运行从实时 observation 建立基线；测试结束保持服务运行或停止必须服从当次用户要求。不得通过清理历史目录、篡改 ledger 或修改游戏状态来制造通过结果，因为 production 不依赖这些目录。

记录 action 数、游戏前后状态、暂停原因、observation/planner/controller 耗时和控制台错误。真实动作测试与性能测试分开报告；单样本不得宣称 p95。
