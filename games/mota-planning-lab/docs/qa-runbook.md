# QA 手册

当前离线门禁验证 Python + Protocol v2 实现；目标 Rust 单步循环尚未实现。通过现有测试不能宣称目标 V1 或策略已经完成。

## 当前离线门禁

运行 `./scripts/run-offline-qa.sh`，依次验证 Node、Python、integration、protocol、双构建确定性、static compliance 和 production integrity。重点检查：

- production 运行态只在内存 `Store()` 中，`state_dir`/`knowledge_dir` 不被读取或写入；
- packaged rules 缺失或非法时启动 fail closed，不回退用户目录；
- 同一进程 single in-flight、guard/delta mismatch 暂停、完成 ACK、商店选择 at-most-once；
- 页面或服务重新实例化后 fresh session，旧 action 不恢复、不重放；
- 双 dist 无 storage 写入或旧 action replay。

真实页面测试必须单独记录动作数、前后状态、暂停原因、耗时和控制台错误；离线性能结果不作为真实页面 SLA。

## Stage 0（已完成）

单一入口 `./scripts/run-stage0-bench.sh` 使用固定 `synthetic-24.json`、`synthetic-100.json`、`synthetic-600.json` 和 `oracle-small.json`。它先做固定 fixture/oracle/等价检查，再分别执行 Python baseline 和 Rust 紧凑 IR 的有界搜索，并把简洁 JSON 结果打印到 stdout。所有 benchmark 输出放在 `mktemp` 临时目录，退出时清理；QA 目录不保存运行结果。

每个 phase 固定一次 warmup，随后保留三份完整计时样本；不 retry、不挑选或丢弃样本。样本 dispersion 上限为 `0.35`，600 层 transition/search 的 Rust/Python 比率都达到 `2.0x` 才认为路线值得进入 shadow-only。最近一次普通结果（2026-07-16，本机 synthetic serial workload）约为 transition `274.50x`、search `59.84x`。

该结论只说明 Rust shadow 方向在合成 bounded workload 上值得继续；不证明生产规则完整、策略正确、并行扩展或服务 SLA。

## 下一步

先实现纯内存 Rust shadow runtime：JS 每轮采集实时状态，Rust 返回一个建议，JS 暂不执行。运行态不持久化 action、规划状态、世界状态或恢复点；唯一允许的持久化是本次启动的旁路全量诊断日志，供事后复盘且运行时只写不读。
