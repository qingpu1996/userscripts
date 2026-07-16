# 魔塔自动驾驶 Planning Lab

本目录保留浏览器侧采集、单步执行和内存契约，以及 Rust Stage 0 spike。旧 Python 决策后端、其数据、测试和历史 QA 记录已移除。

当前没有可运行的 solver runtime。两个浏览器产物保留为后续接入 Rust shadow runtime 的前端基础；在 shadow runtime 实现并单独验收前，禁止用于真实存档自动驾驶。

## 保留内容

- `src/`：页面实时采集、观察、控制、单步执行和内存行为。
- `dist/mota-planning-lab.user.js`：实际安装的用户脚本。
- `dist/mota-planning-lab.direct-mount.js`：受控直接注入产物。
- `tests/js/`：浏览器采集、执行、控制器、协议和纯内存契约测试。
- `rust/stage0-ir/`、`benchmarks/stage0.py` 和 `tests/fixtures/stage0/`：固定的 Stage 0 合成 spike。

## 构建与测试

```bash
node scripts/build-userscript.js mota-planning-lab
node games/mota-planning-lab/scripts/build-direct-mount.mjs
node --test games/mota-planning-lab/tests/js/*.test.js
```

Stage 0 使用唯一入口，所有输出与 Rust target 都在临时目录中，退出时清理：

```bash
games/mota-planning-lab/scripts/run-stage0-bench.sh
```

见 [安装与运行](docs/install-and-run.md)、[前端到 Rust 的最小协议边界](docs/protocol.md)、[Stage 0 与验证](docs/qa-runbook.md) 和 [求解器方向](docs/solver-architecture.md)。
