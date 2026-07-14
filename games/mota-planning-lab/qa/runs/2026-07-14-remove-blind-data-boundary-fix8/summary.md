# 移除盲玩数据读取边界 Fix 8 QA 摘要

Fix 8 修复 production engine API inventory 对 direct member `call/apply` 与动态 bracket member 的漏报。审计现在统一解析 engine member reference，覆盖 direct/static bracket/member alias 的直接调用及 `call/apply/bind`；engine-rooted 动态 property 在读取处立即以 `UNCLASSIFIED_ENGINE_API`、`DYNAMIC_ENGINE_API` fail closed，并向动态 alias 传播。

完整 QA 会把三个点名反例临时写入实际 `src/engine-adapter.js`，重建 userscript 与 direct-mount 两个 dist，要求完整 production audit CLI 非零退出且包含精确未知/动态失败；`finally` 恢复 actual source、重建双 dist，并逐字节核对恢复后的制品。

最终完整离线 QA 为 `135 JS + 116 Python + 1 integration = 252/252`；focused production audit tests 为 `10/10`。userscript SHA-256 为 `c68d80acd0bc648ace9a6f3893d0d9e8a4758910bc589be1aa51d6fd594485f9`，direct-mount SHA-256 为 `fad256fe1f62da57421e0d822c08542204325dbeb474b36f7c7b2faba3f91ef3`。详细 inventory 与 workspace 状态见 [`results.json`](results.json) 和 [`actual-source-audit.md`](actual-source-audit.md)。

未运行真实浏览器、真实游戏、真实存档或用户的 `18724` 服务。本摘要不替代全新独立只读验收。
