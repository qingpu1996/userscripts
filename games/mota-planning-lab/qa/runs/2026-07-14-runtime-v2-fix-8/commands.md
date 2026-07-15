# 第八轮离线 QA 命令

红灯与 targeted：

```bash
node --test games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js \
  games/mota-planning-lab/tests/js/journal-dual-slot.test.js
node games/mota-planning-lab/scripts/static-compliance.mjs
```

完整离线 QA：

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

构建物、index 与工作区核对：

```bash
wc -l -c dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
shasum -a 256 "$(git rev-parse --git-path index)"
git status --short --branch
git -C /Users/nihplod/Documents/codes/frontend/scripts/userscripts status --short --branch
```

真实浏览器、游戏、存档与外网均未运行。
