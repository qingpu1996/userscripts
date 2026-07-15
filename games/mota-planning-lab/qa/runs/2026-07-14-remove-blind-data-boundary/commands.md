# 验证命令

工作区：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

## 定向旧政策红灯与新政策绿灯

基线 HEAD fixture 证明 `core.floors` 的 dot/bracket/optional/runtime 读取原本被登记为 `FORBIDDEN_FLOOR_CATALOGUE`：

```bash
git show HEAD:games/mota-planning-lab/tests/fixtures/static-compliance-cases.json \
  | /opt/homebrew/bin/python3.12 -c \
  'import json,sys; x=json.load(sys.stdin); print(json.dumps([i for i in x["invalid"] if "floors" in i["name"]][:6], ensure_ascii=False, indent=2))'
```

新门禁定向测试与正反投影：

```bash
node --test games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js
node games/mota-planning-lab/scripts/static-compliance.mjs
node --input-type=module -e "import {structuredRuntimeViolations as scan} from './games/mota-planning-lab/scripts/ast-runtime-compliance.mjs'; /* full reads => []; direct mutations => code */"
```

结果：AST `5/5`，Static runtime safety PASS；完整 floors/maps/material/save read 为 `[]`，hero/map/monster/event/save 五类 mutation 全部报告 `DIRECT_RUNTIME_STATE_MUTATION`。

## 隔离 integration

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
node --test games/mota-planning-lab/tests/integration/full-cycle.test.js
```

结果：`1/1`。测试随机选择空闲 loopback 端口，并使用临时 state/knowledge；不连接或停止用户在 18724 上的服务。

## 完整离线 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

结果：`Mota Planning Lab offline QA: PASS`。覆盖 fixture/schema provenance、113 JS、114 Python、1 integration、Protocol wire、compile/syntax、双 dist 两轮确定性构建、Static runtime safety、62 Markdown/38 local links/34 JSON、`git diff --check` 和隔离 prospective staged index。

## 构建物与工作区

```bash
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
git diff --check
git status --short
git diff --stat
```

开发 Agent 未操作真实浏览器、游戏、存档、真实 state/knowledge 或用户 18724 服务；未搜索/读取攻略资料或实际游戏工程；未 stage、commit、push、PR、rebase、squash 或 merge。
