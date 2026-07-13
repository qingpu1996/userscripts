# Protocol v2 第四轮验收整改命令

## Test-first 红灯

```sh
node --test games/mota-planning-lab/tests/js/runtime-v2.test.js
node --test --test-name-pattern='仅重新连接|reconnectOnly 遇到错误' \
  games/mota-planning-lab/tests/js/journal-client-controller.test.js

PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python \
  python3 -m unittest \
  test_runtime_v2.ProtocolV2TopologyTests.test_wal_schema_classification_uses_private_consistent_snapshot \
  test_runtime_v2.ProtocolV2TopologyTests.test_unstable_snapshot_capture_fails_closed_without_opening_original

node games/mota-planning-lab/scripts/static-compliance.mjs
```

旧实现证据：fresh Tampermonkey 两个 key 全缺时得到 `parse_failed`；两个 reconnect 用例都缺失 `intent=reconnect_only`；非法活动 WAL 被拒绝时原 `-shm` SHA-256 改变；新增静态 fixture 有 6 个攻击漏检。测试均在修复前失败，没有通过破坏实现制造红灯。

## Targeted 与完整 QA

```sh
node --test games/mota-planning-lab/tests/js/*.test.js

PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python \
  python3 -m unittest discover -s games/mota-planning-lab/tests/python -p 'test_*.py'

MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

完整 QA 顺序执行 fixture provenance、全部 JS/Python、request/observation/response 协议契约、localhost fake-core integration、compile/syntax、双次确定性构建、src/service/双 dist 静态合规、文档/JSON、`git diff --check`，最后使用临时 Git index 与隔离 object directory 做 prospective staged check。

## 构建物与工作区

```sh
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
wc -l -c dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
shasum -a 256 "$(git rev-parse --git-path index)"
git ls-files -s | shasum -a 256
git status --short
git -C /Users/nihplod/Documents/codes/frontend/scripts/userscripts status --short --branch
```

未运行真实游戏、浏览器注入、存档、移动、换图或外网命令。
