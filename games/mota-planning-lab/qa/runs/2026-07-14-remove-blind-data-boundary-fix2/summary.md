# 移除盲玩数据读取边界 Fix 2 QA 摘要

结论：第二轮只读验收提出的三项阻断均已闭环，完整离线 QA 为 `237/237`，待新的独立只读验收。本摘要不替代独立验收。

## 闭环

- AST carrier 抽象补齐 array spread、`pop/shift/splice` 返回值、rest/spread 参数与返回、method/prototype alias、dynamic property fallback、`for...of`/destructuring、`Reflect.apply`、`Object.values/entries/fromEntries`、`Array.from`、Map/Set constructor/mutator/read iterator。点名五例及 20 组邻近系统反例全部报告 `DIRECT_RUNTIME_STATE_MUTATION`。
- 函数摘要缓存键包含 closure scope revision 与完整 taint signature，不会把 local 实参与 runtime 实参混用；缓存的 container 返回值深拷贝，避免跨调用污染。重复 DAG depth 22 从基线 `7325.2ms` 降到七轮采样中位数 `0.538ms`。
- 默认 source length、step、call depth 三重预算；低预算和过深调用明确报告 `UNSAFE_RUNTIME_MUTATION_ANALYSIS`。不声称实现完整 JavaScript 语义，超出支持子集时保守失败。
- `TASK.md` 架构图不再写“仅 current floorId/hero/current map/visible blocks & enemies”，明确游戏自身 source/definitions/full runtime/save structures 全部可只读用于策略分析；执行状态仍不可直接 mutation。

## 完整验证

- JavaScript：`120/120`
- Python：`116/116`
- Integration：`1/1`
- 总计：`237/237`
- fixture/schema provenance、Protocol Pydantic/JSON Schema、compile/syntax、双 dist 两轮确定性、Acorn hash 与 static runtime safety、docs/JSON、diff 和隔离 prospective staged check 全部通过。
- userscript SHA-256：`c68d80acd0bc648ace9a6f3893d0d9e8a4758910bc589be1aa51d6fd594485f9`
- direct mount SHA-256：`fad256fe1f62da57421e0d822c08542204325dbeb474b36f7c7b2faba3f91ef3`

## 隔离与剩余风险

静态分析器面向项目受控源码，不覆盖 `eval`、动态代码生成、任意 Proxy/高阶库语义；这些构造进入执行层时应由预算/人工审查保守拒绝。完整游戏 source/runtime 读取是合法策略输入，外部攻略、标准路线、录像和人为整理的针对性解法资料仍禁用。

本轮未操作真实浏览器、游戏、存档、真实 state/knowledge 或用户 `127.0.0.1:18724` 服务；未读取实际 h5mota 工程；未使用外部攻略资料；未执行 stage、commit、push、PR、rebase、squash 或 merge。
