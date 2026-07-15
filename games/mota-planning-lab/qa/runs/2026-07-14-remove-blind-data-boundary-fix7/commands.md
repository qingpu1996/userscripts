# Fix 7 验证命令

## 红灯复现

```bash
node --test games/mota-planning-lab/tests/js/production-integrity-audit.test.js
```

新增回归首次运行结果为 `7 tests / 2 pass / 5 fail`：简单 engine alias、解构/member/bound alias、递归 source discovery 与 fake-core root/container 写入拦截均复现失败。详见 [`red-reproduction.md`](red-reproduction.md)。

## 绿灯与完整 QA

```bash
node --test games/mota-planning-lab/tests/js/production-integrity-audit.test.js

MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
node --test games/mota-planning-lab/tests/integration/full-cycle.test.js

node games/mota-planning-lab/scripts/production-integrity-audit.mjs

MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh

shasum -a 256 \
  dist/mota-planning-lab.user.js \
  dist/mota-planning-lab.direct-mount.js

git branch --show-current
git rev-parse HEAD
git status --short
git diff --cached --name-status
git diff --name-status
git diff --stat
```

最终结果：focused `9/9`，integration `1/1`，完整 QA `134 JS + 116 Python + 1 integration = 251/251`，production audit `pass`，prospective staged diff check 与 `git diff --check` 均通过。

未运行：真实浏览器、真实游戏、真实存档、真实 state/knowledge、`127.0.0.1:18724`、联网和外部攻略。
