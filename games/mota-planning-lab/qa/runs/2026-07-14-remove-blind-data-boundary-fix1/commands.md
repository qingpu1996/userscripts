# 验证命令

工作区：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

## 基线红灯

使用 Node `execFileSync("git", ["show", "HEAD:games/mota-planning-lab/scripts/ast-runtime-compliance.mjs"])` 读取基线分析器，将 Acorn import 指向当前 vendored parser 后以 data URL 动态载入，再扫描四个验收反例。结果四例的 `violations` 均为 `[]`：

```text
Reflect.set.apply + array carrier => []
object carrier nested write => []
identity function return write => []
runtime blocks.splice => []
```

## 修复后定向验证

```bash
node --test games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js
node --test \
  games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js \
  games/mota-planning-lab/tests/js/journal-client-controller.test.js
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
node --test games/mota-planning-lab/tests/integration/full-cycle.test.js
node games/mota-planning-lab/scripts/static-compliance.mjs
```

结果：AST `8/8`；AST + client/controller `38/38`；生产 CLI integration `1/1`；Static runtime safety PASS。四个基线漏报例修复后均输出 `DIRECT_RUNTIME_STATE_MUTATION`。

## 完整离线 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

结果：`Mota Planning Lab offline QA: PASS`，`117 JS + 116 Python + 1 integration = 234/234`。脚本同时完成双 dist 确定性、Protocol、compile/syntax、static safety、docs/JSON、`git diff --check` 与隔离 prospective staged check。

```bash
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
git diff --check
git status --short
```

未操作真实浏览器、游戏、存档、真实 state/knowledge 或用户 18724 服务；未使用攻略资料；未执行版本控制写操作。
