#!/usr/bin/env bash
set -euo pipefail

# Prepare an external runner workspace. This script does not copy binaries,
# requests, or source into the repository; source is extracted from git
# archives, binaries are symlinked from their external Cargo target paths, and
# requests are symlinked from REQUEST_ROOT. The runner itself remains
# measurement-only and does not build or archive anything.

REPO_ROOT=${1:?usage: bash prepare-artifacts.sh REPO_ROOT WORK_ROOT REQUEST_ROOT}
WORK_ROOT=${2:-/private/tmp/mota-phase5d-prepared}
REQUEST_ROOT=${3:?usage: bash prepare-artifacts.sh REPO_ROOT WORK_ROOT REQUEST_ROOT}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

case "$REPO_ROOT" in
  /*) ;;
  *) echo "REPO_ROOT must be absolute" >&2; exit 2 ;;
esac
case "$WORK_ROOT" in
  /private/tmp/*) ;;
  *) echo "WORK_ROOT must be under /private/tmp" >&2; exit 2 ;;
esac
case "$REQUEST_ROOT" in
  /*) ;;
  *) echo "REQUEST_ROOT must be absolute" >&2; exit 2 ;;
esac

BASELINE=6fa0f193878b343a0f3dc925e53bda78e3c68a07
COMMIT1=e04c5b00ed6d4471513d19a133e4550078167c4d
FINAL=9969126b6e6702709693298b19193f54e6747002

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

mkdir -p "$WORK_ROOT/src" "$WORK_ROOT/bin" "$WORK_ROOT/raw"
ln -sfn "$SCRIPT_DIR/runner.py" "$WORK_ROOT/runner.py"

# Keep the exact source diff beside the prepared artifacts.  The runner is
# artifact-root aware, so symlink resolution is not part of its identity.
(cd "$REPO_ROOT" && git diff --binary "$BASELINE" "$FINAL" -- .) > "$WORK_ROOT/raw/baseline-to-final.patch"
test -s "$WORK_ROOT/raw/baseline-to-final.patch"
test "$(sha256 "$WORK_ROOT/raw/baseline-to-final.patch")" = "$(sha256 "$SCRIPT_DIR/baseline-to-final.patch")"

prepare_commit() {
  local commit=$1
  local name=$2
  local source_dir="$WORK_ROOT/src/$commit"
  local target_dir="$WORK_ROOT/target-$name"
  local binary="$target_dir/release/mota-shadow-runtime"

  mkdir -p "$source_dir"
  (cd "$REPO_ROOT" && git archive --format=tar "$commit") | tar -xf - -C "$source_dir"
  CARGO_TARGET_DIR="$target_dir" cargo build \
    --manifest-path "$source_dir/games/mota-planning-lab/rust/shadow-runtime/Cargo.toml" \
    --release --bin mota-shadow-runtime >/dev/null
  test -x "$binary"
  ln -sfn "$binary" "$WORK_ROOT/bin/$name"
  printf '%s\t%s\t%s\n' "$name" \
    "$(sha256 "$source_dir/games/mota-planning-lab/rust/shadow-runtime/src/main.rs")" \
    "$(sha256 "$binary")"
}

: > "$WORK_ROOT/source-and-binary.sha256"
prepare_commit "$BASELINE" baseline-6fa | tee -a "$WORK_ROOT/source-and-binary.sha256"
prepare_commit "$COMMIT1" commit1-e04 | tee -a "$WORK_ROOT/source-and-binary.sha256"
prepare_commit "$FINAL" final-996 | tee -a "$WORK_ROOT/source-and-binary.sha256"

for request in official-request.json immediate-request.json; do
  test -f "$REQUEST_ROOT/$request"
  ln -sfn "$REQUEST_ROOT/$request" "$WORK_ROOT/raw/$request"
done

{
  printf 'runner_workspace=%s\n' "$WORK_ROOT"
  printf 'official_request_sha256=%s\n' "$(sha256 "$REQUEST_ROOT/official-request.json")"
  printf 'immediate_request_sha256=%s\n' "$(sha256 "$REQUEST_ROOT/immediate-request.json")"
  printf 'baseline_to_final_patch_sha256=%s\n' "$(sha256 "$WORK_ROOT/raw/baseline-to-final.patch")"
  printf 'source_and_binary_sha256 (new Mach-O byte hashes are toolchain/UUID dependent)\n'
  cat "$WORK_ROOT/source-and-binary.sha256"
} | tee "$WORK_ROOT/prepared-identity.txt"

cat <<'EOF'
Preparation complete. Run the measurement runner with
  MOTA_PHASE5D_WORK_ROOT="$WORK_ROOT" python3 "$SCRIPT_DIR/runner.py"
or
  python3 "$SCRIPT_DIR/runner.py" --root "$WORK_ROOT"
The measurement runner consumes the prepared workspace
and writes only JSON result files under its results/ directory. The packaged
TSV/JSONL files in this QA archive are postprocessed evidence, not runner
outputs. A newly built Mach-O binary is not expected to reproduce a prior
byte hash across toolchains/UUIDs; hashes bind this preparation run only.
EOF
