# Protocol v2 第六轮验收整改命令

测试先行红灯：

```sh
node --test \
  games/mota-planning-lab/tests/js/runtime-v2.test.js \
  games/mota-planning-lab/tests/js/journal-client-controller.test.js \
  > /tmp/mota-fix6-storage-red.log 2>&1
# exit 1: GM/direct no-op 与 pending silent failure 未拒绝

node games/mota-planning-lab/scripts/static-compliance.mjs \
  > /tmp/mota-fix6-static-red.log 2>&1
# exit 1: second-level Object/Reflect alias、global destructure、
# folded string、call/apply/bind 共 7 个 invalid fixture 漏拦
```

targeted 与完整离线 QA：

```sh
node --test \
  games/mota-planning-lab/tests/js/runtime-v2.test.js \
  games/mota-planning-lab/tests/js/journal-client-controller.test.js
node games/mota-planning-lab/scripts/static-compliance.mjs

MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

未运行真实游戏、浏览器注入、存档、移动、换图、截图、OCR、外网或 VCS 写命令。
