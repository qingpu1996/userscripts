# 验证命令

工作目录：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh

git diff --check
git status --short
shasum -a 256 \
  dist/mota-planning-lab.user.js \
  dist/mota-planning-lab.direct-mount.js
```

`run-offline-qa.sh` 内部依次执行 fixture/schema provenance、104 个 Node 单元测试、91 个 Python 单元测试、Protocol wire 双重校验、1 个 localhost 集成测试、Python compileall、全部 JS `node --check`、userscript/direct-mount 双构建与二次 hash 确定性、Acorn 静态盲玩检查、docs/JSON、`git diff --check`，以及隔离临时 index/object directory 的 prospective staged diff check。
