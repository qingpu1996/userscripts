# fix-3 state dir 文档 QA 摘要

本轮只修复第三轮独立只读验收发现的唯一 P2：文档没有明确说明 `MOTA_LAB_STATE_DIR` 是 action_id 幂等身份与恢复链的一部分。未修改或运行浏览器/服务代码、协议、测试、脚本或生成物；未访问真实游戏页面、运行态、存档或外部网络。

## 修复前缺口

修改前的定向 `rg` 与人工检查确认：

- `docs/install-and-run.md` 只列出默认状态目录和改目录环境变量，没有说明该目录不可当作 cache 删除，也没有 pending 门禁、备份或迁移流程；
- `docs/state-machine.md` 只说明服务会从 SQLite ledger 重放 pending action，没有说明正常重启必须复用同一目录，也没有目录切错后的 `UNKNOWN_ACTION_ID` 人工恢复；
- README 的“清除待执行行动”说明没有警告该菜单不能修复或绕过服务 ledger。

验收给出的独立复现已经证明：action A 签发后改用全新 state dir，再提交合法 `not_executed` recovery，会安全拒绝为 `409 UNKNOWN_ACTION_ID`，但旧恢复链已经丢失。本轮没有重复运行该代码复现，只修正文档契约。

## 修复覆盖

- 将 `MOTA_LAB_STATE_DIR` 定义为持久状态根，明确覆盖 SQLite ledger、observation、decision cache、`action_id_sequence` issuance sequence、SQLite sidecar、`decisions.jsonl` 和 `pauses/` evidence。
- 要求正常重启、升级、重新连接复用同一绝对路径与完整目录；删除整个目录属于需用户确认的显式状态重置，不在重启恢复保证内。
- 在 install、state machine 和 README 同时增加 pending 门禁：未 completed/acknowledged、浏览器仍有 pending journal 或现场未确认时，不得切换/迁移 state dir，也不得清 browser pending 绕过。
- 增加停机整目录迁移流程：暂停并停止新行动、确认引擎稳定、记录 journal/fingerprint、停服务、完整复制 SQLite 及 sidecar/JSONL/pauses、保留源备份、原子落位、启动后做监听与只读 ledger 核对，最后才重新连接。
- 增加目录遗失/损坏/切错和 `UNKNOWN_ACTION_ID` 人工恢复流程，明确该错误不代表行动未执行，不得盲目重放、清 journal 或用空目录冒充恢复。
- 区分 `MOTA_LAB_KNOWLEDGE_DIR` 与 state dir：知识标签可独立配置，但不能恢复 action ledger。
- README 提供显眼的最短警告并链接详细章节；install 与 state-machine 双向链接。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 修复后关键短语与 9 步迁移流程 | PASS |
| 实现/文档名称与命令静态一致性 | PASS：WAL、文件名、表名、监听地址一致；明确 v0.1.0 无 `/health` endpoint |
| Markdown 本地相对链接与锚点 | PASS |
| QA JSON 解析 | PASS |
| 行尾空白 | PASS |
| `git diff --check` | PASS |
| 受保护代码/协议/测试/scripts 内容与 mtime 汇总 | 前后相同 |
| `dist/mota-planning-lab.user.js` | 未重建；SHA-256、mtime、大小前后相同 |

受保护文件内容汇总 SHA-256 前后均为 `d01027640915379d3e2ce3d83e2fd82fc7dc3350fd76f3e6b81f5b961cf30cdf`，mtime 汇总前后均为 `f7ec7700537ef4ee91a069e52dc05e4fef2dec812a0a91d4c2a320d5a3e3144e`。生成物 SHA-256 前后均为 `c0b48cf3394114dd773500ff663b9d7046db77e3d081a138e66cbc76b8cd79ac`，mtime `1783962545`、大小 `101229` bytes 均未变化。

T73 首次真实页面只读核对和 T74 用户授权后的分级行动均保持 `not-run`。本轮文档 QA 不能替代真实页面验收；真实 H5 引擎 API、事件时序和 UI 位置仍是剩余风险。
