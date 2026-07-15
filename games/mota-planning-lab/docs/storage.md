# SQLite generation 与恢复

SQLite 是历史知识与行动审计库，不是游戏当前状态缓存。`observations`/`map_snapshots` 中的完整 payload 为 fingerprint、pending/completed 恢复、expected-delta 和暂停取证保留；规划查询必须经 `latest_map_facts()` 投影，删除历史 hero、keys 与 busy，只暴露 revisioned topology、blocks 和 observed anchor。当前资源永远来自本轮 cycle observation。

## 浏览器 journal A/B generation

SQLite ledger 之外，userscript/direct mount journal 是 at-most-once 身份链的浏览器端一半。它不再覆盖单一 active key，也没有权威 pointer。两个槽分别保存完整 envelope：`storage_protocol`、单调 `generation`、`previous_generation`、`previous_commit_hash`、完整 v2 state、`state_hash`、首次导入 witness 与 `commit_hash`。

这里的 v2 state 是最小恢复证据：pending 只保存当前层运行态投影、pre fingerprint、guard、expected delta 和 action identity；completed 只保存 ID、结果 fingerprint 与时间；pause 只保留当前层投影和压缩详情。完整 `engine_model`、跨层 floor catalog 和可从现场重建的数据不会写入槽位。页面内使用已验证 generation 的内存缓存，普通 `snapshot()` 不重复读取和哈希双槽；关键 mutation 仍执行读写 witness、候选写后验证与最高 generation 复核。外部 storage 变化会使缓存失效或在下一关键写前 fail closed。

读取时先验证每个 envelope 自身的前代声明：generation 1 必须是 `previous_generation=0` 且 `previous_commit_hash=null`；generation 大于 1 时必须是安全整数，并严格满足 `previous_generation=generation-1` 与合法 previous commit hash。随后独立稳定读取两槽并验证 canonical hash。两个合法槽必须是相邻 generation，且高槽的 previous generation/hash 精确指向低槽；同 generation、gap、链断、整数溢出或 unexpected higher 都 fail closed。只有一个合法高 generation 槽且其内部声明仍严格相邻时，允许忽略另一个部分/截断 candidate，从而保住上次 committed identity。写入永远选择非当前最高槽，写后双读完整 envelope，再从两槽重新选择新最高；不覆盖当前最高合法槽。

单槽自证只能证明 envelope 声明的直接前代相邻，不能凭空证明更早历史没有被整体回放。没有外部高水位时，单个合法 `generation=100, previous_generation=99` 可以恢复；历史回放风险由 localhost service 的持久 ledger、session/guard/fingerprint 与行动 ack 链共同补强，不宣称浏览器单槽独立解决 rollback。

如果底层调用在完整 candidate 落盘后才抛错，本轮 controller 仍暂停，但刷新会恢复新完整 state：pending candidate 表示“未执行 pending”，completion candidate保留“已执行待 ack”证据。如果 candidate 只部分落盘，刷新恢复旧完整槽。GM `list/get` 双探针与 direct `getItem` 双读仍是每个物理槽的底层门禁。

旧单 key v2、v1 和 corrupt 内容不删除、不覆盖。首次导入把其 identity/classification/evidence 写入 generation witness；之后内容变化重新 quarantine。清 pending、archive/disposition 和逻辑 clear 都写新 generation，不物理删除唯一证据。

`MOTA_LAB_STATE_DIR/mota-lab.sqlite3` 是导入入口，不再是分类后重新打开的运行数据库。服务把入口 main/WAL/SHM 当作不可变证据：先做成对检查、WAL framing、SHM size、两轮 identity/stat/hash 读取，再把一致内容复制到 state dir 内的私有 candidate。schema、CHECK、AUTOINCREMENT 和行为探针只打开 candidate。

候选通过后，服务再次核对导入入口或上一代 generation 身份，把 candidate 原子改名为 `.mota-lab.sqlite3.generations/gen-*/ledger.sqlite3`，fsync generation 目录，再用 fsync 后的 JSON manifest 原子发布当前 generation。SQLite 正常连接只指向这个已经分类的 generation，绝不回到导入 pathname。连接返回后、任何 `PRAGMA journal_mode` 或 DDL 前，还会再次核对导入 witness 与 generation 主文件身份。

因此，即使其他进程在“私有快照完成”和“实际 SQLite connect”之间用 rename/replace 放入 legacy、future 或未知数据库，替换 inode 也不会成为运行连接目标；检测到 witness 或 generation 变化时启动拒绝，替换库 main/sidecar 不会被本服务写入。

## 目录与权威状态

- `.mota-lab.sqlite3.manifest.json`：协议版本、当前 generation、数据库相对名、首次导入 identity/hash 和发布时间。
- `.mota-lab.sqlite3.generations/gen-*/ledger.sqlite3`：当前或历史 generation；WAL/SHM 只与对应 generation 同目录。
- `.candidate-*`：尚未发布的临时 generation。成功启动会清理崩溃残留；未通过分类的 candidate 立即删除。
- 原 `mota-lab.sqlite3[-wal|-shm]`：首次导入 witness。manifest 发布后不得手工替换、覆盖或用 SQLite 工具打开后改写。

manifest 是重启的权威指针；原导入文件不会在每次运行后同步成最新账本。账本数据写在当前 generation 中，并在下一次服务启动时从 manifest 指向的 generation 一致复制、验证、再发布新 generation。合法 v2 导入和活动 WAL 均保留；legacy、partial、future、未知对象、sidecar 不完整、复制中变化和 manifest 损坏全部 fail closed，不做静默迁移。

## 备份与迁移

浏览器侧备份必须包含旧 witness key、A/B 两个 generation 槽和 v1 quarantine key；只备份“看起来最新”的一个 key 无法证明链一致。userscript 与 direct-mount namespace 必须分别备份，不得混用。

只在服务完全停止、自动驾驶暂停且没有未结算行动时复制整个 `MOTA_LAB_STATE_DIR`，必须同时保留 manifest、全部 generation、导入 witness、JSONL 和暂停证据。不要只复制名为 `mota-lab.sqlite3` 的导入入口，也不要自行删除 manifest 后把 generation 当成新库导入。

需要回滚或审计迁移时，先保留目录级只读备份；当前版本没有自动 schema 迁移器。若 manifest、witness 或 generation 身份不一致，选择新 state dir 或使用未来独立审计工具，不要手工“修好”指针后继续行动。
