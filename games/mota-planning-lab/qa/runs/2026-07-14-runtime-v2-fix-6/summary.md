# Protocol v2 第六轮验收整改结果

状态：离线 QA PASS；仍须全新只读验收，不代表真实页面验收。

## 两项 P1 修复证明

- journal durability：userscript 的 `GM_setValue/GM_deleteValue` 与 direct mount 的 `localStorage.setItem/removeItem` 均不再把“未 throw”视为成功。关键 mutation 绑定 read→write witness，写入前再次确认旧 identity 未变化；完成写入后执行两次独立稳定读回，并核对完整 Protocol v2 journal 的 canonical JSON/hash 语义等价。silent no-op、旧值、截断、变形、读写间变化、读回变化和异常统一为 typed `JOURNAL_STORAGE_UNSTABLE`。正常 Tampermonkey structured clone 可通过，不要求对象 identity 相同。
- at-most-once：controller 只有在 pending durable 后才进入引擎 API；故障注入证明 pending 写失败时移动 API 为 0。mark-completed 或 ack 写失败时保留上一份 pending 或 completed-without-ack，后续错误新 action 响应仍零执行。session、seen、scan、archive/disposition、pause、clear 等关键字段使用同一个 verified Journal mutation 路径。
- static gate：结构化 token IR 新增常量字符串折叠、多级 global/Object/Reflect root/method alias、destructuring alias 和 `call/apply/bind` 目标解析。验收指定五项攻击、额外 apply/bind/template fixture 全部拦截；Object-like 局部命名、plain local mutation 和 current runtime 只读正例通过。src、service、userscript、direct-mount 共用同一门禁。

## 最终结果

- JavaScript：88/88 PASS。
- Python unittest：90/90 PASS。
- localhost fake-core integration：1/1 PASS。
- 自动化测试合计：179/179 PASS。
- Protocol wire：1 request + 1 observation + 5 responses，Pydantic/JSON Schema/browser parser PASS。
- compile/syntax、双次确定性构建、静态合规、Markdown/JSON、`git diff --check`、隔离 prospective staged：PASS。
- userscript：4114 行 / 166635 bytes / `848bea7a7eeb945e6ec380ed61a17e1a07a47a4467361a901dc564d9472c64fe`。
- direct mount：4057 行 / 157245 bytes / `6a852506dfc9f4c4b9b06acb66012cd82a36314fdb8ee6e5d82494213370e078`。
- 真实 index 内容哈希保持 `f2e2321282b6086cd29edc4ed4c91c24f79a5fc2d27529ec3431369bb2ed3989`；raw index SHA-256 保持 `2add78eb6b7ee74c43de89114e97b262f6b36b2a8fa2a242e2879fd62c7515a9`。

## 未覆盖与交付门

- `not-run`：真实游戏页面、真实存档、真实移动/换图、内置浏览器注入、截图、OCR、外网。
- 静态扫描是保守的结构化 token IR，不是完整 ECMAScript parser；当前覆盖已登记的多级 alias、destructure、常量字符串和 wrapper invocation，未来若允许运行更复杂语法需同步扩充 fixture 或改用固定版本 AST parser。
- 必须由主会话新建未参与修复的只读验收 Agent；验收通过前不可 stage/commit，push 前仍需用户明确确认。
