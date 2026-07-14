# getDamage undefined fail-closed QA 命令

工作目录：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

## 定向绿灯

```bash
node --test \
  --test-name-pattern='实时攻防可解释|undefined 战损|damage 严格值域|怪物未知|采集期未知战损' \
  games/mota-planning-lab/tests/js/observer-and-compliance.test.js

PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python:\
/opt/homebrew/lib/python3.12/site-packages:\
/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
/opt/homebrew/bin/python3.12 -m unittest \
  test_models_api.ProtocolModelTests.test_damage_is_required_and_rejects_non_protocol_wire_values
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
