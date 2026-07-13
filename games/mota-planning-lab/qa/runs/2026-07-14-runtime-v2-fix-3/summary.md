# Protocol v2 第三轮验收整改结果

状态：离线 QA PASS；仍须全新只读验收，不代表真实页面验收。

## 修复证明

- journal fail-closed：固定 v1/v2 key 的解析失败、错误 root shape、错误 protocol 和底层读取异常均进入 `JOURNAL_CORRUPT`；普通初始化、确认、启动、重连和写入不能覆盖；只能显式归档当前内容哈希并使用专用确认短语开始 v2，且内容变化会重新 quarantine。证据只保存 key、长度、状态和哈希，不落原始损坏内容。
- SQLite 合约：不再相信 `sqlite_master.sql` 的 CHECK 子串；`table_xinfo` 精确拒绝 generated/hidden/extra column，并把现有库只读备份到内存后以真实非法写入探针验证 CHECK、FK、sequence 与 AUTOINCREMENT 行为。comment/字符串伪造无法满足行为约束，原数据库字节、schema、`user_version`、journal mode 与 sidecar 不变。
- reconnect/ACK：`reconnectOnly()` 只做恢复观测；pause/error/malformed/network 全部保留 pending 与 evidence，且不执行新 action。只有服务专用 `idle` 回应携带完全相同的 `acknowledged_action_id` 才清理 completed pending；同一请求不会顺带签发下一行动。
- 换图目标：已验证出口只有唯一、完整目标时才把精确 `map_instance_id` 与 `floor_id` 写入 expected delta；A→B 通过、A→C 失败；同出口多个目标在普通规划与扫描态都以 `TRANSITION_TARGET_AMBIGUOUS` 暂停；未知目标保持 opaque。
- 静态盲玩：新增括号别名、常量 bracket key、嵌套 destructuring、`**=`、`delete`、`Object.assign`、`Object.defineProperty`、`Reflect.set` 绕过 fixture；src/service/双 dist 使用同一门禁，合法局部对象写入仍通过。
- 文案：活动恢复注释明确为 same-ID byte-equivalent replay，不再描述改签 replacement action。

## 最终结果

- fixture/schema provenance：7 active JSON fixtures，PASS。
- JavaScript：73/73 PASS。
- Python unittest：81/81 PASS。
- localhost fake-core integration：1/1 PASS。
- 自动化测试合计：155/155 PASS。
- Protocol wire：1 observation + 5 responses，PASS。
- 静态盲玩扫描：18 browser + 16 service files + 两个 dist，PASS。
- 文档/JSON：29 Markdown、20 local links、20 JSON，PASS。
- 双次确定性构建、compile/syntax、diff/check、隔离 prospective staged：PASS。
- userscript：3656 行 / 147504 bytes / `72e16639ddd98d88bdb2cb366311e0353924b00003b0c88cb622501ac5859fae`。
- direct mount：3603 行 / 139117 bytes / `c95bd198415d34b3969c7269aec53cf1ac4be5ddac4a6b5ef792a684bcc56b53`。
- 真实 index 内容哈希前后均为 `f2e2321282b6086cd29edc4ed4c91c24f79a5fc2d27529ec3431369bb2ed3989`；raw index 文件哈希前后均为 `2add78eb6b7ee74c43de89114e97b262f6b36b2a8fa2a242e2879fd62c7515a9`。
- worktree 有 70 个全部位于允许 scope 的未提交状态项；无 staged 文件、无残留 `__pycache__`/`.pyc`，主 checkout `main` 保持 clean。

## 未覆盖与交付门

- `not-run`：真实游戏页面、真实存档、真实移动/换图、内置浏览器注入、外网。
- 未宣称整局全局最优；当前证明边界是动态运行态观察、持久扫描、显式 ACK、单未决事务、原子执行和有限预算规划的离线正确性。
- 必须由主会话新建未参与开发的只读验收 Agent；验收通过前不可交付，push 前仍需用户明确确认。
