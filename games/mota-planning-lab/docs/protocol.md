# 前端到 Rust 的最小协议边界

现有浏览器源码和 JSON Schema 保留了采集、响应校验与执行所需的最小契约。旧 Python 实现已删除；这些 Schema 不是可运行服务的声明，字段将由后续 Rust shadow runtime 逐项复核，而非在本轮重设计。

- `observation.schema.json`：JS 从页面取得的实时 observation。
- `cycle-request.schema.json`：当前前端请求形状。
- `cycle-response.schema.json`：当前前端校验并交给执行器的单步响应形状。

目标方向不变：JS 每轮重新采集实时状态，Rust 只在内存中基于该状态返回一个建议，JS 至多执行一个动作。下一轮实时 observation 同时是上一步实际结果和下一步输入；不恢复、不重放、不持久化 action、世界或规划状态。

Rust shadow runtime 尚未开发。接入时必须以共享 fixture 验证字段、规范化和陈旧响应处理；本轮不新增接口、状态机或持久化机制。旁路日志只用于本次启动后的复盘，solver 和浏览器运行循环均不得读取它。
