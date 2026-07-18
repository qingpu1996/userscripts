# Phase 4B closeout candidate QA (2026-07-18)

This archive compares the accepted Phase 3 baseline
`c20ddd27a0342b9a7b827ae69588fe6784ef05f4` with the current **uncommitted
closeout candidate**. The candidate contains the already accepted Phase 4B
static region/portal graph from `299786b564e9d75b1db52b3eeab65451736a50ad`
plus the pending shared passability classification and profile-only accepted
semantic trace. It is not identified as commit `299786b` or as any future commit.

## Exact identities and provenance

- Official request: 2,576,604 bytes, SHA-256
  `508b4d25557b0c30b649d5e923a5ec9fa3470dc8555d8d49e3dcb9bad98ba55e`.
  This is the same request recorded by
  [`Phase 3 preflight QA`](../phase3-preflight-2026-07-18/README.md) and its
  `source-hashes-phase3a.txt`; the body is not archived here.
- Baseline source/binary SHA-256: `22dcc4d7bcbf05cd01c72671500c31c87586d3650f81f41e98edd8a29e77b0f3` /
  `ef27419252fc7904fcec7c272afeeab74c010c7bb3e1395a8c095e5f2611e685`.
  The source hash matches `main.rs` at commit `c20ddd2`; this binary was rebuilt
  from a `git archive` snapshot in an isolated `/private/tmp` Cargo target for
  this final run.
- Uncommitted candidate source/binary SHA-256:
  `f6e1149bf2daed46ff9458ac2b0723a7b2bcbe85a924cb73ecedf6ae385e05a6` /
  `7fd89633b925433e182d11990d7cdccd2cd039cd97d6842637389c8aa658cfa9`.
  The source was frozen before the isolated release build and matched the
  working-tree `main.rs` again after the build and measurements. Pre-commit
  review must recheck this exact blob hash.
- Measurement-time repository HEAD was
  `299786b564e9d75b1db52b3eeab65451736a50ad`; the candidate source differed
  from the historical `299786b` `main.rs` hash
  `cc0f581af41dfb7a82a8c379953005d12593fc1f5de9df6145bf72be3a48ec51`.

All builds, binaries, source snapshots, and the request body stayed under
`/private/tmp`. The durable archive contains raw runner summaries, samples and
profile JSONL, but no binary, Cargo target tree or request body:

- `summary.json` and `official-samples.tsv`: raw default-off 7+7 runner output.
- `profile-summary.json`, `profile-samples.tsv`, `profile-A.jsonl`, and
  `profile-B.jsonl`: raw profile run output. Each JSONL contains the warmup event
  followed by three formal events.
- `profile-key-counters.tsv`: compact projection of those eight JSONL events.
- `hashes.sha256`: hashes of every archived evidence file except the manifest itself.

The frozen runner and raw assets remain, non-durably, under
`/private/tmp/mota-phase4b-closeout-evidence.1bpam3`; the isolated Cargo target
is `/private/tmp/mota-phase4b-closeout-target.1bpam3`.

## Method

Each resident release binary received one warmup followed by seven formal
default-off requests, interleaved `A,B` on the same host. RSS was sampled from
the service PID every 10 ms. Canonical JSON removes only `shadow.cycle` and is
serialized with sorted keys.

```sh
python3 /private/tmp/mota-phase4b-closeout-evidence.1bpam3/run_phase25_profile.py \
  --request /private/tmp/mota-phase4b-closeout-evidence.1bpam3/request/request.json \
  --out /private/tmp/mota-phase4b-closeout-evidence.1bpam3/ab \
  --version A=/private/tmp/mota-phase4b-closeout-evidence.1bpam3/binary/A-c20ddd2 \
  --version B=/private/tmp/mota-phase4b-closeout-evidence.1bpam3/binary/B-uncommitted-closeout \
  --source A=/private/tmp/mota-phase4b-closeout-evidence.1bpam3/source/A-c20ddd2-main.rs \
  --source B=/private/tmp/mota-phase4b-closeout-evidence.1bpam3/source/B-uncommitted-closeout-main.rs \
  --samples 7 --warmups 1 --port-base 22540 --no-profile
```

The profile run used the same request and versions with `--samples 3`,
`--warmups 1`, `--port-base 22640`, and no `--no-profile`. Profile latency and
RSS are diagnostic overhead measurements and are not compared with default-off
latency or the 65 MB default-off RSS gate.

## Result

Baseline median POST was `1204.340708 ms`; candidate median POST was
`1188.036749 ms`, a `1.3538%` reduction. This is a neutral result and **does not
establish a meaningful performance improvement**. The previous archived
`20.8852%` claim came from a differently hashed dirty source and is superseded;
it must not be used for this candidate.

Candidate default-off max RSS was `50,020,352 B` = `50.020352` decimal MB =
`47.703125` MiB, below the 65 MB gate. All 14 formal responses had canonical
SHA-256 `af9d3ceabca4a57c6c0f3713defac7f9038970050260076ac626a0df4ace96f2`.

All four candidate profile events (warmup plus three formal samples) recorded
accepted semantic trace `7f0aeb674cd6f09f`. Search and budget counters were
stable across all events and matched the baseline: 50,000 accepted/explored,
126,119 rejected, 281,991 pending, 371,918 work items popped, 219,918 stale
sources, 59,822 stale skips, and Phase B explored = 0. Candidate graph counters
were also stable: 176,119 graph views, zero BFS fallbacks, 3,943,594 region
traversals, and 4,847,678 portal traversals. The baseline predates the accepted
trace field and therefore has no trace value to compare.

The performance result is limited to this fixed official request on this host.
It does not support a delivery claim based on latency improvement. It says
nothing about different saves, BFS fallback loads, nonzero Phase B performance,
or production execution, and it adds no Phase B/FIFO/budget/protocol/Phase 5
capability.
