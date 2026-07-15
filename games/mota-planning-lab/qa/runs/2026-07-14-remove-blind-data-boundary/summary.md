# 移除盲玩数据读取边界 QA 摘要

结论：策略数据边界重置的离线开发验证通过，待主会话派发全新只读验收。本摘要不能替代独立验收或真实页面复核。

## 最终政策

- 唯一盲玩限制是不搜索、读取、导入或使用《魔塔24层》的攻略、标准路线、通关录像及其他人为整理的针对性解法资料。
- 游戏自身完整 runtime/source definitions 全部可读，包括 `core.floors`、完整/未来 maps、`material`、物品/怪物/事件定义、地图源码和存档结构。
- 游戏权威对象仍不可直接篡改；所有现场变化必须经过正常引擎接口、guard、稳定等待和真实差分校验。
- 运行通信继续限制为 localhost；读取范围扩大不授权向非本地端点发送游戏工程、运行态或存档。

## 静态门禁

- 旧 `FORBIDDEN_FLOOR_CATALOGUE` 和 floors/material/source/full-runtime 文本禁令已删除。
- Acorn 数据流现在把所有 runtime-rooted 权威对象 mutation 统一报告为 `DIRECT_RUNTIME_STATE_MUTATION`，覆盖 assignment/update/delete、destructure/function alias、Object/Reflect、`call/apply/bind`。
- 合法 fixture 覆盖完整 floors/maps/material/source/save structure 读取、`structuredClone(core.status)` 和正常公开引擎 API；反例覆盖 hero、map/block、monster、event、save 及 freeze/defineProperty/Reflect 绕过。
- userscript metadata、`@connect 127.0.0.1` 和生成物 endpoint 检查保持不变。

## 测试结果

- 定向：5 个 AST 测试全部通过；当前 full-runtime read 返回零 violation，5 类 runtime mutation 均返回 `DIRECT_RUNTIME_STATE_MUTATION`。
- 完整离线 QA：`113 JS + 114 Python + 1 integration = 228/228`。
- Protocol Pydantic/JSON Schema、Python compileall、JS syntax、双 dist 确定性、Static runtime safety、docs/JSON、`git diff --check` 与隔离 prospective staged check 全部通过。
- userscript SHA-256：`6bb64239fc71e5a2c31f0159a39a2a8b200f4f646109007d27c1b11611140814`。
- direct mount SHA-256：`524fbe3f3370d52d226b2bfae01ec42c8af7973886d2f918e0ea6ffb56e76651`。

## 隔离说明与风险

首次完整 QA 在 integration 前发现用户已有服务占用 `127.0.0.1:18724`，按原测试设计安全失败。开发 Agent 未停止、连接或触碰该服务；integration transport 随后改为随机临时 loopback 端口和临时 state/knowledge 目录，最终完整 QA 通过，生产 endpoint 与 CLI 端口约束未改变。

本轮只重置策略数据政策和静态门禁，没有实现完整 source-definition 解析器或全量规划器；现有 planner 仍主要消费 Protocol observation/历史 world model。未操作真实浏览器、真实游戏、存档或真实 state/knowledge，未读取游戏实际工程文件，未使用攻略资料，也未执行任何版本控制写操作。
