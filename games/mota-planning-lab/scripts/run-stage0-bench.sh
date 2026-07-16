#!/usr/bin/env bash
# Run the ordinary Stage 0 spike in a disposable temporary directory.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
FIXTURE_DIR="$PROJECT_DIR/tests/fixtures/stage0"
PYTHON_BIN=${MOTA_LAB_PYTHON:-python3}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mota-stage0.XXXXXX")
export CARGO_TARGET_DIR="$TMP_DIR/cargo-target"
export PYTHONDONTWRITEBYTECODE=1

cleanup() {
  status=$?
  trap - EXIT INT TERM
  rm -rf "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT INT TERM

run_logged() {
  local log="$TMP_DIR/command.log"
  if ! "$@" >"$log" 2>&1; then
    cat "$log" >&2
    return 1
  fi
}

run_logged "$PYTHON_BIN" "$PROJECT_DIR/benchmarks/stage0.py" fixtures --root "$FIXTURE_DIR"
run_logged "$PYTHON_BIN" -m unittest discover -s "$PROJECT_DIR/tests/python" -p test_stage0_benchmark.py
run_logged cargo fmt --manifest-path "$PROJECT_DIR/rust/stage0-ir/Cargo.toml" --check
run_logged cargo test --locked --manifest-path "$PROJECT_DIR/rust/stage0-ir/Cargo.toml"
run_logged cargo build --release --locked --manifest-path "$PROJECT_DIR/rust/stage0-ir/Cargo.toml"

"$PYTHON_BIN" "$PROJECT_DIR/benchmarks/stage0.py" run \
  --root "$FIXTURE_DIR" --threads 1 --output "$TMP_DIR/python.json"
"$CARGO_TARGET_DIR/release/mota-stage0-ir" "$FIXTURE_DIR" "$TMP_DIR/rust.json" --threads 1

"$PYTHON_BIN" "$PROJECT_DIR/benchmarks/compare_stage0.py" \
  --fixture-root "$FIXTURE_DIR" \
  --python "$TMP_DIR/python.json" \
  --rust "$TMP_DIR/rust.json"
