# QA

Stage 0 是离线 synthetic spike，不是生产求解器验收，也不代表真实存档策略正确或具备 SLA。

运行单一入口：

```bash
cd games/mota-planning-lab
./scripts/run-stage0-bench.sh
```

入口会校验固定 24/100/600 层 fixtures 和小塔 oracle，运行 Python baseline 与 Rust 紧凑 IR 的同规则有界搜索，并在临时目录保留一次 warmup 与三份普通计时样本。比较结果打印到 stdout；临时目录、Rust target 和结果文件在退出时清理，不写入本目录。

最近一次普通结果（2026-07-16，本机 synthetic serial bounded workload）约为：transition `274.50x`、search `59.84x`（Rust/Python）。样本使用 0.35 dispersion 检查和 2.0x 路线判断；倍数会随机器负载变化，不应外推到生产。

结论：Stage 0 已完成，Rust 路线进入 `shadow-only` runtime；尚未进行生产迁移或真实页面行动。
