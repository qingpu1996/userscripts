# Optional unsupported frontier QA 命令

工作目录：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

```bash
env PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python:/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  /opt/homebrew/bin/python3.12 -m unittest \
  games.mota-planning-lab.tests.python.test_state_planner.PlannerCycleTests.test_optional_unsupported_boundary_does_not_block_supported_door \
  games.mota-planning-lab.tests.python.test_state_planner.PlannerCycleTests.test_unsupported_boundary_blocking_only_corridor_pauses_without_crossing \
  games.mota-planning-lab.tests.python.test_state_planner.PlannerCycleTests.test_multiple_unsupported_boundaries_choose_deterministic_evidence -v
```

修改前结果：`3` 项中 `1` 项失败；可绕开的 optional NPC 错误返回 `pause`，红灯复现真实缺陷。

```bash
env PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python:/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  /opt/homebrew/bin/python3.12 -m unittest games/mota-planning-lab/tests/python/test_state_planner.py -v

env PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python:/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  /opt/homebrew/bin/python3.12 -m unittest discover -s games/mota-planning-lab/tests/python -p 'test_*.py' -v

MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh

shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
git diff --check
git status --short
```

完整 QA 脚本内部还会执行 fixture provenance、Protocol Pydantic/JSON Schema、Python compileall、所有 JS syntax check、userscript/direct-mount 双次确定性构建、Acorn 静态盲玩、文档/JSON 校验，以及隔离临时 index 的 prospective staged check。
