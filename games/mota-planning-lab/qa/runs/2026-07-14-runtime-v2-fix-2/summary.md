# Protocol v2 第二轮验收整改结果

状态：离线 QA PASS；仍须全新只读验收，不代表真实页面验收。

## 修复证明

- legacy journal：disposition 重新核对当前 legacy 内容哈希；内容变化重新 quarantine；已有 v2 session/pending/completed/ack/seen/scan identity 时拒绝处置，既有 evidence 原样保留。
- SQLite：`user_version=2` 之外，写前结构化核对列序、type、NOT NULL/default、PK、UNIQUE/CHECK/FK、必要 index 和 action sequence；partial、伪同列和约束缺失数据库原态拒绝。
- recovery：同 session 只允许一个 unresolved `issued`；reconnect/resume 携带真实 pending identity；pre-state 重发同一 ID，completed 后才签下一 ID，改变 fingerprint 或重启服务不能绕过。
- 静态盲玩：token/member-chain/简单别名检测覆盖 dot、bracket、optional floors 与 hero status write；合法 current map 和 hero read fixture 通过；src/service/双 dist 同门禁。
- 文案：活跃 serializer docstring 与恢复文档统一为 Protocol v2 和 same-ID replay。

## 最终结果

- fixture/schema provenance：7 active JSON fixtures，PASS。
- JavaScript：69/69 PASS。
- Python unittest：79/79 PASS。
- localhost fake-core integration：1/1 PASS。
- 自动化测试合计：149/149 PASS。
- Protocol wire：1 observation + 4 responses，PASS。
- 静态盲玩扫描：18 browser + 16 service files + 两个 dist，PASS。
- 文档/JSON：27 Markdown、19 local links、19 JSON，PASS。
- 双次确定性构建、compile/syntax、diff/check、隔离 prospective staged：PASS。
- userscript：3329 行 / 131616 bytes / `02fd3fb1c79bbc208742341baa2cc1772552c55fd78e57edcc332cc2770950d0`。
- direct mount：3276 行 / 123867 bytes / `b17ace73263bd8c00adb8942e6b1836ae60e5112a9d031d17c231ff808714792`。
- 真实 index 内容哈希前后均为 `f2e2321282b6086cd29edc4ed4c91c24f79a5fc2d27529ec3431369bb2ed3989`；raw index 文件哈希前后均为 `2add78eb6b7ee74c43de89114e97b262f6b36b2a8fa2a242e2879fd62c7515a9`。
- worktree 有 68 个全部位于允许 scope 的未提交状态项；无 staged 文件、无残留 `__pycache__`/`.pyc`，主 checkout `main` 保持 clean。

## 未覆盖与交付门

- `not-run`：真实游戏页面、真实存档、真实移动/换图、内置浏览器注入、外网。
- 未宣称整局全局最优；当前证明边界是运行态观察、持久扫描、单未决事务、原子执行和有限预算规划的离线正确性。
- 必须由主会话新建未参与开发的只读验收 Agent；验收通过前不可交付，push 前仍需用户明确确认。
