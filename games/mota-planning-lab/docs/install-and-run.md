# 安装与启动

所有步骤默认只在本机工作；不会自动打开游戏、安装扩展、确认基线、开始行动或碰物理存档。

## 服务

```bash
cd games/mota-planning-lab
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r service/requirements.lock
PYTHONPATH=service python -m mota_lab serve
```

服务只监听 `127.0.0.1`，默认端口为 `18724`。`serve --port <1..65535>` 只用于同机隔离实例或 QA；浏览器客户端必须显式配置同一个 `http://127.0.0.1:<port>/cycle`，且仍拒绝非 loopback、HTTPS 或其他 path。`MOTA_LAB_STATE_DIR` 是 session、action_id、世界图和恢复链的持久身份根，不是 cache；正常重启和升级必须复用同一完整绝对路径。pending 时禁止删除、迁移或切空目录。`MOTA_LAB_KNOWLEDGE_DIR` 只保存人工标签，不能替代 ledger。

Protocol v2 数据库使用 `PRAGMA user_version=2`，但版本号不是唯一凭据。空白或合法 v2 导入入口会先一致复制 main/WAL/SHM 到 state dir 私有 candidate，schema/CHECK/AUTOINCREMENT 探针只操作 candidate；通过后原子发布 `.mota-lab.sqlite3.manifest.json` 与 `.mota-lab.sqlite3.generations/gen-*`。之后入口文件只作 identity witness，当前账本以 manifest 指向的 generation 为准。WAL/SHM 缺一、framing/size 异常、双读不稳定、rename/swap、legacy/future/unknown schema 或 manifest 损坏都会安全拒绝。详见 [SQLite generation 与恢复](storage.md)。

浏览器发现 v1 journal 后，普通“确认基线”、启动、重连和 resume 均继续显示 `JOURNAL_V1_MIGRATION_REQUIRED`。Tampermonkey 菜单先执行“归档旧 v1 journal 证据”，核对归档 ID 和 pending/recovery 标记，再执行“确认归档后开始 v2 新会话”并二次确认。确认时当前 legacy 内容必须仍与 archive ID 一致；以后改写会再次 quarantine。若同 namespace 已有 v2 session/pending/completed/ack/seen/scan 证据，处置会拒绝而不是清空 v2 证据。direct mount 使用隔离的 `mota-planning-lab:direct-mount:journal:v1` quarantine key，通过 `__motaPlanningLab.controller.archiveLegacyJournal()` 与 `beginV2AfterLegacyArchive(...)` 执行同一流程；不要直接删除 localStorage key。

若旧 witness/v1 key 无法解析或 shape/protocol 错误，显示 `JOURNAL_CORRUPT`。若 A/B 两槽同 generation、链断、unexpected higher、读不稳定或没有合法 generation，显示 `JOURNAL_STORAGE_UNSTABLE`。候选槽部分写时不要删除它：刷新会保留旧完整槽；候选已完整但调用报错时刷新会恢复新 pending/completed identity。只能恢复存储 API 后重试，不能清 key、清 pending 或把不稳定证据当普通损坏 journal 处置。

## Tampermonkey 模式

```bash
node scripts/build-userscript.js mota-planning-lab
node --check dist/mota-planning-lab.user.js
```

用户手动导入 `dist/mota-planning-lab.user.js`。构建物包含 `userscript` marker，权限包含 `GM_getValue/GM_setValue/GM_deleteValue/GM_listValues/GM_xmlhttpRequest`；缺任一项都 fail closed，不会降级使用页面 localStorage。脚本只核对固定的 witness/v1/A/B journal keys，不枚举游戏 storage，也不会自动更新或发布。

迁移或备份浏览器状态时必须同时保留旧 witness key、v1 quarantine key、`journal:v2:slot:a` 与 `journal:v2:slot:b`。不要只复制最新 generation，也不要手工创建 pointer。

## Direct mount 模式

```bash
node games/mota-planning-lab/scripts/build-direct-mount.mjs
node --check dist/mota-planning-lab.direct-mount.js
PYTHONPATH=games/mota-planning-lab/service \
  python -m mota_lab serve --allow-direct-mount-origin https://h5mota.com
```

CORS 默认关闭。参数只接受精确 origin `https://h5mota.com`，只放行 POST、`Content-Type` 和 `X-Mota-Lab`，不使用通配符。

将审计过的 `dist/mota-planning-lab.direct-mount.js` 作为本地脚本注入目标页面。该构建物包含独立 `direct-mount` marker，只有这个显式 marker 才允许使用精确 direct journal localStorage namespace；缺 GM API 的 userscript 绝不会隐式进入此模式。具体注入由宿主浏览器/调试工具完成，本项目不会自动打开页面或远程加载代码。

没有 GM 菜单时，悬浮面板仍有“确认基线、启动、暂停、重连、导出”。

“仅重新连接本地决策器”发送 `intent=reconnect_only`，只验证连接、completed ACK 与 unresolved identity。它不会触发 planner 或签发新 action；若服务错误返回 execute，面板会暂停为 `RECONNECT_UNEXPECTED_EXECUTE` 并保留 action identity，不会执行。

## 首次会话

1. 页面加载后保持停止，只显示首次稳定 observation。
2. 导出并核对当前 session/map instance/dimensions/英雄摘要。
3. 用户明确选择 new game、handoff 或 resume，并确认基线。
4. 服务端完成 `session.command=confirm`；此前绝不签发行动。
5. 用户再次点击“启动”才进入循环。
6. 首次接管先运行物理扫描状态机；扫描期间只走安全空走廊、已验证无消耗 transition 或一次 opaque 楼梯/传送出口，不会打怪、开门、取资源、访问 NPC 或机关。

handoff 的 expected guard 来自会话配置，不编译进脚本。resume 必须复用同一 state dir 中已确认的 session。物理 save/load 默认禁用，没有内置槽位。

## 状态目录维护

安全迁移只能在自动驾驶暂停、无 pending、最后 completed 已 ack、服务完全停止时执行。完整复制整个 state dir，尤其是 generation manifest、所有 `gen-*`、入口 witness、JSONL 与 pauses；只复制入口 `mota-lab.sqlite3` 会丢失当前权威账本。新路径核对目录级 hash 后启动；不要用 SQLite 客户端直接打开 witness 或活动 generation 做“只读确认”，以免改变 sidecar。

出现 `UNKNOWN_ACTION_ID` 时保留浏览器 pending、pre fingerprint、当前 observation 和旧目录证据，恢复原 ledger 后做 pre/expected-post/ambiguous 三分法；不得清 journal 或重签替代行动。

## 离线 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

该命令构建两个产物两次并核对确定性，使用临时 Git index 做 prospective staged diff check，不污染真实 index。
