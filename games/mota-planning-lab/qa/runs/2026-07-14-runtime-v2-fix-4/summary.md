# Protocol v2 第四轮验收整改结果

状态：离线 QA PASS；仍须全新只读验收，不代表真实页面验收。

## 四项修复证明

- Tampermonkey absent：`GM_listValues` 在读取/解析前建立固定 key existence；两个 key 全缺和单缺正常，真实 present 的旧 sentinel、undefined、null、primitive、array、wrong shape 与 read/list throw 全部进入损坏隔离；object clone、GM set/delete 语义和 fresh session 建立通过。
- reconnect no-issue：请求三侧新增 strict `intent=cycle|reconnect_only`。fresh reconnect 连续调用均不新增 action/decision；服务端 unresolved 只返回同 identity 暂停。浏览器收到错误 execute 时行动 API 为零，并持久保存 action ID、guard 与 response fingerprint。
- SQLite WAL：分类前不以任何模式连接真实 path。main/WAL/SHM 有界双读 stat/hash、WAL framing、SHM size 与分类后复核通过后，才在私有临时目录执行 schema/behavior probe。非法 active WAL、无 SHM、截断 sidecar、复制不稳定和 unknown sidecar 均安全拒绝，原文件 bytes/existence/mtime 不变，临时快照清理。
- 静态合规：`window.core["floors"]`、`unsafeWindow.core["floors"]`、globalThis/core alias、status ancestor `Object.assign/defineProperties/setPrototypeOf` 与 `Reflect.deleteProperty` 全拦；合法 current runtime reads 和 local plain-object mutations 通过。src/service/两个 dist 使用同一门禁。

## 最终结果

- JavaScript：75/75 PASS。
- Python unittest：86/86 PASS。
- localhost fake-core integration：1/1 PASS。
- 自动化测试合计：162/162 PASS。
- Protocol wire：1 request + 1 observation + 5 responses，PASS。
- 双次确定性构建、compile/syntax、静态合规、文档/JSON、diff check、隔离 prospective staged：PASS。
- userscript：3699 行 / 149082 bytes / `890c1e6c4682604e6cb44fdc9525bc6c1045a3a9f58e610371b3954cc0926ce8`。
- direct mount：3645 行 / 140582 bytes / `12df4c4a662088402c207dddcdeedbbf07bd669166cfada9a5e41a2ca75aebdf`。
- 真实 index 内容哈希保持 `f2e2321282b6086cd29edc4ed4c91c24f79a5fc2d27529ec3431369bb2ed3989`；raw index SHA-256 保持 `2add78eb6b7ee74c43de89114e97b262f6b36b2a8fa2a242e2879fd62c7515a9`。

## 未覆盖与交付门

- `not-run`：真实游戏页面、真实存档、真实移动/换图、内置浏览器注入、外网。
- WAL 一致快照是进程内有界取证，不宣称替代操作系统级原子文件系统快照；持续并发写会 fail closed。
- 必须由主会话新建未参与开发的只读验收 Agent；验收通过前不可 stage/commit，push 前仍需用户明确确认。
