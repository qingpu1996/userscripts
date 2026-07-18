#!/usr/bin/env python3
"""Run interleaved shadow-runtime A/B/C samples without archiving the request.

The caller supplies independently built binaries as ``LABEL=PATH`` arguments.
Each process stays resident for its warmup and official samples; only POST
wall time and 10 ms RSS samples are recorded. Profile JSON is copied from
stderr when MOTA_SHADOW_PROFILE=1. The fixed request is read, hashed, and
never written to the output directory.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import signal
import statistics
import subprocess
import threading
import time
from typing import Any


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rss_bytes(pid: int) -> int:
    try:
        value = subprocess.check_output(
            ["ps", "-o", "rss=", "-p", str(pid)], text=True
        ).strip()
        return int(value) * 1024
    except (OSError, subprocess.CalledProcessError, ValueError):
        return 0


class Runtime:
    def __init__(self, label: str, binary: Path, port: int, profile: bool) -> None:
        self.label = label
        self.binary = binary
        self.port = port
        env = os.environ.copy()
        if profile:
            env["MOTA_SHADOW_PROFILE"] = "1"
        else:
            env.pop("MOTA_SHADOW_PROFILE", None)
        self.process = subprocess.Popen(
            [str(binary), "--port", str(port)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        assert self.process.stdout is not None
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            line = self.process.stdout.readline()
            if not line:
                break
            if '"event":"ready"' in line or '"event": "ready"' in line:
                return
        self.stop()
        raise RuntimeError(f"{label}: runtime did not report ready")

    def post(self, body: bytes) -> tuple[float, int, str, int]:
        samples: list[int] = []
        done = threading.Event()

        def sample_rss() -> None:
            while not done.is_set():
                samples.append(rss_bytes(self.process.pid))
                done.wait(0.010)

        sampler = threading.Thread(target=sample_rss, daemon=True)
        sampler.start()
        started = time.perf_counter()
        status = 0
        response = b""
        try:
            connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=180)
            connection.request(
                "POST",
                "/cycle",
                body=body,
                headers={
                    "Origin": "https://h5mota.com",
                    "Content-Type": "application/json",
                    "X-Mota-Lab": "1",
                },
            )
            result = connection.getresponse()
            status = result.status
            response = result.read()
            connection.close()
        finally:
            elapsed_ms = (time.perf_counter() - started) * 1000
            done.set()
            sampler.join()
        canonical_hash = ""
        if status == 200:
            value = json.loads(response)
            value.get("shadow", {}).pop("cycle", None)
            canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            canonical_hash = hashlib.sha256(canonical.encode()).hexdigest()
        return elapsed_ms, max(samples or [0]), canonical_hash, status

    def profile_lines(self) -> list[dict[str, Any]]:
        if self.process.stderr is None:
            return []
        lines = self.process.stderr.read().splitlines()
        parsed = []
        for line in lines:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if value.get("event") == "mota_shadow_profile_v1":
                parsed.append(value)
        return parsed

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def parse_version(value: str) -> tuple[str, Path]:
    label, separator, path = value.partition("=")
    if not separator or not label or not path:
        raise argparse.ArgumentTypeError("version must be LABEL=PATH")
    return label, Path(path).expanduser().resolve()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--version", action="append", type=parse_version, required=True)
    parser.add_argument(
        "--source",
        action="append",
        type=parse_version,
        default=[],
        help="optional LABEL=source path for the source hash recorded with a version",
    )
    parser.add_argument("--samples", type=int, default=10)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--port-base", type=int, default=19880)
    parser.add_argument("--no-profile", action="store_true")
    args = parser.parse_args()
    if len(args.version) < 1 or args.samples < 1 or args.warmups < 0:
        raise SystemExit("at least one version and positive samples are required")

    body = args.request.read_bytes()
    source_by_label = dict(args.source)
    args.out.mkdir(parents=True, exist_ok=True)
    runtimes: dict[str, Runtime] = {}
    by_label: dict[str, list[dict[str, Any]]] = {label: [] for label, _ in args.version}
    try:
        for offset, (label, binary) in enumerate(args.version):
            runtimes[label] = Runtime(label, binary, args.port_base + offset, not args.no_profile)
        for _ in range(args.warmups):
            for label, _ in args.version:
                runtimes[label].post(body)
        order = [label for index in range(args.samples) for label, _ in args.version]
        with (args.out / "samples.tsv").open("w", encoding="utf-8") as raw:
            raw.write("sample\tversion\tstatus\tpost_ms\tmax_rss_bytes\tcanonical_sha256\n")
            for sample, label in enumerate(order, 1):
                elapsed, rss, response_hash, status = runtimes[label].post(body)
                by_label[label].append(
                    {
                        "sample": sample,
                        "status": status,
                        "post_ms": elapsed,
                        "max_rss_bytes": rss,
                        "canonical_sha256": response_hash,
                    }
                )
                raw.write(
                    f"{sample}\t{label}\t{status}\t{elapsed:.6f}\t{rss}\t{response_hash}\n"
                )
    finally:
        profile_events: dict[str, list[dict[str, Any]]] = {}
        for label, runtime in runtimes.items():
            runtime.stop()
            events = runtime.profile_lines()
            profile_events[label] = events
            (args.out / f"profile-{label}.jsonl").write_text(
                "".join(json.dumps(event, sort_keys=True) + "\n" for event in events),
                encoding="utf-8",
            )

    summary: dict[str, Any] = {
        "schema": "mota-phase25-profile-v1",
        "request": {"sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body)},
        "versions": {
            label: {
                "binary": str(binary),
                "binary_sha256": sha256(binary),
                **(
                    {
                        "source": str(source_by_label[label]),
                        "source_sha256": sha256(source_by_label[label]),
                    }
                    if label in source_by_label
                    else {}
                ),
            }
            for label, binary in args.version
        },
        "method": {
            "warmups_per_version": args.warmups,
            "official_samples_per_version": args.samples,
            "order": [label for label in order],
            "request": "pure POST /cycle",
            "rss": "service PID sampled every 10 ms",
            "canonical_response": "sorted JSON with shadow.cycle removed",
        },
        "results": {},
        "profile_events": profile_events,
        "raw_samples_tsv": str((args.out / "samples.tsv").resolve()),
    }
    for label, rows in by_label.items():
        elapsed = [row["post_ms"] for row in rows]
        rss = [row["max_rss_bytes"] for row in rows]
        summary["results"][label] = {
            "median_post_ms": statistics.median(elapsed),
            "p95_post_ms": percentile(elapsed, 0.95),
            "max_post_ms": max(elapsed),
            "median_rss_bytes": statistics.median(rss),
            "p95_rss_bytes": percentile(rss, 0.95),
            "max_rss_bytes": max(rss),
            "canonical_response_hashes": sorted({row["canonical_sha256"] for row in rows}),
        }
    (args.out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
