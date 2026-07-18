# Phase 3 前置收尾 QA 归档（2026-07-18）

本目录冻结 `11abffc` 的 Phase 3 基线，供下一轮 local-reachable cache 评审复核；不包含 request body、二进制、target 或服务日志。`summary.json` 的数字逐项来自既有 raw/summary，`phase3-official-samples.tsv` 与 `profile-phase3-*.jsonl` 是从 `/private/tmp/mota-phase3b-final-evidence` 逐字复制的样本/profile，`phase25-official-samples.tsv` 来自 `/private/tmp/mota-phase25-profile-current-off`。

## 对照边界

`phase25_final` 是现有 Phase 2.5 final（`554da51`）的 default-off 10+10 批次；该旧 profile schema 已记录 `work_items_popped=335850`、`stale_source_work_items=205881`、`connectivity_view_calls=197187` 和 `local_reachable_calls=1774683`，但尚未输出 stale skip、accepted/rejected/pending 或 PassabilitySignature potential-hit 字段，因此归档明确标为 `not_emitted`，没有补造数字。

严格的 Phase 3 A/B 是同一最终批次（`594dc6d` baseline 对 `11abffc` final，7+7 samples），final profile 行记录：`work_items_popped=371918`、stale observed/skipped `219918/59822`、`connectivity_view_calls=176119`、`local_reachable_calls=1585071`、accepted/rejected/pending `50000/126119/281991`、PassabilitySignature potential hit rate `0.9324446665165157`。两版 canonical response hash 都是 `af9d3ceabca4a57c6c0f3713defac7f9038970050260076ac626a0df4ace96f2`。

Phase 2.5 与 Phase 3 数字跨批次，不能当作严格单轮 A/B；性能/内存结论以这组最终 Phase 3 A/B 为准。request SHA-256 为 `508b4d25557b0c30b649d5e923a5ec9fa3470dc8555d8d49e3dcb9bad98ba55e`（2,576,604 B）；source/binary SHA-256 和临时路径见 `summary.json` 与 `source-hashes-phase3a.txt`。临时路径只是运行时证据定位，原始载荷未归档。

## 本轮代码验证

`main.rs` 新增 action-kind profile 计数（door/resource/enemy/transition/event/shop/invalid，稳定字段），确定性小世界 differential oracle（固定 xorshift seed，stale skip on/off、预算/目标/Phase B canonical route 对照），以及非零 Phase B proven route/replay fixture。Phase 3 生产搜索语义、预算、FIFO、未证明规则处理未改变；PassabilitySignature 仍是 profiling-only 诊断，无 cache/region graph。

验证命令：`cargo fmt -- --check`、debug/release `cargo test`、`cargo check`、`git diff --check`；本轮 Rust 测试 78/78 通过。profile 关闭时不创建诊断计时器或集合。QA 归档只保存 summary、samples/profile、hash 和本说明。
