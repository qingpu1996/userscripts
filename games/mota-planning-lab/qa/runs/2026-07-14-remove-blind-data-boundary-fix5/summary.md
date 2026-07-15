# 移除盲玩数据读取边界 Fix 5 QA 摘要

结论：第五轮验收指出的 callable function return closure allocation identity 串污已闭环；最终完整离线 QA 为 `241/241`，待全新独立只读验收。本摘要不替代独立验收。

## 根因与修复

- Fix 4 已禁止 mutable heap result 缓存，但 `kind:function` 仍会按 parent scope identity/revision 和结构 value signature 缓存。同一函数节点用两个结构相同、identity 不同的对象调用时，第二次会复用第一次返回的 closure，造成捕获对象串污。
- `memoizableResult()` 现在改用显式安全白名单；只有 `local/unknown/global/constant/runtime/builtin` 等 scalar/runtime immutable 摘要可复用，heap、callable 以及未来新增的 value kind 默认都不缓存。函数体会在每次 allocation-sensitive 调用时重建真实抽象 allocation。
- 该策略不尝试把结构 signature 冒充 allocation identity，也不把 fresh container/closure 误合并。scalar/runtime DAG 摘要路径不变，原 depth 22/40 性能优势保留。

## 回归覆盖

- 原始漏报例现在产生 `DIRECT_RUNTIME_STATE_MUTATION`；原始误报例返回 `[]`。
- 新增同一表达式多实例、相同结构参数、allocation/call 双顺序、nested closure、closure returns closure、bound callable，以及 fresh captured container 的正反回归。
- 2000 次 closure/container allocation 九轮中位数 `12.797ms`、最大 `24.739ms`；低 `maxSteps` 明确 fail closed。
- Acceptance 1–4 的 alias/carrier/closure/container/CLI/性能矩阵继续由完整 QA 覆盖；合法完整数据读取、本地 mutation 和公开行动 API 继续通过。
- `qa/README.md` 已补齐 Fix 4 和 Fix 5 evidence 索引。

## 隔离与剩余风险

分析器仍面向项目受控 JavaScript 子集，不声称解释任意 `eval`、Proxy 或动态代码生成；超出预算或已识别的不支持 carrier 保守报告 `UNSAFE_RUNTIME_MUTATION_ANALYSIS`。对 callable receiver 的保守重分析可能比 scalar memo 多消耗步骤，但 2000 allocation 回归远低于默认预算和 1 秒测试上限。

本轮未操作真实浏览器、游戏、存档、真实 state/knowledge 或用户 `127.0.0.1:18724` 服务；未读取实际 h5mota 工程；未联网或使用外部攻略；未执行 stage、commit、push、PR、rebase、squash 或 merge。
