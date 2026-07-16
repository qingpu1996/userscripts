from __future__ import annotations

import copy
import json
import statistics
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "benchmarks"))
import compare_stage0
import stage0


class Stage0BenchmarkTest(unittest.TestCase):
    def _synthetic_result(self, implementation: str, rate: int) -> dict:
        fixture_root = ROOT / "tests/fixtures/stage0"
        expected, oracle = compare_stage0.expected_semantics(fixture_root)

        def phase_samples(work: int, deterministic: dict[str, int]) -> tuple[list[dict], list[float]]:
            samples = []
            for _ in range(stage0.PERF_SAMPLES):
                repetitions = 1
                wall = max(stage0.MIN_SAMPLE_NS, work * 1_000_000_000 // rate)
                sample = {"wall_clock_ns": wall, "repetitions": repetitions, "work_units": work}
                for field, value in deterministic.items():
                    sample[field] = (
                        stage0.repeated_checksum(value, repetitions)
                        if field in {"checksum", "projection_checksum"}
                        else value * repetitions
                    )
                samples.append(sample)
            rates = [sample["work_units"] * 1e9 / sample["wall_clock_ns"] for sample in samples]
            return samples, rates

        rows = []
        for fixture in compare_stage0.SCALE_FIXTURES:
            transition = expected[fixture]["transition"]
            search = expected[fixture]["search"]
            transition_samples, transition_rates = phase_samples(
                transition["operations_per_repetition"],
                {"successes": transition["successes_per_repetition"], "checksum": transition["checksum_per_repetition"]},
            )
            search_samples, search_rates = phase_samples(
                search["nodes"], {"projection_checksum": stage0.search_checksum(search)}
            )
            sampling = {"minimum_sample_wall_clock_ns": stage0.MIN_SAMPLE_NS,
                        "sample_count": stage0.PERF_SAMPLES, "aggregate": "median"}
            rows.append({
                "fixture": fixture,
                "input_digest": expected[fixture]["payload"]["metadata"]["input_digest"],
                "compile": {"wall_clock_ns": 1},
                "transition": {
                    **{field: transition[field] for field in ("operations_per_repetition", "successes_per_repetition", "checksum_per_repetition")},
                    "transitions_per_second": statistics.median(transition_rates),
                    "samples": transition_samples,
                    "sample_rates_per_second": transition_rates,
                    "sampling": sampling,
                },
                "search": {
                    **{field: search[field] for field in compare_stage0.SEARCH_FIELDS},
                    "projection_checksum_per_repetition": stage0.search_checksum(search),
                    "nodes_per_second": statistics.median(search_rates),
                    "samples": search_samples,
                    "sample_rates_per_second": search_rates,
                    "sampling": sampling,
                    "first_action_proof_status": "proven",
                    "first_action_proof_certificate": expected[fixture]["proof"],
                },
            })
        return {
            "schema_version": stage0.RESULT_SCHEMA_VERSION,
            "implementation": implementation,
            "rule_version": stage0.RULE_VERSION,
            "fixture_schema": compare_stage0.FIXTURE_SCHEMA,
            "search_boundary": compare_stage0.SEARCH_BOUNDARY,
            "phase_contract": stage0.PHASE_CONTRACT,
            "fixtures": rows,
            "oracle": oracle,
        }

    def test_fixtures_are_exact_and_deterministic(self) -> None:
        fixture_root = ROOT / "tests/fixtures/stage0"
        self.assertEqual(
            sorted(path.name for path in fixture_root.glob("*.json")),
            sorted(stage0.REQUIRED_FIXTURES),
        )
        for path, expected in stage0.expected_files(fixture_root).items():
            self.assertEqual(path.read_bytes(), expected)

        with tempfile.TemporaryDirectory() as raw:
            copy = Path(raw)
            for path, expected in stage0.expected_files(copy).items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(expected)
            command = [
                sys.executable,
                str(ROOT / "benchmarks/stage0.py"),
                "fixtures",
                "--root",
                str(copy),
            ]
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
            (copy / "extra.json").write_text("{}\n")
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_oracle_and_competing_openings(self) -> None:
        oracle = stage0.exhaustive(stage0.generate_oracle())
        self.assertEqual(oracle["route"][-1], "finish")
        self.assertEqual(oracle["first_action"], "fight-scout")
        for floors in (24, 100, 600):
            payload = stage0.generate_scale(floors)
            self.assertEqual(stage0.prove_first_action(payload)["status"], "proven")
            self.assertGreater(stage0.transition_projection(payload)["checksum_per_repetition"], 0)

    def test_fixture_search_matches_python_baseline(self) -> None:
        fixture_root = ROOT / "tests/fixtures/stage0"
        for name in stage0.REQUIRED_FIXTURES[:3]:
            payload = stage0.validate_payload(fixture_root / name)
            result = stage0.bounded_search(payload)
            self.assertEqual(result["node_limit"], min(stage0.MAX_SEARCH_NODES, 64 * len(payload["actions"])))
            self.assertGreater(result["nodes"], 0)
            self.assertEqual(stage0.prove_first_action(payload)["status"], "proven")

    def test_runner_uses_a_disposable_directory(self) -> None:
        script = (ROOT / "scripts/run-stage0-bench.sh").read_text()
        self.assertIn("mktemp", script)
        self.assertIn("CARGO_TARGET_DIR", script)

    def test_comparator_rejects_bad_results(self) -> None:
        fixture_root = ROOT / "tests/fixtures/stage0"
        python_result = self._synthetic_result("python", 100)
        rust_result = self._synthetic_result("rust", 300)
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            python_path = directory / "python.json"
            rust_path = directory / "rust.json"

            def run_case(label: str, python_value: dict, rust_value: dict) -> None:
                python_path.write_text(json.dumps(python_value))
                rust_path.write_text(json.dumps(rust_value))
                completed = subprocess.run(
                    [sys.executable, str(ROOT / "benchmarks/compare_stage0.py"),
                     "--fixture-root", str(fixture_root), "--python", str(python_path), "--rust", str(rust_path)],
                    capture_output=True, text=True,
                )
                self.assertNotEqual(completed.returncode, 0, label)
                self.assertEqual(completed.stdout, "", label)
                self.assertIn(label, completed.stderr, label)

            good_python = directory / "good-python.json"
            good_rust = directory / "good-rust.json"
            good_python.write_text(json.dumps(python_result))
            good_rust.write_text(json.dumps(rust_result))
            self.assertEqual(compare_stage0.compare(fixture_root, good_python, good_rust)["status"], "pass")

            bad_schema = copy.deepcopy(python_result)
            bad_schema["schema_version"] = "BAD"
            run_case("schema_version", bad_schema, rust_result)

            bad_version = copy.deepcopy(python_result)
            bad_version["rule_version"] = "BAD"
            run_case("rule_version", bad_version, rust_result)

            bad_oracle = copy.deepcopy(rust_result)
            bad_oracle["oracle"]["score"] += 1
            run_case("oracle", python_result, bad_oracle)

            bad_deterministic = copy.deepcopy(rust_result)
            bad_deterministic["fixtures"][0]["transition"]["checksum_per_repetition"] += 1
            run_case("checksum_per_repetition", python_result, bad_deterministic)

            bad_dispersion = copy.deepcopy(python_result)
            transition = bad_dispersion["fixtures"][0]["transition"]
            transition["samples"][0]["wall_clock_ns"] *= 2
            transition["sample_rates_per_second"][0] = (
                transition["samples"][0]["work_units"] * 1e9 / transition["samples"][0]["wall_clock_ns"]
            )
            run_case("dispersion", bad_dispersion, rust_result)

            bad_speedup = copy.deepcopy(rust_result)
            for index, row in enumerate(bad_speedup["fixtures"]):
                for phase_name, aggregate_name in (("transition", "transitions_per_second"), ("search", "nodes_per_second")):
                    phase = row[phase_name]
                    source = python_result["fixtures"][index][phase_name]
                    rates = []
                    for sample in phase["samples"]:
                        sample["wall_clock_ns"] = int(sample["work_units"] * 1e9 / 100)
                        rates.append(sample["work_units"] * 1e9 / sample["wall_clock_ns"])
                    phase["sample_rates_per_second"] = rates
                    phase[aggregate_name] = statistics.median(rates)
                    self.assertNotEqual(source[aggregate_name], 0)
            run_case("speedup", python_result, bad_speedup)


if __name__ == "__main__":
    unittest.main()
