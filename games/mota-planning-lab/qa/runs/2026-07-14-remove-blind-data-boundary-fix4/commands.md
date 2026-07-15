# Fix 4 验证命令

工作区：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

## 红灯

详见 [`red-reproduction.md`](red-reproduction.md)。五类验收反例修改前均返回 `[]`；加入回归后定向测试为 `0 pass / 1 fail`。

## 绿灯定向验证

```bash
node --check games/mota-planning-lab/scripts/ast-runtime-compliance.mjs
node --test --test-name-pattern='mutable return|嵌套 closure|recursion fail-closed|函数摘要按 taint' \
  games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js
node --test games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js
```

结果：定向 `4/4`，AST 文件全量 `14/14`。五个原始验收反例现在均精确返回 `DIRECT_RUNTIME_STATE_MUTATION`；同函数、不同函数、nested closure、nested object、array/Map/Set mutator、反序更新、不同 memo signature 和无 prime 对照全部拒绝。fresh local container、captured local container、完整运行态只读与公开行动 API 继续合法。

## 性能与预算

七轮独立采样：

```text
depth 22  median 0.765 ms  max 4.057 ms
depth 40  median 0.948 ms  max 1.281 ms
```

修复只禁用 mutable heap result 的 memo；scalar/runtime 摘要仍然缓存，所以 DAG 22/40 仍近线性。递归/互递归、`maxSourceLength`、`maxSteps`、`maxCallDepth` 与 unsupported carrier 继续 fail closed。

## 完整离线 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

结果：`Mota Planning Lab offline QA: PASS`，`123 JS + 116 Python + 1 integration = 240/240`。integration 通过生产 `python -m mota_lab serve` 使用显式随机 loopback 端口，未连接或停止用户 `127.0.0.1:18724`。脚本同时完成 fixture/schema provenance、Protocol Pydantic/JSON Schema、compile/syntax、双 dist 两轮确定性、static runtime safety、docs/JSON、diff 和隔离 prospective staged check。

```bash
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
git diff --check
```

```text
c68d80acd0bc648ace9a6f3893d0d9e8a4758910bc589be1aa51d6fd594485f9  dist/mota-planning-lab.user.js
fad256fe1f62da57421e0d822c08542204325dbeb474b36f7c7b2faba3f91ef3  dist/mota-planning-lab.direct-mount.js
```
