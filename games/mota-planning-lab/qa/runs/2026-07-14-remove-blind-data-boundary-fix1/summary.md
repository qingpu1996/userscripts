# 移除盲玩数据读取边界 Fix 1 QA 摘要

结论：两项独立验收阻断已修复，完整离线 QA 为 `234/234`，待全新只读验收。此摘要不替代独立验收或真实页面复核。

## 阻断闭环

- AST 数据流会追踪数组/对象 carrier、carrier 后续赋值与局部构造、简单函数参数/rest/spread/返回值、Object/Reflect `call/apply/bind`、实例与 `Array/Map/Set.prototype` 原地 mutator。`push/pop/shift/unshift/splice/sort/reverse/copyWithin/fill/set/add/delete/clear` 对 runtime-rooted 对象均报告 `DIRECT_RUNTIME_STATE_MUTATION`。
- 本地快照、局部对象/数组 mutation、完整 floors/maps/material/source/save 读取和 `setAutomaticRoute/moveDirectly/stopAutomaticRoute/doSL` 正常行动接口保持零 violation。分析按 AST 有界遍历，递归函数以 active set 截断。
- integration 不再重写 transport 端口，也不再直接调用 `uvicorn.run(create_app(...))`。它以随机空闲 loopback 端口执行 `python -m mota_lab serve --host 127.0.0.1 --port <port>`，并把同一显式 `/cycle` endpoint 交给生产 client。
- `serve` 默认端口仍为 `18724`，仅允许 `127.0.0.1`，显式端口限制在 `1..65535`；client 同样只接受 `http://127.0.0.1:<port>/cycle`。integration 使用临时 state/knowledge，不连接、停止或复用用户 `18724` 服务。

## 红灯与绿灯

以 `git show HEAD:.../ast-runtime-compliance.mjs` 动态载入基线分析器，四个验收反例全部输出空 violation：array apply carrier、object carrier、identity return 和 runtime `splice`。修复后同四例全部输出 `DIRECT_RUNTIME_STATE_MUTATION`。定向 AST `8/8`、client/controller 与 AST 合跑 `38/38`、生产 CLI integration `1/1`。

## 完整验证

- JavaScript：`117/117`
- Python：`116/116`
- Integration：`1/1`
- 总计：`234/234`
- fixture/schema provenance、Protocol Pydantic/JSON Schema、compile/syntax、双 dist 两轮确定性构建、Acorn hash 与 static runtime safety、64 Markdown/39 links/35 JSON、`git diff --check` 和隔离 prospective staged check 全部通过。
- userscript SHA-256：`c68d80acd0bc648ace9a6f3893d0d9e8a4758910bc589be1aa51d6fd594485f9`
- direct mount SHA-256：`fad256fe1f62da57421e0d822c08542204325dbeb474b36f7c7b2faba3f91ef3`

## 剩余风险与隔离声明

静态门禁是面向项目代码常见数据流的保守、有界分析器，不声称覆盖 `eval`、动态代码生成、任意高阶库回调或完整 JavaScript 语义；这些能力不应进入执行层。策略数据政策保持为“游戏自身 source/runtime 全部可读，外部攻略资料禁用，权威现场不可直接 mutation”。

本轮未操作真实浏览器、真实游戏、存档、真实 state/knowledge 或用户 `127.0.0.1:18724` 服务；未搜索或读取攻略/标准路线/录像/针对性解法资料或实际 h5mota 工程；未 stage、commit、push、创建/更新 PR、rebase、squash 或 merge。
