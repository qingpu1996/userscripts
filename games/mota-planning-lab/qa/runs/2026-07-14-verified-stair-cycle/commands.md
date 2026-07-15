# 验证命令

工作区：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

## 定向红灯与绿灯

见 [red-tests.md](red-tests.md)。实现后运行：

```bash
PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python:/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  /opt/homebrew/bin/python3.12 -m unittest -v test_runtime_v2
```

覆盖互返楼梯 idle、当前 redDoor、远端 resource、opaque→verified、AUTO3/4/5、restart completed/ack、root-live-only enemy 与 known-unfightable。

## 完整离线 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

该脚本依次执行 fixture/schema provenance、全部 JS、全部 Python、Pydantic/JSON Schema、integration、compileall、JS syntax、双 dist 两轮确定性构建、Acorn 静态盲玩、docs/JSON、`git diff --check` 和隔离 prospective staged index 检查。

## 构建物 hash 与工作区

```bash
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
git diff --check
git status --short --branch
git diff --stat
```

本轮修复 Agent 未启动 localhost 服务、未操作浏览器、未读取或写入真实 state/knowledge 目录，也未执行 stage、commit、push、PR、rebase、squash 或 merge。
