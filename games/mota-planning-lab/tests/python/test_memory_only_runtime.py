import tempfile
import unittest
import inspect
from unittest.mock import patch
from pathlib import Path

from mota_lab.api import CycleCoordinator, Settings
from mota_lab.__main__ import main
from mota_lab.storage import Store
from mota_lab.knowledge import KnowledgeError


class MemoryOnlyRuntimeTests(unittest.TestCase):
    def test_coordinator_ignores_hostile_state_tree_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            knowledge = root / "knowledge"
            state.mkdir()
            knowledge.mkdir()
            hostile = {
                state / "mota-lab.sqlite3": b"old sqlite",
                state / "mota-lab.sqlite3-wal": b"old wal",
                state / "mota-lab.sqlite3-shm": b"old shm",
                state / ".mota-lab.sqlite3.manifest.json": b"{bad",
                state / "decisions.jsonl": b"old decision\n",
                knowledge / "block-labels.json": b'{"protocol":1,"labels":[{"hostile":true}]}',
                knowledge / "floor-models.json": b'{"protocol":1,"floors":[{"floor_id":"HOSTILE"}]}',
                knowledge / "nested" / "old-runtime.jsonl": b"hostile nested content\n",
            }
            for path, payload in hostile.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(payload)
            before = {
                path: (path.read_bytes(), path.stat().st_mtime_ns, path.stat().st_mode)
                for path in hostile
            }
            tree_before = sorted(str(path.relative_to(root)) for path in root.rglob("*"))
            coordinator = CycleCoordinator(Settings.for_directory(root))
            self.assertTrue(coordinator.store._memory_only)
            clean = CycleCoordinator(Settings.for_directory(root / "clean"))
            self.assertEqual(coordinator.knowledge.fingerprint(), clean.knowledge.fingerprint())
            self.assertEqual(
                {
                    path: (path.read_bytes(), path.stat().st_mtime_ns, path.stat().st_mode)
                    for path in hostile
                },
                before,
            )
            self.assertEqual(sorted(str(path.relative_to(root)) for path in root.rglob("*")), tree_before)

    def test_serve_compatibility_directories_are_never_touched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "missing-state" / "trap"
            knowledge = root / "missing-knowledge" / "trap"
            captured = {}

            def fake_run(app, **kwargs):
                captured["coordinator"] = app.state.coordinator

            with patch("uvicorn.run", side_effect=fake_run):
                result = main([
                    "--state-dir", str(state),
                    "--knowledge-dir", str(knowledge),
                    "serve",
                ])
            self.assertEqual(result, 0)
            self.assertFalse(state.parent.exists())
            self.assertFalse(knowledge.parent.exists())
            self.assertTrue(captured["coordinator"].store._memory_only)

    def test_store_restart_has_no_session_action_or_decision(self):
        first = Store()
        self.assertEqual(first.observation_count(), 0)
        first.close()
        restarted = Store()
        self.assertEqual(restarted.observation_count(), 0)
        self.assertIsNone(restarted.get_action("AUTO-OLD"))
        self.assertIsNone(restarted.get_decision("old"))

    def test_production_factory_has_no_runtime_path_probe_or_file_store(self):
        source = inspect.getsource(CycleCoordinator.__init__)
        for forbidden in (
            "settings.state_dir", "settings.knowledge_dir", "settings.labels_path",
            "settings.floors_path", ".is_file(", ".exists(", "Store(settings",
        ):
            self.assertNotIn(forbidden, source)
        self.assertIn("Store()", source)
        self.assertIn("from_bundled_read_only", source)

    def test_missing_or_invalid_bundled_rules_fail_closed_without_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = Settings.for_directory(root)
            invalid = root / "bundled"
            invalid.mkdir()
            bad_settings = Settings(
                state_dir=settings.state_dir,
                knowledge_dir=settings.knowledge_dir,
                bundled_data_dir=invalid,
            )
            with self.assertRaises(KnowledgeError):
                CycleCoordinator(bad_settings)
            (invalid / "block-labels.json").write_text("{bad", encoding="utf-8")
            (invalid / "floor-models.json").write_text('{"protocol":1,"floors":[]}', encoding="utf-8")
            with self.assertRaises(KnowledgeError):
                CycleCoordinator(bad_settings)


if __name__ == "__main__":
    unittest.main()
