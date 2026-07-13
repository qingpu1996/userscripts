# Protocol v2 第二轮验收整改命令

## Test-first 红灯

```sh
node --test --test-name-pattern='v1 disposition|仅重新连接|已证明未执行' \
  games/mota-planning-lab/tests/js/runtime-v2.test.js \
  games/mota-planning-lab/tests/js/journal-client-controller.test.js

PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python \
python3 -m unittest \
  test_runtime_v2.ProtocolV2TopologyTests.test_empty_database_initializes_v2_and_normal_v2_restarts \
  test_runtime_v2.ProtocolV2TopologyTests.test_counterfeit_v2_schema_contracts_fail_before_any_write \
  test_storage_recovery_cli.StorageAndRecoveryTests.test_session_wide_unresolved_action_blocks_new_fingerprint_and_replays_same_id \
  test_storage_recovery_cli.StorageAndRecoveryTests.test_not_executed_recovery_replays_same_id_and_is_restart_idempotent
```

修复前新增 3 个 JS 用例为 `0 pass / 3 fail`：reconnect 发送 `phase=none`、同 ID 被当成 duplicate、legacy disposition 清空已有 v2 evidence。Python 4 个定向测试产生 11 个失败断言：partial/伪同列/缺约束 schema 被接受，同 session 换 fingerprint 签出第二行动，`not_executed` 改签 action ID。没有通过破坏代码制造红灯。

## 修复后 targeted 与完整 QA

```sh
node --test games/mota-planning-lab/tests/js/*.test.js
PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python \
  python3 -m unittest discover -s games/mota-planning-lab/tests/python -p 'test_*.py'
MOTA_LAB_PYTHON=python3 MOTA_LAB_PYTHONPATH='' \
  node --test games/mota-planning-lab/tests/integration/*.test.js

before=$(git ls-files -s | shasum -a 256 | awk '{print $1}')
MOTA_LAB_PYTHON=python3 MOTA_LAB_PYTHONPATH='' \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh
after=$(git ls-files -s | shasum -a 256 | awk '{print $1}')
test "$before" = "$after"
```

`run-offline-qa.sh` 顺序执行 fixture/schema provenance、全部 JS/Python、Protocol wire、localhost fake-core integration、compile/syntax、双构建确定性、src/service/双 dist 静态盲玩扫描、文档/JSON、`git diff --check`，最后使用临时 `GIT_INDEX_FILE`、隔离 object directory 与真实 objects 只读 alternate 做 prospective staged diff check。

## 构建物与工作区

```sh
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
wc -c -l dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
git status --short
git status --ignored --short games/mota-planning-lab
```

未运行真实游戏、浏览器注入、存档、移动、换图或外网命令。
