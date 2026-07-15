# fix-2 离线 QA 摘要

本轮只使用 fake core、synthetic fixtures、本机临时目录和临时 localhost 服务，修复第二轮只读验收独立复现的 3 个 P1。未访问真实游戏页面、真实运行态、存档或外部网络；未使用 screenshot、OCR 或 Canvas。

## test-first 复现

新增回归先在旧实现上运行。Python targeted 两文件共 36 项：30 通过、5 失败、1 error。六个红灯分别证明：

- KnowledgeStore 写入 `trigger=None` 后删除必填 `trigger`；
- CLI 表面成功，但重新加载 triggerless 标签会遇到损坏知识文件；
- FastAPI idle 原始 JSON 删除 `RegistryEntry.trigger=null`；
- `floor_number=null` 的 execute 原始 JSON 删除 `Guard.floor=null`；
- 四 status field-aware 序列化矩阵无法再通过严格 Pydantic wire model；
- stair completed 后返回相同 fingerprint 会重放旧 action_id。

浏览器 targeted 21/21；其中新增用例确认旧 completed ID 保持不可重放，而服务签发的全新 ID 可作为独立行动正常执行。修复并补齐审计后，targeted Python 38/38、JS 21/21。

## 修复结果

- P1-1：知识文件改用 `exclude_unset` 的模型感知序列化。必填可空 `BlockLabel.trigger` 保留显式 null；真正未设置的 optional 字段才省略。KnowledgeStore 与 CLI 都覆盖落盘、重建 registry 和等价标签复读。
- P1-2：所有四种响应统一使用同一 field-aware serializer。真实 TestClient/FastAPI raw JSON 中 `RegistryEntry.trigger=null` 与 `Guard.floor=null` 均保留，并同时通过 Pydantic、checked-in JSON Schema 和浏览器 parser；非法 optional null 与额外字段的既有严格门禁不变。
- P1-3：action_id 改由 SQLite 持久 issuance sequence 签发，不依赖墙钟；保留值永不复用且显式跳过 ledger 碰撞。pending 重试/重启重放原 ID；completed 后合法返回相同 fingerprint 生成 B/C 新 ID，同一 pending 重试仍稳定。decision cache 对同 key 原位更新，重试不增加 ledger/cache 行。

## 最终结果

| 检查 | 结果 |
| --- | --- |
| JS `node:test` | 56 pass / 0 fail |
| Python `unittest` | 55 pass / 0 fail |
| localhost + fake core integration | 1 pass / 0 fail |
| 自动化测试总计 | 112 pass / 0 fail |
| shared protocol fixtures | PASS，Pydantic + JSON Schema，1 observation + 4 responses |
| Python compileall / JS syntax / dist syntax | PASS |
| 静态盲玩合规扫描 | PASS，17 个源文件 + 生成 userscript |
| Markdown links / JSON / whitespace / `git diff --check` | PASS |
| userscript 确定性构建 | PASS |

生成物：`dist/mota-planning-lab.user.js`，2657 行，101229 bytes，SHA-256 `c0b48cf3394114dd773500ff663b9d7046db77e3d081a138e66cbc76b8cd79ac`。浏览器源码未改，因此与 fix-1 生成物一致；本轮仍实际重建并验证哈希。

T73 真实页面只读基线核对和 T74 用户授权后的分级行动仍为 `not-run`，不用离线证据替代。
