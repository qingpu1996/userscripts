# 移除盲玩数据读取边界 Fix 7 QA 摘要

本轮修复 actual production integrity 的两个 P1：engine API inventory 不再只看 callee object 的字面 `runtime/core`，而会追踪受控项目支持的简单对象 alias、`scope.core/globalThis.core`、静态 member alias、对象解构与邻近 `bind/call/apply`；未知和动态 engine method 统一 fail closed。production discovery 改为递归扫描 `src`/`service`，并要求 browser source 与 userscript manifest 精确一致。

fake-core instrumentation 统一覆盖 `core/status/maps/hero/current map/blocks/enemy` 根和数组/对象子容器的 `set/delete/defineProperty`。负向矩阵证明读取、collector、client、service 和初始化不能开启 action scope；完整 cycle 中每次权威变化都有公开行动 API、路径和操作类型归因。

完整离线 QA 为 `134 JS + 116 Python + 1 integration = 251/251`。production audit 覆盖 `19 browser + 16 service + 2 dist`，manifest 为 19 项且集合精确一致；API inventory 无未分类调用，临时 actual-adapter alias 注入则明确失败。userscript SHA-256 为 `c68d80acd0bc648ace9a6f3893d0d9e8a4758910bc589be1aa51d6fd594485f9`，direct-mount SHA-256 为 `fad256fe1f62da57421e0d822c08542204325dbeb474b36f7c7b2faba3f91ef3`。

Fix 6 的 `results.json` 缺少 branch/worktree/HEAD/staged/dirty/diff scope 与完整 parser/planner 风险；这是历史证据缺口，本轮在 Fix 7 新证据中纠正，不改写 Fix 6 历史文件。

未运行真实浏览器、真实游戏、真实存档或用户的 `18724` 服务。本摘要不替代全新独立只读验收。
