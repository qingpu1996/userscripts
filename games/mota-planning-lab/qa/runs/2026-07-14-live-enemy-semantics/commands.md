# 当前怪物实时语义 QA 命令

工作目录：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

## 定向红灯

```bash
node --test games/mota-planning-lab/tests/js/observer-and-compliance.test.js

PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python:\
/opt/homebrew/lib/python3.12/site-packages:\
/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
/opt/homebrew/bin/python3.12 -m unittest \
  test_state_planner.PlannerCycleTests.test_known_unfightable_enemy_does_not_block_independent_supported_progress \
  test_state_planner.PlannerCycleTests.test_known_unfightable_enemy_is_blocked_and_idle_when_it_is_the_only_frontier \
  test_state_planner.PlannerCycleTests.test_damage_null_is_unexplained_once_live_attack_can_penetrate \
  test_runtime_v2.SessionWorldAndCorsTests.test_change_map_completion_ack_precedes_live_unfightable_enemy_planning
```

实现前 JS 新增测试 `2` 项失败：真实 `exp` 被归一为 null 并触发 `DAMAGE_UNEXPLAINED`；attack 10/defense 10 的 null damage 触发 `DAMAGE_NULL`。Python 定向测试 `3` 个 assertion 失败：独立资源被全局 pause、唯一不可战斗 frontier 被 pause、可穿透 null 错误标成 `DAMAGE_NULL`；换层恢复测试在补齐测试 import 后同样依赖上述语义。详见 `red-tests.md`。

## 定向绿灯与完整离线 QA

```bash
node --test \
  games/mota-planning-lab/tests/js/observer-and-compliance.test.js \
  games/mota-planning-lab/tests/js/journal-client-controller.test.js

MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh

shasum -a 256 \
  dist/mota-planning-lab.user.js \
  dist/mota-planning-lab.direct-mount.js

git diff --check
git status --short
```

完整脚本执行 fixture/schema provenance、全部 JS/Python/integration、Protocol Pydantic + JSON Schema、Python compileall、全部 JS syntax、userscript/direct-mount 双次确定性构建、Acorn 静态盲玩、docs/JSON、`git diff --check` 和隔离 prospective staged index 检查。
