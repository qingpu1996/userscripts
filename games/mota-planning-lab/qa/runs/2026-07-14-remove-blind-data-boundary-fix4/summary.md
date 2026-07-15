# 移除盲玩数据读取边界 Fix 4 QA 摘要

结论：第四轮验收指出的 mutable function return memo alias 漏报已闭环；最终完整离线 QA 为 `240/240`，待全新独立只读验收。本摘要不替代独立验收。

## 根因与修复

- 旧 memo store/hit 会深拷贝 `array/object/map/set/iterator` 返回值。函数返回 captured container 时，预热后的每次调用都得到不同 clone；通过返回值执行的 local→runtime 更新不会更新真实抽象 heap，也不会 bump owner/closure revision，于是后续写入被过期 local clone 漏报。
- 对 mutable result 盲目共享原对象也不正确：`function fresh(){return {};}` 在真实 JS 中每次都分配新容器，共享摘要会伪造 alias。
- 因此本轮对 mutable heap result 采用保守不缓存，每次重新分析函数体。captured container 会重新 lookup 到同一 abstract heap object，属性赋值和 Array/Map/Set mutator 会正常 bump owner scope revision；fresh container 则每次新建抽象对象。scalar/runtime 摘要仍然缓存，不回退 DAG 性能。

## 回归覆盖

- object、nested closure、array、Map、Set 五个验收反例由 `[]` 变为精确 `DIRECT_RUNTIME_STATE_MUTATION`。
- 新增同一函数/不同函数返回同容器、nested closure、container 嵌套、属性/索引赋值、Map/Set mutator、无 prime、反序 runtime→local→runtime 和不同 memo signature 回归。
- fresh local container 不伪造 alias，captured local container 正常修改不误报；完整游戏 runtime/source/definition/save 只读和公开行动 API 仍合法。
- 前三轮闭包 identity/revision、20 类 carrier、原始直接 mutation 组、fixture valid/invalid、CLI integration、dist/hash/docs/diff 均由完整 QA 继续覆盖且通过。

## 性能、隔离与剩余风险

DAG depth 22/40 七轮中位数分别为 `0.765ms` / `0.948ms`，最大值为 `4.057ms` / `1.281ms`。递归、互递归和 source/step/call-depth 预算仍 fail closed。分析器仍面向项目受控 JavaScript 子集，不声称解释任意 `eval`、Proxy 或动态代码生成；超出预算或已识别的不支持 carrier 保守报告 `UNSAFE_RUNTIME_MUTATION_ANALYSIS`。

本轮未操作真实浏览器、游戏、存档、真实 state/knowledge 或用户 `127.0.0.1:18724` 服务；未读取实际 h5mota 工程；未联网或使用外部攻略；未执行 stage、commit、push、PR、rebase、squash 或 merge。
