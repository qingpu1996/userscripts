#!/usr/bin/env python3
"""Deterministic Stage 0 fixture, oracle, and Python baseline.

This synthetic subset is deliberately not the production planner.  Phase RSS is
measured in a fresh worker process per fixture/phase so a previous phase cannot
pollute the process high-water mark.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import resource
import statistics
import subprocess
import sys
import time
import tracemalloc
from collections import deque
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

RULE_VERSION = "stage0-subset-v2"
RESULT_SCHEMA_VERSION = 4
PHASE_CONTRACT = {"version": "stage0-phase-contract-v1", "transition": "apply every catalog action in source order; reset to initial only after an illegal transition", "search": "pure bounded_search only; fixture parsing, catalog compilation, and first-action proof excluded", "proof": "separate source-order certificate scan"}
GENERATOR_VERSION = "stage0-generator-v2"
SEED = 240711
MAX_SEARCH_NODES = 16_384
MIN_SAMPLE_NS = 100_000_000
# Fixed, predeclared sampling protocol.  One unmeasured operation settles
# process-local allocator/cache state; every recorded sample is then calibrated
# to a one-second target.  No attempt is retried or selected: all three raw
# samples remain in the result and must independently satisfy the comparator's
# unchanged 0.35 dispersion gate.
CALIBRATION_TARGET_NS = 1_000_000_000
PERF_SAMPLES = 3
MAX_SAMPLE_REPETITIONS = 1_000_000
REQUIRED_FIXTURES = ("synthetic-24.json", "synthetic-100.json", "synthetic-600.json", "oracle-small.json")


def canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def action(action_id: str, floor: int, requires: list[str], **delta: Any) -> dict[str, Any]:
    return {"id": action_id, "floor": floor, "requires": requires, **delta}


def generate_scale(floors: int) -> dict[str, Any]:
    actions: list[dict[str, Any]] = [
        action("opening-safe", 0, [], hp=3, choice_group="opening"),
        action("opening-risky", 0, [], hp=1, choice_group="opening"),
    ]
    previous: list[str] = []
    for floor in range(1, floors + 1):
        fight = f"f{floor:04d}-fight"
        extra = {"requires_choice": "opening"} if floor == 1 else {}
        actions.append(action(fight, floor, previous, hp=-((floor * 7 + SEED) % 19 + 1), gold=8 + floor % 11, **extra))
        actions.append(action(f"f{floor:04d}-potion", floor, [fight], hp=4 + floor % 9))
        if floor % 7 == 0:
            key = f"f{floor:04d}-key"
            actions.append(action(key, floor, [fight], yellow=1))
            door = f"f{floor:04d}-door"
            actions.append(action(door, floor, [key], consume_yellow=1, defense=1))
            previous = [door]
        else:
            previous = [fight]
    payload = {"metadata": {"synthetic": True, "seed": SEED, "generator_version": GENERATOR_VERSION,
               "rule_version": RULE_VERSION, "floors": floors, "nodes": floors,
               "edges": sum(len(row["requires"]) for row in actions),
               "first_action_proof": {"choice_group": "opening", "completion_condition": "execute every non-conflicting action", "method": "exact replay of each opening followed by the shared source-order topological completion; additive transitions make all complete orders state-equivalent"},
               "limitations": ["No shops, scripted events, critical items, regions, or engine-specific combat.",
                               "Damage is a fixture delta, not a model of real game combat.",
                               "Scale search is a deterministic bounded workload, not an optimal-route oracle."]},
               "initial": {"hp": 100000, "attack": 10, "defense": 10, "gold": 0, "yellow": 0}, "actions": actions}
    payload["metadata"]["input_digest"] = digest(payload)
    return payload


def generate_oracle() -> dict[str, Any]:
    payload = {"metadata": {"synthetic": True, "seed": SEED, "generator_version": GENERATOR_VERSION,
               "rule_version": RULE_VERSION, "floors": 3, "nodes": 8, "edges": 9,
               "oracle": "complete enumeration of every legal action order",
               "score": "lexicographic (hp, attack+defense, defense), encoded as hp*1000000+(attack+defense)*1000+defense",
               "limitations": ["No shops or scripted/critical items; every transition is enumerated exactly."]},
               "initial": {"hp": 40, "attack": 5, "defense": 5, "gold": 0, "yellow": 0},
               "actions": [action("take-yellow", 1, [], yellow=1), action("fight-scout", 1, [], hp=-4, gold=5),
                           action("open-yellow", 1, ["take-yellow"], consume_yellow=1),
                           action("take-shield", 2, ["open-yellow"], defense=3),
                           action("fight-guard", 2, ["open-yellow"], hp=-12, attack=2),
                           action("take-potion", 2, ["fight-scout"], hp=7),
                           action("fight-boss", 3, ["fight-guard", "take-shield"], hp=-16),
                           action("finish", 3, ["fight-boss"], terminal=True)]}
    payload["metadata"]["input_digest"] = digest(payload)
    return payload


def expected_files(root: Path) -> dict[Path, bytes]:
    rows = {root / f"synthetic-{n}.json": canonical(generate_scale(n)) for n in (24, 100, 600)}
    rows[root / "oracle-small.json"] = canonical(generate_oracle())
    return rows


@dataclass(frozen=True)
class State:
    hp: int
    attack: int
    defense: int
    gold: int
    yellow: int


def dominates(left: State, right: State) -> bool:
    """Strict component-wise Pareto dominance (never dataclass/tuple ordering)."""
    pairs = zip(asdict(left).values(), asdict(right).values())
    comparisons = [(a >= b, a > b) for a, b in pairs]
    return all(weak for weak, _ in comparisons) and any(strict for _, strict in comparisons)


MASK64 = (1 << 64) - 1
CHECKSUM_SEED = 0xCBF29CE484222325


def state_checksum(checksum: int, state: State, ordinal: int) -> int:
    """Language-neutral wrapping checksum binding all five transition fields."""
    value = checksum ^ ((ordinal + 1) * 0x9E3779B185EBCA87 & MASK64)
    for field in (state.hp, state.attack, state.defense, state.gold, state.yellow):
        value ^= field & MASK64
        value = value * 0x100000001B3 & MASK64
    return value


def transition_projection(payload: dict[str, Any]) -> dict[str, int]:
    state = State(**payload["initial"]); successful = 0; checksum = CHECKSUM_SEED
    for ordinal, row in enumerate(payload["actions"]):
        nxt = apply(state, row)
        if nxt is None:
            state = State(**payload["initial"])
        else:
            state = nxt; successful += 1
        checksum = state_checksum(checksum, state, ordinal)
    return {"operations_per_repetition": len(payload["actions"]), "successes_per_repetition": successful,
            "checksum_per_repetition": checksum}


def repeated_checksum(checksum: int, repetitions: int) -> int:
    return checksum * repetitions & MASK64


def search_checksum(result: dict[str, Any]) -> int:
    value = CHECKSUM_SEED
    for item in (result["nodes"], result["node_limit"], result["candidate_transitions"], result["pareto_labels"],
                 result["pruned"], int(result["node_limit_reached"]), result["logical_allocation_events"]):
        value ^= int(item) & MASK64; value = value * 0x100000001B3 & MASK64
    return value


@dataclass(frozen=True)
class Node:
    state: State
    done: int
    depth: int


def apply(state: State, row: dict[str, Any]) -> State | None:
    yellow = state.yellow + int(row.get("yellow", 0)) - int(row.get("consume_yellow", 0))
    hp = state.hp + int(row.get("hp", 0))
    if yellow < 0 or hp <= 0:
        return None
    return replace(state, hp=hp, attack=state.attack + int(row.get("attack", 0)),
                   defense=state.defense + int(row.get("defense", 0)), gold=state.gold + int(row.get("gold", 0)), yellow=yellow)


def score(state: State) -> int:
    return state.hp * 1_000_000 + (state.attack + state.defense) * 1_000 + state.defense


def exhaustive(payload: dict[str, Any]) -> dict[str, Any]:
    initial, actions = State(**payload["initial"]), payload["actions"]
    best: tuple[int, tuple[str, ...], State] | None = None
    explored = legal_routes = 0
    def visit(state: State, done: frozenset[str], route: tuple[str, ...]) -> None:
        nonlocal best, explored, legal_routes
        explored += 1
        for row in actions:
            if row["id"] in done or not set(row["requires"]).issubset(done):
                continue
            nxt = apply(state, row)
            if nxt is None:
                continue
            next_route = route + (row["id"],)
            if row.get("terminal"):
                legal_routes += 1
                candidate = (score(nxt), next_route, nxt)
                if best is None or candidate[0] > best[0] or (candidate[0] == best[0] and candidate[1] < best[1]):
                    best = candidate
            else:
                visit(nxt, done | {row["id"]}, next_route)
    visit(initial, frozenset(), ())
    if best is None:
        raise RuntimeError("oracle has no terminal route")
    value, route, terminal = best
    return {"terminal": asdict(terminal), "score": value, "first_action": route[0], "route": list(route),
            "explored_nodes": explored, "legal_terminal_routes": legal_routes}


def validate_payload(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_bytes())
    clean = dict(payload); clean["metadata"] = dict(payload["metadata"])
    claimed = clean["metadata"].pop("input_digest")
    if digest(clean) != claimed: raise ValueError(f"digest mismatch: {path}")
    if clean["metadata"].get("rule_version") != RULE_VERSION: raise ValueError(f"rule version mismatch: {path}")
    return payload


def compile_catalog(payload: dict[str, Any]) -> tuple[tuple[Any, ...], ...]:
    ids = {row["id"]: i for i, row in enumerate(payload["actions"])}
    return tuple((row["id"], int(row["floor"]), tuple(ids[item] for item in row["requires"]), int(row.get("hp", 0)),
                  int(row.get("attack", 0)), int(row.get("defense", 0)), int(row.get("gold", 0)),
                  int(row.get("yellow", 0)), int(row.get("consume_yellow", 0)), bool(row.get("terminal", False)),
                  row.get("choice_group"), row.get("requires_choice"))
                 for row in payload["actions"])


def peak_rss_bytes() -> int:
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return raw if platform.system() == "Darwin" else raw * 1024


def prove_first_action(payload: dict[str, Any]) -> dict[str, Any]:
    """Replay every competing opening through the same exact completion condition."""
    actions = payload["actions"]
    group = payload["metadata"].get("first_action_proof", {}).get("choice_group")
    candidates = [row for row in actions if row.get("choice_group") == group and not row["requires"] and not row.get("requires_choice")]
    results = []
    for opening in candidates:
        state = apply(State(**payload["initial"]), opening)
        if state is None:
            continue
        done = {opening["id"]}; route = [opening["id"]]
        progress = True
        while progress:
            progress = False
            for row in actions:
                if row["id"] in done or (row.get("choice_group") == group and row["id"] != opening["id"]):
                    continue
                if not set(row["requires"]).issubset(done):
                    continue
                required_group = row.get("requires_choice")
                if required_group and not any(a["id"] in done and a.get("choice_group") == required_group for a in actions):
                    continue
                nxt = apply(state, row)
                if nxt is None:
                    continue
                state = nxt; done.add(row["id"]); route.append(row["id"]); progress = True
        expected_done = len(actions) - sum(1 for row in actions if row.get("choice_group") == group and row["id"] != opening["id"])
        results.append({"first_action": opening["id"], "complete": len(done) == expected_done,
                        "terminal": asdict(state), "score": score(state), "route": route})
    ordered = sorted(results, key=lambda row: (-row["score"], row["first_action"]))
    proven = len(ordered) >= 2 and all(row["complete"] for row in ordered) and ordered[0]["score"] > ordered[1]["score"]
    if proven:
        winner = State(**ordered[0]["terminal"])
        proven = all(dominates(winner, State(**row["terminal"])) for row in ordered[1:])
    return {"status": "proven" if proven else "unproven", "condition": "exact_complete_all_actions_with_strict_terminal_dominance",
            "choice_group": group, "completion_method": "source-order topological replay; all shared transitions are additive and order-independent",
            "candidate_count": len(ordered), "candidates": ordered,
            "first_action": ordered[0]["first_action"] if proven else None}


def bounded_search(payload: dict[str, Any]) -> dict[str, Any]:
    actions = payload["actions"]; node_limit = min(MAX_SEARCH_NODES, 64 * len(actions))
    ids = {row["id"]: i for i, row in enumerate(actions)}
    requires = [sum(1 << ids[item] for item in row["requires"]) for row in actions]
    group_masks: dict[str, int] = {}
    for index, row in enumerate(actions):
        if row.get("choice_group"): group_masks[row["choice_group"]] = group_masks.get(row["choice_group"], 0) | (1 << index)
    initial = State(**payload["initial"]); queue: deque[Node] = deque([Node(initial, 0, 0)])
    labels: dict[int, State] = {0: initial}
    nodes = pruned = candidates = logical_allocations = 0
    while queue and nodes < node_limit:
        node = queue.popleft(); nodes += 1
        for index, row in enumerate(actions):
            bit = 1 << index
            group = row.get("choice_group"); required_group = row.get("requires_choice")
            if node.done & bit or requires[index] & ~node.done: continue
            if group and node.done & group_masks[group]: continue
            if required_group and not node.done & group_masks.get(required_group, 0): continue
            candidates += 1
            nxt = apply(node.state, row)
            if nxt is None: pruned += 1; continue
            logical_allocations += 1  # candidate State materialization
            done = node.done | bit
            old = labels.get(done)
            if old is not None and (old == nxt or dominates(old, nxt)): pruned += 1; continue
            labels[done] = nxt; logical_allocations += 1  # accepted done-set/label snapshot
            if not row.get("terminal"):
                queue.append(Node(nxt, done, node.depth + 1)); logical_allocations += 1
    return {"nodes": nodes, "node_limit": node_limit, "candidate_transitions": candidates,
            "pareto_labels": len(labels), "pruned": pruned, "node_limit_reached": bool(queue),
            "logical_allocation_events": logical_allocations}


def calibrated_samples(operation: Any) -> tuple[list[dict[str, int]], Any]:
    # This is a fixed protocol step, not a retry and not a performance sample.
    # It prevents a fresh worker's one-time setup from becoming a measured
    # sample while leaving the measured transition/search workload untouched.
    operation()
    samples: list[dict[str, int]] = []; last = None
    for _ in range(PERF_SAMPLES):
        repetitions = 1
        while True:
            start = time.perf_counter_ns()
            for __ in range(repetitions): last = operation()
            elapsed = time.perf_counter_ns() - start
            if elapsed >= CALIBRATION_TARGET_NS or repetitions >= MAX_SAMPLE_REPETITIONS: break
            repetitions = min(MAX_SAMPLE_REPETITIONS, repetitions * max(2, CALIBRATION_TARGET_NS // max(elapsed, 1)))
        samples.append({"wall_clock_ns": elapsed, "repetitions": repetitions})
    return samples, last


def phase_worker(path: Path, phase: str) -> dict[str, Any]:
    payload = validate_payload(path)
    if phase == "compile":
        tracemalloc.start(); start = time.perf_counter_ns(); catalog = compile_catalog(payload)
        elapsed = time.perf_counter_ns() - start; _, trace_peak = tracemalloc.get_traced_memory(); tracemalloc.stop()
        return {"wall_clock_ns": elapsed, "phase_peak_rss_bytes": peak_rss_bytes(),
                "rss_measurement": {"scope": "fresh subprocess for this fixture and compile phase", "method": "getrusage(RUSAGE_SELF).ru_maxrss at phase completion", "unit": "bytes"},
                "catalog_ir_estimated_bytes": len(repr(catalog).encode()), "python_tracemalloc_peak_bytes": trace_peak,
                "catalog_size_method": "UTF-8 bytes of Python tuple repr; language-local estimate, not allocator usage."}
    if phase == "transition":
        rows = payload["actions"]; initial = State(**payload["initial"])
        projection = transition_projection(payload)
        def batch() -> int:
            state = initial; checksum = CHECKSUM_SEED
            for ordinal, row in enumerate(rows):
                nxt = apply(state, row); state = initial if nxt is None else nxt
                checksum = state_checksum(checksum, state, ordinal)
            return checksum
        samples, checksum = calibrated_samples(batch)
        for sample in samples:
            repetitions = sample["repetitions"]
            sample.update({"work_units": len(rows) * repetitions,
                           "successes": projection["successes_per_repetition"] * repetitions,
                           "checksum": repeated_checksum(checksum, repetitions)})
        rates = [s["work_units"] * 1e9 / s["wall_clock_ns"] for s in samples]
        return {"operations_per_repetition": len(rows), "successes_per_repetition": projection["successes_per_repetition"],
                "checksum_per_repetition": checksum, "transitions_per_second": statistics.median(rates),
                "samples": samples, "sample_rates_per_second": rates,
                "sampling": {"minimum_sample_wall_clock_ns": MIN_SAMPLE_NS, "sample_count": PERF_SAMPLES, "aggregate": "median"},
                "state_copy_estimated_bytes_per_transition": 40, "state_copy_method": "five signed 64-bit scalar fields; packed-state-equivalent estimate."}
    if phase == "search":
        samples, result = calibrated_samples(lambda: bounded_search(payload))
        checksum = search_checksum(result)
        for sample in samples:
            sample.update({"work_units": result["nodes"] * sample["repetitions"],
                           "projection_checksum": repeated_checksum(checksum, sample["repetitions"])})
        rates = [s["work_units"] * 1e9 / s["wall_clock_ns"] for s in samples]
        proof_latencies = []
        for _ in range(9): proof_latencies.append(measure_proof(payload)[0])
        proof = prove_first_action(payload)
        return {**{k: result[k] for k in ("nodes", "node_limit", "candidate_transitions", "pareto_labels", "pruned", "node_limit_reached")},
                "logical_allocation_events": result["logical_allocation_events"], "projection_checksum_per_repetition": checksum,
                "nodes_per_second": statistics.median(rates), "samples": samples, "sample_rates_per_second": rates,
                "sampling": {"minimum_sample_wall_clock_ns": MIN_SAMPLE_NS, "sample_count": PERF_SAMPLES, "aggregate": "median"},
                "phase_peak_rss_bytes": peak_rss_bytes(),
                "rss_measurement": {"scope": "fresh subprocess for this fixture and search phase", "method": "getrusage(RUSAGE_SELF).ru_maxrss at phase completion", "unit": "bytes"},
                "prune_rate": result["pruned"] / result["candidate_transitions"],
                "per_node_allocation": {"value": result["logical_allocation_events"] / result["nodes"], "unit": "explicit logical allocation events/expanded node", "kind": "estimated", "numerator": result["logical_allocation_events"], "denominator": result["nodes"],
                                        "method": "count candidate State materialization, accepted done-set/label snapshot, and enqueued Node; identical event definition in both implementations"},
                "first_action_proof_latency_ns": int(statistics.median(proof_latencies)), "first_action_proof_status": proof["status"],
                "first_action_proof_certificate": proof,
                "proof_measurement": {"samples": 9, "aggregate": "median", "scope": "unique-root-action certificate scan only"}}
    raise ValueError(f"unknown phase {phase}")


def measure_proof(payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    start = time.perf_counter_ns(); proof = prove_first_action(payload); return time.perf_counter_ns() - start, proof


def run_worker(path: Path, phase: str) -> dict[str, Any]:
    completed = subprocess.run([sys.executable, str(Path(__file__).resolve()), "worker", "--fixture", str(path), "--phase", phase], check=True, capture_output=True)
    return json.loads(completed.stdout)


def benchmark(path: Path, requested_threads: int) -> dict[str, Any]:
    payload = validate_payload(path)
    return {"fixture": path.name, "input_digest": payload["metadata"]["input_digest"],
            "compile": run_worker(path, "compile"), "transition": run_worker(path, "transition"),
            "search": run_worker(path, "search"),
            "parallelism": {"requested_threads": requested_threads, "workers_used": 1,
                            "mode": "serial-stage0; --threads is an invariance configuration, not parallel execution"}}


def main() -> int:
    parser = argparse.ArgumentParser(); sub = parser.add_subparsers(dest="command", required=True)
    fixture = sub.add_parser("fixtures"); fixture.add_argument("--root", type=Path, required=True); fixture.add_argument("--write", action="store_true"); fixture.add_argument("--replace", action="store_true")
    run = sub.add_parser("run"); run.add_argument("--root", type=Path, required=True); run.add_argument("--output", type=Path); run.add_argument("--threads", type=int, choices=range(1, 257), default=1)
    worker = sub.add_parser("worker"); worker.add_argument("--fixture", type=Path, required=True); worker.add_argument("--phase", choices=("compile", "transition", "search"), required=True)
    args = parser.parse_args()
    if args.command == "worker": sys.stdout.buffer.write(canonical(phase_worker(args.fixture, args.phase))); return 0
    if args.command == "fixtures":
        expected = expected_files(args.root)
        if args.write:
            existing = [p for p, content in expected.items() if p.exists() and p.read_bytes() != content]
            if existing and not args.replace: raise SystemExit("refusing to replace fixture(s); pass --replace: " + ", ".join(map(str, existing)))
            args.root.mkdir(parents=True, exist_ok=True)
            for path, content in expected.items(): path.write_bytes(content)
            return 0
        actual = sorted(path.name for path in args.root.glob("*.json")) if args.root.is_dir() else []
        errors = [str(path) for path, content in expected.items() if not path.exists() or path.read_bytes() != content]
        if actual != sorted(REQUIRED_FIXTURES): errors.append(f"managed JSON set expected={sorted(REQUIRED_FIXTURES)}, actual={actual}")
        if errors: print("fixture mismatch: " + ", ".join(errors), file=sys.stderr); return 1
        print(f"validated {len(expected)} deterministic fixtures"); return 0
    actual = sorted(path.name for path in args.root.glob("*.json"))
    if actual != sorted(REQUIRED_FIXTURES): raise SystemExit(f"managed fixture set mismatch: expected={sorted(REQUIRED_FIXTURES)}, actual={actual}")
    results = [benchmark(args.root / name, args.threads) for name in REQUIRED_FIXTURES[:3]]
    oracle_payload = validate_payload(args.root / REQUIRED_FIXTURES[3])
    output = {"schema_version": RESULT_SCHEMA_VERSION, "implementation": "python", "rule_version": RULE_VERSION,
              "fixture_schema": "stage0-fixture-v2", "search_boundary": {"node_limit_formula": "min(16384, 64 * action_count)", "order": "FIFO + source action order"},
              "phase_contract": PHASE_CONTRACT,
              "fixtures": results, "oracle": exhaustive(oracle_payload),
              "environment": {"python": sys.version.split()[0], "platform": platform.platform(), "pid": os.getpid()}}
    encoded = canonical(output)
    if args.output: args.output.write_bytes(encoded)
    else: sys.stdout.buffer.write(encoded)
    return 0


if __name__ == "__main__": raise SystemExit(main())
