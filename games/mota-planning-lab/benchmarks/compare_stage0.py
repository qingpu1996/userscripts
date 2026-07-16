#!/usr/bin/env python3
"""Small, offline Stage 0 comparison for the Python baseline and Rust spike.

The comparator checks deterministic fixture/oracle/search projections and then
reports the ordinary synthetic benchmark ratio. Callers own the temporary
result files and may discard them after this command exits.
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


def _rates(phase: dict[str, Any], where: str) -> list[float]:
    rates = phase.get("sample_rates_per_second")
    samples = phase.get("samples")
    require(isinstance(rates, list) and len(rates) == stage0.PERF_SAMPLES, f"{where}: expected three rates")
    require(isinstance(samples, list) and len(samples) == stage0.PERF_SAMPLES, f"{where}: expected three samples")
    parsed: list[float] = []
    for index, (rate, sample) in enumerate(zip(rates, samples)):
        require(isinstance(rate, (int, float)) and not isinstance(rate, bool), f"{where}[{index}]: invalid rate")
        require(math.isfinite(float(rate)) and float(rate) > 0, f"{where}[{index}]: invalid rate")
        require(isinstance(sample, dict), f"{where}[{index}]: invalid sample")
        wall = sample.get("wall_clock_ns")
        require(isinstance(wall, int) and wall >= stage0.MIN_SAMPLE_NS, f"{where}[{index}]: sample too short")
        work = sample.get("work_units")
        require(isinstance(work, int) and work > 0, f"{where}[{index}]: invalid work count")
        expected_rate = work * 1e9 / wall
        require(math.isclose(float(rate), expected_rate, rel_tol=1e-12), f"{where}[{index}]: rate does not match work/time")
        parsed.append(float(rate))
    median = statistics.median(parsed)
    spread = (max(parsed) - min(parsed)) / median
    require(spread <= MAX_RATE_SPREAD, f"{where}: dispersion {spread:.3f} exceeds {MAX_RATE_SPREAD:.2f}")
    return parsed


def _validate_result(name: str, result: dict[str, Any], expected: dict[str, dict[str, Any]], oracle: dict[str, Any]) -> dict[str, float]:
    require(result.get("schema_version") == stage0.RESULT_SCHEMA_VERSION, f"{name}: schema version mismatch")
    require(result.get("implementation") == name, f"{name}: implementation mismatch")
    require(result.get("rule_version") == stage0.RULE_VERSION, f"{name}: rule version mismatch")
    require(result.get("oracle") == oracle, f"{name}: oracle mismatch")
    rows = result.get("fixtures")
    require(isinstance(rows, list) and len(rows) == len(SCALE_FIXTURES), f"{name}: fixture result count mismatch")

    rates: dict[str, tuple[float, float]] = {}
    for row, fixture in zip(rows, SCALE_FIXTURES):
        where = f"{name}/{fixture}"
        require(isinstance(row, dict) and row.get("fixture") == fixture, f"{where}: fixture mismatch")
        source = expected[fixture]["payload"]
        _same(row.get("input_digest"), source["metadata"]["input_digest"], f"{where}.input_digest")

        transition = row.get("transition")
        require(isinstance(transition, dict), f"{where}: missing transition")
        projection = expected[fixture]["transition"]
        for field in ("operations_per_repetition", "successes_per_repetition", "checksum_per_repetition"):
            _same(transition.get(field), projection[field], f"{where}.transition.{field}")
        transition_rates = _rates(transition, f"{where}.transition.samples")
        require(
            math.isclose(float(transition.get("transitions_per_second", 0)), statistics.median(transition_rates), rel_tol=1e-12),
            f"{where}: transition aggregate does not match samples",
        )

        search = row.get("search")
        require(isinstance(search, dict), f"{where}: missing search")
        expected_search = expected[fixture]["search"]
        for field in SEARCH_FIELDS:
            _same(search.get(field), expected_search[field], f"{where}.search.{field}")
        _same(search.get("projection_checksum_per_repetition"), stage0.search_checksum(expected_search), f"{where}.search.checksum")
        _same(search.get("first_action_proof_status"), "proven", f"{where}.proof.status")
        _same(search.get("first_action_proof_certificate"), expected[fixture]["proof"], f"{where}.proof")
        search_rates = _rates(search, f"{where}.search.samples")
        require(
            math.isclose(float(search.get("nodes_per_second", 0)), statistics.median(search_rates), rel_tol=1e-12),
            f"{where}: search aggregate does not match samples",
        )

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
    threshold_pass = all(value >= MIGRATION_RATIO for value in ratios.values())
    return {
        "status": "pass" if threshold_pass else "fail",
        "stage": "stage0-complete",
        "decision": "enter-rust-shadow-only" if threshold_pass else "reconsider-rust-route",
        "ratios": ratios,
        "threshold": MIGRATION_RATIO,
        "fixtures": list(SCALE_FIXTURES),
        "workload": "synthetic serial bounded benchmark; 0.35 sample dispersion limit",
        "limitations": [
            "Synthetic fixtures only; no production strategy or SLA claim.",
            "Rust result supports a shadow-runtime direction, not production migration.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-root", type=Path, required=True)
    parser.add_argument("--python", dest="python_result", type=Path, required=True)
    parser.add_argument("--rust", dest="rust_result", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = compare(args.fixture_root, args.python_result, args.rust_result)
    except Exception as error:  # keep the single runner's output machine-readable
        report = {"status": "fail", "stage": "stage0", "error": str(error)}
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
