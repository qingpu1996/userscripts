# Phase 5A.1 closure/shop opportunity census (2026-07-19)

This is profile-only feasibility evidence. It does not enable closure, skip,
merge, reorder, shop DP, or change FIFO, the 50k budget, Pareto admission,
Phase B, protocol output, or Shadow-only execution.

The census compiles exact consumed-slot dependencies from typed blocks and
audited event coordinate operations. Normal resource materialization's own
`false -> true` write is distinct from another rule's `set_true`. A resource
slot is private only when no other rule reads it or performs `set_true`,
clear/reactivate, same-coordinate replacement, or an unknown write. Failed
coordinate/slot mapping makes every possibly related slot non-private rather
than attributing uncertainty only to the event slot.

`PureBoundedIntegralGain` v1 considers only active, closure-private,
single-field non-negative integer gains among gold, experience, and the three
keys, with no float, multiplier, level, or inventory effect. Its `u128`
ArithmeticEnvelope is strict fail-closed: any shop choice consuming one field
and gaining another makes both related fields unsafe; ambiguous integral field
propagation makes the whole integral envelope unsafe. Shop local-DP opportunity
is reported separately, but each candidate still proves the production price
at its initial purchase count, the last of 50,000 purchases, and the count after
those purchases without overflow.

For every accepted Phase A state, the diagnostic dry-run may apply eligible
boundaries to a copy, but never admits or enqueues the copy. The projected
work-item metric remains `sum(actions - waves)`. Its only denominator is the
independent `phase_a_connectivity_view_calls` profile field, which counts
production Phase A views and excludes Phase B, replay, and diagnostic dry-run
views. `projected_accepted_states_removed` remains null because no quotient
search was constructed.

## Official request

The existing official request (SHA-256
`508b4d25557b0c30b649d5e923a5ec9fa3470dc8555d8d49e3dcb9bad98ba55e`)
was run once as warmup and twice formally against the final release binary.
All three profile events had accepted trace `7f0aeb674cd6f09f`; both formal
responses, after removing the process cycle counter, had SHA-256
`af9d3ceabca4a57c6c0f3713defac7f9038970050260076ac626a0df4ace96f2`.

All five integral envelopes were unsafe because the official model contains
cross-resource shop conversions. Consequently none of 104 statically eligible
single-field resources was final eligible: 0/108,374 final eligible attempts,
zero accepted states with eligible resources, and zero projected removed
resource work-items over 176,119 production Phase A connectivity views. The
separate shop census still found 18 candidate choices across 6 shops, reachable
from all 50,000 accepted states. Machine-readable counters and exact source,
binary, and request hashes are in
[`census-summary.json`](census-summary.json).

Searches of existing QA and private temporary evidence found repeated copies
of this same official request and synthetic/transition fixtures, but no second
independently sourced real save. No additional save was fabricated.

## Decision

Neither predeclared Phase 5B gate is met: the final eligible attempt ratio and
projected removed work-items per production Phase A connectivity view are both
0%. The recommendation is therefore **Phase 6**. Phase 5B resource closure is
not supported by this census; shop local-DP remains only a separately reported
static opportunity and is not enabled.
