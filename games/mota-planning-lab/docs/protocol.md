# 前端到 Rust 的最小协议边界

现有浏览器源码和 JSON Schema 保留了采集、响应校验与执行所需的最小契约。旧 Python 实现已删除；Stage1 Rust shadow runtime 只实现最小请求形状并返回只读建议，尚未实现规划器或动作服务。

- `observation.schema.json`：JS 从页面取得的实时 observation。
- `cycle-request.schema.json`：当前前端请求形状。
- `cycle-response.schema.json`：当前前端校验的单步响应形状。`idle` 可带严格的 `shadow` 对象，字段仅为 `mode: "read_only"`、稳定 reason、进程内 cycle 及 observation 摘要；其中不允许 action、operation、guard 或任何可执行指令。

目标方向不变：JS 每轮重新采集实时状态，Rust 只在内存中基于该状态返回一个建议，JS 至多执行一个动作。下一轮实时 observation 同时是上一步实际结果和下一步输入；不恢复、不重放、不持久化 action、世界或规划状态。

Stage1 runtime 只绑定 `127.0.0.1:18724`，业务上仅接受 `POST /cycle`，有效请求只返回 `idle + shadow`。`POST` 必须携带 `Content-Type: application/json`（可带 charset）和 `X-Mota-Lab: 1`；若携带 `Origin`，它必须精确为 `https://h5mota.com`，无 Origin 的 GM 请求仍需满足前两项。为 direct-mount 当前配置的 `https://h5mota.com` 提供严格的 `OPTIONS /cycle` CORS 预检和实际响应 CORS header；该 Origin 的拒绝响应也保留 `Access-Control-Allow-Origin` 与 `Vary: Origin`，其他 Origin 不会得到 CORS 授权。其他方法和路径仍拒绝。9 MiB 的请求上限覆盖前端公开的 8 MiB engine model 以及最多 1 MiB 的 cycle envelope，且仍禁止无界读取。前端 `main.js` 显式启用 `shadowOnly`：即便服务返回旧 `execute` 包，控制器也会在任何 adapter/executor 调用前以 `SHADOW_EXECUTION_FORBIDDEN` 暂停。`tests/fixtures/shadow-cycle-request.json` 和 `tests/js/shadow-runtime-contract.test.js` 使用真实 HTTP 验证 Rust/JS 合同；不访问真实页面，也不等同于真实浏览器或 PNA 验证。

runtime 不读写 action、世界、规划、恢复或日志文件；唯一的 runtime 状态是当前进程内 shadow cycle。旁路日志尚未实现。
