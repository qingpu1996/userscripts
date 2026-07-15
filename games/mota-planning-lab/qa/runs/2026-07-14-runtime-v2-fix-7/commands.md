# 第七轮离线 QA 命令

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

另行执行的红灯/targeted 命令：

```bash
node --test games/mota-planning-lab/tests/js/journal-dual-slot.test.js
node games/mota-planning-lab/scripts/static-compliance.mjs
```
