# Canonical tools 零钥匙省略恢复 QA 命令

工作目录：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

## 定向红灯与绿灯

```bash
node --test \
  --test-name-pattern='canonical hero.items.tools|黄钥匙归零字段' \
  games/mota-planning-lab/tests/js/observer-and-compliance.test.js \
  games/mota-planning-lab/tests/js/journal-client-controller.test.js
```

实现前两个定向测试均失败：canonical `tools` 缺少 `yellowKey` 抛出
`INCOMPLETE_KEY_LAYOUT`，刷新恢复无法进入 connected/completed。实现后 `2/2` 通过。

## 完整离线 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh

shasum -a 256 \
  dist/mota-planning-lab.user.js \
  dist/mota-planning-lab.direct-mount.js

git diff --check
git status --short
```

完整脚本执行 fixture/schema provenance、全部 JS/Python/integration、Protocol
Pydantic + JSON Schema、Python compileall、JS syntax、userscript/direct-mount 双次确定性构建、
Acorn 静态盲玩、docs/JSON、`git diff --check` 和隔离 prospective staged index 检查。
