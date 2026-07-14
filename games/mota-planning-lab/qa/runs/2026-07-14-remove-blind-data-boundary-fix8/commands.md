# Fix 8 验证命令

```bash
node --test games/mota-planning-lab/tests/js/production-integrity-audit.test.js
node games/mota-planning-lab/scripts/test-production-engine-api-injection.mjs
node games/mota-planning-lab/scripts/production-integrity-audit.mjs

MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh

shasum -a 256 \
  dist/mota-planning-lab.user.js \
  dist/mota-planning-lab.direct-mount.js

git diff --check
git status --short
git diff --cached --name-status
```

真实页面、真实游戏、真实存档、真实 state/knowledge、`127.0.0.1:18724`、网络与外部攻略均不运行或接触。
