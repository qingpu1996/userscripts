#!/usr/bin/env python3
"""Validate shared synthetic wire fixtures against the service models."""

from __future__ import annotations

import json
from pathlib import Path

from json_schema_support import assert_json_schema_instance
from mota_lab.models import (
    CycleRequest,
    ErrorResponse,
    ExecuteResponse,
    IdleResponse,
    Observation,
    PauseResponse,
)


PROJECT_DIR = Path(__file__).resolve().parent.parent
FIXTURE_DIR = PROJECT_DIR / "tests" / "fixtures"


def compact(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def main() -> int:
    observation_fixture = json.loads(
        (FIXTURE_DIR / "synthetic-observation.json").read_text(encoding="utf-8")
    )
    Observation.model_validate_json(compact(observation_fixture["observation"]))
    request_payload = {
        "source": "mota-planning-lab-userscript",
        "intent": "reconnect_only",
        "completed_action_id": None,
        "observation": observation_fixture["observation"],
        "session": {"mode": "new_game", "command": "observe"},
        "recovery": {
            "phase": "none",
            "pending_action_id": None,
            "pre_fingerprint": None,
            "current_fingerprint": None,
            "detail_code": None,
        },
    }
    CycleRequest.model_validate_json(compact(request_payload))
    request_schema = json.loads(
        (PROJECT_DIR / "protocol" / "cycle-request.schema.json").read_text(
            encoding="utf-8"
        )
    )
    if request_schema.get("additionalProperties") is not False \
            or "intent" not in request_schema.get("required", []) \
            or request_schema.get("properties", {}).get("intent", {}).get("enum") \
            != ["cycle", "reconnect_only"]:
        raise AssertionError("cycle request schema does not strictly declare reconnect intent")

    responses = json.loads(
        (FIXTURE_DIR / "protocol-responses.json").read_text(encoding="utf-8")
    )
    response_schema = json.loads(
        (PROJECT_DIR / "protocol" / "cycle-response.schema.json").read_text(
            encoding="utf-8"
        )
    )
    for model, key in (
        (ExecuteResponse, "execute"),
        (PauseResponse, "pause"),
        (IdleResponse, "idle"),
        (ErrorResponse, "error"),
    ):
        model.model_validate_json(compact(responses[key]))
        assert_json_schema_instance(responses[key], response_schema)
    IdleResponse.model_validate_json(compact(responses["recovery_ack"]))
    assert_json_schema_instance(responses["recovery_ack"], response_schema)

    print(
        "Protocol wire fixtures: PASS "
        "(Pydantic + JSON Schema; 1 request + 1 observation + 5 responses)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
