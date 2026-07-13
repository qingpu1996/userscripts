from __future__ import annotations

import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import ValidationError

from mota_lab.api import CycleCoordinator, create_app
from mota_lab.models import (
    BlockLabel,
    CycleRequest,
    ErrorResponse,
    ExecuteResponse,
    IdleResponse,
    Observation,
    PauseKind,
    PauseResponse,
    model_to_wire_dict,
)

from json_schema_support import assert_json_schema_instance
from mota_test_support import make_block, make_observation, make_request, make_settings


def assert_browser_parser_accepts(payloads: list[dict]) -> None:
    project_dir = Path(__file__).resolve().parents[2]
    helper = project_dir / "tests" / "js" / "helpers" / "runtime.js"
    script = """
const fs = require("node:fs");
const { loadRuntime } = require(process.argv[1]);
const lab = loadRuntime();
for (const payload of JSON.parse(fs.readFileSync(0, "utf8"))) {
  lab.validateCycleResponse(payload);
}
"""
    completed = subprocess.run(
        ["node", "-e", script, str(helper)],
        input=json.dumps(payloads, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "browser protocol parser rejected service payload:\n"
            + completed.stderr
            + completed.stdout
        )


def response_schema_branch(status: str) -> dict:
    project_dir = Path(__file__).resolve().parents[2]
    schema = json.loads(
        (project_dir / "protocol" / "cycle-response.schema.json").read_text(
            encoding="utf-8"
        )
    )
    return schema["$defs"][status]


def assert_top_level_schema_shape(payload: dict) -> None:
    branch = response_schema_branch(payload["status"])
    keys = set(payload)
    assert set(branch["required"]) <= keys
    assert keys <= set(branch["properties"])


def response_schema() -> dict:
    project_dir = Path(__file__).resolve().parents[2]
    return json.loads(
        (project_dir / "protocol" / "cycle-response.schema.json").read_text(
            encoding="utf-8"
        )
    )


class ProtocolModelTests(unittest.TestCase):
    def test_valid_observation_and_nullable_enemy_attack_defense(self) -> None:
        block = make_block(
            x=1,
            y=0,
            block_id="enemyA",
            cls="enemy48",
            trigger="battle",
            damage=0,
            enemy={
                "hp": 1,
                "attack": None,
                "defense": None,
                "gold": 0,
                "experience": 0,
                "special": [1],
            },
        )
        parsed = Observation.model_validate(make_observation(blocks=[block]))
        self.assertEqual(parsed.hero.hp, 208)
        self.assertIsNone(parsed.blocks[0].enemy.attack)

    def test_field_aware_serializer_audits_all_required_nullable_request_fields(self) -> None:
        triggerless = make_block(
            x=1,
            y=0,
            block_id="wall",
            cls="terrains",
            trigger=None,
            enemy=None,
        )
        enemy = make_block(
            x=2,
            y=0,
            block_id="enemyA",
            cls="enemy48",
            trigger="battle",
            damage=0,
            enemy={
                "hp": 1,
                "attack": None,
                "defense": None,
                "gold": 0,
                "experience": 0,
                "special": [],
            },
        )
        request = CycleRequest.model_validate(
            make_request(
                make_observation(
                    floor_name=None,
                    floor_number=None,
                    blocks=[triggerless, enemy],
                )
            )
        )
        payload = model_to_wire_dict(request)
        self.assertIn("completed_action_id", payload)
        self.assertIsNone(payload["completed_action_id"])
        self.assertIn("floor_name", payload["observation"])
        self.assertIsNone(payload["observation"]["floor_name"])
        self.assertIn("floor_number", payload["observation"])
        self.assertIsNone(payload["observation"]["floor_number"])
        self.assertIn("trigger", payload["observation"]["blocks"][0])
        self.assertIsNone(payload["observation"]["blocks"][0]["trigger"])
        self.assertIsNone(payload["observation"]["blocks"][1]["enemy"]["attack"])
        self.assertIsNone(payload["observation"]["blocks"][1]["enemy"]["defense"])

        label = BlockLabel(
            id="wall",
            cls="terrains",
            trigger=None,
            category="wall",
            passable=False,
            boundary=False,
            fast_path=False,
        )
        label_payload = model_to_wire_dict(label)
        self.assertIn("trigger", label_payload)
        self.assertIsNone(label_payload["trigger"])
        self.assertNotIn("expected_delta", label_payload)

    def test_extra_fields_rejected_at_every_boundary(self) -> None:
        root = make_request(make_observation())
        root["maps"] = {}
        with self.assertRaises(ValidationError):
            CycleRequest.model_validate(root)

        hero = make_request(make_observation())
        hero["observation"]["hero"]["items"] = {}
        with self.assertRaises(ValidationError):
            CycleRequest.model_validate(hero)

        block = make_block(x=1, y=1)
        block["disable"] = False
        with self.assertRaises(ValidationError):
            CycleRequest.model_validate(make_request(make_observation(blocks=[block])))

    def test_dimensions_and_coordinates_are_strict_11_by_11(self) -> None:
        wrong = make_observation()
        wrong["dimensions"]["width"] = 12
        with self.assertRaises(ValidationError):
            Observation.model_validate(wrong)
        out_of_bounds = make_observation(blocks=[make_block(x=11, y=0)])
        with self.assertRaises(ValidationError):
            Observation.model_validate(out_of_bounds)

    def test_duplicate_block_coordinates_rejected(self) -> None:
        blocks = [make_block(x=1, y=2), make_block(x=1, y=2, block_id="other")]
        with self.assertRaises(ValidationError):
            Observation.model_validate(make_observation(blocks=blocks))

    def test_missing_or_null_block_identity_rejected(self) -> None:
        for field in ("numeric_id", "id", "cls"):
            block = make_block(x=1, y=1)
            block[field] = None
            with self.subTest(field=field), self.assertRaises(ValidationError):
                Observation.model_validate(make_observation(blocks=[block]))

    def test_pause_taxonomy_is_exact(self) -> None:
        self.assertEqual(
            {kind.value for kind in PauseKind},
            {
                "NEW_OBJECT_OR_MECHANISM",
                "UNKNOWN_DAMAGE",
                "UNKNOWN_FLOOR",
                "EXPECTED_DELTA_MISMATCH",
                "GUARD_MISMATCH",
                "UNSUPPORTED_INTERACTION",
                "DECISION_SERVICE_UNAVAILABLE",
                "ENGINE_API_INCOMPATIBLE",
            },
        )

    def test_all_cycle_response_models_are_strictly_aligned(self) -> None:
        project_dir = Path(__file__).resolve().parents[2]
        fixtures = json.loads(
            (project_dir / "tests" / "fixtures" / "protocol-responses.json").read_text(
                encoding="utf-8"
            )
        )
        execute = fixtures["execute"]
        execute["registry_entries"] = [
            {
                "id": "syntheticRedPotion",
                "cls": "items",
                "trigger": "getItem",
                "category": "resource",
                "passable": True,
                "boundary": True,
                "fast_path": False,
                "version": 1,
            }
        ]
        ExecuteResponse.model_validate(execute)
        PauseResponse.model_validate_json(json.dumps(fixtures["pause"]))
        IdleResponse.model_validate(fixtures["idle"])
        ErrorResponse.model_validate(
            {"status": "error", "error_code": "SCHEMA_REJECTED", "reason": "bad"}
        )

        mutations = [
            lambda value: value.update(action_id="AUTO-deadbeefdeadbeef"),
            lambda value: value["registry_entries"][0].pop("version"),
            lambda value: value.update(extra=True),
            lambda value: value["registry_entries"][0].update(extra=True),
            lambda value: value["operations"][0].update(extra=True),
            lambda value: value["guard"].update(extra=True),
            lambda value: value["guard"]["keys"].update(extra=0),
            lambda value: value["expected_delta"].update(extra=0),
            lambda value: value["expected_delta"]["removed_blocks"][0].update(extra=True),
        ]
        for mutate in mutations:
            invalid = copy.deepcopy(execute)
            mutate(invalid)
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                ExecuteResponse.model_validate(invalid)

        empty_delta = copy.deepcopy(execute)
        empty_delta["expected_delta"] = {}
        with self.assertRaises(ValidationError):
            ExecuteResponse.model_validate(empty_delta)

        missing_pause_details = copy.deepcopy(fixtures["pause"])
        missing_pause_details.pop("details")
        with self.assertRaises(ValidationError):
            PauseResponse.model_validate(missing_pause_details)
        with self.assertRaises(ValidationError):
            IdleResponse.model_validate({"status": "idle", "reason": "ok", "extra": True})
        with self.assertRaises(ValidationError):
            ErrorResponse.model_validate(
                {"status": "error", "error_code": "BAD", "reason": "bad", "extra": True}
            )

    def test_response_serialization_preserves_required_nulls_and_omits_unset_optionals(self) -> None:
        project_dir = Path(__file__).resolve().parents[2]
        fixtures = json.loads(
            (project_dir / "tests" / "fixtures" / "protocol-responses.json").read_text(
                encoding="utf-8"
            )
        )
        registry_entry = {
            "id": "syntheticWall",
            "cls": "terrains",
            "trigger": None,
            "category": "wall",
            "passable": False,
            "boundary": False,
            "fast_path": False,
            "version": 1,
        }
        execute_fixture = copy.deepcopy(fixtures["execute"])
        execute_fixture["guard"]["floor"] = None
        execute_fixture["registry_entries"] = [registry_entry]
        responses = [
            ExecuteResponse.model_validate(execute_fixture),
            PauseResponse(
                status="pause",
                pause_kind=PauseKind.UNKNOWN_FLOOR,
                detail_code="FLOOR_MODEL_MISSING",
                reason="synthetic pause",
                details={},
                registry_entries=[registry_entry],
            ),
            IdleResponse(
                status="idle",
                reason="synthetic idle",
                registry_entries=[registry_entry],
            ),
            ErrorResponse(
                status="error",
                error_code="SYNTHETIC_ERROR",
                reason="synthetic error",
            ),
        ]
        models = (ExecuteResponse, PauseResponse, IdleResponse, ErrorResponse)
        payloads = [CycleCoordinator._response_payload(response) for response in responses]
        for model, payload in zip(models, payloads):
            assert_top_level_schema_shape(payload)
            assert_json_schema_instance(payload, response_schema())
            model.model_validate_json(json.dumps(payload, ensure_ascii=False))

        execute_payload, pause_payload, idle_payload, error_payload = payloads
        self.assertIn("floor", execute_payload["guard"])
        self.assertIsNone(execute_payload["guard"]["floor"])
        self.assertIsNone(execute_payload["registry_entries"][0]["trigger"])
        self.assertIsNone(pause_payload["registry_entries"][0]["trigger"])
        self.assertIsNone(idle_payload["registry_entries"][0]["trigger"])
        self.assertNotIn("supersedes_action_id", execute_payload)
        self.assertNotIn("evidence_path", pause_payload)
        self.assertNotIn("errors", error_payload)

        schema = json.loads(
            (project_dir / "protocol" / "cycle-response.schema.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertIn("floor", schema["$defs"]["guard"]["required"])
        self.assertIn("null", schema["$defs"]["guard"]["properties"]["floor"]["type"])
        self.assertIn("trigger", schema["$defs"]["registryEntry"]["required"])
        self.assertIn(
            "null",
            schema["$defs"]["registryEntry"]["properties"]["trigger"]["type"],
        )
        assert_browser_parser_accepts(payloads)


class ApiBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temporary.name))
        self.client = TestClient(create_app(self.settings))
        self.payload = make_request(make_observation())

    def tearDown(self) -> None:
        self.client.close()
        self.temporary.cleanup()

    def test_requires_exact_header(self) -> None:
        response = self.client.post("/cycle", json=self.payload)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error_code"], "INVALID_HEADER")

    def test_requires_json_content_type(self) -> None:
        response = self.client.post(
            "/cycle",
            content=json.dumps(self.payload),
            headers={"X-Mota-Lab": "1", "Content-Type": "text/plain"},
        )
        self.assertEqual(response.status_code, 415)

    def test_body_size_limit(self) -> None:
        settings = make_settings(Path(self.temporary.name) / "small", max_body_bytes=100)
        with TestClient(create_app(settings)) as client:
            response = client.post(
                "/cycle",
                content=b"{" + b" " * 200 + b"}",
                headers={"X-Mota-Lab": "1", "Content-Type": "application/json"},
            )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["error_code"], "REQUEST_TOO_LARGE")

    def test_schema_rejects_extra_without_echoing_input(self) -> None:
        payload = copy.deepcopy(self.payload)
        payload["observation"]["maps"] = {"secret": "must-not-echo"}
        response = self.client.post(
            "/cycle", json=payload, headers={"X-Mota-Lab": "1"}
        )
        self.assertEqual(response.status_code, 422)
        text = response.text
        self.assertNotIn("must-not-echo", text)
        self.assertEqual(response.json()["error_code"], "SCHEMA_REJECTED")

    def test_only_cycle_route_is_exposed(self) -> None:
        self.assertEqual(self.client.get("/docs").status_code, 404)
        self.assertEqual(self.client.get("/openapi.json").status_code, 404)
        self.assertEqual(self.client.get("/cycle").status_code, 405)

    def test_rate_limit_is_local_and_configurable(self) -> None:
        settings = make_settings(
            Path(self.temporary.name) / "rate", rate_limit_per_second=2
        )
        with TestClient(create_app(settings)) as client:
            responses = [
                client.post("/cycle", json=self.payload, headers={"X-Mota-Lab": "1"})
                for _ in range(3)
            ]
        self.assertEqual([response.status_code for response in responses], [200, 200, 429])
        self.assertEqual(responses[-1].json()["error_code"], "RATE_LIMITED")
        self.assertIn("reason", responses[-1].json())

    def test_valid_first_floor_pauses_as_unknown_floor(self) -> None:
        response = self.client.post(
            "/cycle", json=self.payload, headers={"X-Mota-Lab": "1"}
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["pause_kind"], "UNKNOWN_FLOOR")
        PauseResponse.model_validate_json(response.text)
        assert_json_schema_instance(body, response_schema())
        assert_browser_parser_accepts([body])

    def test_protocol_error_uses_error_envelope_not_pause_taxonomy(self) -> None:
        payload = copy.deepcopy(self.payload)
        payload["completed_action_id"] = "AUTO-0000000000000000"
        response = self.client.post(
            "/cycle", json=payload, headers={"X-Mota-Lab": "1"}
        )
        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertEqual(body["status"], "error")
        self.assertEqual(body["error_code"], "UNKNOWN_ACTION_ID")
        self.assertIn("reason", body)
        self.assertNotIn("pause_kind", body)
        ErrorResponse.model_validate_json(response.text)
        assert_json_schema_instance(body, response_schema())
        assert_browser_parser_accepts([body])

    def test_http_idle_keeps_trigger_null_in_raw_registry_entry(self) -> None:
        settings = make_settings(Path(self.temporary.name) / "nullable-idle")
        settings.knowledge_dir.mkdir(parents=True, exist_ok=True)
        settings.floors_path.write_text(
            json.dumps(
                {
                    "protocol": 1,
                    "floors": [
                        {
                            "floor_id": "F1",
                            "known": True,
                            "name": "1F",
                            "source": "human",
                            "version": 1,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        settings.labels_path.write_text(
            json.dumps(
                {
                    "protocol": 1,
                    "labels": [
                        {
                            "id": "wall",
                            "cls": "terrains",
                            "trigger": None,
                            "category": "wall",
                            "passable": False,
                            "boundary": False,
                            "fast_path": False,
                            "supported": True,
                            "source": "human",
                            "version": 1,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        wall = make_block(
            x=1,
            y=0,
            block_id="wall",
            cls="terrains",
            trigger=None,
            no_pass=True,
        )
        with TestClient(create_app(settings)) as client:
            response = client.post(
                "/cycle",
                json=make_request(make_observation(blocks=[wall])),
                headers={"X-Mota-Lab": "1"},
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "idle")
        self.assertIn("trigger", body["registry_entries"][0])
        self.assertIsNone(body["registry_entries"][0]["trigger"])
        IdleResponse.model_validate(body)
        assert_top_level_schema_shape(body)
        assert_json_schema_instance(body, response_schema())
        assert_browser_parser_accepts([body])

    def test_http_execute_keeps_floor_null_in_raw_guard(self) -> None:
        settings = make_settings(Path(self.temporary.name) / "nullable-execute")
        settings.knowledge_dir.mkdir(parents=True, exist_ok=True)
        settings.floors_path.write_text(
            json.dumps(
                {
                    "protocol": 1,
                    "floors": [
                        {
                            "floor_id": "F1",
                            "known": True,
                            "name": None,
                            "source": "human",
                            "version": 1,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        settings.labels_path.write_text(
            json.dumps(
                {
                    "protocol": 1,
                    "labels": [
                        {
                            "id": "potion",
                            "cls": "items",
                            "trigger": "getItem",
                            "category": "resource",
                            "passable": True,
                            "boundary": True,
                            "fast_path": False,
                            "supported": True,
                            "expected_delta": {"hp": 200},
                            "source": "human",
                            "version": 1,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        potion = make_block(x=1, y=0, block_id="potion")
        with TestClient(create_app(settings)) as client:
            response = client.post(
                "/cycle",
                json=make_request(
                    make_observation(
                        floor_name=None,
                        floor_number=None,
                        blocks=[potion],
                    )
                ),
                headers={"X-Mota-Lab": "1"},
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "execute")
        self.assertIn("floor", body["guard"])
        self.assertIsNone(body["guard"]["floor"])
        ExecuteResponse.model_validate(body)
        assert_top_level_schema_shape(body)
        assert_json_schema_instance(body, response_schema())
        assert_browser_parser_accepts([body])


if __name__ == "__main__":
    unittest.main()
