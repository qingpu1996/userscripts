# Protocol v2 第三轮验收整改命令

## Test-first 红灯

```sh
node --test --test-name-pattern='固定 journal key|仅重新连接|精确 map target' \
  games/mota-planning-lab/tests/js/runtime-v2.test.js \
  games/mota-planning-lab/tests/js/journal-client-controller.test.js

PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python \
python3 -m unittest \
  test_runtime_v2.ProtocolV2TopologyTests.test_counterfeit_check_comments_and_generated_columns_fail_without_touching_db \
  test_runtime_v2.SessionWorldAndCorsTests.test_ordinary_verified_transition_binds_exact_target_and_ambiguous_exit_pauses

node games/mota-planning-lab/scripts/static-compliance.mjs \
  games/mota-planning-lab/tests/fixtures/static-compliance-cases.json
```

修复前红灯证据：新增 journal/reconnect 3 组 JS 失败；SQLite comment 伪造 CHECK 与 generated hidden column 被接受；普通规划同一出口多目标没有暂停；8 个新增静态绕过 fixture 均漏检。精确目标 A→B/A→C 的浏览器差分用例在实现目标绑定后先行通过。没有通过破坏代码制造红灯。

## 修复后 targeted 与完整 QA

```sh
node --test games/mota-planning-lab/tests/js/runtime-v2.test.js

PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python \
  python3 -m unittest games/mota-planning-lab/tests/python/test_runtime_v2.py -v

before=$(git ls-files -s | shasum -a 256 | awk '{print $1}')
raw_before=$(shasum -a 256 "$(git rev-parse --git-path index)" | awk '{print $1}')
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh
after=$(git ls-files -s | shasum -a 256 | awk '{print $1}')
raw_after=$(shasum -a 256 "$(git rev-parse --git-path index)" | awk '{print $1}')
test "$before" = "$after"
test "$raw_before" = "$raw_after"
```

`run-offline-qa.sh` 顺序执行 fixture/schema provenance、全部 JS/Python、Protocol wire、localhost fake-core integration、compile/syntax、双构建确定性、src/service/双 dist 静态盲玩扫描、文档/JSON、`git diff --check`，最后使用临时 `GIT_INDEX_FILE`、隔离 object directory 与真实 objects 只读 alternate 做 prospective staged diff check。

## 构建物与工作区

```sh
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
wc -c -l dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
git status --short
git status --ignored --short games/mota-planning-lab
git -C /Users/nihplod/Documents/codes/frontend/scripts/userscripts status --short --branch
```

未运行真实游戏、浏览器注入、存档、移动、换图或外网命令。
