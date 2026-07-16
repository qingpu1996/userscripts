#!/usr/bin/env python3
"""Compare the deterministic Python and Rust Stage 0 benchmark results.

This is an offline synthetic gate.  It checks fixture identity, deterministic
projections, sample arithmetic and the ordinary Rust-over-Python ratio; it does
not make a production-runtime claim.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "benchmarks"))
import stage0

SCALE_FIXTURES = stage0.REQUIRED_FIXTURES[:3]
SEARCH_FIELDS = (
    "nodes",
    "node_limit",
    "candidate_transitions",
    "pareto_labels",
    "pruned",
    "node_limit_reached",
    "logical_allocation_events",
)
FIXTURE_SCHEMA = "stage0-fixture-v2"
SEARCH_BOUNDARY = {
    "node_limit_formula": "min(16384, 64 * action_count)",
    "order": "FIFO + source action order",
}
MAX_RATE_SPREAD = 0.35
MIGRATION_RATIO = 2.0


def fail(message: str) -> None:
    raise ValueError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def expected_semantics(root: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Return deterministic expectations derived from the checked-in fixtures."""
    actual = sorted(path.name for path in root.glob("*.json"))
    require(actual == sorted(stage0.REQUIRED_FIXTURES), f"fixture set mismatch: {actual}")
    expected_bytes = stage0.expected_files(root)
    for path, content in expected_bytes.items():
        require(path.is_file() and path.read_bytes() == content, f"fixture bytes mismatch: {path.name}")

    expected: dict[str, dict[str, Any]] = {}
    for name in SCALE_FIXTURES:
        payload = stage0.validate_payload(root / name)
        expected[name] = {
            "payload": payload,
            "transition": stage0.transition_projection(payload),
            "search": stage0.bounded_search(payload),
            "proof": stage0.prove_first_action(payload),
        }
    oracle = stage0.exhaustive(stage0.validate_payload(root / "oracle-small.json"))
    return expected, oracle


def _same(value: Any, expected: Any, where: str) -> None:
    if value != expected:
        fail(f"{where} mismatch: expected {expected!r}, got {value!r}")


def _positive_number(value: Any, where: str) -> float:
    require(isinstance(value, (int, float)) and not isinstance(value, bool), f"{where}: invalid number")
    try:
        parsed = float(value)
    except (OverflowError, ValueError) as error:
        fail(f"{where}: invalid number ({error})")
    require(math.isfinite(parsed) and parsed > 0, f"{where}: number must be finite and positive")
    return parsed


def _rates(
    phase: dict[str, Any],
    where: str,
    *,
    work_per_repetition: int,
    deterministic: dict[str, int] | None = None,
) -> list[float]:
    rates = phase.get("sample_rates_per_second")
    samples = phase.get("samples")
    require(isinstance(rates, list) and len(rates) == stage0.PERF_SAMPLES, f"{where}: expected three rates")
    require(isinstance(samples, list) and len(samples) == stage0.PERF_SAMPLES, f"{where}: expected three samples")
    sampling = phase.get("sampling")
    require(isinstance(sampling, dict), f"{where}: missing sampling contract")
    _same(sampling.get("sample_count"), stage0.PERF_SAMPLES, f"{where}.sample_count")
    _same(sampling.get("minimum_sample_wall_clock_ns"), stage0.MIN_SAMPLE_NS, f"{where}.minimum_sample_wall_clock_ns")

    parsed: list[float] = []
    for index, (rate, sample) in enumerate(zip(rates, samples)):
        sample_where = f"{where}[{index}]"
        parsed_rate = _positive_number(rate, f"{sample_where}.rate")
        require(isinstance(sample, dict), f"{sample_where}: invalid sample")
        repetitions = sample.get("repetitions")
        require(isinstance(repetitions, int) and not isinstance(repetitions, bool) and repetitions > 0,
                f"{sample_where}: invalid repetitions")
        wall = sample.get("wall_clock_ns")
        require(isinstance(wall, int) and not isinstance(wall, bool), f"{sample_where}: invalid elapsed time")
        require(wall >= stage0.MIN_SAMPLE_NS, f"{sample_where}: sample too short")
        work = sample.get("work_units")
        require(isinstance(work, int) and not isinstance(work, bool) and work > 0,
                f"{sample_where}: invalid work count")
        _same(work, work_per_repetition * repetitions, f"{sample_where}.work_units")
        if deterministic:
            for field, per_repetition in deterministic.items():
                _same(sample.get(field), stage0.repeated_checksum(per_repetition, repetitions)
                      if field in {"checksum", "projection_checksum"} else per_repetition * repetitions,
                      f"{sample_where}.{field}")
        expected_rate = work * 1e9 / wall
        require(math.isclose(parsed_rate, expected_rate, rel_tol=1e-12),
                f"{sample_where}: rate does not match work/time")
        parsed.append(parsed_rate)

    median = statistics.median(parsed)
    spread = (max(parsed) - min(parsed)) / median
    require(math.isfinite(spread) and spread <= MAX_RATE_SPREAD,
            f"{where}: dispersion {spread:.3f} exceeds {MAX_RATE_SPREAD:.2f}")
    return parsed


def _validate_compile(phase: Any, where: str) -> None:
    require(isinstance(phase, dict), f"{where}: missing compile phase")
    _positive_number(phase.get("wall_clock_ns"), f"{where}.wall_clock_ns")


def _validate_result(
    name: str,
    result: dict[str, Any],
    expected: dict[str, dict[str, Any]],
    oracle: dict[str, Any],
) -> dict[str, float]:
    require(isinstance(result, dict), f"{name}: result must be an object")
    _same(result.get("schema_version"), stage0.RESULT_SCHEMA_VERSION, f"{name}.schema_version")
    _same(result.get("implementation"), name, f"{name}.implementation")
    _same(result.get("rule_version"), stage0.RULE_VERSION, f"{name}.rule_version")
    _same(result.get("fixture_schema"), FIXTURE_SCHEMA, f"{name}.fixture_schema")
    _same(result.get("search_boundary"), SEARCH_BOUNDARY, f"{name}.search_boundary")
    _same(result.get("phase_contract"), stage0.PHASE_CONTRACT, f"{name}.phase_contract")
    _same(result.get("oracle"), oracle, f"{name}.oracle")
    rows = result.get("fixtures")
    require(isinstance(rows, list) and len(rows) == len(SCALE_FIXTURES), f"{name}: fixture result count mismatch")

    rates: dict[str, tuple[float, float]] = {}
    for row, fixture in zip(rows, SCALE_FIXTURES):
        where = f"{name}/{fixture}"
        require(isinstance(row, dict) and row.get("fixture") == fixture, f"{where}: fixture mismatch")
        source = expected[fixture]["payload"]
        _same(row.get("input_digest"), source["metadata"]["input_digest"], f"{where}.input_digest")

        _validate_compile(row.get("compile"), f"{where}.compile")
        transition = row.get("transition")
        require(isinstance(transition, dict), f"{where}: missing transition")
        projection = expected[fixture]["transition"]
        for field in ("operations_per_repetition", "successes_per_repetition", "checksum_per_repetition"):
            _same(transition.get(field), projection[field], f"{where}.transition.{field}")
        transition_rates = _rates(
            transition,
            f"{where}.transition.samples",
            work_per_repetition=projection["operations_per_repetition"],
            deterministic={
                "successes": projection["successes_per_repetition"],
                "checksum": projection["checksum_per_repetition"],
            },
        )
        _same(transition.get("transitions_per_second"), statistics.median(transition_rates),
              f"{where}.transition aggregate")

        search = row.get("search")
        require(isinstance(search, dict), f"{where}: missing search")
        expected_search = expected[fixture]["search"]
        for field in SEARCH_FIELDS:
            _same(search.get(field), expected_search[field], f"{where}.search.{field}")
        _same(search.get("projection_checksum_per_repetition"), stage0.search_checksum(expected_search),
              f"{where}.search.checksum")
        _same(search.get("first_action_proof_status"), "proven", f"{where}.proof.status")
        _same(search.get("first_action_proof_certificate"), expected[fixture]["proof"], f"{where}.proof")
        search_rates = _rates(
            search,
            f"{where}.search.samples",
            work_per_repetition=expected_search["nodes"],
            deterministic={"projection_checksum": stage0.search_checksum(expected_search)},
        )
        _same(search.get("nodes_per_second"), statistics.median(search_rates),
              f"{where}.search aggregate")

        rates[fixture] = float(transition["transitions_per_second"]), float(search["nodes_per_second"])
    return {"transition": rates[SCALE_FIXTURES[-1]][0], "search": rates[SCALE_FIXTURES[-1]][1]}


def compare(fixture_root: Path, python_path: Path, rust_path: Path) -> dict[str, Any]:
    expected, oracle = expected_semantics(fixture_root)
    python_result = json.loads(python_path.read_text())
    rust_result = json.loads(rust_path.read_text())
    python_rates = _validate_result("python", python_result, expected, oracle)
    rust_rates = _validate_result("rust", rust_result, expected, oracle)
    ratios = {
        "transition": rust_rates["transition"] / python_rates["transition"],
        "search": rust_rates["search"] / python_rates["search"],
    }
    for phase, ratio in ratios.items():
        _positive_number(ratio, f"speedup.{phase}")
    threshold_pass = all(value >= MIGRATION_RATIO for value in ratios.values())
    outcome = "enter-rust-shadow-only" if threshold_pass else "reconsider-rust-route"
    return {
        "status": "pass" if threshold_pass else "fail",
        "stage": "stage0-complete",
        "ratios": ratios,
        "thresholds": {"dispersion": MAX_RATE_SPREAD, "speedup": MIGRATION_RATIO},
        "outcome": outcome,
        "decision": outcome,
        "fixtures": list(SCALE_FIXTURES),
        "scope": "synthetic Stage 0 comparison only; not a production runtime claim",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-root", type=Path, required=True)
    parser.add_argument("--python", dest="python_result", type=Path, required=True)
    parser.add_argument("--rust", dest="rust_result", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = compare(args.fixture_root, args.python_result, args.rust_result)
    except Exception as error:  # one concise stdout JSON is reserved for success
        print(f"stage0 comparison failed: {error}", file=sys.stderr)
        return 1
    if report["status"] != "pass":
        print(
            f"stage0 comparison failed: speedup below {MIGRATION_RATIO:.1f}x "
            f"(ratios={report['ratios']})",
            file=sys.stderr,
        )
        return 1
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
