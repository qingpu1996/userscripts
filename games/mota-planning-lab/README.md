# 魔塔自动驾驶 Planning Lab

本目录保留浏览器侧采集、单步执行和内存契约，以及 Rust Stage 0 spike。旧 Python 决策后端、其数据、测试和历史 QA 记录已移除。

Stage2B Rust shadow runtime 只基于单次 observation 分析当前楼层：它返回可达边界中的怪物、三色门、资源和楼梯，以及即时距离、战损/钥匙成本与可行性。响应仍为只读 `idle + shadow`，不选择或执行动作，也不代表全局最优或可通关。

## 保留内容

- `src/`：页面实时采集、观察、控制、单步执行和内存行为。
- `dist/mota-planning-lab.user.js`：实际安装的用户脚本。
- `dist/mota-planning-lab.direct-mount.js`：受控直接注入产物。
- `tests/js/`：浏览器采集、执行、控制器、协议和纯内存契约测试。
- `rust/stage0-ir/`、`benchmarks/stage0.py` 和 `tests/fixtures/stage0/`：固定的 Stage 0 合成 spike。
- `rust/shadow-runtime/`：仅绑定 `127.0.0.1` 的 Stage2B 只读 Rust runtime；浏览器仍强制 `shadowOnly`。

## 构建与测试

```bash
node scripts/build-userscript.js mota-planning-lab
node games/mota-planning-lab/scripts/build-direct-mount.mjs
node --test games/mota-planning-lab/tests/js/*.test.js
cargo run --manifest-path games/mota-planning-lab/rust/shadow-runtime/Cargo.toml -- --port 18724
```

Rust runtime 的业务入口仅为 `POST /cycle`；为 direct-mount 的 `https://h5mota.com` 请求提供严格的 `OPTIONS /cycle` CORS 预检。请求体上限为 9 MiB：前端公开的 engine model 上限为 8 MiB，额外保留 1 MiB 给 cycle envelope，仍拒绝无界读取。没有日志、数据库、恢复或动作持久化。合同测试会使用合成 observation 启动临时 runtime 并自动清理。

Stage 0 使用唯一入口，所有输出与 Rust target 都在临时目录中，退出时清理：

```bash
games/mota-planning-lab/scripts/run-stage0-bench.sh
```

见 [安装与运行](docs/install-and-run.md)、[前端到 Rust 的最小协议边界](docs/protocol.md)、[Stage 0 与验证](docs/qa-runbook.md) 和 [求解器方向](docs/solver-architecture.md)。

当前实现的架构、状态模型、决策流程与外部评审问题见[当前 Shadow 求解器技术方案](docs/current-solver-architecture.md)。
