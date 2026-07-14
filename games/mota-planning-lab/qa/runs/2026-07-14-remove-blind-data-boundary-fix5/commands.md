# Fix 5 验证命令

工作区：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

## 红灯

详见 [`red-reproduction.md`](red-reproduction.md)。验收漏报例返回 `[]`，误报例错误返回 `DIRECT_RUNTIME_STATE_MUTATION`；加入回归后定向测试为 `0 pass / 1 fail`。

## 绿灯定向验证

```bash
node --check games/mota-planning-lab/scripts/ast-runtime-compliance.mjs
node --test --test-name-pattern='callable return 保持每次 closure allocation identity|mutable return|嵌套 closure|recursion fail-closed|函数摘要按 taint' \
  games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js
node --test games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js
```

结果：定向 `5/5`，AST 文件全量 `15/15`。验收漏报例被精确拒绝，误报例合法通过；同表达式多实例、相同结构实参、allocation/call 顺序、nested closure、closure returns closure、bound callable、fresh captured container 正反例全部通过。

## 性能与预算

九轮独立采样：

```text
depth 22                       median 0.682 ms  max 4.084 ms
depth 40                       median 1.001 ms  max 1.264 ms
2000 closure/container alloc   median 12.797 ms max 24.739 ms
```

2000 allocation 在默认预算内合法完成；`maxSteps: 1000` 精确返回 `UNSAFE_RUNTIME_MUTATION_ANALYSIS` / `step-budget`。scalar/runtime 摘要仍缓存，depth 22/40 DAG 保持近线性。

## 完整离线 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

结果：`Mota Planning Lab offline QA: PASS`，`124 JS + 116 Python + 1 integration = 241/241`。integration 通过生产 `python -m mota_lab serve` 使用显式随机 loopback 端口，未连接或停止用户 `127.0.0.1:18724`。脚本同时完成 fixture/schema provenance、Protocol Pydantic/JSON Schema、compile/syntax、双 dist 两轮确定性、static runtime safety、docs/JSON、diff 和隔离 prospective staged check。

```bash
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
git diff --check
```

```text
c68d80acd0bc648ace9a6f3893d0d9e8a4758910bc589be1aa51d6fd594485f9  dist/mota-planning-lab.user.js
fad256fe1f62da57421e0d822c08542204325dbeb474b36f7c7b2faba3f91ef3  dist/mota-planning-lab.direct-mount.js
```
