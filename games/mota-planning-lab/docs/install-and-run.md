# 安装与启动

以下步骤只构建本地产物、启动 localhost 服务并由用户手动安装 userscript。任何命令都不会打开游戏、安装到 Tampermonkey、读写游戏存档或启动自动驾驶。

## 前置条件

- Node.js 18 或更高版本，用于构建和 JavaScript 测试。
- Python 3.11 或更高版本。
- Tampermonkey 或兼容的 userscript 管理器。
- 目标页为 `https://h5mota.com/games/24/`。

## 1. 创建项目本地 Python 环境

在仓库根目录执行：

```bash
cd games/mota-planning-lab
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install -r service/requirements.lock
```

`.venv/` 已在项目 `.gitignore` 中排除。依赖只安装到项目环境，不写系统 Python。

也可以安装命令入口：

```bash
python -m pip install --no-deps -e service
```

不安装 editable package 时，后续命令加上 `PYTHONPATH=service` 即可。

## 2. 启动 localhost 决策服务

```bash
PYTHONPATH=service python -m mota_lab serve
```

服务固定监听 `127.0.0.1:18724`。CLI 会拒绝非 loopback host 或不同端口；FastAPI 的 docs/openapi 页面也被关闭。

默认运行数据写入：

- 状态、SQLite、JSONL 与暂停证据：`~/.local/state/mota-planning-lab/`
- 人工知识标签：`~/.local/share/mota-planning-lab/knowledge/`

可用环境变量改到独立目录：

```bash
MOTA_LAB_STATE_DIR="$HOME/mota-lab-state" \
MOTA_LAB_KNOWLEDGE_DIR="$HOME/mota-lab-knowledge" \
PYTHONPATH=service python -m mota_lab serve
```

初始 bundled knowledge 为空，不预装真实 4F 地图、block 或路线。

### 2.1 状态目录不是缓存

`MOTA_LAB_STATE_DIR` 是服务的**持久状态根**，不是临时 cache。它与浏览器 GM journal 共同组成 action_id 的幂等身份和恢复链，目录内包括：

- `mota-lab.sqlite3` 及存在时的 `mota-lab.sqlite3-wal`、`mota-lab.sqlite3-shm` 等 SQLite sidecar；数据库内保存 observation、action ledger、decision cache 和 `action_id_sequence` issuance sequence；
- `decisions.jsonl` 决策审计日志；
- `pauses/` 下的结构化 pause evidence。

正常重启、升级和“仅重新连接本地决策器”都必须复用同一个**绝对路径和完整目录**。不得删除、清空、换成空目录，或只留下一个新建的同名 SQLite 文件。删除整个 state dir 属于显式状态重置，超出“服务重启可恢复”的保证范围；必须由用户主动确认，并先处理所有 pending 状态。

`MOTA_LAB_KNOWLEDGE_DIR` 是另一条数据边界，只保存人工维护的 floor/block 知识标签，可以独立配置和备份。仅保留 knowledge dir **不能**恢复 action ledger、action_id issuance sequence、decision cache 或浏览器 pending 对应的服务端身份。

浏览器 journal 与服务状态根如何共同完成最多一次执行，见[浏览器控制状态机](state-machine.md)。

### 2.2 pending 行动期间的绝对门禁

只要满足以下任一条件，就绝对不得切换、迁移、删除或清空 `MOTA_LAB_STATE_DIR`：

- 服务签发的行动尚未 completed 并 acknowledged；
- 浏览器 GM journal 仍有 `pending_action`；
- 当前游戏现场尚未与 pre-fingerprint / expected post-state 完成核对。

不确定时一律按“仍有 pending”处理。此时也不得使用“清除待执行行动”菜单绕过；该菜单只清浏览器账本，不会补回或修复服务端 ledger。先保持自动驾驶暂停、停止自动寻路并完成恢复核对，再考虑任何目录操作。

### 2.3 安全迁移 state dir

迁移必须作为一次停机、整目录、可回滚的维护操作执行：

1. 在浏览器中暂停自动驾驶并停止产生新 action；保持 userscript 断开或暂停，不发送新的 `/cycle`。
2. 确认没有执行中的自动路线、移动、锁控制或活动事件。不得清除 browser pending journal。
3. 记录源/目标绝对路径、`pending_action`、`last_completed_action`、`last_acknowledged_action_id`，以及当前现场 fingerprint。`pending_action` 此时必须为 `null`，最后完成行动也必须已 acknowledged；若发现 pending，记录其 action_id、phase、pre-fingerprint 和 expected_delta 后立即中止迁移，先按状态机恢复流程处理，全部确认后再从第 1 步重新开始。
4. 停止 localhost 服务，确认服务进程已退出。SQLite 使用 WAL；不得在数据库运行中只复制单个 `mota-lab.sqlite3`。
5. 使用文件系统 snapshot，或在同一文件系统的临时目录中完整复制整个 state dir。复制必须包含 SQLite 主文件及所有现存 sidecar、数据库内的 issuance sequence 与 decision cache、`decisions.jsonl`、`pauses/` 及其他目录项；校验完成后再以原子 rename 放到目标路径。
6. 保留未修改的原目录作为回滚备份，不要让服务先在目标位置初始化空目录，也不要用目标内容覆盖唯一备份。
7. 将 `MOTA_LAB_STATE_DIR` 指向新的绝对路径，浏览器仍保持暂停/断开，然后启动服务。
8. 先做健康与只读核对：确认进程只监听 `127.0.0.1:18724`；以只读方式执行 SQLite `PRAGMA quick_check`，核对 actions/decisions/observations 数量、pending 或最后完成 action_id、`action_id_sequence.next_value` 与迁移前记录一致；同时确认 JSONL 和 pause evidence 已完整复制。v0.1.0 没有独立 `/health` endpoint，健康核对不得用会签发行动的 `/cycle` 代替。
9. 以上均一致后，才使用“仅重新连接本地决策器”核对浏览器 journal、当前现场和迁移后的 ledger 连续性；确认仍无 pending 且 action_id 链一致后，才可恢复自动驾驶。若意外出现 pending、`UNKNOWN_ACTION_ID` 或现场不符，立即保持暂停并进入故障恢复，不得继续。

可选的只读核对命令示例；它不能替代第 3 步保存的浏览器 journal 与现场记录：

```bash
lsof -nP -iTCP:18724 -sTCP:LISTEN
sqlite3 -readonly "$MOTA_LAB_STATE_DIR/mota-lab.sqlite3" \
  'PRAGMA quick_check; SELECT COUNT(*) FROM observations; SELECT COUNT(*) FROM actions; SELECT COUNT(*) FROM decisions; SELECT action_id,status FROM actions ORDER BY updated_at DESC LIMIT 5; SELECT next_value FROM action_id_sequence WHERE singleton=1;'
```

### 2.4 目录遗失、损坏或切错

如果 state dir 遗失、损坏或误指向空目录：

1. 保持自动驾驶暂停并停止自动寻路；不要盲目重放，不要清 browser journal，也不要新建空目录冒充恢复。
2. 保留浏览器 pending、最后完成记录和当前现场 observation/fingerprint；停止当前服务，把误用目录单独保存，避免覆盖证据。
3. 优先恢复原 state dir 或第 2.3 节的完整备份，再按只读 ledger 核对与恢复三分法继续。
4. 服务返回 `UNKNOWN_ACTION_ID` 只说明当前 ledger 不认识该 action_id，**不代表行动未执行**。恢复原账本后再核对；若账本确实无法恢复，必须进入 [`UNKNOWN_ACTION_ID` 人工恢复流程](state-machine.md#unknown_action_id-人工恢复)，不得自动签发替代行动。

若最终决定删除整个 state dir 并重新开始，这是一项需用户明确确认的显式状态重置。必须先对 pending 行动给出人工结论并归档 journal、现场 fingerprint 和备份位置；不能把它描述成普通服务重启或无损恢复。

## 3. 构建 userscript

回到仓库根目录：

```bash
node scripts/build-userscript.js mota-planning-lab
node --check dist/mota-planning-lab.user.js
```

生成文件为 `dist/mota-planning-lab.user.js`。metadata 只匹配目标页面，只 `@connect 127.0.0.1`，不含自动更新 URL。

## 4. 手动安装

1. 打开 Tampermonkey 管理页，选择“添加新脚本”或“从文件安装”。
2. 手动导入生成的 `dist/mota-planning-lab.user.js`。
3. 检查权限只有 `unsafeWindow`、GM 本地存储、菜单注册和 localhost 请求。
4. 保存脚本。项目不会替用户执行这一步。

## 5. 首次运行

首次打开目标页时脚本保持 `STOPPED`，只读取当前层白名单现场并核对：

- 显示 4F，位置 `x=8,y=3`
- HP 208，ATK 23，DEF 21
- Gold 16，EXP 63
- 黄/蓝/红钥匙 `4/1/0`

不匹配时以 `GUARD_MISMATCH / INITIAL_BASELINE_MISMATCH` 暂停。匹配时面板显示“现场核对通过，等待手动启动”，仍不会行动。

确认 localhost 已启动后，使用油猴菜单“启动自动驾驶”。因为初始知识库为空，服务第一次会对真实 floorId 返回 `UNKNOWN_FLOOR` 并生成只含当前层的证据包；按 [`manual-labeling.md`](manual-labeling.md) 完成人工标签后，再手动重新连接或启动。

## 6. 控制菜单

- 启动自动驾驶
- 暂停自动驾驶
- 导出当前层运行态
- 清除待执行行动
- 仅重新连接本地决策器

“清除待执行行动”只清 GM journal，需要确认，不会回滚、移动、改游戏状态或修复服务 ledger。行动尚未 completed/acknowledged、浏览器仍有 pending 或现场尚未确认时禁止使用；它不是 state dir 遗失、迁移或 `UNKNOWN_ACTION_ID` 的恢复手段。“仅重新连接”只做 observation/cycle 握手，不执行服务返回的行动。

## 存档边界

v0.1.0 不启用真实 save/load。初始化不读取 slot 8，任何阶段都不会覆盖 slot 8。搜索分支只存在于本地数据模型中。

## 停止

先使用菜单“暂停自动驾驶”，再在服务终端按 `Ctrl-C`。停止服务不修改游戏；服务不可达时浏览器会安全暂停，不会缓存动作后离线执行。下次启动仍须使用同一个 `MOTA_LAB_STATE_DIR` 绝对路径和完整目录；迁移或故障时按第 2.3、2.4 节处理。
