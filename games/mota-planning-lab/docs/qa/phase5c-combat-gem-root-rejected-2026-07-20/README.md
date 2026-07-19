# Phase 5C：combat-gem root reduction（Rejected）

## 结论

本探针已停止并完整回退，未进入 typed certificate 或生产提交。它验证的是一个极窄的 **accepted-source forced root gate**，不是此前已拒绝的通用 resource closure。

## 做了什么

在 accepted source 已经得到 `ConnectivityView` 后，若当前稳定顺序的 boundary 中出现首个合格红/蓝宝石，则只入队一个现有 `PhaseAWorkItem` 并返回；否则保持原有 boundary/shop 入队逻辑。明确不做 batch、wave、额外 connectivity、Pareto 前处理、new work item、closure 子系统或 Phase B 改动。

官方白名单为：`redGem`/numeric `27`（attack +3）和 `blueGem`/numeric `28`（defense +3）。临时 typed shape 还要求资源初始 active、仅单一攻或防增益、其余数值/倍率/inventory 均为空或恒等；同格存在第二个 active dynamic boundary 时不强制。

## 怎么做

使用固定官方请求（SHA-256 `508b4d25557b0c30b649d5e923a5ec9fa3470dc8555d8d49e3dcb9bad98ba55e`，2,576,604 bytes），warmup 1 次后交错 3+3：

* overhead gate-off：A 基线 vs B 候选但关闭 gate；
* gain gate-on：A 基线 vs C 候选并开启 gate；
* 只有至少 5% 中位耗时改善且 RSS ≤55 MB 才继续 7+7；未达到则停止。

候选二进制 SHA-256 为 `b53345b7fc2ff33fd928943048ac58e4847cb1df78987cb05f7471e4539244b7`，基线二进制 SHA-256 为 `18bfa06aba4814948ee85c0fd680a5cb518576aaf3c1aacbaae9be3a9f804082`。

## 未达预期的证据

gate-off 结果：A 中位 `1195.596 ms`、最大 RSS `49,987,584 B`；B 中位 `1193.071 ms`、最大 RSS `50,167,808 B`，仅约 `-0.21%`，canonical response 相同，未达到 5% 门槛。

gate-on 结果：A 中位 `1223.245 ms`、最大 RSS `51,331,072 B`；C 中位 `1266.540 ms`、最大 RSS `47,497,216 B`，候选慢约 `3.54%`，因此没有继续 7+7。canonical response 相同，但 accepted semantic trace hash 不同。

profile-on 诊断（单次样本）记录：`popped=408244`、`materialize=331890`、`connectivity=177868`、`accepted=50000`、`rejected=127868`、`pending=183675`、`PhaseB=0`；forced roots/pickups `2974`，ordinary boundary actions suppressed `31123`，shop actions suppressed `8922`。这说明 gate 确实改变了调度，但在该请求上没有转化为低延迟。

## 证据限制

`summary.json`、TSV、profile JSONL 和 hashes 可复核上述数字；但候选脚本中的 `source_sha` 是回退后的 HEAD 源码哈希，临时 diff/候选源码快照未保存。因此不能进行独立的源码级复审，也不能把这次性能差异归因到某个具体实现细节。开发回告称临时 3 项专项测试和全量 Rust `93/93` 通过，但原始测试输出未归档。

## 回退与后续

探针结束后仓库恢复为 `main@07f6fc099c9231f3e100406e61fab3823253024b`，工作区 clean，无生产代码残留。

若未来重试，必须先保存候选 source patch/hash、正式 profile 和测试输出，并提供新的证据说明调度或搜索深度代价为何会改变；不要直接重新实现本探针。

