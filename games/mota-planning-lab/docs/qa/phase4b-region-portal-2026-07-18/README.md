# Phase 4B static region/portal graph QA (2026-07-18)

This evidence compares the accepted Phase 3 baseline `c20ddd27a0342b9a7b827ae69588fe6784ef05f4`
with the dirty Phase 4B source. Phase A uses the compiled static region/portal graph; Phase B,
navigation, replay, and the differential oracle retain the uncached cell BFS.

## Integrity and method

- Official request: 2,576,604 bytes, SHA-256
  `508b4d25557b0c30b649d5e923a5ec9fa3470dc8555d8d49e3dcb9bad98ba55e`.
- Baseline source/binary SHA-256: `22dcc4d7bcbf05cd01c72671500c31c87586d3650f81f41e98edd8a29e77b0f3` /
  `ec3bc7feee5128f401b7e2e7c29ea09fc4fe93aa87a0c57883a1b05819f938ff`.
- Candidate source/binary SHA-256: `ae7a7d134301984fa816999b4b9d6fd8d1415c9556a4e415be768d05f2757dcb` /
  `90f57494cfabed381cb09378125e51421ac8a6cffb30b25f6482a8fe17c6fbff`.
- Each resident release binary received one warmup followed by seven formal requests, interleaved
  `A,B` on the same host. RSS was sampled from the service PID every 10 ms. Canonical JSON removes
  only `shadow.cycle` and is serialized with sorted keys.
- Raw A/B evidence (summaries, TSV, JSONL, and runner outputs) remains under
  `/private/tmp/mota-phase4b-final-evidence`. The official request and baseline binary are
  under `/private/tmp/mota-phase4a-final-evidence`; the candidate binary is under
  `/private/tmp/mota-phase4b-final-target`. These are temporary verification paths, not
  archived repository artifacts.

Formal command (using the frozen Phase 3 runner):

```sh
python3 /private/tmp/mota-phase3b-final-evidence/run_phase25_profile.py \
  --request /private/tmp/mota-phase4a-final-evidence/request/request.json \
  --out /private/tmp/mota-phase4b-final-evidence/ab \
  --version A=/private/tmp/mota-phase4a-final-evidence/binary/A-c20ddd2 \
  --version B=/private/tmp/mota-phase4b-final-target/release/mota-shadow-runtime \
  --source A=/private/tmp/mota-phase4a-final-evidence/source/A-main.rs \
  --source B=games/mota-planning-lab/rust/shadow-runtime/src/main.rs \
  --samples 7 --warmups 1 --port-base 22240 --no-profile
```

The profile run used the same command with `--out .../profile`, `--samples 1`, port base `22340`,
and profiling enabled (no `--no-profile`).

## Result

Baseline median was 1233.469750 ms; Phase 4B median was 975.856958 ms, a 20.8852% reduction.
Candidate peak RSS was 50,020,352 bytes = 50.020352 decimal MB, below the 100 MB gate. All formal
responses had canonical SHA-256 `af9d3ceabca4a57c6c0f3713defac7f9038970050260076ac626a0df4ace96f2`.

The profile comparison preserved all official-load search counters: 50,000 accepted/explored,
126,119 rejected, 281,991 pending, 371,918 work items popped, 219,918 stale sources, and 59,822
stale skips. Both versions recorded Phase B explored = 0 for this budget-exhausted official load.
Phase 4B recorded 176,119 graph views, zero BFS fallbacks, 3,943,594 region traversals, and
4,847,678 portal traversals per request; its Phase A `local_reachable` count was zero.

Debug and release suites each passed 80/80 tests. The new graph-vs-uncached-BFS oracle enumerates
door/resource/event/opaque/enemy consumed states, reversible cross-floor transitions, dynamic
activation boundaries, terminals, shops, complete view content, and candidate order. Existing tests
continue to cover impure transition rejection, unknown rule fail-closed parsing, nonzero Phase B
route/replay, and deterministic stale/FIFO differential behavior.

The performance result is limited to the fixed official request on this host. No complete component
member cache, topology cache, global cache, persistence, or additional stale category was added.
