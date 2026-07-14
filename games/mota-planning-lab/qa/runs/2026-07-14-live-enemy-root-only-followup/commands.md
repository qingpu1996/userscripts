# 怪物事实 root-live-only QA 命令

工作目录：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

## 定向红灯与绿灯

```bash
PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python:\
/opt/homebrew/lib/python3.12/site-packages:\
/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
/opt/homebrew/bin/python3.12 -m unittest \
  test_runtime_v2.SessionWorldAndCorsTests.test_world_search_never_reuses_live_enemy_fact_after_same_map_resource \
  test_runtime_v2.SessionWorldAndCorsTests.test_world_search_never_reuses_live_enemy_fact_after_non_attack_resource \
  test_runtime_v2.SessionWorldAndCorsTests.test_world_search_never_reuses_live_enemy_fact_after_return_to_same_map \
  test_runtime_v2.SessionWorldAndCorsTests.test_world_search_live_root_enemy_is_a_terminal_atomic_candidate \
  test_runtime_v2.SessionWorldAndCorsTests.test_known_unfightable_enemy_is_never_crossed_by_scan_or_world_search

node --test --test-name-pattern='当前怪物字段别名严格归一' \
  games/mota-planning-lab/tests/js/observer-and-compliance.test.js
```

## 完整离线 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh

shasum -a 256 \
  dist/mota-planning-lab.user.js \
  dist/mota-planning-lab.direct-mount.js

git diff --check
git status --short --branch
```

完整脚本覆盖 fixture/schema provenance、全部 JS/Python/integration、Protocol Pydantic + JSON Schema、Python compileall、全部 JS syntax、userscript/direct-mount 双次确定性构建、Acorn 静态盲玩、docs/JSON、`git diff --check` 和隔离 prospective staged index。
