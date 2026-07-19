# Phase 5D certified combat-gem policy (2026-07-20)

## Scope and conclusion

This archive records the final, shipped Phase 5D source at
`9969126b6e6702709693298b19193f54e6747002`.  It is deliberately distinct
from the rejected experiments:

- [Phase 5B](../phase5b-monotone-free-pickup-rejected-2026-07-20/README.md)
  attempted a general fixed-point pickup closure and was reverted.
- [Phase 5C](../phase5c-combat-gem-root-rejected-2026-07-20/README.md) was an
  unbound whitelist probe and was rejected for latency.
- [Phase 6A](../phase6a-shop-dp-rejected-2026-07-19/README.md) was a local
  shop DP and was reverted.

Phase 5D has **no closure, batch materialization, wave, resource sub-search,
shop DP, cache, queue-policy change, or executor**.  It adds one static
certificate shared by two separately executed paths:

1. **Internal Phase A root policy.**  After a state is accepted and its one
   `ConnectivityView` is already available, the stable-first certified combat
   gem is the only ordinary `PhaseAWorkItem` enqueued.  Otherwise the existing
   boundary/shop order is unchanged.  The gem then follows the normal
   materialize → view → canonicalize → interner → Pareto path.
2. **Initial immediate suggestion.**  A same-floor, local-origin certified gem
   in the initial view returns one read-only suggestion before Phase A store,
   queue, numeric proof, or Phase B witness are created.

The certificate is fail-closed.  It accepts only the audited `redGem`/27
attack `+3` and `blueGem`/28 defense `+3` typed resource forms, requiring an
independent consumed slot, no non-free colocated block, no other read/write/
reactivate/replace/unknown dependency, and finite-safe arithmetic.  The
combat fields must be exact non-negative integers no greater than `2^53`;
the world upper envelope is checked with `u128` arithmetic before converting
back to the exact `f64` range.  Fairy/non-commuting transforms are crossed
only when the strict operation-count and binary64-rounding envelope is proven;
otherwise their required consumed slots remain in the certificate mask.  The
certificate is compiled once after typed rules and slot dependencies exist;
hot paths perform only an indexed certificate lookup plus finite/exact, `+3`,
upper-bound, and required-mask checks, never a world rescan.  Any newly added
typed enum/rule must be exhaustively audited or the certificate remains empty.
Its proof boundary excludes later rules which could reduce/overwrite the
relevant combat stat or observe the gem's slot.  Future rule additions
therefore fail closed until re-certified.

The internal policy preserves the numerical-proof domain: a certified gem is
free, only increases one combat stat, opens rather than closes its own portal,
and is independent of later conditions.  A route that never takes it is
strictly no better; a route that takes it later can commute it before doors,
combat, shops, reversible movement, independent resources, and audited events.
Phase B still searches the original action graph and replays the canonical
witness, so the Phase A scheduling choice does not dictate route ordering.

The immediate result is intentionally **not** a full-route proof.  It returns
`proof: unproven`, `reason: deferred_for_certified_immediate_combat_gem`,
`truncated: false`, `explored_states: 0`, `route: null`, and
`decision_mode: certified_immediate_action`, with an existing read-only
resource `RouteStep` as `first_suggestion`.  UI text explains that global
proof is deferred.  The runtime remains Shadow-only: it never calls an
adapter/executor or changes game state.  A future execution layer may perform
at most that one action, must obtain a new observation next cycle, and must
not reuse this suggestion, view, or search state.

## Artifact identity and reproduction boundary

All final measurements below use independent `git archive` source trees and
release binaries for the exact commits in [`identity.json`](identity.json):

| lane | commit | `main.rs` SHA-256 | release binary SHA-256 |
| --- | --- | --- | --- |
| A baseline | `6fa0f193878b343a0f3dc925e53bda78e3c68a07` | `34e264869b4a7aa8475ff58b07c3485b5b8ff177357c1de7d0f7da7899fbb460` | `4a0fbc3abcab103689500cb0fb7360c89cb81e9b0b33ee719e32e2714d73843f` |
| Commit 1 | `e04c5b00ed6d4471513d19a133e4550078167c4d` | `0d0291b4c31eb007c8613a4bc9a9d1382290ab77f94fa4236ed6aaabaedd9302` | `a2ee50ab74875b008fa4f446d79307829b056a26171beedad0b304a7d712c749` |
| final | `9969126b6e6702709693298b19193f54e6747002` | `8ccb6a1ffda454c0a3964dc7c7a5972a08137c72095898e4f08747cbe39cfbe2` | `ffa2a6969b42fb50f2b65cd4d457d958de6dbb73aa43f57e1716db300ec88fe0` |

The official request remains outside Git because it is 2,576,604 bytes; its
SHA-256 is `508b4d25557b0c30b649d5e923a5ec9fa3470dc8555d8d49e3dcb9bad98ba55e`.
The compact immediate fixture SHA-256 is
`3353594d7a10a74f36ebce9a6aed4fcd39289bde176af8c2cf604625fad01031`.
[`baseline-to-final.patch`](baseline-to-final.patch) is the complete binary
Git patch for `6fa0 → 9969126`; no duplicated full source snapshot or binary
is committed.  [`runner.py`](runner.py) is a measurement runner: it consumes
prepared `src/<commit>/`, `bin/{baseline-6fa,commit1-e04,final-996}`, and
`raw/{official-request.json,immediate-request.json}` artifacts, and does not
run `git archive`, build Rust binaries, or create source/request artifacts.
The preparation step must bind each run to the source, binary, and request
SHA-256 values in [`identity.json`](identity.json); a newly rebuilt Mach-O
binary may have a different byte hash because of toolchain/UUID details.
For a fresh external workspace, run
`bash prepare-artifacts.sh <repo-root> /private/tmp/<workspace> <request-root>`;
the helper performs the three `git archive` extractions, release builds under
`/private/tmp/<workspace>/target-*`, source/binary/request hashing, and creates
only symlinks for `runner.py` and into the runner's `src/`, `bin/`, and `raw/`
paths.  It never copies those artifacts into this repository.  The runner writes JSON result
files under its external `results/` directory; it does not itself emit the
packaged TSV/JSONL evidence files shown below.

The runner accepts an explicit prepared root via
`MOTA_PHASE5D_WORK_ROOT=/private/tmp/<workspace> python3 runner.py` or
`python3 runner.py --root /private/tmp/<workspace>`. Use
`python3 runner.py --root /private/tmp/<workspace> --identity-only` to verify
the prepared source, binary, request, and patch artifacts without running
benchmarks.

## Official 50k comparison

Seven warmed, persistent, interleaved POST samples were taken per lane with
profiling disabled.  Immediate was explicitly disabled in all lanes because
the official initial root is a certificate miss.

| lane | median POST | p95 POST | max RSS | result |
| --- | ---: | ---: | ---: | --- |
| A: `6fa0` | 1196.425 ms | 1206.563 ms | 50,200,576 B | unproven / 50,000 |
| B: final, root policy off | 1239.973 ms | 1243.781 ms | 50,249,728 B | unproven / 50,000 |
| C: final, root policy on | 1248.365 ms | 1266.672 ms | 48,152,576 B | unproven / 50,000 |

All 21 canonical response hashes are
`af9d3ceabca4a57c6c0f3713defac7f9038970050260076ac626a0df4ace96f2`.
The A→B default-off overhead is `+3.640%` (the two delivered commits are
included in this comparison).  The policy effect is B→C: C is `+0.6768%`
slower than B, below the agreed 5% bound, and its max RSS is below 55 MB.

The matching final-binary profile event records B/C respectively:

| metric | gate off B | gate on C |
| --- | ---: | ---: |
| accepted / rejected / pending | 50,000 / 126,119 / 281,991 | 50,000 / 127,868 / 183,675 |
| popped / materialize / views | 371,918 / 312,096 / 176,119 | 408,244 / 331,890 / 177,868 |
| region / portal traversals | 3,943,594 / 4,847,678 | 4,099,170 / 5,251,290 |
| forced roots / enqueued gems | 0 / 0 | 2,974 / 2,974 |
| suppressed boundaries / shops | 0 / 0 | 31,123 / 8,922 |
| accepted-depth p50/p95/max | 15 / 16 / 16 | 16 / 18 / 18 |
| consumed-slot p50/p95/max | 26 / 28 / 28 | 28 / 29 / 30 |

The trace hashes differ because this policy intentionally alters Phase A
scheduling.  Both responses are budget-exhausted `unproven`; the difference
is not treated as a proof regression.

## Equal-depth and equal-work diagnostics

These are profile-enabled, test-only environment limits.  They neither alter
the production protocol nor claim `proven`: `search_quality.benchmark_limit_reason`
is `depth_budget_exhausted` for depth lanes and `work_budget_exhausted` for the
work lane.  Full raw metrics are in
[`depth-work-summary.json`](depth-work-summary.json).

| limit | gate off: accepted/popped/views | gate on: accepted/popped/views | gate-on POST |
| --- | ---: | ---: | ---: |
| depth 8 | 868 / 6,008 / 2,486 | 446 / 2,659 / 1,114 | 20.440 vs 30.138 ms |
| depth 12 | 5,448 / 37,611 / 16,859 | 2,910 / 17,758 / 8,274 | 71.494 vs 132.226 ms |
| depth 16 | 50,000 / 371,918 / 176,119 | 26,351 / 184,306 / 87,976 | 653.517 vs 1335.470 ms |
| work 200k | depth max 15; 29,037 accepted | depth max 17; 28,546 accepted | 723.412 vs 737.735 ms |

Thus, at equal strategic-depth bounds the policy removes delayed-gem
permutations and work.  At equal popped-work it reaches depth 17 rather than
15, with a slightly lower one-sample elapsed time.  These are one official
input/sample per limit and diagnose search quality; they are not a general SLA.

## Immediate-action fixture

The fixture begins with a certified same-floor red gem plus a door, enemy,
potion, and shop.  Seven warmed/interleaved final-binary samples compare full
global search against the production-default immediate path:

| lane | median POST | max RSS | explored | response |
| --- | ---: | ---: | ---: | --- |
| full global (`MOTA_IMMEDIATE_COMBAT_GEM_POLICY=0`) | 1.877 ms | 3,440,640 B | 41 | budget-unproven |
| immediate default | 0.541 ms | 2,441,216 B | 0 | deferred certified suggestion |

The immediate profile has exactly one initial Phase A view, zero store
creations, zero Phase A/Phase B explored states, zero popped items, one
immediate hit, and one `global_search_skipped`; its suggestion is resource
`redGem`.  The full-global fixture keeps normal Phase A root policy behavior.
These observations establish the one-view short-circuit boundary, not a
complete terminal-route proof.

## Validation and evidence files

- Rust debug and release: 113/113 each.
- `cargo fmt --check` and `git diff --check 6fa0..9969126`: pass.
- `bash -n prepare-artifacts.sh` and runner Python compile-only check: pass.
- Targeted JS protocol/controller: 3/3; localhost Rust contract: 4/4.
- Python parity is **not green**: `jsonschema` is absent
  (`ModuleNotFoundError`) and no dependency was installed.  The Rust Draft
  2020-12 tests and targeted JS negative cases are archived; this environment
  gap and its risk boundary are unchanged by the Phase 5D docs/QA commit.

Raw sample tables and final profile JSONL: [`official-samples.tsv`](official-samples.tsv),
[`official-profile.jsonl`](official-profile.jsonl),
[`immediate-samples.tsv`](immediate-samples.tsv), and
[`immediate-profile.jsonl`](immediate-profile.jsonl).  Aggregate results are
in [`summary.json`](summary.json); the official default-immediate-miss warmup
and one formal profile are preserved in
[`default-miss-warmup.tsv`](default-miss-warmup.tsv),
[`default-miss-sample.tsv`](default-miss-sample.tsv), and
[`default-miss-profile.jsonl`](default-miss-profile.jsonl), with identity and
counter parity in [`default-miss-summary.json`](default-miss-summary.json).
Test logs are in [`tests/`](tests/).

## Known limits

- Official evidence is one Phase-B-zero, budget-exhausted observation; its
  50k latency is not a multi-save or proven-route claim.
- Depth/work diagnostics are one profile-enabled sample each.
- The immediate fixture is intentionally small; it validates the single-step
  response contract, not a real-game terminal proof.
- Future combat/stat/slot-observing rules require certificate re-audit; they
  must remain non-certified by default.
- The final source has no automatic execution capability.  Any future consumer
  must re-observe after one suggested action.
