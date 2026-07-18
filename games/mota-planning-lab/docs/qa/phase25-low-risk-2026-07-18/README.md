# Phase 2.5-B low-risk cleanup QA（2026-07-18）

本轮只验证低风险物化、结构哈希和 Pareto frontier 清理；没有加入 stale-source skip、topology cache、region graph、typed rules、hasher 切换、并行或 Phase B 改动。源码唯一改动为 `rust/shadow-runtime/src/main.rs`。

## 固定输入与构建

- request：2,576,604 B，SHA-256 `508b4d25557b0c30b649d5e923a5ec9fa3470dc8555d8d49e3dcb9bad98ba55e`
- baseline：`960819577f4ad0546734511badd68facaaad5134`，源码 SHA-256 `217d8aaf938b78d9d9f7286565481a59a2924a52a30f2148d351f9e1b117777a`
- final worktree：源码 SHA-256 `205c0645828fb4d6e99d79918e82de15b0a320cd98ca2c6d75f0d43286a2c5e8`
- baseline release binary SHA-256 `9e5e9a076969c70d86660e078c8137eccf27512622451b13b20647e0df140927`
- final release binary SHA-256 `c3165c12b1c673a085348e5bcfadef5ecc5b6c66ed78016fe6a947fb1a9d0e86`

两个版本均使用 release、独立常驻进程、1 次预热；default-off 之后交错发送 10+10 次纯 `POST /cycle`，每 10 ms 采样服务 PID RSS。profile-on 另各运行 1 次正式请求（原始文件包含预热与正式请求两行）。

## Default-off A/B

原始摘要见 [`ab.json`](ab.json)，原始样本见 [`official-samples.tsv`](official-samples.tsv)。两版本 20 次响应均 HTTP 200，去除 `shadow.cycle` 后 canonical response hash 都是 `af9d3ceabca4a57c6c0f3713defac7f9038970050260076ac626a0df4ace96f2`；请求仍为 `explored_states=50000`、`phase_b_explored=0`、`proof=unproven`。

| 版本 | median POST | max RSS |
| --- | ---: | ---: |
| 9608195 | 1476.244 ms | 71,417,856 B |
| final | 1411.880 ms | 50,135,040 B |

final 相对 baseline 的 median 为 -4.36%，final RSS 低于 60 MB。baseline 有一次 RSS 尖峰，未改变响应或预算结论。

## Profile-on 对照

原始 profile 行分别见 [`profile-before.jsonl`](profile-before.jsonl) 与 [`profile-after.jsonl`](profile-after.jsonl)。最终正式行保持：`phase_a_explored=50000`、`phase_b_explored=0`、`work_items_popped=335850`，materialize `335850 = 197186 feasible + 138664 infeasible`，`connectivity_view=197187`、`local_reachable=topology_query_total=1774683`、topology `49 unique + 1774634 repeated`。

| 指标 | 9608195 | final |
| --- | ---: | ---: |
| structural hash calls | 215401 | 197187 |
| structural equality checks | 178973 | 178973 |
| frontier comparisons | 210759 | 178973 |
| Phase A materialize ns | 82,800,077 | 47,440,329 |
| frontier ns | 5,986,252 | 4,028,247 |

按 action kind 的调用数与 feasible/infeasible 计数保持不变；view/local/topology 计数没有扩大。

## 验证命令

```text
cargo fmt -- --check
cargo test
CARGO_TARGET_DIR=/private/tmp/mota-phase25-build/phase25-current cargo build --release
CARGO_TARGET_DIR=/private/tmp/mota-phase25-build/phase25-current cargo test --release
git diff --check
```

上述命令均通过；Rust 测试为 58/58。性能 runner 的原始输出保留在本目录，不包含 request body、二进制或 Cargo target。
