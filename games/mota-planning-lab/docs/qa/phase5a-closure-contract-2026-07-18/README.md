# Phase 5A resource closure contract (2026-07-18)

Phase 5A adds only a conservative qualification contract, an exhaustive small
oracle, and profile-only opportunity counters. It does **not** merge, skip, or
reorder resource actions; it does not alter candidates, FIFO/50k accounting,
Pareto state identity, objectives, Phase B, the HTTP response, or Shadow-only
execution. Any actual closure is a separate Phase 5B change requiring explicit
authorization and independent validation.

## Qualification contract

`resource_closure_eligible` accepts only a typed `CompiledBlockRule::Resource`
whose block is initially active and has its own valid consumed slot. Its delta
must be the exact identity on hp, attack, defense, gold, experience, level and
all keys: additive values are zero, floating multipliers are one, and inventory
is empty. Metadata must agree that there are no resource, inventory, flag, shop
count, or topology reads/writes. The only durable change is the action's normal
`false -> true` consumed-slot write. Materialization also places the state at
the action's adjacent cell; the exchange proof applies only after the existing
connectivity view maps that transient position to the same canonical
representative.

This deliberately excludes every current resource action with an actual
benefit. A non-zero integer addition can overflow; a floating addition or
multiply has IEEE/finiteness and ordering concerns; inventory, level, flags,
shops, enemies, doors, events, transitions, opaque and unknown rules have
effects outside the contract. Initially inactive and slotless resource blocks
are also excluded. If a workload contains no identity resource blocks, the
eligible count is correctly zero; Phase 5A does not broaden the contract to
manufacture an opportunity.

## Oracle and negative domain

The Rust oracle uses the production `materialize_pending_action` path for three
eligible actions, all six action orders, and three small states. It verifies:

- each action remains feasible and no rule fault is produced;
- after the shared canonical representative premise, every order has the exact
  same final `SolverState` and numeric objective;
- only the three distinct consumed bits change; inventory, flags, shop counts,
  level, resources, floor and canonical position are identical;
- checked overflow stays a global `rule_arithmetic_invalid` fault for an
  ineligible resource action rather than being reclassified as infeasibility.

Negative qualification fixtures cover integer overflow domains, cross-resource
effects, inventory, level, floating addition, multiplication, door, enemy,
event/flag-conditional semantics, shop, transition, opaque and unknown rules.
These tests exercise compiled typed rules as well as real materialization; they
are not a helper-only acceptance argument.

The oracle is intentionally a small finite proof harness, not a claim about
arbitrary graph reachability. It assumes the candidate actions were separately
available from the same closure and that the post-action connectivity view has
the same representative. Phase 5A therefore does not define or count a
potential merge batch.

## Profile-only fields

With `MOTA_SHADOW_PROFILE=1`, the diagnostic JSON adds:

```json
{
  "resource_closure_contract": {
    "observed_by_action_kind": {"door": 0, "resource": 2, "enemy": 0, "transition": 0, "event": 0, "shop": 0, "invalid": 0},
    "eligible_by_action_kind": {"door": 0, "resource": 1, "enemy": 0, "transition": 0, "event": 0, "shop": 0, "invalid": 0},
    "potential_merge_batches": null,
    "potential_merge_batches_reason": "Phase5A does not define a reachability-preserving batch boundary"
  }
}
```

The sample is archived as [`profile-fixture.json`](profile-fixture.json). It is
the fixed unit-test fixture, not an official-save measurement.
Counters observe resource materialization attempts using the existing stable
action-kind names. They use fixed arrays already owned by profile state and do
not create a set, cache, queue, or response field. With profile disabled, the
eligibility helper and counter update do not run.

The official Phase 4B request was also run profile-only against the Phase 5A
release build (one warmup plus two formal samples). All three events were
stable: 108,374 observed resource materialization attempts and **zero eligible
actions**, accepted trace `7f0aeb674cd6f09f`, and the prior canonical response
hash. The compact identities and counters are archived in
[`official-profile-counters.json`](official-profile-counters.json). This is an
opportunity measurement, not a latency comparison or performance claim.

## Phase 5B gate

Before any production closure can be authorized, a Phase 5B design must define
and independently verify all of the following:

1. a reachability-preserving batch boundary and proof that every member is
   simultaneously applicable despite consumed-slot topology changes;
2. a deterministic canonical order/representative that preserves exact final
   state, objective, fault ordering and route witness semantics;
3. unchanged FIFO candidate order, 50k budget accounting, Pareto acceptance,
   Phase B replay, protocol output and Shadow-only behavior;
4. differential tests against unclosed production materialization on broader
   topology fixtures, plus profile evidence that real eligible opportunities
   exist before taking optimization risk.
