# Phase 2.5-A profiling（2026-07-18）

本目录归档当前 `d596e59` 之后的内部 profiling 入口与可重复取样脚本。它只服务于热点观测：不改变 `/cycle` JSON、HTTP headers、schema、搜索顺序、预算、Pareto 或 stale 语义，也不实现缓存或其他 Phase 2.5-B 优化。

## 运行时入口

release shadow runtime 默认不采样。只有设置 `MOTA_SHADOW_PROFILE=1` 时，才会在每个 `/cycle` 请求结束后向 stderr 输出一行 `mota_shadow_profile_v1` JSON；stdout 仍只输出 `ready`，响应体不包含 profile 字段。关闭时 instrumentation 只保留开关分支，不创建计时器、profile HashSet 或 topology 描述副本。

JSON 同时提供扁平字段和按阶段/类别分组字段，便于脚本和人工复核：

- `work_items_popped`、`stale_source_work_items`；
- `materialize.phase_a/phase_b`，按 `door/resource/enemy/transition/event/shop/invalid` 记录 calls/ns 与 feasible/infeasible；Phase A 的 `feasible + infeasible == work_items_popped`，Phase B 单独列出；
- `connectivity_view`、`local_reachable`、`structural_hash` 的 calls/ns，以及 `structural_equality_checks`；
- `frontier.comparisons/ns` 与 `enqueue_actions_ns`；
- `topology.query_total/unique_keys/repeated_keys`。unique key 是在建索引时对精确静态 floor topology（宽高、有效格、block-index 布局）做 intern，再与原始 start `(x,y)` 组成的 key；只统计 HashSet，不复用或缓存可达结果。`query_total == unique_keys + repeated_keys`。

profile 的计时是运行时 `Instant` 插桩，包含插桩本身，适合排序而不是 SLA；`topology` key intern 仅在 profile 开启时建立。`connectivity_view.calls` 包含初始 view；`local_reachable.calls` 和 topology query 总数均覆盖 Phase A/B 的所有闭包扫描。

## A/B/C 取样

`run_phase25_profile.py` 接受已独立构建的二进制路径，不切换当前工作树、不把 request body、二进制或 Cargo `target` 写入仓库。它会为每个版本启动独立常驻服务，一次预热后按命令行版本顺序交错发送正式样本；每个 POST 期间以 10 ms 采样 PID RSS。输出仅包含 request hash、binary hash、原始样本 TSV、canonical response hash 和 stderr profile JSONL。

示例（将 A/B/C 替换为临时目录中的 release 二进制）：

```bash
python3 games/mota-planning-lab/docs/qa/phase25-profile-2026-07-18/run_phase25_profile.py \
  --request /private/tmp/mota-structural-label-ab-evidence/request.json \
  --out /private/tmp/mota-phase25-profile-2026-07-18 \
  --samples 10 --warmups 1 --no-profile \
  --version A=/private/tmp/mota-phase25-bins/4a7ad6c \
  --version B=/private/tmp/mota-phase25-bins/d899a8f \
  --version C=/private/tmp/mota-phase25-bins/d596e59
```

正式归档前应把 `/private/tmp/.../summary.json`、`samples.tsv` 和需要分析版本的 `profile-*.jsonl` 逐字复制到本目录，并在此 README 记录构建方式、source/binary/request hashes、10+10+10 顺序、median/p95/max RSS、canonical response 检查及 Phase A/B 计数。历史批次不得与本轮数据混写；仓库不保存 request body、二进制、target 或临时服务日志。

## 本轮同机证据（同一批次）

本轮使用 release、同一台机器、同一份 2,576,604 B request；A=`4a7ad6c`，B=`d899a8f`，C=`d596e59` 当前工作树（profile 入口默认关闭）。每个服务 1 次预热，随后按 `A,B,C` 交错 10+10+10 次纯 POST；每次 POST 期间每 10 ms 采样 PID RSS。canonical 是排序 JSON 并删除 `shadow.cycle`。三版每个响应均 HTTP 200，canonical hash 均为 `af9d3ceabca4a57c6c0f3713defac7f9038970050260076ac626a0df4ace96f2`，`explored_states=50000`、`phase_b_explored=0`。

| 版本 | median POST ms | p95 POST ms | max POST ms | median RSS B | p95 RSS B | max RSS B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 1974.208 | 2095.247 | 2144.275 | 140,853,248 | 141,452,083 | 141,459,456 |
| B | 3288.098 | 3370.037 | 3377.751 | 81,666,048 | 82,861,261 | 83,738,624 |
| C | 1421.735 | 1463.215 | 1475.157 | 51,994,624 | 52,002,816 | 52,002,816 |

同轮原始证据为 [`ab.json`](ab.json) 与 [`official-samples.tsv`](official-samples.tsv)；C 的一次 profile-on 请求产生的 1 行 stderr JSONL 见 [`profile-C.jsonl`](profile-C.jsonl)。profile-on 仅用于热点计数，不用于上表 default-off timing 汇总。该行的计数为：`phase_a_explored=50000`、`phase_b_explored=0`、`work_items_popped=335850`，Phase A materialize `335850 = 197186 feasible + 138664 infeasible`，`stale_source_work_items=205881`，`connectivity_view_calls=197187`，`local_reachable_calls=topology_query_total=1774683`，topology `49 unique + 1774634 repeated`，`structural_hash_calls=215401`、`structural_equality_checks=178973`、`frontier_comparisons=210759`。本轮只观察热点，不据此实施 Phase 2.5-B 清理；下一步低风险清理是否值得执行仍需用户/验收阶段决定。

同机默认关闭快速 gate 另以 `d596e59` 未插桩 release 为 base、当前 C 为对照，各 7 个正式样本；base median 为 1464.377 ms、C 为 1476.994 ms（+0.86%），base max RSS 53,936,128 B、C 为 53,329,920 B，canonical hash 仍一致。原始证据见 [`fast-gate.json`](fast-gate.json) 与 [`fast-gate.tsv`](fast-gate.tsv)。
