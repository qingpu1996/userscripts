# Fix 2 验证命令

工作区：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

## 定向验证

```bash
node --check games/mota-planning-lab/scripts/ast-runtime-compliance.mjs
node --test games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js
node games/mota-planning-lab/scripts/static-compliance.mjs
git diff --check
```

结果：AST `11/11`；20 组系统 mutation 反例全部拒绝；完整 src 与双 dist 静态扫描通过。合法完整 floors/maps/material/source/save 读取、局部 snapshot/container mutation 和正常引擎公开行动接口保持通过。

## 性能与预算

使用测试内 depth 32 重复 DAG 硬阈值 `<500ms`；独立七轮采样的中位数/最大值：

```text
depth 20  median 0.863 ms  max 4.320 ms
depth 22  median 0.538 ms  max 1.617 ms
depth 30  median 0.612 ms  max 1.189 ms
depth 40  median 1.213 ms  max 2.444 ms
```

`maxSourceLength`、`maxSteps`、`maxCallDepth` 均有定向回归；耗尽统一返回 `UNSAFE_RUNTIME_MUTATION_ANALYSIS`，不静默放行。

## 完整离线 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

结果：`Mota Planning Lab offline QA: PASS`，`120 JS + 116 Python + 1 integration = 237/237`。integration 继续执行生产 `python -m mota_lab serve --host 127.0.0.1 --port <random>`，未连接、停止或复用用户 `18724` 服务。脚本同时完成 Protocol、compile/syntax、双 dist 两轮确定性、Static runtime safety、docs/JSON、`git diff --check` 和隔离 prospective staged check。

```bash
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
```

```text
c68d80acd0bc648ace9a6f3893d0d9e8a4758910bc589be1aa51d6fd594485f9  dist/mota-planning-lab.user.js
fad256fe1f62da57421e0d822c08542204325dbeb474b36f7c7b2faba3f91ef3  dist/mota-planning-lab.direct-mount.js
```
