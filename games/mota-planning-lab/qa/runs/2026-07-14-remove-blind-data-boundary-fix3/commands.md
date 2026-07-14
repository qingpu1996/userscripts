# Fix 3 验证命令

工作区：`/Users/nihplod/.codex/worktrees/mota-planning-lab-runtime-v2`

## 红灯

详见 [`red-reproduction.md`](red-reproduction.md)。修改 analyzer 前，两条验收反例均返回空 violations；加入回归后定向测试为 `1 pass / 1 fail`。

## 定向闭包与静态门禁

```bash
node --check games/mota-planning-lab/scripts/ast-runtime-compliance.mjs
node --test games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js
node games/mota-planning-lab/scripts/static-compliance.mjs
git diff --check
git diff --cached --check
git diff --cached --name-only
```

结果：AST `13/13`；两条验收反例及 local→runtime、runtime→local、不同 closure 实例、unknown 预分析、深层 container taint 均精确报告 `DIRECT_RUNTIME_STATE_MUTATION`。原 20 类 carrier、原直接 mutation 组继续拒绝；合法局部闭包 mutation、完整 runtime/source/definition/save 只读和公开行动 API 零误报。静态扫描覆盖 19 个浏览器文件、16 个服务文件和双 dist，并验证 vendored Acorn。

## 性能与预算

七轮独立采样：

```text
depth 22  median 0.857 ms  max 4.189 ms
depth 40  median 1.148 ms  max 1.497 ms
```

修复使用 closure scope identity + scope binding revision；抽象 container 在绑定时递归登记 owner，任何深层原地 mutation 单调提升 owner scope revision。缓存键无需扫描整个 scope binding 图，因此重复 DAG 保持近线性。递归/互递归均在 500ms 门槛内 fail closed；`maxSourceLength`、`maxSteps`、`maxCallDepth` 预算回归继续通过。

## 完整离线 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

结果：`Mota Planning Lab offline QA: PASS`，`122 JS + 116 Python + 1 integration = 239/239`。integration 通过生产 `python -m mota_lab serve` 使用显式随机 loopback 端口，未连接或停止用户 `127.0.0.1:18724`。脚本同时完成 fixture/schema provenance、Protocol Pydantic/JSON Schema、compile/syntax、双 dist 两轮确定性、static runtime safety、docs/JSON、diff 和隔离 prospective staged check。

```bash
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
```

```text
c68d80acd0bc648ace9a6f3893d0d9e8a4758910bc589be1aa51d6fd594485f9  dist/mota-planning-lab.user.js
fad256fe1f62da57421e0d822c08542204325dbeb474b36f7c7b2faba3f91ef3  dist/mota-planning-lab.direct-mount.js
```
