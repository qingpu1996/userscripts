# 移除盲玩数据读取边界 Fix 3 QA 摘要

结论：第三轮验收指出的嵌套 closure 摘要缓存串污已闭环；最终完整离线 QA 为 `239/239`，待全新独立只读验收。本摘要不替代独立验收。

## 根因与修复

- 旧 memo key 只有捕获 scope 的 revision 数字序列和当前实参 taint signature。不同外层调用创建的 closure、函数预分析的 `UNKNOWN` 环境与真实 runtime 调用可能具有相同 revision 数字，错误复用 `UNKNOWN`/local 摘要。
- 每次分析现在给 scope 分配唯一 identity；函数摘要键同时包含完整 closure scope identity/revision 链和实参 taint signature，不同 closure instance、预分析与真实调用天然隔离。
- array/object/map/set 抽象值在绑定时递归登记 owner scope；包括深层子 container 在内的原地 mutation 会单调提升所有 owner scope revision，新插入的 container 继续继承 owner。这样同一 closure 内 local→runtime 的深层 taint 变化不会复用旧摘要，也不需要每次扫描整个 scope 图。
- 缓存仍按函数节点和抽象环境复用。depth 22/40 七轮中位数分别为 `0.857ms` / `1.148ms`；递归与互递归继续快速 fail closed，source/step/call-depth 预算保持 fail closed。

## 回归覆盖

- 两条验收反例、local→runtime、runtime→local、同一函数节点的不同 closure 实例、unknown 预分析、不同及同一闭包环境内的深层 container taint，六组均精确报告 `DIRECT_RUNTIME_STATE_MUTATION`。
- 原 20 类 carrier 和既有直接 mutation 用例继续拒绝；合法闭包返回局部对象后 mutation、完整游戏 runtime/source/definition/save 读取和公开行动 API 均无误报。
- 完整离线 QA：`122 JS + 116 Python + 1 integration = 239/239`；fixture/schema、Protocol、compile/syntax、双 dist 确定性、static runtime safety、docs/JSON、diff/prospective staged 全绿。

## 隔离与剩余风险

分析器仍面向项目受控 JavaScript 子集，不声称解释任意 `eval`、Proxy 或动态代码生成；超出预算或已识别的不支持 carrier 保守报告 `UNSAFE_RUNTIME_MUTATION_ANALYSIS`。container owner 是保守 alias 传播，可能额外失效缓存，但不会把 runtime mutation 当成合法局部 mutation。

本轮未操作真实浏览器、游戏、存档、真实 state/knowledge 或用户 `127.0.0.1:18724` 服务；未读取实际 h5mota 工程；未联网或使用外部攻略；未执行 stage、commit、push、PR、rebase、squash 或 merge。
