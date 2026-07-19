# Phase 6A shop local-DP rejected archive (2026-07-19)

This directory records the Phase 6A single-shop local Pareto-DP experiment that
was tried, measured, rejected, and fully reverted. It is historical QA evidence,
not an active feature description. The current repository contains no Phase 6A
implementation.

## 1. Phase, date, and conclusion

- Phase: **6A**, single-shop exact local Pareto DP.
- Date: **2026-07-19**.
- Conclusion: **Rejected and fully reverted**.
- The current repository has no Phase 6A code. The repository HEAD remains
  `33f3dc1d2c566d248b7b715935f167480bfb00df` (`33f3dc1`); no implementation
  commit or revert commit is required for this failed experiment.

## 2. Goal, non-goals, and acceptance gates

The goal was an exact local Pareto DP for one shop at a time, used only while
enumerating Phase A candidates. Phase B individual-witness handling was not
changed and was not part of this experiment.

The retention gates were:

1. The official default-off median must show a clear improvement; an improvement
   below 5% is not retained.
2. Maximum resident set size must remain at or below 65 MB (`65,000,000` B gate).
3. Canonical responses must remain identical.

The candidate passed the response and RSS gates but failed the latency gate, so
the experiment was not retained.

## 3. What was done and how

The following is the implementation summary reported by the development
handoff and its profile evidence. It describes the rejected experiment; it does
not claim that these paths remain in the current source tree.

- Whole-shop qualification was fail-closed: positive costs, a non-decreasing
  purchase/cost sequence, explicit cost/count checks, no effect that replenishes
  a shop currency, and no structural effect were required.
- The design used one 24-byte sentinel work item for each source×shop pair.
- The production materializer locally enumerated shop choices using an exact key
  and full-state identity.
- Dominance retained resource values `>=` and purchase counts `<=`; choice
  sequences were stable.
- A fixed-cap or fault condition used an atomic reverse-`push_front` fallback.
- One-to-many results entered the existing connectivity, interner, and Pareto
  paths. Phase B was unchanged.
- Runtime profile counters were added for search, materialization, connectivity,
  and local-DP work.

## 4. Correctness evidence

The development handoff reported a successful `cargo check` and **96/96**
correctness checks. The temporary test output was not saved, so this archive
does not independently reproduce or re-run those checks.

The formal 7+7 A/B run returned HTTP 200 for every sample. After removing
`shadow.cycle` and sorting JSON, all 14 canonical responses had the same SHA-256:
`af9d3ceabca4a57c6c0f3713defac7f9038970050260076ac626a0df4ace96f2`.

## 5. Formal performance evidence and rejection

The official request was 2,576,604 B with SHA-256
`508b4d25557b0c30b649d5e923a5ec9fa3470dc8555d8d49e3dcb9bad98ba55e`. Each
resident release service received one warmup and seven formal requests. Formal
requests were pure `POST /cycle`, interleaved baseline/candidate in one process
order, with RSS sampled every 10 ms. Canonical JSON removed only
`shadow.cycle` before hashing.

The raw summary is [`ab-summary.json`](ab-summary.json), SHA-256
`9130e5547f5f20c0069ba190096ed7379d172ce51c6962ea6aaddd55650a318c`. The
complete 14-row sample set is [`official-samples.tsv`](official-samples.tsv),
SHA-256 `ade95f2f67e71f88bb143181e8b565193f9c0913b2ddea97b08015c7380802f1`.

| version | median POST | p95 POST | max RSS |
| --- | ---: | ---: | ---: |
| baseline | 1230.318959 ms | 1244.641984 ms | 50,249,728 B |
| candidate | 1267.086083 ms | 1280.292908 ms | 46,710,784 B |

Across the complete sample file, baseline POST values ranged from
1225.599250–1245.401333 ms and candidate values from 1260.485583–1282.459833
ms. Per-sample max RSS ranged from 49,922,048–50,249,728 B for baseline and
46,284,800–46,710,784 B for candidate. Candidate median latency was **2.988422%
slower** than baseline. Thus RSS was below the 65 MB gate and canonical output
matched, but the required meaningful median improvement was absent: **Phase 6A
failed and was rejected**.

## 6. Profile diagnostics and artifact identity

The formal A/B summary identifies these artifacts:

| version | source SHA-256 | binary SHA-256 |
| --- | --- | --- |
| baseline | `34e264869b4a7aa8475ff58b07c3485b5b8ff177357c1de7d0f7da7899fbb460` | `6b7579887e358c63f8f30f4b0dc70ce3852f405b3c1598f64307820c24c61f9e` |
| formal candidate | `88d67f07fd64790e39657e1f75bc77d60ca3b777c3fded3f43c38a3748edd941` | `74f3fe16b9d21069e6dd6c709ce55096435f6a1b1fef88f0cd8c90856da8a3c5` |

The formal A/B `profile_events` arrays were empty. The zero-byte copies
[`profile-baseline.jsonl`](profile-baseline.jsonl) and
[`profile-candidate.jsonl`](profile-candidate.jsonl) preserve that fact. The
diagnostic profile run is [`profile-smoke-summary.json`](profile-smoke-summary.json)
and its one raw event is [`profile-smoke-candidate.jsonl`](profile-smoke-candidate.jsonl).

**Artifact mismatch warning:** the profile-smoke candidate is source
`ad18363df2bde8a2dc61712f2596f7c0bb3657a89410906ace80b91bd86862f1` and binary
`72b73b31402af63ad7c6d8071e9e3f2f0384977e6b10b7abdccbc0ac26a78955`, not the
formal A/B candidate source/binary above. Its counters therefore support
diagnosis only; they cannot prove the unique cause of the formal slowdown.

The reported baseline-to-profile-smoke-candidate counter changes were:

| counter | baseline → profile-smoke candidate |
| --- | ---: |
| Phase A pending | 281,991 → 239,523 |
| work items popped | 371,918 → 314,386 |
| Phase A shop materialization calls | 86,298 → 0 |
| accepted / rejected / connectivity views | 50,000 / 126,119 / 176,119 (same) |

The smoke candidate recorded local-DP **runs/nodes/edges/outcomes** of
**28,766 / 49,160 / 147,480 / 20,394**, with **0 cap fallbacks** and **0 fault
fallbacks**. It also recorded `phase_b_explored = 0`. The left-side baseline
counter values are handoff/reference values; no formal baseline profile event
was archived, so they are not an independently recomputable A/B profile pair.

## 7. Why it was rejected versus remaining hypotheses

**Established by the formal evidence:** candidate latency missed the gate by
2.988422%; all 14 canonical responses matched; and candidate maximum RSS stayed
below 65 MB. The rejection is therefore a time-gate failure, not a correctness
or memory-gate failure.

**Only hypotheses, not conclusions:** the 147,480 internal DP edges, or the
cost of local DP itself offsetting avoided shop materialization, could explain
the regression. The formal A/B profile streams are empty and the smoke profile
uses a different candidate artifact, so this archive cannot select between those
hypotheses or assign causality.

## 8. Reverted and retained

All Phase 6A code, tests, and implementation documentation were fully reverted.
Only this failure archive and its small evidence files are retained. No revert
commit was needed because the working tree returned to the pre-experiment
source at `33f3dc1`.

## 9. Prerequisites for any future retry

A retry requires a different design and must bind the exact final source artifact
to both profiling and formal A/B measurement. It must reduce accepted/connectivity
work or materially reduce local-DP internal cost; simply changing caps or
reusing the rejected design is insufficient. Any proposed direction remains a
hypothesis until it is measured against the same formal gates, with Phase B still
separately scoped.

## 10. Evidence limits

- Evidence covers one official save/request only; no second real save was tested.
- Phase B was zero and is not evaluated by this archive.
- Formal candidate source snapshots, binaries, request body, test output, and
  large logs were not archived; only their hashes in the raw summary remain.
- Formal A/B profile JSONL is empty. The smoke JSONL is diagnostic and has a
  different source/binary identity from the formal candidate.
- Temporary files and Cargo `target` trees remain outside the repository only;
  this archive contains no binary, request body, source snapshot, target, or
  large log.

## Archive manifest

[`hashes.sha256`](hashes.sha256) records SHA-256 for every archived evidence file
except the manifest itself. The manifest is generated after all copies are made;
the README is intentionally not included in its file list.
