# fix-3 state dir 文档 QA 命令

工作目录：

```text
/Users/nihplod/.codex/worktrees/mota-planning-lab-v0.1.0
```

## 基线与修复前缺口

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git diff --cached --name-only

rg -n 'MOTA_LAB_STATE_DIR|临时|cache|缓存|删除|清空|迁移|备份|UNKNOWN_ACTION_ID|pending|SQLite|state dir|状态根' \
  games/mota-planning-lab/docs/install-and-run.md \
  games/mota-planning-lab/docs/state-machine.md \
  games/mota-planning-lab/README.md
```

基线为 branch `feature/mota-planning-lab/v0.1.0`、HEAD `eee41c0af3caa1f39e9cc143b681594009bda9a4`、index clean。修复前定向输出只有 install 的默认目录/环境变量、state-machine 的一般 pending/ledger 说明及 README 的“清 pending”说明；人工检查确认没有持久状态根警告、pending 期间禁止换目录、整目录迁移或 `UNKNOWN_ACTION_ID` 人工恢复。

修改前记录受保护文件基线：

```bash
find games/mota-planning-lab/src games/mota-planning-lab/service \
  games/mota-planning-lab/tests games/mota-planning-lab/protocol \
  games/mota-planning-lab/scripts -type f ! -path '*/__pycache__/*' -print0 \
  | sort -z | xargs -0 shasum -a 256 | shasum -a 256

find games/mota-planning-lab/src games/mota-planning-lab/service \
  games/mota-planning-lab/tests games/mota-planning-lab/protocol \
  games/mota-planning-lab/scripts -type f ! -path '*/__pycache__/*' \
  -exec stat -f '%m %N' {} + | sort | shasum -a 256

shasum -a 256 dist/mota-planning-lab.user.js
stat -f '%m %z %N' dist/mota-planning-lab.user.js
```

基线分别为内容汇总 `d01027640915379d3e2ce3d83e2fd82fc7dc3350fd76f3e6b81f5b961cf30cdf`、mtime 汇总 `f7ec7700537ef4ee91a069e52dc05e4fef2dec812a0a91d4c2a320d5a3e3144e`；dist 为 `c0b48cf3394114dd773500ff663b9d7046db77e3d081a138e66cbc76b8cd79ac`、mtime `1783962545`、`101229` bytes。

## 修复后覆盖与实现一致性

```bash
rg -n 'MOTA_LAB_STATE_DIR.*(持久状态根|不是.*cache)|正常重启.*绝对路径|pending.*绝对不得|不得在数据库运行中只复制单个|完整复制整个 state dir|原子 rename|PRAGMA quick_check|UNKNOWN_ACTION_ID.*不代表行动未执行|MOTA_LAB_KNOWLEDGE_DIR.*不能.*action ledger|显式状态重置' \
  games/mota-planning-lab/README.md \
  games/mota-planning-lab/docs/install-and-run.md \
  games/mota-planning-lab/docs/state-machine.md \
  games/mota-planning-lab/TASK.md

rg -n 'journal_mode=WAL|CREATE TABLE IF NOT EXISTS (observations|actions|decisions|action_id_sequence)|mota-lab.sqlite3|decisions.jsonl|127.0.0.1:18724' \
  games/mota-planning-lab/service/mota_lab \
  games/mota-planning-lab/docs/install-and-run.md

rg -n '^## T73|^## T74|T73/T74 保持未完成|T73.*T74.*未执行' \
  games/mota-planning-lab/docs/qa-runbook.md \
  games/mota-planning-lab/TASK.md \
  games/mota-planning-lab/qa/README.md
```

结果：全部 exit 0。关键持久化、门禁、迁移、故障恢复和 knowledge/state 区分均存在；实现与文档中的 WAL、文件名、表名和监听地址一致；T73/T74 仍明确未执行。

## Markdown、JSON 与空白

使用只读 Node 检查器扫描 `games/mota-planning-lab/**/*.md` 的本地相对链接；目录目标必须存在，文件 fragment 必须匹配对应 Markdown 标题生成的锚点。结果：PASS。

```bash
node -e 'const fs=require("fs");const p="games/mota-planning-lab/qa/runs/2026-07-14-fix-3-docs/results.json";JSON.parse(fs.readFileSync(p,"utf8"));console.log("QA JSON parse: PASS")'

if rg -n '[[:blank:]]+$' \
  games/mota-planning-lab/README.md \
  games/mota-planning-lab/TASK.md \
  games/mota-planning-lab/docs/install-and-run.md \
  games/mota-planning-lab/docs/state-machine.md \
  games/mota-planning-lab/qa/README.md \
  games/mota-planning-lab/qa/runs/2026-07-14-fix-3-docs; then
  exit 1
else
  printf 'no trailing whitespace\n'
fi

git diff --check
```

结果：JSON 可解析、无行尾空白、`git diff --check` exit 0。

## 受保护文件复核

再次执行基线的两条汇总 hash 命令与 dist 的 `shasum`/`stat`，结果逐字相同。另执行：

```bash
git status --short
git diff --cached --name-only
git branch --show-current
git rev-parse HEAD
```

结果：index clean，branch 和 HEAD 未变化；工作区仍是开发/修复开始前已有的未跟踪 `games/mota-planning-lab/` 与 `dist/mota-planning-lab.user.js`。本轮没有重建 dist，也没有 stage、commit、push、PR、rebase、squash 或 merge。

未运行全量离线回归，因为本轮只改文档且明确禁止原地重建 dist；112 项结果仍引用 [`../2026-07-14-fix-2/summary.md`](../2026-07-14-fix-2/summary.md)，本轮不冒充重新执行。
