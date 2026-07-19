# Phase 5B monotone free-pickup rejected archive (2026-07-20)

This directory records the Phase 5B `MonotoneFreePickup` candidate that was
measured, rejected, and fully reverted. It is historical QA evidence, not an
active feature description. The current repository contains no Phase 5B code.

## 1. Phase, date, and status

- Phase: **5B**, monotone free-pickup closure.
- Date: **2026-07-20**.
- Status: **Rejected and fully reverted** after the default-off fail-fast
  precheck.
- The current repository is at `d3233fa1fa27cbb6882bcd770953b6be12fc023e`
  (`d3233fa`); no Phase 5B code remains and no revert commit was made.

## 2. User-authorized simplified model and goal

The authorized model was a fixed point over currently reachable pure additive
resources. Complex or non-monotone actions exited that model. Phase A was to emit
closed states; Phase B retained individual route actions and replay. Retention
gates were time, RSS, and semantic/canonical-response correctness. This archive
does not expand those gates or claim a proof for general reachability.

## 3. What was done and how

The following is the development handoff's implementation summary. It
describes the rejected experiment only; the code was rolled back and cannot be
reconstructed directly from this archive.

- A world-field and arithmetic-envelope audit qualified **312 of 322**
  observed resources in the smoke census. Identity, integer, and float
  additive forms were audited; a multiplier by itself was not closure-eligible.
- Phase A used atomic closure waves in stable block order before interning and
  Pareto comparison, filtering resource work from the ordinary queue.
- Phase B kept the old BFS navigation and individual `RouteAction`/replay
  behavior.
- An atomic clone fallback covered closure failures. Profile counters and
  tests were added around connectivity, waves, materialization, and closure.

## 4. Correctness evidence

The development handoff reported **92/92** candidate checks as re-runnable, but
they ran before the formal B artifact and had no source binding. The rollback
reported **90/90** checks passing. Those test outputs are not archived, so the
claims are recorded with that limitation rather than independently reproduced
here.

The canonical-response comparison in the archived A/B precheck was stable:
all six recorded responses were HTTP 200 and had the same canonical hash after
sorting JSON and removing only `shadow.cycle`:

`af9d3ceabca4a57c6c0f3713defac7f9038970050260076ac626a0df4ace96f2`.

## 5. Failure evidence and rejection

The archived run is a **default-off fail-fast precheck** with one warmup and
three official samples per version (A/B/A/B/A/B, commonly called **1+3+3**).
It is **not** the planned formal 7+7 run. The request was 2,576,604 bytes with
SHA-256
`508b4d25557b0c30b649d5e923a5ec9fa3470dc8555d8d49e3dcb9bad98ba55e`.

| version | median POST | p95 POST | POST range | max RSS | RSS range |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline A | 1193.432124 ms | 1195.650812 ms | 1188.852375–1195.897332 ms | 50,020,352 B | 49,741,824–50,020,352 B |
| candidate B | 1306.017291 ms | 1309.527442 ms | 1302.612666–1309.917458 ms | 42,762,240 B | 42,450,944–42,762,240 B |

Candidate median latency was **9.43373% slower** than baseline. The candidate's
fastest recorded request was still slower than the baseline's slowest (a direct
comparison of the six rows). RSS was lower and canonical responses matched,
but the time gate failed, so the candidate was rejected before formal 7+7.
The archived precheck is an archived summary plus display-precision
samples/evidence: [`formal-precheck-summary.json`](formal-precheck-summary.json)
and [`formal-precheck-samples.tsv`](formal-precheck-samples.tsv). The summary is
the runner's authoritative aggregate, computed from the runtime measurements
before rounding. The TSV is a runner-exported display of rounded samples (six
decimal places), not a full-precision raw sample file. It is sufficient to
independently check direction, approximate median/range/slow-percent, and the
HTTP/canonical/RSS findings, but it cannot reproduce every summary statistic or
its final digits. For example, the TSV displays A p95 as `1195.6508112` versus
`1195.650811586529` in the summary, and B as `1309.5274413` versus
`1309.5274415798485`.

## 6. Profile diagnosis and artifact identity

The formal-precheck summary identifies baseline A as source
`34e264869b4a7aa8475ff58b07c3485b5b8ff177357c1de7d0f7da7899fbb460`, binary
`6b7579887e358c63f8f30f4b0dc70ce3852f405b3c1598f64307820c24c61f9e`; candidate
B as source
`9902e6fdf5af730e40029fd22e3bfce85eb85a52f04b5a598010887bcd6ba153`, binary
`106ea083b392ffae4173040d5ab199737c784d5bc771d5d01123b75306a02e60`.

The non-empty profile-smoke C is a different artifact: source
`a4e64997e0f7374a6059cd597bb0bee7aa81207df8de8f2346560c1c76747d35`, binary
`8abeee6750c579783aafecefdde026820fad657a37690bf0a7416ce8f4997009`.
This source/binary mismatch means C is diagnostic only; it cannot prove the
formal B result or causality. The archived formal profile streams are empty,
which faithfully records the summary's zero `profile_events` for A and B.

The diagnostic counter comparison reported a reference profile row (not a
formal A/B profile event) with connectivity **176,119** and pending **281,991**;
profile-smoke C recorded connectivity **156,660**, pending **153,302**, and
accepted **50,000**. C recorded **46,880** closure pickups and **46,880**
resource work items avoided, with closure faults **0** and atomic fallbacks
**0**. Because the baseline row and C are from different profile artifacts,
these counters support diagnosis only.

## 7. Confirmed findings versus hypotheses

**Confirmed:** the 1+3+3 default-off precheck failed the latency gate by
9.43373%; candidate RSS was lower; all six canonical responses matched; and
the implementation and tests were rolled back.

**Hypotheses only:** wave materialization, repeated reviews, or closure
bookkeeping may have caused the overhead. The artifact mismatch and empty
formal profile streams prevent a causal conclusion.

## 8. Reverted and retained

All Phase 5B code, tests, and implementation documentation were reverted. Only
this archive is retained; there is no revert commit. The archive contains no
binary, request body, source snapshot, build target, or large log.

## 9. Prerequisites for any retry

- Bind the same final source and profile artifacts to both sides of the A/B
  measurement; do not use a smoke-only candidate identity.
- Microprofile each wave, materializer, and review before another performance
  gate.
- A retry must reduce accepted-state/review work or avoid re-review; simply
  reusing this candidate is not sufficient.
- Include a nonzero Phase B fixture and verify its individual route/replay
  semantics before any formal run.

## 10. Evidence limits

- One save/request only; no second real save was tested.
- Phase B explored zero states in the archived smoke profile.
- The result is a 1+3+3 precheck, not formal 7+7.
- No non-empty formal profile is archived; A/B profile streams are zero bytes.
- The TSV preserves display-precision samples only; full-precision per-sample
  timings were not archived, so summary p95/POST final digits cannot be
  independently reproduced from the TSV.
- The formal candidate source snapshot is absent; only its path and hash remain
  in the summary. The 92/92 and 90/90 test claims have no saved test output.
- Profile-smoke C is not source/binary-identical to formal B, so its counters
  cannot establish formal causality.

## Archive manifest

[`hashes.sha256`](hashes.sha256) records SHA-256 for every archived evidence
file except the manifest itself. The README is intentionally excluded from the
manifest.
