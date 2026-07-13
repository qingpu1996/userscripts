"""``python -m mota_lab`` entry point."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path
from typing import Optional, Sequence

from .api import Settings
from .labels import (
    LabelCommandError,
    apply_block_from_pause,
    apply_floor_from_pause,
    create_evidence_from_request,
    list_pauses,
    registry_for_settings,
)
from .models import PauseKind


def _boolean_pair(parser: argparse.ArgumentParser, name: str, positive: str, negative: str) -> None:
    parser.add_argument(positive, dest=name, action="store_true")
    parser.add_argument(negative, dest=name, action="store_false")
    parser.set_defaults(**{name: None})


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m mota_lab")
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--knowledge-dir", type=Path)
    subcommands = parser.add_subparsers(dest="command", required=True)

    serve = subcommands.add_parser("serve", help="run the localhost decision service")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=18724)
    serve.add_argument(
        "--allow-direct-mount-origin",
        choices=["https://h5mota.com"],
        help="explicitly enable exact-origin CORS for the in-app direct-mount bridge",
    )

    labels = subcommands.add_parser("labels", help="inspect or apply human labels")
    label_commands = labels.add_subparsers(dest="labels_command", required=True)
    label_commands.add_parser("list", help="list pause evidence packages")
    label_commands.add_parser("show", help="show current auditable knowledge")

    floor = label_commands.add_parser("apply-floor", help="mark evidence floor as modeled")
    floor.add_argument("--pause", type=Path, required=True)
    floor.add_argument("--name")

    block = label_commands.add_parser("apply-block", help="label a block from pause evidence")
    block.add_argument("--pause", type=Path, required=True)
    block.add_argument("--x", type=int, required=True)
    block.add_argument("--y", type=int, required=True)
    block.add_argument(
        "--category",
        choices=["terrain", "wall", "door", "resource", "enemy", "npc", "mechanism", "stair", "other"],
        required=True,
    )
    _boolean_pair(block, "passable", "--passable", "--blocked")
    _boolean_pair(block, "boundary", "--boundary", "--non-boundary")
    _boolean_pair(block, "fast_path", "--fast-path", "--no-fast-path")
    _boolean_pair(block, "supported", "--supported", "--unsupported")
    block.add_argument("--expected-delta", help="strict JSON object")

    evidence = label_commands.add_parser("evidence", help="generate a pause package from a request")
    evidence.add_argument("--request", type=Path, required=True)
    evidence.add_argument("--pause-kind", choices=[kind.value for kind in PauseKind], required=True)
    evidence.add_argument("--detail-code", required=True)
    evidence.add_argument("--reason", required=True)
    return parser


def _settings(args: argparse.Namespace) -> Settings:
    settings = Settings.from_env()
    if args.state_dir is not None:
        settings = replace(settings, state_dir=args.state_dir)
    if args.knowledge_dir is not None:
        settings = replace(settings, knowledge_dir=args.knowledge_dir)
    return settings


def _json_print(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2))


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    settings = _settings(args)
    try:
        if args.command == "serve":
            if args.host != "127.0.0.1":
                parser.error("serve only permits --host 127.0.0.1")
            if args.port != 18724:
                parser.error("serve only permits --port 18724")
            import uvicorn

            from .api import create_app

            settings = replace(settings, direct_mount_origin=args.allow_direct_mount_origin)
            uvicorn.run(create_app(settings), host="127.0.0.1", port=18724)
            return 0

        if args.labels_command == "list":
            _json_print(list_pauses(settings))
            return 0
        if args.labels_command == "show":
            registry = registry_for_settings(settings)
            _json_print(
                {
                    "labels": [
                        label.model_dump(mode="json") for label in registry.labels().values()
                    ],
                    "floors": [
                        floor.model_dump(mode="json") for floor in registry.floors().values()
                    ],
                }
            )
            return 0
        if args.labels_command == "apply-floor":
            model = apply_floor_from_pause(settings, args.pause, name=args.name)
            _json_print(model.model_dump(mode="json"))
            return 0
        if args.labels_command == "apply-block":
            missing = [
                name
                for name in ("passable", "boundary", "fast_path")
                if getattr(args, name) is None
            ]
            if missing:
                parser.error("apply-block requires explicit booleans for: " + ", ".join(missing))
            expected_delta = None
            if args.expected_delta is not None:
                expected_delta = json.loads(args.expected_delta)
                if not isinstance(expected_delta, dict):
                    raise LabelCommandError("--expected-delta must decode to an object")
            label = apply_block_from_pause(
                settings,
                args.pause,
                x=args.x,
                y=args.y,
                category=args.category,
                passable=args.passable,
                boundary=args.boundary,
                fast_path=args.fast_path,
                supported=True if args.supported is None else args.supported,
                expected_delta=expected_delta,
            )
            _json_print(label.model_dump(mode="json"))
            return 0
        if args.labels_command == "evidence":
            path = create_evidence_from_request(
                settings,
                args.request,
                pause_kind=args.pause_kind,
                detail_code=args.detail_code,
                reason=args.reason,
            )
            _json_print({"evidence_path": str(path)})
            return 0
    except (LabelCommandError, json.JSONDecodeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
