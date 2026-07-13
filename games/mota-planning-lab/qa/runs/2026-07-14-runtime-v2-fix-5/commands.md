# Protocol v2 第五轮验收整改命令

本文件记录 test-first、targeted 和完整离线 QA。最终数量、hash 与工作区证明见同目录 `summary.md` 和 `results.json`。

```sh
node --test games/mota-planning-lab/tests/js/runtime-v2.test.js
node games/mota-planning-lab/scripts/static-compliance.mjs

PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python \
  python3 -m unittest \
  test_runtime_v2.ProtocolV2TopologyTests.test_classified_inode_swap_to_future_schema_is_never_opened_or_written

node --test games/mota-planning-lab/tests/js/*.test.js
PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python \
  python3 -m unittest discover -s games/mota-planning-lab/tests/python -p 'test_*.py'

MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

红灯来自旧实现：缺 GM API 会隐式进入 direct mount；stale `GM_listValues` 会漏掉真实 v1/v2；指定 6 个 destructuring/function alias 攻击未命中；私有快照完成后、原 pathname connect 前换入 `user_version=99` 时 Store 未拒绝。修复后才转绿。

未运行真实游戏、浏览器注入、存档、移动、换图、截图、OCR 或外网命令。
