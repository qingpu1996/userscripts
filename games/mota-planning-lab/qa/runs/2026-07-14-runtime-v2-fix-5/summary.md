# Protocol v2 第五轮验收整改结果

状态：离线 QA PASS；仍须全新只读验收，不代表真实页面验收。

## 三项 P1 修复证明

- userscript fail-closed：userscript/direct-mount 构建物包含互斥显式 marker。缺 `GM_getValue/GM_setValue/GM_deleteValue/GM_listValues/GM_xmlhttpRequest` 任一项均返回 `USERSCRIPT_API_UNAVAILABLE`，不读取 direct localStorage；fixed key 由 list 前后稳定性和两个动态 sentinel 双读交叉确认。stale omission/inclusion、stored undefined/null/object/primitive、get/list 变化及读写删/request throw 全覆盖，不稳定时在 session/request/action 前暂停 `JOURNAL_STORAGE_UNSTABLE`。
- SQLite identity binding：入口 pathname 只作 immutable import witness。一致 main/WAL/SHM 复制到 state dir candidate，schema/行为探针通过并复核 source 后，原子发布 generation manifest；正常连接仅指向已分类 generation，连接返回后、WAL/DDL 前再次核对 import 与 generation identity。分类中、复制中、发布时、最终 connect 时换入 `user_version=99` 均拒绝，替换库 bytes/mtime/user_version/sidecar 不变，上一 manifest 回滚。合法 v2、活动 WAL、服务重启、manifest 恢复和 candidate crash residual 清理通过。
- static aliases：scanner 新增 bare `window/globalThis/unsafeWindow` core destructuring、nested/computed/quoted property 和 `Object/Reflect` mutation 函数赋值/解构 alias 追踪。指定 6 个攻击和扩展 fixture 全拦；合法 current runtime read 与 local plain-object alias mutation 通过，src/service/双 dist 同门禁。

## 最终结果

- JavaScript：79/79 PASS。
- Python unittest：90/90 PASS。
- localhost fake-core integration：1/1 PASS。
- 自动化测试合计：170/170 PASS。
- Protocol wire：1 request + 1 observation + 5 responses，Pydantic/JSON Schema/browser parser PASS。
- compile/syntax、双次确定性构建、静态合规、Markdown/JSON、`git diff --check`、隔离 prospective staged：PASS。
- userscript：3869 行 / 156130 bytes / `9cd80b99ecaa95565bfe9a3d610dcc48fa6a6c35a3c8f6964e31e7c8c4304c55`。
- direct mount：3812 行 / 147222 bytes / `f6ef478be455543c24005ec0f6d28b1ccc6fff9cb4f64bd533c3b815553f1625`。
- 真实 index 内容哈希保持 `f2e2321282b6086cd29edc4ed4c91c24f79a5fc2d27529ec3431369bb2ed3989`；raw index SHA-256 保持 `2add78eb6b7ee74c43de89114e97b262f6b36b2a8fa2a242e2879fd62c7515a9`。

## 兼容与恢复

- 当前合法 Protocol v2 main/WAL/SHM 可首次导入；数据在发布 generation 中继续，服务重启从 manifest 指向的权威 generation 恢复，不做静默 schema 升级。
- 迁移/备份必须复制整个 state dir，不能只复制导入入口。历史 generation 为审计与失败恢复保留；未发布 `.candidate-*` 会在成功启动后清理。
- manifest、import witness 或 generation identity 不一致全部 fail closed；没有自动修复或覆盖未知库。

## 未覆盖与交付门

- `not-run`：真实游戏页面、真实存档、真实移动/换图、内置浏览器注入、截图、OCR、外网。
- 持久 generation 方案假设一个 state dir 由一个服务实例负责；不支持多个独立服务进程并发发布 manifest。
- 必须由主会话新建未参与修复的只读验收 Agent；验收通过前不可 stage/commit，push 前仍需用户明确确认。
