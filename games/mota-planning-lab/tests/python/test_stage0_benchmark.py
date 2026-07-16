from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "benchmarks"))
import stage0


class Stage0BenchmarkTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
