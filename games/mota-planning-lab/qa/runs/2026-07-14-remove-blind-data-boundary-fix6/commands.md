# Fix 6 验证命令

```bash
node --test games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js \
  games/mota-planning-lab/tests/js/production-integrity-audit.test.js

MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
node --test games/mota-planning-lab/tests/integration/full-cycle.test.js

node games/mota-planning-lab/scripts/production-integrity-audit.mjs

MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

最终输出与 hash 见 `results.json`。
