# Phase 4A request-local cache rejected (2026-07-18)

This decision record is derived only from
`/private/tmp/mota-phase4a-cpu-vm-profile/README.md` and `summary.json`. It records the
request-local `local_reachable` cache family that was measured, rejected, and fully reverted.
It does not archive or claim to archive a source snapshot, binary, request body, CPU sample, or
VM diagnostic.

## Design and measured variants

The cache boundary was one request. The source evidence describes the key machinery as an exact
passability projection/signature interner plus per-call probe; the cached value work was the
`local_reachable` reachable-bitset/buffer result. The source archive does not preserve a more
specific field-level key/value schema, so none is asserted here.

All variants used the same 2,576,604-byte request (SHA-256
`508b4d25557b0c30b649d5e923a5ec9fa3470dc8555d8d49e3dcb9bad98ba55e`), one warmup and ten
formal requests. Every canonical response hash was
`af9d3ceabca4a57c6c0f3713defac7f9038970050260076ac626a0df4ace96f2`.

| variant | binary SHA-256 | median POST | p95 POST | RSS after request 10 |
| --- | --- | ---: | ---: | ---: |
| baseline `c20ddd27a0342b9a7b827ae69588fe6784ef05f4` | `ec3bc7feee5128f401b7e2e7c29ea09fc4fe93aa87a0c57883a1b05819f938ff` | 1139.0475 ms | not recorded | 49.758208 MB / 47.453125 MiB |
| fixed open-address cache | `9d19a2b86f14ce659e8031aa18d520124c236c4ed7a575d0fb80de089fd611ab` | 1721.7375 ms (+51.2%) | not recorded | 53.559296 MB / 51.078125 MiB |
| signature-capacity cache | `91b4da9a772078f28b4b61a64e6a1d211e1442b1d764fe9e796c7069abac3225` | 2605.1855 ms (+128.7%) | not recorded | 53.805056 MB / 51.312500 MiB |

The source README/summary do not record cache hit or miss counters for either variant; hit, miss
and hit-rate values are therefore **not recorded**, rather than reconstructed from other temporary
directories. RSS conversions shown here are exact for the recorded byte counts: decimal MB =
bytes / 1,000,000; binary MiB = bytes / 1,048,576.
Against baseline post-request RSS, the two candidates added 3,801,088 B (3.801088 MB / 3.625000
MiB) and 4,046,848 B (4.046848 MB / 3.859375 MiB), respectively.

## Rejection decision

CPU sampling kept 93–95% of candidate analysis samples in `ConnectivityIndex::view` and exposed
candidate-only signature projection/interning, hashing/probing, ring writes, allocation and buffer
movement. The cache did not remove enough bitset materialization or connectivity work to offset
its own bookkeeping. Both variants were materially slower and used more RSS, so the request-local
cache was fully reverted and will not be retried in this phase. Phase 4B instead evaluated a
request-local static region/portal graph; this record makes no performance claim for any different
future cache boundary.
