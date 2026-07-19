#!/usr/bin/env python3
"""Reproducible, artifact-bound Phase 5D final QA measurement runner.

This script consumes prepared ``src/<commit>/``, ``bin/`` and ``raw/``
artifacts.  It deliberately does not run ``git archive``, build Rust binaries,
or create source/request artifacts.  Performance lanes run with profiling
disabled; profile evidence is a separate single-sample run.
"""
import hashlib
import http.client
import argparse
import json
import os
import signal
import statistics
import subprocess
import threading
import time
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, help="prepared workspace root")
parser.add_argument("--identity-only", action="store_true", help="validate prepared artifacts and exit")
args = parser.parse_args()
ROOT = (args.root or (Path(os.environ["MOTA_PHASE5D_WORK_ROOT"])
                      if os.environ.get("MOTA_PHASE5D_WORK_ROOT")
                      else Path(__file__).resolve().parent)).resolve()
BIN = ROOT / "bin"
if args.identity_only:
    required = [
        ROOT / "prepared-identity.txt",
        ROOT / "raw" / "official-request.json",
        ROOT / "raw" / "immediate-request.json",
        ROOT / "raw" / "baseline-to-final.patch",
        BIN / "baseline-6fa", BIN / "commit1-e04", BIN / "final-996",
    ]
    required += list((ROOT / "src").glob("*/games/mota-planning-lab/rust/shadow-runtime/src/main.rs"))
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise SystemExit("missing prepared artifact(s): " + ", ".join(missing))
    print(json.dumps({"root": str(ROOT), "prepared_identity":
                      (ROOT / "prepared-identity.txt").read_text()}, indent=2))
    raise SystemExit(0)
OFFICIAL = (ROOT / "raw" / "official-request.json").read_bytes()
IMMEDIATE = (ROOT / "raw" / "immediate-request.json").read_bytes()


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def rss_bytes(pid):
    try:
        return int(subprocess.check_output(
            ["ps", "-o", "rss=", "-p", str(pid)], text=True
        ).strip() or 0) * 1024
    except Exception:
        return 0


def percentile(values, fraction):
    values = sorted(values)
    position = (len(values) - 1) * fraction
    low = int(position)
    high = min(low + 1, len(values) - 1)
    return values[low] + (values[high] - values[low]) * (position - low)


def canonical_sha(value):
    canonical = json.loads(json.dumps(value))
    canonical.get("shadow", {}).pop("cycle", None)
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


class Runtime:
    def __init__(self, binary, port, policy=None, immediate=None, profile=False, extra=None):
        env = os.environ.copy()
        for key, value in {
            "MOTA_PHASE_A_COMBAT_GEM_POLICY": policy,
            "MOTA_IMMEDIATE_COMBAT_GEM_POLICY": immediate,
        }.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        if profile:
            env["MOTA_SHADOW_PROFILE"] = "1"
        else:
            env.pop("MOTA_SHADOW_PROFILE", None)
        for key, value in (extra or {}).items():
            env[key] = str(value)
        self.process = subprocess.Popen(
            [str(binary), "--port", str(port)], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, env=env,
        )
        self.port = port
        assert self.process.stdout
        ready = self.process.stdout.readline()
        assert "ready" in ready, ready

    def post(self, body):
        rss, done = [], threading.Event()
        def poll():
            while not done.is_set():
                rss.append(rss_bytes(self.process.pid))
                done.wait(0.005)
        thread = threading.Thread(target=poll, daemon=True)
        thread.start()
        started = time.perf_counter()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=180)
            conn.request("POST", "/cycle", body, {
                "Origin": "https://h5mota.com", "Content-Type": "application/json",
                "X-Mota-Lab": "1",
            })
            response = conn.getresponse()
            raw = response.read()
            conn.close()
        finally:
            elapsed_ms = (time.perf_counter() - started) * 1000
            done.set(); thread.join()
        value = json.loads(raw)
        global_ = value.get("shadow", {}).get("analysis", {}).get("global", {})
        return {
            "status": response.status, "post_ms": elapsed_ms,
            "max_rss_bytes": max(rss or [0]), "canonical_sha256": canonical_sha(value),
            "proof": global_.get("proof"), "reason": global_.get("reason"),
            "explored_states": global_.get("explored_states"),
            "decision_mode": global_.get("decision_mode"),
            "route_is_null": global_.get("route") is None,
            "suggestion_kind": (global_.get("first_suggestion") or {}).get("step_kind"),
            "suggestion_block_id": (global_.get("first_suggestion") or {}).get("block_id"),
        }

    def stop(self):
        self.process.send_signal(signal.SIGTERM)
        self.process.wait(timeout=10)
        assert self.process.stderr
        lines = self.process.stderr.read().splitlines()
        events = []
        for line in lines:
            try:
                item = json.loads(line)
                if item.get("event") == "mota_shadow_profile_v1":
                    events.append(item)
            except json.JSONDecodeError:
                pass
        return {"exit_code": self.process.returncode, "profile_events": events, "stderr": lines}


def run_lanes(specs, body, samples, port):
    runtimes = {
        name: Runtime(binary, port + index, policy, immediate, profile, extra)
        for index, (name, binary, policy, immediate, profile, extra) in enumerate(specs)
    }
    rows = {name: [] for name in runtimes}
    for runtime in runtimes.values():
        runtime.post(body)
    names = list(runtimes)
    for sample in range(samples):
        for offset in range(len(names)):
            name = names[(sample + offset) % len(names)]
            row = runtimes[name].post(body)
            row["sample"] = sample + 1
            rows[name].append(row)
    return rows, {name: runtime.stop() for name, runtime in runtimes.items()}


def summarize(rows):
    return {
        name: {
            "median_post_ms": statistics.median(row["post_ms"] for row in values),
            "p95_post_ms": percentile([row["post_ms"] for row in values], 0.95),
            "max_rss_bytes": max(row["max_rss_bytes"] for row in values),
            "canonical_sha256": sorted({row["canonical_sha256"] for row in values}),
            "status": sorted({row["status"] for row in values}),
            "proof": sorted({str(row["proof"]) for row in values}),
            "reason": sorted({str(row["reason"]) for row in values}),
            "explored_states": sorted({row["explored_states"] for row in values}),
            "decision_mode": sorted({str(row["decision_mode"]) for row in values}),
            "route_is_null": sorted({row["route_is_null"] for row in values}),
            "suggestion_kind": sorted({str(row["suggestion_kind"]) for row in values}),
            "suggestion_block_id": sorted({str(row["suggestion_block_id"]) for row in values}),
        }
        for name, values in rows.items()
    }


BASE = BIN / "baseline-6fa"
FINAL = BIN / "final-996"
out = ROOT / "results"
out.mkdir(exist_ok=True)

official = [
    ("A_baseline_6fa", BASE, None, None, False, None),
    ("B_final_gate_off_immediate_off", FINAL, "0", "0", False, None),
    ("C_final_gate_on_immediate_off", FINAL, "1", "0", False, None),
]
rows, stops = run_lanes(official, OFFICIAL, 7, 26400)
(out / "official-samples.json").write_text(json.dumps(rows, indent=2) + "\n")
(out / "official-summary.json").write_text(json.dumps(summarize(rows), indent=2) + "\n")
(out / "official-processes.json").write_text(json.dumps(stops, indent=2) + "\n")

profiles = [
    ("B_final_gate_off_immediate_off", FINAL, "0", "0", True, None),
    ("C_final_gate_on_immediate_off", FINAL, "1", "0", True, None),
]
rows, stops = run_lanes(profiles, OFFICIAL, 1, 26420)
(out / "official-profile-samples.json").write_text(json.dumps(rows, indent=2) + "\n")
(out / "official-profile-events.json").write_text(json.dumps(stops, indent=2) + "\n")

limits = {}
for name, extra in [
    ("depth8", {"MOTA_PHASE_A_MAX_STRATEGIC_DEPTH": 8}),
    ("depth12", {"MOTA_PHASE_A_MAX_STRATEGIC_DEPTH": 12}),
    ("depth16", {"MOTA_PHASE_A_MAX_STRATEGIC_DEPTH": 16}),
    ("work200k", {"MOTA_PHASE_A_MAX_WORK_ITEMS": 200000}),
]:
    specs = [
        ("B_final_gate_off", FINAL, "0", "0", True, extra),
        ("C_final_gate_on", FINAL, "1", "0", True, extra),
    ]
    rows, stops = run_lanes(specs, OFFICIAL, 1, 26440 + len(limits) * 4)
    limits[name] = {"samples": rows, "processes": stops}
(out / "limits.json").write_text(json.dumps(limits, indent=2) + "\n")

immediate = [
    ("B_final_full_global", FINAL, "1", "0", False, None),
    ("C_final_immediate_default", FINAL, "1", "1", False, None),
]
rows, stops = run_lanes(immediate, IMMEDIATE, 7, 26470)
(out / "immediate-samples.json").write_text(json.dumps(rows, indent=2) + "\n")
(out / "immediate-summary.json").write_text(json.dumps(summarize(rows), indent=2) + "\n")
(out / "immediate-processes.json").write_text(json.dumps(stops, indent=2) + "\n")

immediate_profile = [
    ("B_final_full_global", FINAL, "1", "0", True, None),
    ("C_final_immediate_default", FINAL, "1", "1", True, None),
]
rows, stops = run_lanes(immediate_profile, IMMEDIATE, 1, 26490)
(out / "immediate-profile-samples.json").write_text(json.dumps(rows, indent=2) + "\n")
(out / "immediate-profile-events.json").write_text(json.dumps(stops, indent=2) + "\n")

identity = {
    "baseline_commit": "6fa0f193878b343a0f3dc925e53bda78e3c68a07",
    "commit1": "e04c5b00ed6d4471513d19a133e4550078167c4d",
    "final_commit": "9969126b6e6702709693298b19193f54e6747002",
    "baseline_source_sha256": sha256(ROOT / "src" / "6fa0f193878b343a0f3dc925e53bda78e3c68a07" / "games/mota-planning-lab/rust/shadow-runtime/src/main.rs"),
    "commit1_source_sha256": sha256(ROOT / "src" / "e04c5b00ed6d4471513d19a133e4550078167c4d" / "games/mota-planning-lab/rust/shadow-runtime/src/main.rs"),
    "final_source_sha256": sha256(ROOT / "src" / "9969126b6e6702709693298b19193f54e6747002" / "games/mota-planning-lab/rust/shadow-runtime/src/main.rs"),
    "baseline_binary_sha256": sha256(BASE),
    "commit1_binary_sha256": sha256(BIN / "commit1-e04"),
    "final_binary_sha256": sha256(FINAL),
    "official_request_sha256": hashlib.sha256(OFFICIAL).hexdigest(),
    "immediate_request_sha256": hashlib.sha256(IMMEDIATE).hexdigest(),
    "baseline_to_final_patch_sha256": sha256(ROOT / "raw" / "baseline-to-final.patch"),
}
(out / "identity.json").write_text(json.dumps(identity, indent=2) + "\n")
