# 验证

浏览器侧回归：

```bash
node --test games/mota-planning-lab/tests/js/*.test.js
node scripts/build-userscript.js mota-planning-lab
node games/mota-planning-lab/scripts/build-direct-mount.mjs
```

Stage 0 的唯一入口：

```bash
games/mota-planning-lab/scripts/run-stage0-bench.sh
```

Stage2B 由 `tests/js/shadow-runtime-contract.test.js` 启动临时 Rust runtime，并用合成 observation 验证当前楼层候选及 JS/Schema 合同。测试使用临时 Cargo target，结束后清理；不访问浏览器或真实游戏。

该入口校验固定 24/100/600 层 fixture 和小塔 oracle，运行 Python baseline 与 Rust 紧凑 IR，并把结果打印到 stdout。临时结果和 Rust target 在退出时清理；不要把运行产物提交到 `qa/`。

Stage 0 只证明固定合成 workload 的可重复性，不证明真实页面策略、生产性能或自动驾驶安全性。
