# fix-1 离线 QA 摘要

本轮只使用 fake core、synthetic fixtures、本机临时目录和临时 localhost 服务，修复首次只读验收发现的 2 个 P1 和 1 个 P2。未访问真实游戏页面、真实运行态、存档或外部网络；未使用 screenshot、OCR 或 Canvas。

## 针对性回归证据

新测试先在旧实现上运行：JS 针对性集合共 45 项，39 通过、6 失败。六个失败分别直接证明：

- 采集期 `UNKNOWN_DAMAGE` 的 pause observation 为 `null`；
- 旧 pending 边界只改变位置仍被归类为 `completed`；
- registry entry 缺失 `version` 仍被接受；
- execute 根/嵌套额外字段仍被接受；
- 混合版本 localhost 响应仍可进入行动流程；
- 边界仅声明 position postcondition 仍会执行。

Python 针对性集合在旧实现上还因缺少严格 `ErrorResponse` 模型而在收集期失败。修复后，上述测试全部转绿。

## 修复结果

- P1-1：观察器先完成本轮当前层 blocks 序列化，再携带完整 observation 抛出未知战损暂停；`null`、`???`、`NaN` 均保留安全的原始/规范化证据，决策与行动调用数为 0。
- P1-2：服务、标签 CLI 和浏览器都要求边界具有可验证非位置 postcondition；怪物/门/资源精确要求目标 block 移除，楼梯要求 floor 差分。结算和恢复都不再仅凭位置变化完成边界。
- P2：浏览器、Pydantic models 和 JSON Schema 统一了四种 response status 的必填/可选/额外字段、action_id、registry version、operation、guard 和 expected_delta 嵌套结构。非法响应在行动 API 前映射为 `INVALID_RESPONSE`。

## 最终结果

| 检查 | 结果 |
| --- | --- |
| JS `node:test` | 55 pass / 0 fail |
| Python `unittest` | 47 pass / 0 fail |
| localhost + fake core integration | 1 pass / 0 fail |
| 自动化测试总计 | 103 pass / 0 fail |
| shared protocol fixtures | PASS，1 observation + 4 responses |
| Python compileall / JS syntax / dist syntax | PASS |
| 静态盲玩合规扫描 | PASS，17 个源文件 + 生成 userscript |
| Markdown links / whitespace / `git diff --check` | PASS |
| userscript build | PASS |

生成物：`dist/mota-planning-lab.user.js`，2657 行，101229 bytes，SHA-256 `c0b48cf3394114dd773500ff663b9d7046db77e3d081a138e66cbc76b8cd79ac`。

T73 真实页面只读基线核对和 T74 用户授权后的分级行动仍为 `not-run`，不用离线证据替代。
